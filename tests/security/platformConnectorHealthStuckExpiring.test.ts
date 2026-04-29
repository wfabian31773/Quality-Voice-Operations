/**
 * End-to-end coverage for the `stuckOutboxEvents` / `stuckOutboxSummary`
 * and `expiringSoon` / `summary.expiringSoon` portions of
 * `GET /platform/connector-health`.
 *
 * Sibling to `tests/security/platformConnectorHealthGet.test.ts`, which
 * covers the `connectors`, `summary`, and `recentRefreshFailures` slices
 * but stubs `listConnectorTokenHealth` to avoid the envelope-encryption
 * setup. This file is deliberately the opposite shape: it does NOT mock
 * `listConnectorTokenHealth`, instead seeding real envelope-encrypted
 * `connector_configs` rows so the route exercises the same SQL +
 * decryption path that runs in production. That guards the "expiring
 * tokens" surface against:
 *   - schema drift in `connector_configs` / `encryption_keys`,
 *   - regressions in the per-tenant decrypt fan-out in
 *     `listConnectorTokenHealth`,
 *   - the `expiringWithinHours` query-param clamping (also covered by
 *     unit tests, but only mocked snapshots — there's no end-to-end
 *     guarantee that the clamped window actually filters real token
 *     timestamps).
 *
 * It also seeds real `outbox_events` rows in `failed` and `dead_letter`
 * across two tenants so the `stuckOutboxEvents` projection and the
 * `stuckOutboxSummary` aggregate query both run against the production
 * schema. The mocked unit suite covers the response shape; this guards
 * against schema renames / RLS tightening on `outbox_events`.
 *
 * Cleanup deletes every seeded row (encryption_keys, connector_configs,
 * outbox_events, integrations, audit_logs, user_roles, users, tenants)
 * to leave the platform DB pristine for other suites.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

const STAMP = Date.now();
const ADMIN_TENANT = randomUUID();
// Two tenants the platform admin should be able to see across in a
// single GET — one supplies a "stuck failed" outbox row + a token
// expiring inside the default 48h window, the other supplies a
// "dead_letter" outbox row + a token expiring 5 days out (only visible
// when the caller widens the expiringWithinHours window).
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const ADMIN_USER = {
  id: randomUUID(),
  email: `admin-${STAMP}@connector-health-stuck-exp.local`,
};
const NONADMIN_USER = {
  id: randomUUID(),
  email: `non-admin-${STAMP}@connector-health-stuck-exp.local`,
};

// Provider must be in `getRefreshableProviders()` for the token-health
// snapshot to consider it (hubspot is registered in the REFRESHERS map).
const PROVIDER = 'hubspot';
const INTEGRATION_A_ID = randomUUID();
const INTEGRATION_B_ID = randomUUID();

const OUTBOX_FAILED_KEY = `qvo-stuck-failed-${STAMP}`;
const OUTBOX_DEAD_KEY = `qvo-stuck-dead-${STAMP}`;

// Token expiry windows used by the seed. Must stay inside / outside the
// default 48h `expiringSoon` horizon to make the assertions deterministic.
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const FIVE_DAYS_MS = 5 * 24 * 60 * 60 * 1000;

let app: import('express').Express;
let issueToken: typeof import('../../server/admin-api/middleware/auth').issueToken;
let withPrivilegedClient: typeof import('../../platform/db').withPrivilegedClient;
let getPlatformPool: typeof import('../../platform/db').getPlatformPool;
let encryptSensitiveField: typeof import('../../platform/security/FieldEncryption').encryptSensitiveField;
let adminToken: string;
let nonAdminToken: string;
let tokenAExpiresAt: number;
let tokenBExpiresAt: number;

const GET_PATH = '/platform/connector-health';

async function seedFixtures() {
  // The token-tracking encryption needs to be done via the real helper
  // (which goes through `getOrCreateTenantDEK` to mint a per-tenant DEK
  // and persist it in `encryption_keys`). We capture the ciphertext
  // first so the privileged INSERT below doesn't cross a transaction
  // boundary with the DEK bootstrap.
  const now = Date.now();
  tokenAExpiresAt = now + SIX_HOURS_MS;
  tokenBExpiresAt = now + FIVE_DAYS_MS;
  const tokenAIssuedAt = now - 30 * 60 * 1000;
  const tokenBIssuedAt = now - 60 * 60 * 1000;

  await withPrivilegedClient(async (client) => {
    // Three tenants total — the admin's own tenant (so requireAuth's
    // tenant-status gate passes) plus the two whose connectors we want
    // to see in a single cross-tenant response.
    for (const [tenantId, label] of [
      [ADMIN_TENANT, 'admin'],
      [TENANT_A, 'a'],
      [TENANT_B, 'b'],
    ] as const) {
      await client.query(
        `INSERT INTO tenants (id, name, slug, status)
         VALUES ($1, $2, $3, 'active')
         ON CONFLICT (id) DO NOTHING`,
        [
          tenantId,
          `ConnectorHealthStuckExp ${label}`,
          `connector-health-stuck-exp-${label}-${STAMP}`,
        ],
      );
    }

    await client.query(
      `INSERT INTO users (id, tenant_id, email, role, is_active, email_verified, is_platform_admin)
       VALUES ($1, $2, $3, 'tenant_owner', true, true, true)
       ON CONFLICT (id) DO NOTHING`,
      [ADMIN_USER.id, ADMIN_TENANT, ADMIN_USER.email],
    );
    await client.query(
      `INSERT INTO user_roles (user_id, tenant_id, role)
       VALUES ($1, $2, 'tenant_owner')
       ON CONFLICT (user_id, tenant_id, role) DO NOTHING`,
      [ADMIN_USER.id, ADMIN_TENANT],
    );

    await client.query(
      `INSERT INTO users (id, tenant_id, email, role, is_active, email_verified, is_platform_admin)
       VALUES ($1, $2, $3, 'tenant_owner', true, true, false)
       ON CONFLICT (id) DO NOTHING`,
      [NONADMIN_USER.id, ADMIN_TENANT, NONADMIN_USER.email],
    );
    await client.query(
      `INSERT INTO user_roles (user_id, tenant_id, role)
       VALUES ($1, $2, 'tenant_owner')
       ON CONFLICT (user_id, tenant_id, role) DO NOTHING`,
      [NONADMIN_USER.id, ADMIN_TENANT],
    );

    // Both tenants get a HEALTHY ('success') hubspot integration. Healthy
    // status is required for the row to qualify for the proactive
    // `expiringSoon` bucket — the route deliberately excludes
    // needs_reconnect / error rows from that surface (they have their
    // own dedicated table).
    await client.query(
      `INSERT INTO integrations (
         id, tenant_id, name, integration_type, provider, is_enabled, config,
         last_sync_status, last_sync_at
       ) VALUES (
         $1, $2, 'HubSpot Soon', 'crm', $3, true, '{}'::jsonb,
         'success', NOW()
       )
       ON CONFLICT (id) DO NOTHING`,
      [INTEGRATION_A_ID, TENANT_A, PROVIDER],
    );
    await client.query(
      `INSERT INTO integrations (
         id, tenant_id, name, integration_type, provider, is_enabled, config,
         last_sync_status, last_sync_at
       ) VALUES (
         $1, $2, 'HubSpot Later', 'crm', $3, true, '{}'::jsonb,
         'success', NOW()
       )
       ON CONFLICT (id) DO NOTHING`,
      [INTEGRATION_B_ID, TENANT_B, PROVIDER],
    );

    // Stuck outbox events: tenant A in `failed` (worker still has more
    // attempts left, future next_attempt_at), tenant B in `dead_letter`
    // (max_attempts reached, no further retries).
    await client.query(
      `INSERT INTO outbox_events (
         tenant_id, idempotency_key, event_type, integration_id, payload,
         status, attempts, max_attempts, last_error, next_attempt_at
       ) VALUES (
         $1, $2, 'lead.created', $3, '{"contact":"+15551110001"}'::jsonb,
         'failed', 2, 5, 'transient connection reset', NOW() + INTERVAL '15 minutes'
       )`,
      [TENANT_A, OUTBOX_FAILED_KEY, INTEGRATION_A_ID],
    );
    await client.query(
      `INSERT INTO outbox_events (
         tenant_id, idempotency_key, event_type, integration_id, payload,
         status, attempts, max_attempts, last_error, next_attempt_at
       ) VALUES (
         $1, $2, 'call.completed', $3, '{"callId":"abc"}'::jsonb,
         'dead_letter', 5, 5, 'remote 502 — gateway timeout', NULL
       )`,
      [TENANT_B, OUTBOX_DEAD_KEY, INTEGRATION_B_ID],
    );
  });

  // Encrypt the tracking fields with the real envelope helper. Each call
  // bootstraps the per-tenant DEK in `encryption_keys` if it doesn't yet
  // exist — exactly the same path the OAuth refresh flow uses when it
  // first writes a token. We persist the ciphertext via the privileged
  // client in a separate transaction below so the route's per-tenant
  // decrypt fan-out exercises the full envelope path end-to-end.
  const tokenAExpiresCipher = await encryptSensitiveField(
    TENANT_A,
    String(tokenAExpiresAt),
  );
  const tokenAIssuedCipher = await encryptSensitiveField(
    TENANT_A,
    String(tokenAIssuedAt),
  );
  const tokenBExpiresCipher = await encryptSensitiveField(
    TENANT_B,
    String(tokenBExpiresAt),
  );
  const tokenBIssuedCipher = await encryptSensitiveField(
    TENANT_B,
    String(tokenBIssuedAt),
  );

  await withPrivilegedClient(async (client) => {
    await client.query(
      `INSERT INTO connector_configs (tenant_id, integration_id, config_key, encrypted_value)
       VALUES
         ($1, $2, 'token_expires_at', $3),
         ($1, $2, 'token_issued_at',  $4)
       ON CONFLICT (integration_id, config_key)
       DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value, updated_at = NOW()`,
      [TENANT_A, INTEGRATION_A_ID, tokenAExpiresCipher, tokenAIssuedCipher],
    );
    await client.query(
      `INSERT INTO connector_configs (tenant_id, integration_id, config_key, encrypted_value)
       VALUES
         ($1, $2, 'token_expires_at', $3),
         ($1, $2, 'token_issued_at',  $4)
       ON CONFLICT (integration_id, config_key)
       DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value, updated_at = NOW()`,
      [TENANT_B, INTEGRATION_B_ID, tokenBExpiresCipher, tokenBIssuedCipher],
    );
  });
}

async function cleanup() {
  await withPrivilegedClient(async (client) => {
    // Disable triggers in this transaction so audit_logs DELETEs don't
    // trip the immutable audit_logs guard (mirrors the cleanup pattern
    // used by the sibling GET e2e suite). The cascade from
    // `tenants -> audit_logs` would otherwise abort the DELETE.
    await client.query(`SET LOCAL session_replication_role = replica`);
    for (const tenantId of [TENANT_A, TENANT_B, ADMIN_TENANT]) {
      await client.query(
        `DELETE FROM outbox_events WHERE tenant_id = $1`,
        [tenantId],
      );
      await client.query(
        `DELETE FROM connector_configs WHERE tenant_id = $1`,
        [tenantId],
      );
      await client.query(
        `DELETE FROM audit_logs WHERE tenant_id = $1`,
        [tenantId],
      );
      await client.query(
        `DELETE FROM encryption_keys WHERE tenant_id = $1`,
        [tenantId],
      );
      await client.query(`DELETE FROM integrations WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM user_roles WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM users WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    }
  });
}

describe('GET /platform/connector-health stuck outbox + expiring tokens (end-to-end)', () => {
  beforeAll(async () => {
    process.env.ADMIN_JWT_SECRET =
      process.env.ADMIN_JWT_SECRET ?? 'qvo-connector-health-stuck-exp-secret';

    const dbMod = await import('../../platform/db');
    withPrivilegedClient = dbMod.withPrivilegedClient;
    getPlatformPool = dbMod.getPlatformPool;

    const fieldEnc = await import('../../platform/security/FieldEncryption');
    encryptSensitiveField = fieldEnc.encryptSensitiveField;

    const auth = await import('../../server/admin-api/middleware/auth');
    issueToken = auth.issueToken;

    app = (await import('../../server/admin-api/app')).default;

    await seedFixtures();

    adminToken = issueToken({
      userId: ADMIN_USER.id,
      tenantId: ADMIN_TENANT,
      email: ADMIN_USER.email,
      role: 'tenant_owner',
      isPlatformAdmin: true,
    });
    nonAdminToken = issueToken({
      userId: NONADMIN_USER.id,
      tenantId: ADMIN_TENANT,
      email: NONADMIN_USER.email,
      role: 'tenant_owner',
      isPlatformAdmin: false,
    });
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    const pool = getPlatformPool();
    if (typeof (pool as { end?: () => Promise<void> }).end === 'function') {
      await (pool as { end: () => Promise<void> }).end().catch(() => {});
    }
  });

  it('returns 401 when no Authorization header is provided', async () => {
    const res = await request(app).get(GET_PATH);
    expect(res.status).toBe(401);
  });

  it('returns 403 when the caller is authenticated but not a platform admin', async () => {
    const res = await request(app)
      .get(GET_PATH)
      .set('Authorization', `Bearer ${nonAdminToken}`);
    expect(
      res.status,
      `expected 403, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`,
    ).toBe(403);
  });

  it('projects real outbox_events rows into stuckOutboxEvents + stuckOutboxSummary', async () => {
    const res = await request(app)
      .get(GET_PATH)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(
      res.status,
      `expected 200, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`,
    ).toBe(200);

    expect(Array.isArray(res.body.stuckOutboxEvents)).toBe(true);
    const stuck = res.body.stuckOutboxEvents as Array<Record<string, unknown>>;

    const failed = stuck.find(
      (r) => r.tenantId === TENANT_A && r.eventType === 'lead.created',
    );
    expect(
      failed,
      'failed outbox row for tenant A must surface in stuckOutboxEvents',
    ).toBeDefined();
    expect(failed!.status).toBe('failed');
    expect(failed!.attempts).toBe(2);
    expect(failed!.maxAttempts).toBe(5);
    expect(failed!.integrationId).toBe(INTEGRATION_A_ID);
    expect(failed!.integrationProvider).toBe(PROVIDER);
    expect(failed!.integrationName).toBe('HubSpot Soon');
    expect(failed!.integrationType).toBe('crm');
    expect(failed!.tenantName).toBe('ConnectorHealthStuckExp a');
    expect(failed!.tenantSlug).toBe(`connector-health-stuck-exp-a-${STAMP}`);
    expect(failed!.lastError).toBe('transient connection reset');
    expect(typeof failed!.nextAttemptAt).toBe('string');
    expect(Number.isNaN(Date.parse(failed!.nextAttemptAt as string))).toBe(false);

    const dead = stuck.find(
      (r) => r.tenantId === TENANT_B && r.eventType === 'call.completed',
    );
    expect(
      dead,
      'dead_letter outbox row for tenant B must surface in stuckOutboxEvents',
    ).toBeDefined();
    expect(dead!.status).toBe('dead_letter');
    expect(dead!.attempts).toBe(5);
    expect(dead!.maxAttempts).toBe(5);
    expect(dead!.nextAttemptAt).toBeNull();
    expect(dead!.tenantSlug).toBe(`connector-health-stuck-exp-b-${STAMP}`);
    expect(dead!.lastError).toBe('remote 502 — gateway timeout');
    // The route orders dead_letter rows ahead of failed ones so the
    // most-broken work bubbles to the top of the table — verify the
    // dead_letter row appears before the failed row in the response.
    const deadIdx = stuck.findIndex((r) => r === dead);
    const failedIdx = stuck.findIndex((r) => r === failed);
    expect(deadIdx).toBeGreaterThanOrEqual(0);
    expect(failedIdx).toBeGreaterThanOrEqual(0);
    expect(deadIdx).toBeLessThan(failedIdx);

    // Summary aggregates across the whole platform DB, so other suites
    // running in parallel may bump these counters higher. Lower-bound
    // assertions prove our two seeded rows contributed without coupling
    // to unrelated test fixtures.
    const summary = res.body.stuckOutboxSummary as Record<string, number>;
    expect(typeof summary.failed).toBe('number');
    expect(typeof summary.deadLetter).toBe('number');
    expect(typeof summary.affectedTenants).toBe('number');
    expect(summary.failed).toBeGreaterThanOrEqual(1);
    expect(summary.deadLetter).toBeGreaterThanOrEqual(1);
    expect(summary.affectedTenants).toBeGreaterThanOrEqual(2);

    expect(res.body.stuckOutboxLimit).toBe(100);
    expect(res.body.window.stuckOutboxLimit).toBe(100);
  });

  it('surfaces real expiring tokens via the unmocked listConnectorTokenHealth path', async () => {
    const res = await request(app)
      .get(GET_PATH)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.status).toBe(200);

    // Default window is 48h. Tenant A's token expires in 6h → must
    // appear in expiringSoon. Tenant B's token expires in 5d → must NOT.
    expect(Array.isArray(res.body.expiringSoon)).toBe(true);
    expect(res.body.expiringSoonWithinHours).toBe(48);
    expect(res.body.expiringSoonWindowMs).toBe(48 * 60 * 60 * 1000);
    expect(res.body.window.expiringWithinHours).toBe(48);

    const expiring = res.body.expiringSoon as Array<Record<string, unknown>>;
    const tenantAExpiring = expiring.find(
      (r) => r.tenantId === TENANT_A && r.integrationId === INTEGRATION_A_ID,
    );
    expect(
      tenantAExpiring,
      'tenant A token expiring in 6h must appear in expiringSoon under default window',
    ).toBeDefined();
    expect(tenantAExpiring!.provider).toBe(PROVIDER);
    expect(tenantAExpiring!.tenantName).toBe('ConnectorHealthStuckExp a');
    expect(tenantAExpiring!.tenantSlug).toBe(`connector-health-stuck-exp-a-${STAMP}`);
    expect(tenantAExpiring!.lastSyncStatus).toBe('success');
    expect(typeof tenantAExpiring!.expiresInMs).toBe('number');
    expect(tenantAExpiring!.expiresInMs as number).toBeGreaterThan(0);
    expect(tenantAExpiring!.expiresInMs as number).toBeLessThanOrEqual(SIX_HOURS_MS);
    // Round-tripped token timestamps must come back as ISO-8601 strings
    // matching the seeded epoch values (proves envelope decryption +
    // numeric parsing actually ran end-to-end).
    expect(tenantAExpiring!.tokenExpiresAt).toBe(
      new Date(tokenAExpiresAt).toISOString(),
    );
    expect(typeof tenantAExpiring!.tokenIssuedAt).toBe('string');

    const tenantBExpiring = expiring.find(
      (r) => r.tenantId === TENANT_B && r.integrationId === INTEGRATION_B_ID,
    );
    expect(
      tenantBExpiring,
      'tenant B token expires in 5d and must NOT appear in expiringSoon under the 48h default window',
    ).toBeUndefined();

    // summary.expiringSoon is global across the platform DB, so other
    // suites' fixtures may push it higher — we just need it to count at
    // least our own seeded row.
    expect(typeof res.body.summary.expiringSoon).toBe('number');
    expect(res.body.summary.expiringSoon).toBeGreaterThanOrEqual(1);
  });

  it('honours the expiringWithinHours query param and clamps out-of-range values', async () => {
    // Narrow window (12h): tenant A (6h) qualifies, tenant B (5d) does not.
    const narrow = await request(app)
      .get(`${GET_PATH}?expiringWithinHours=12`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(narrow.status).toBe(200);
    expect(narrow.body.expiringSoonWithinHours).toBe(12);
    expect(narrow.body.expiringSoonWindowMs).toBe(12 * 60 * 60 * 1000);
    const narrowIds = (
      narrow.body.expiringSoon as Array<Record<string, unknown>>
    ).map((r) => r.integrationId);
    expect(narrowIds).toContain(INTEGRATION_A_ID);
    expect(narrowIds).not.toContain(INTEGRATION_B_ID);

    // Wide window (168h = 7d): both tenants qualify, sorted by soonest
    // expiry first (route does an explicit `.sort((a,b) => a.expiresInMs
    // - b.expiresInMs)` so tenant A — 6h — must come before tenant B — 5d).
    const wide = await request(app)
      .get(`${GET_PATH}?expiringWithinHours=168`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(wide.status).toBe(200);
    expect(wide.body.expiringSoonWithinHours).toBe(168);
    const wideRows = wide.body.expiringSoon as Array<Record<string, unknown>>;
    const tenantAIdx = wideRows.findIndex((r) => r.integrationId === INTEGRATION_A_ID);
    const tenantBIdx = wideRows.findIndex((r) => r.integrationId === INTEGRATION_B_ID);
    expect(
      tenantAIdx,
      'tenant A row must appear in the 168h window',
    ).toBeGreaterThanOrEqual(0);
    expect(
      tenantBIdx,
      'tenant B row must appear in the 168h window',
    ).toBeGreaterThanOrEqual(0);
    expect(
      tenantAIdx,
      'tenant A (6h) must come before tenant B (5d) in expiringSoon',
    ).toBeLessThan(tenantBIdx);

    // Out-of-range values clamp to the [1h, 168h] bounds. Garbage falls
    // back to the 48h default. These assertions exist in the mocked unit
    // suite too — repeating them here proves the live route + handler
    // wiring still applies the clamp end-to-end.
    const tooBig = await request(app)
      .get(`${GET_PATH}?expiringWithinHours=99999`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(tooBig.status).toBe(200);
    expect(tooBig.body.expiringSoonWithinHours).toBe(168);

    const tooSmall = await request(app)
      .get(`${GET_PATH}?expiringWithinHours=0`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(tooSmall.status).toBe(200);
    expect(tooSmall.body.expiringSoonWithinHours).toBe(1);

    const garbage = await request(app)
      .get(`${GET_PATH}?expiringWithinHours=abc`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(garbage.status).toBe(200);
    expect(garbage.body.expiringSoonWithinHours).toBe(48);
  });
});
