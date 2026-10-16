// @vitest-environment node
//
// PR #88: tenant isolation against a real Postgres using the restricted
// `qvo_app` role (migration 120). Proves that
//   - the daily isolation suite passes when the app pool is qvo_app,
//   - it fails loudly when the role can bypass RLS (BYPASSRLS, table owner
//     without FORCE, FORCE missing) or a policy is broken,
//   - restricted-pool `query()` and checked-out clients inside a request
//     tenant scope are bound to app.tenant_id, and a privileged (scheduler)
//     scope reaches every tenant (Codex P1s on platform/db/index.ts).
//
// Skips unless QVO_RLS_TEST_DATABASE_URL is set. It must point at a
// DISPOSABLE local database already migrated as postgres, e.g.
//   DATABASE_URL_PRIVILEGED=postgres://postgres@127.0.0.1:55432/qvo_test \
//     npx tsx scripts/run-migrations.ts
//   QVO_RLS_TEST_DATABASE_URL=postgres://postgres@127.0.0.1:55432/qvo_test \
//     npx vitest run tests/security/qvoAppRlsRealDb.test.ts
// The qvo_app URL defaults to the same host/db with user qvo_app (local
// trust auth); override with QVO_RLS_TEST_APP_URL. Non-local hosts are
// refused because the test alters roles, policies and table ownership.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';

const PRIV_URL = process.env.QVO_RLS_TEST_DATABASE_URL ?? '';

function appUrlFrom(privUrl: string): string {
  if (process.env.QVO_RLS_TEST_APP_URL) return process.env.QVO_RLS_TEST_APP_URL;
  const u = new URL(privUrl);
  u.username = 'qvo_app';
  u.password = '';
  return u.toString();
}

