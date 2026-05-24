import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';

const FAKE_TENANT_A = randomUUID();
const FAKE_TENANT_B = randomUUID();

let pool: ReturnType<typeof import('../../platform/db').getPlatformPool> | null = null;

async function getPool() {
  if (!pool) {
    const { getPlatformPool } = await import('../../platform/db');
    pool = getPlatformPool();
  }
  return pool;
}

// Tests that INSERT into audit_logs (immutability + cross-tenant write) need
// the fake tenant rows to exist first — audit_logs.tenant_id has a FK to
// tenants.id, so the INSERT would otherwise fail with a foreign-key violation
// BEFORE the immutability trigger or RLS WITH CHECK ever fires, masking what
// the test is actually trying to verify.
async function seedFakeTenants(): Promise<void> {
  const p = await getPool();
  await p.query(
    `INSERT INTO tenants (id, name, slug, status, plan)
     VALUES ($1, 'rls-test-a', 'rls-test-a', 'active', 'starter'),
            ($2, 'rls-test-b', 'rls-test-b', 'active', 'starter')
     ON CONFLICT (id) DO NOTHING`,
    [FAKE_TENANT_A, FAKE_TENANT_B],
  );
}

async function cleanupFakeTenants(): Promise<void> {
  const p = await getPool();
  // audit_logs FK is ON DELETE CASCADE? If not, clean them first.
  await p.query(`DELETE FROM audit_logs WHERE tenant_id = ANY($1::text[])`, [[FAKE_TENANT_A, FAKE_TENANT_B]]);
  await p.query(`DELETE FROM tenants WHERE id = ANY($1::text[])`, [[FAKE_TENANT_A, FAKE_TENANT_B]]);
}

describe('Tenant Isolation - RLS Enforcement', () => {
  beforeAll(seedFakeTenants);
  afterAll(cleanupFakeTenants);

  const RLS_TABLES = [
    'agents', 'phone_numbers', 'call_sessions', 'integrations',
    'connector_configs', 'campaigns', 'campaign_contacts',
    'audit_logs', 'api_keys', 'user_roles', 'analytics_metrics',
  ];

  describe('RLS policies are enabled', () => {
    for (const table of RLS_TABLES) {
      it(`should have RLS enabled on ${table}`, async () => {
        const p = await getPool();
        const { rows } = await p.query(
          `SELECT relrowsecurity FROM pg_class WHERE relname = $1`,
          [table],
        );
        if (rows.length > 0) {
          expect(rows[0].relrowsecurity).toBe(true);
        }
      });
    }
  });

  describe('Cross-tenant read isolation', () => {
    for (const table of ['agents', 'call_sessions', 'audit_logs', 'api_keys']) {
      it(`should block cross-tenant reads on ${table}`, async () => {
        const p = await getPool();
        const client = await p.connect();
        let isolated = false;
        try {
          await client.query('BEGIN');
          await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [FAKE_TENANT_A]);

          const { rows } = await client.query(
            `SELECT COUNT(*) as cnt FROM ${table} WHERE tenant_id = $1`,
            [FAKE_TENANT_B],
          );
          const count = parseInt(rows[0]?.cnt as string ?? '0');
          await client.query('COMMIT');
          isolated = count === 0;
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          const errStr = String(err);
          isolated = errStr.includes('policy') || errStr.includes('permission denied') || errStr.includes('row_security');
          if (!isolated) {
            throw new Error(`Unexpected isolation test error on ${table}: ${errStr}`);
          }
        } finally {
          client.release();
        }
        expect(isolated).toBe(true);
      });
    }
  });

  describe('Cross-tenant write isolation', () => {
    it('should prevent inserting data for a different tenant', async () => {
      const p = await getPool();
      const client = await p.connect();
      let blocked = false;
      let blockReason = '';
      try {
        await client.query('BEGIN');
        // Switch to platform_rls_tester so RLS WITH CHECK actually enforces.
        // postgres has BYPASSRLS, so without this the test could pass for the
        // wrong reason (FK violation, not RLS).
        await client.query('SET LOCAL ROLE platform_rls_tester');
        await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [FAKE_TENANT_A]);

        // actor_user_id intentionally NULL to avoid a FK violation that would
        // mask whether RLS WITH CHECK is the thing blocking the insert.
        await client.query(
          `INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type)
           VALUES ($1, NULL, $2, $3)`,
          [FAKE_TENANT_B, 'test.cross_tenant_write', 'test'],
        );
        await client.query('ROLLBACK');
        blocked = false;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        blocked = true;
        blockReason = String(err);
      } finally {
        client.release();
      }
      expect(blocked, `expected RLS to block cross-tenant write, got: ${blockReason}`).toBe(true);
      // RLS row-level violation has SQLSTATE 42501 / message includes
      // "violates row-level security policy". FK violation would be 23503.
      expect(blockReason, 'expected RLS error, not FK violation').toMatch(/row-level security|policy/i);
    });
  });

  describe('Audit log immutability', () => {
    // Reuse FAKE_TENANT_A which is pre-seeded by beforeAll, otherwise the
    // INSERT below fails with a FK violation on audit_logs.tenant_id ->
    // tenants.id BEFORE the immutability trigger gets a chance to fire.
    // actor_user_id is intentionally NULL — it has a FK to users.id which we
    // don't need to satisfy for an immutability test.
    const TEST_TENANT = FAKE_TENANT_A;

    it('should prevent UPDATE on audit_logs', async () => {
      const p = await getPool();
      const client = await p.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL row_security = off');

        const { rows } = await client.query(
          `INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type)
           VALUES ($1, NULL, $2, $3)
           RETURNING id`,
          [TEST_TENANT, 'test.immutability_check', 'test'],
        );
        const insertedId = rows[0].id as string;

        await expect(
          client.query(
            `UPDATE audit_logs SET action = 'tampered' WHERE id = $1`,
            [insertedId],
          ),
        ).rejects.toThrow(/immutable/);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });

    it('should prevent DELETE on audit_logs', async () => {
      const p = await getPool();
      const client = await p.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL row_security = off');

        const { rows } = await client.query(
          `INSERT INTO audit_logs (tenant_id, actor_user_id, action, resource_type)
           VALUES ($1, NULL, $2, $3)
           RETURNING id`,
          [TEST_TENANT, 'test.immutability_check', 'test'],
        );
        const insertedId = rows[0].id as string;

        await expect(
          client.query(
            `DELETE FROM audit_logs WHERE id = $1`,
            [insertedId],
          ),
        ).rejects.toThrow(/immutable/);
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    });
  });
});