function isLocal(url: string): boolean {
  const host = new URL(url).hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

if (PRIV_URL && !isLocal(PRIV_URL)) {
  throw new Error('QVO_RLS_TEST_DATABASE_URL must point at a local disposable Postgres');
}

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();

describe.skipIf(!PRIV_URL)('qvo_app RLS against real Postgres', () => {
  let admin: Client;
  let db: typeof import('../../platform/db');
  let isolation: typeof import('../../platform/security/TenantIsolationService');
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    admin = new Client({ connectionString: PRIV_URL });
    await admin.connect();
    const { rowCount } = await admin.query(
      `SELECT 1 FROM schema_migrations WHERE filename = '120_qvo_app_restricted_role.sql'`,
    );
    if (!rowCount) throw new Error('Migration 120 not applied — run scripts/run-migrations.ts first');

    for (const [i, id] of [TENANT_A, TENANT_B].entries()) {
      await admin.query(
        `INSERT INTO tenants (id, name, slug, status) VALUES ($1, $2, $3, 'active')`,
        [id, `RLS test ${i}`, `rls-test-${id}`],
      );
      await admin.query(`INSERT INTO agents (tenant_id, name) VALUES ($1, 'agent')`, [id]);
      await admin.query(
        `INSERT INTO audit_logs (tenant_id, action, resource_type) VALUES ($1, 'test', 'test')`,
        [id],
      );
      await admin.query(
        `INSERT INTO api_keys (tenant_id, name, key_hash, key_prefix) VALUES ($1, 'k', $2, 'vai_')`,
        [id, `hash-${id}`],
      );
    }

    for (const k of ['APP_ENV', 'DATABASE_URL', 'DATABASE_URL_PRIVILEGED']) savedEnv[k] = process.env[k];
    process.env.APP_ENV = 'development';
    process.env.DATABASE_URL = appUrlFrom(PRIV_URL);
    process.env.DATABASE_URL_PRIVILEGED = PRIV_URL;
    db = await import('../../platform/db');
    isolation = await import('../../platform/security/TenantIsolationService');
  });

  afterAll(async () => {
    await db?.closePlatformPool();
    if (admin) {
      // audit_logs is immutable, so the seeded tenants stay behind; the
      // database is disposable.
      for (const table of ['api_keys', 'agents']) {
        await admin.query(`DELETE FROM ${table} WHERE tenant_id = ANY($1)`, [[TENANT_A, TENANT_B]]);
      }
      await admin.end();
    }
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function failedTests(): Promise<string[]> {
    const result = await isolation.runAllIsolationTests(TENANT_A, { source: 'manual' });
    return result.results.filter((r) => !r.passed).map((r) => `${r.testName}: ${r.details}`);
  }

  it('passes the isolation suite when the app pool is qvo_app', async () => {
    expect(await failedTests()).toEqual([]);
  });

  it('still tests the qvo_app pool when run from a scheduler or a request scope', async () => {
    for (const run of [db.runWithPrivilegedScope, (fn: () => Promise<unknown>) => db.runWithTenantScope(TENANT_A, fn)]) {
      const result = (await run(() => isolation.runAllIsolationTests(TENANT_A, { source: 'scheduled' }))) as Awaited<
        ReturnType<typeof isolation.runAllIsolationTests>
      >;
      const role = result.results.find((r) => r.testName === 'Connected role subject to RLS');
      expect(role?.details).toContain('"qvo_app"');
      expect(result.results.filter((r) => !r.passed)).toEqual([]);
    }
  });

  it('binds restricted-pool queries to the request tenant scope', async () => {
    const pool = db.getPlatformPool();
    const count = async (tenantId: string) =>
      Number((await pool.query(`SELECT COUNT(*) AS n FROM agents WHERE tenant_id = $1`, [tenantId])).rows[0].n);

    expect(await db.runWithRestrictedScope(() => count(TENANT_A))).toBe(0); // qvo_app, no tenant: RLS hides all
    expect(await count(TENANT_A)).toBe(1); // no scope: privileged pool, as before the switch
    expect(await db.runWithTenantScope(TENANT_A, () => count(TENANT_A))).toBe(1);
    expect(await db.runWithTenantScope(TENANT_B, () => count(TENANT_A))).toBe(0);
  });

  it('binds checked-out clients to the request tenant scope', async () => {
    const pool = db.getPlatformPool();
    const countViaClient = (tenantId: string, explicitTx: boolean) =>
      db.runWithTenantScope(tenantId, async () => {
        const client = await pool.connect();
        try {
          if (explicitTx) await client.query('BEGIN');
          const { rows } = await client.query(`SELECT COUNT(*) AS n FROM agents WHERE tenant_id = $1`, [TENANT_A]);
          if (explicitTx) await client.query('COMMIT');
          return Number(rows[0].n);
        } finally {
          client.release();
        }
      });

    expect(await countViaClient(TENANT_A, true)).toBe(1);
    expect(await countViaClient(TENANT_A, false)).toBe(1);
    expect(await countViaClient(TENANT_B, true)).toBe(0);
    await db.runWithRestrictedScope(async () => {
      const client = await pool.connect(); // released client is unbound again
      try {
        const { rows } = await client.query(`SELECT COUNT(*) AS n FROM agents WHERE tenant_id = $1`, [TENANT_A]);
        expect(Number(rows[0].n)).toBe(0);
      } finally {
        client.release();
      }
    });
  });

  it('sends restricted-pool work to the privileged pool in a privileged (scheduler) scope', async () => {
    const pool = db.getPlatformPool();
    const { rows } = await db.runWithPrivilegedScope(() =>
      pool.query(`SELECT COUNT(*) AS n FROM agents WHERE tenant_id = ANY($1)`, [[TENANT_A, TENANT_B]]),
    );
    expect(Number(rows[0].n)).toBe(2);
  });

  it('fails when a policy leaks rows across tenants', async () => {
    await admin.query(`CREATE POLICY qvo_test_leak ON agents FOR SELECT USING (true)`);
    try {
      const failed = await failedTests();
      expect(failed.some((f) => f.startsWith('Cross-tenant read blocked on agents'))).toBe(true);
    } finally {
      await admin.query(`DROP POLICY qvo_test_leak ON agents`);
    }
  });

  it('fails when qvo_app has BYPASSRLS', async () => {
    await admin.query(`ALTER ROLE qvo_app BYPASSRLS`);
    try {
      const failed = await failedTests();
      expect(failed.some((f) => f.includes('CONNECTED ROLE BYPASSES RLS'))).toBe(true);
    } finally {
      await admin.query(`ALTER ROLE qvo_app NOBYPASSRLS`);
    }
  });

  it('fails when qvo_app owns a table without FORCE ROW LEVEL SECURITY', async () => {
    const { rows } = await admin.query(`SELECT pg_get_userbyid(relowner) AS owner FROM pg_class WHERE relname = 'api_keys'`);
    const owner = rows[0].owner as string;
    await admin.query(`ALTER TABLE api_keys OWNER TO qvo_app`);
    await admin.query(`ALTER TABLE api_keys NO FORCE ROW LEVEL SECURITY`);
    try {
      const failed = await failedTests();
      expect(failed.some((f) => f.includes('CONNECTED ROLE OWNS api_keys'))).toBe(true);
      expect(failed.some((f) => f.startsWith('Cross-tenant read blocked on api_keys'))).toBe(true);
    } finally {
      await admin.query(`ALTER TABLE api_keys FORCE ROW LEVEL SECURITY`);
      await admin.query(`ALTER TABLE api_keys OWNER TO ${owner}`);
    }
  });

  it('fails when FORCE ROW LEVEL SECURITY is missing', async () => {
    await admin.query(`ALTER TABLE agents NO FORCE ROW LEVEL SECURITY`);
    try {
      const failed = await failedTests();
      expect(failed.some((f) => f.startsWith('FORCE RLS on agents'))).toBe(true);
    } finally {
      await admin.query(`ALTER TABLE agents FORCE ROW LEVEL SECURITY`);
    }
  });
});