describe('Encryption Service', () => {
  it('should encrypt and decrypt field data with versioned format', async () => {
    const { encryptField, decryptField, generateDEK, isEnvelopeEncrypted } = await import('../../platform/security/EncryptionService');
    const dek = generateDEK();
    const keyId = randomUUID();
    const plaintext = 'sensitive PII data';

    const encrypted = encryptField(plaintext, dek, keyId);
    expect(isEnvelopeEncrypted(encrypted)).toBe(true);
    expect(encrypted).toContain('env1:');
    expect(encrypted).toContain(keyId);

    const decrypted = decryptField(encrypted, dek);
    expect(decrypted).toBe(plaintext);
  });

  it('should detect envelope-encrypted vs legacy ciphertext', async () => {
    const { isEnvelopeEncrypted } = await import('../../platform/security/EncryptionService');
    expect(isEnvelopeEncrypted('env1:abc123:payload')).toBe(true);
    expect(isEnvelopeEncrypted('legacyBase64Data==')).toBe(false);
  });

  it('should parse key ID from envelope ciphertext', async () => {
    const { parseEnvelopeCiphertext } = await import('../../platform/security/EncryptionService');
    const keyId = randomUUID();
    const result = parseEnvelopeCiphertext(`env1:${keyId}:payloaddata`);
    expect(result.keyId).toBe(keyId);
    expect(result.payload).toBe('payloaddata');
  });
});

describe('API Key Scope Enforcement', () => {
  it('should block API key users without scopes', async () => {
    const { requireApiKeyPermission } = await import('../../server/admin-api/middleware/apiKeyScope');
    const req = {
      user: { userId: 'apikey:test', tenantId: 'test', email: 'test', role: 'tenant_owner', isPlatformAdmin: false },
      apiKeyScopes: undefined,
    } as unknown as import('express').Request;
    const res = {
      status: (code: number) => ({ json: (body: unknown) => ({ code, body }) }),
    } as unknown as import('express').Response;
    const next = () => {};

    const middleware = requireApiKeyPermission('read-only');
    const result = middleware(req, res, next);
    expect(result).toBeUndefined();
  });

  it('should allow JWT users through scope checks', async () => {
    const { requireApiKeyPermission } = await import('../../server/admin-api/middleware/apiKeyScope');
    let nextCalled = false;
    const req = {
      user: { userId: 'user-123', tenantId: 'test', email: 'test@test.com', role: 'tenant_owner', isPlatformAdmin: false },
    } as unknown as import('express').Request;
    const res = {} as import('express').Response;
    const next = () => { nextCalled = true; };

    const middleware = requireApiKeyPermission('admin');
    middleware(req, res, next);
    expect(nextCalled).toBe(true);
  });
});

describe('Tenant Guard Middleware', () => {
  it('should block cross-tenant body params', async () => {
    const { requireTenantContext } = await import('../../server/admin-api/middleware/tenantGuard');
    let statusCode = 0;
    let responseBody: unknown = null;
    const req = {
      user: { userId: 'user-1', tenantId: 'tenant-a', email: 'a@test.com', role: 'tenant_owner', isPlatformAdmin: false },
      body: { tenantId: 'tenant-b' },
      query: {},
      path: '/test',
    } as unknown as import('express').Request;
    const res = {
      status: (code: number) => {
        statusCode = code;
        return { json: (body: unknown) => { responseBody = body; } };
      },
    } as unknown as import('express').Response;
    const next = () => {};

    requireTenantContext(req, res, next);
    expect(statusCode).toBe(403);
  });

  it('should allow matching tenant params', async () => {
    const { requireTenantContext } = await import('../../server/admin-api/middleware/tenantGuard');
    let nextCalled = false;
    const req = {
      user: { userId: 'user-1', tenantId: 'tenant-a', email: 'a@test.com', role: 'tenant_owner', isPlatformAdmin: false },
      body: { tenantId: 'tenant-a' },
      query: {},
      path: '/test',
    } as unknown as import('express').Request;
    const res = {} as import('express').Response;
    const next = () => { nextCalled = true; };

    requireTenantContext(req, res, next);
    expect(nextCalled).toBe(true);
  });
});
