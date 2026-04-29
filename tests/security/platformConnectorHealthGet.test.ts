/**
 * End-to-end coverage for the cross-tenant connector health PAGE endpoint
 * (`GET /platform/connector-health`).
 *
 * The unit suite at `tests/integrations/platformConnectorHealthActions.test.ts`
 * exercises the GET handler with every dependency mocked, which catches
 * shape regressions but cannot detect:
 *   - schema drift in the JOIN onto `tenants` or column renames on
 *     `integrations` (the route hand-writes SQL),
 *   - regressions in `requireAuth` / `requirePlatformAdmin` middleware,
 *   - the `connector.token_refresh_failed` -> `recentRefreshFailures`
 *     translation (the route reads `a.changes->>'provider'` /
 *     `a.changes->>'error'`).
 *
 * This file complements it by driving the real Express app, the real auth
 * middleware, the real RBAC check, and real rows written to the platform
 * DB across two tenants. The token-health snapshot helper
 * (`listConnectorTokenHealth`) is stubbed because it fans out per-tenant
 * decryption work that depends on a full envelope-encryption setup — the
 * route's contract for that field already has dedicated unit coverage.
 *
 * Cleanup deletes every seeded row (integrations, audit logs, user_roles,
 * users, tenants) to leave the platform DB pristine for other tests.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

// Stub only the cross-tenant token-health fan-out. The route gracefully
// degrades when this throws, so returning [] keeps the response shape
// intact while letting the real SQL for connectors / summary /
// recentRefreshFailures run end-to-end.
const listConnectorTokenHealthMock = vi.fn<(providers: string[]) => Promise<unknown[]>>();

vi.mock('../../platform/integrations/connectors', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    listConnectorTokenHealth: (providers: string[]) =>
      listConnectorTokenHealthMock(providers),
  };
});

const STAMP = Date.now();
const ADMIN_TENANT = randomUUID();
// Two tenants the platform admin should be able to see across in a single
// GET — that's the whole point of the cross-tenant view.
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const ADMIN_USER = { id: randomUUID(), email: `admin-${STAMP}@connector-health-get-e2e.local` };
const NONADMIN_USER = { id: randomUUID(), email: `non-admin-${STAMP}@connector-health-get-e2e.local` };
const HEALTHY_INTEGRATION_ID = randomUUID();
const UNHEALTHY_INTEGRATION_ID = randomUUID();

let app: import('express').Express;
let issueToken: typeof import('../../server/admin-api/middleware/auth').issueToken;
let withPrivilegedClient: typeof import('../../platform/db').withPrivilegedClient;
let getPlatformPool: typeof import('../../platform/db').getPlatformPool;
let adminToken: string;
let nonAdminToken: string;

const GET_PATH = '/platform/connector-health';

async function seedFixtures() {
  await withPrivilegedClient(async (client) => {
    // Three tenants total — the admin's own tenant (so requireAuth's
    // tenant-status gate passes) plus the two whose connectors we want to
    // see in a single cross-tenant response.
    for (const [tenantId, label] of [
      [ADMIN_TENANT, 'admin'],
      [TENANT_A, 'a'],
      [TENANT_B, 'b'],
    ] as const) {
      await client.query(
        `INSERT INTO tenants (id, name, slug, status)
         VALUES ($1, $2, $3, 'active')
         ON CONFLICT (id) DO NOTHING`,
        [tenantId, `ConnectorHealthGetE2E ${label}`, `connector-health-get-e2e-${label}-${STAMP}`],
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

    // Tenant A: a HEALTHY integration. It should NOT show up in the
    // `connectors` array (that array only contains needs_reconnect/error)
    // but it MUST be counted in `summary.healthy` and contribute to the
    // total enabled count, proving the summary aggregates across tenants.
    await client.query(
      `INSERT INTO integrations (
         id, tenant_id, name, integration_type, provider, is_enabled, config,
         last_sync_status, last_sync_at
       ) VALUES (
         $1, $2, 'HubSpot Healthy', 'crm', 'hubspot', true, '{}'::jsonb,
         'success', NOW()
       )
       ON CONFLICT (id) DO NOTHING`,
      [HEALTHY_INTEGRATION_ID, TENANT_A],
    );

    // Tenant B: an UNHEALTHY integration in needs_reconnect. It MUST
    // appear in `connectors` and contribute to summary.needsReconnect /
    // summary.affectedTenants.
    await client.query(
      `INSERT INTO integrations (
         id, tenant_id, name, integration_type, provider, is_enabled, config,
         last_sync_status, last_sync_error, last_sync_error_at
       ) VALUES (
         $1, $2, 'HubSpot Wedged', 'crm', 'hubspot', true, '{}'::jsonb,
         'needs_reconnect', 'invalid_grant', NOW()
       )
       ON CONFLICT (id) DO NOTHING`,
      [UNHEALTHY_INTEGRATION_ID, TENANT_B],
    );

    // Recent token-refresh failure for tenant B's integration. The route
    // surfaces this in `recentRefreshFailures` after parsing the JSONB
    // `changes` column for `provider` / `error` fields.
    await client.query(
      `INSERT INTO audit_logs (
         tenant_id, actor_user_id, actor_role, action,
         resource_type, resource_id, changes, severity
       ) VALUES (
         $1, NULL, 'system', 'connector.token_refresh_failed',
         'connector', $2,
         $3::jsonb, 'warning'
       )`,
      [
        TENANT_B,
        UNHEALTHY_INTEGRATION_ID,
        JSON.stringify({ provider: 'hubspot', error: 'invalid_grant' }),
      ],
    );
  });
}

async function cleanup() {
  await withPrivilegedClient(async (client) => {
    // Disable triggers in this transaction so audit_logs DELETEs don't
    // trip the immutable audit_logs guard (mirrors the cleanup pattern
    // used by the POST quick-action e2e suite).
    await client.query(`SET LOCAL session_replication_role = replica`);
    for (const tenantId of [TENANT_A, TENANT_B, ADMIN_TENANT]) {
      await client.query(
        `DELETE FROM audit_logs WHERE tenant_id = $1`,
        [tenantId],
      );
      await client.query(`DELETE FROM connector_configs WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM integrations WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM user_roles WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM users WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    }
  });
}

describe('GET /platform/connector-health (end-to-end)', () => {
  beforeAll(async () => {
    process.env.ADMIN_JWT_SECRET =
      process.env.ADMIN_JWT_SECRET ?? 'qvo-connector-health-get-e2e-secret';

    const dbMod = await import('../../platform/db');
    withPrivilegedClient = dbMod.withPrivilegedClient;
    getPlatformPool = dbMod.getPlatformPool;

    const auth = await import('../../server/admin-api/middleware/auth');
    issueToken = auth.issueToken;

    app = (await import('../../server/admin-api/app')).default;

    listConnectorTokenHealthMock.mockResolvedValue([]);

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
    expect(res.body.error).toMatch(/Platform admin/);
  });

  it('returns a cross-tenant snapshot when the caller is a platform admin', async () => {
    const res = await request(app)
      .get(GET_PATH)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(
      res.status,
      `expected 200, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`,
    ).toBe(200);

    // ----- connectors[] (only attention statuses, not healthy ones) -----
    expect(Array.isArray(res.body.connectors)).toBe(true);
    const connectorsById = new Map<string, Record<string, unknown>>(
      (res.body.connectors as Array<Record<string, unknown>>).map((c) => [
        c.integrationId as string,
        c,
      ]),
    );

    const wedged = connectorsById.get(UNHEALTHY_INTEGRATION_ID);
    expect(wedged, 'needs_reconnect integration must appear in connectors[]').toBeDefined();
    expect(wedged!.tenantId).toBe(TENANT_B);
    expect(wedged!.tenantName).toBe(`ConnectorHealthGetE2E b`);
    expect(wedged!.tenantSlug).toBe(`connector-health-get-e2e-b-${STAMP}`);
    expect(wedged!.provider).toBe('hubspot');
    expect(wedged!.connectorType).toBe('crm');
    expect(wedged!.lastSyncStatus).toBe('needs_reconnect');
    expect(wedged!.lastSyncError).toBe('invalid_grant');
    // hubspot is in the refreshable provider list, so the route must
    // mark this row as actionable from the UI.
    expect(wedged!.refreshable).toBe(true);

    // The healthy integration belongs in summary, NOT in connectors[].
    expect(
      connectorsById.has(HEALTHY_INTEGRATION_ID),
      'healthy integration must NOT appear in connectors[]',
    ).toBe(false);

    // ----- summary aggregates across BOTH tenants -----
    const summary = res.body.summary as Record<string, number>;
    expect(typeof summary.needsReconnect).toBe('number');
    expect(typeof summary.healthy).toBe('number');
    expect(typeof summary.totalEnabled).toBe('number');
    expect(typeof summary.affectedTenants).toBe('number');
    // Counters are global across the platform DB, so they may include
    // rows from other suites/seeds running in parallel. Assert lower
    // bounds that prove our two tenants contributed.
    expect(summary.needsReconnect).toBeGreaterThanOrEqual(1);
    expect(summary.healthy).toBeGreaterThanOrEqual(1);
    // We seeded two enabled integrations, so total must be >= 2.
    expect(summary.totalEnabled).toBeGreaterThanOrEqual(2);
    // Tenant B contributes one affected tenant (needs_reconnect).
    expect(summary.affectedTenants).toBeGreaterThanOrEqual(1);

    // ----- recentRefreshFailures contains the seeded audit row -----
    expect(Array.isArray(res.body.recentRefreshFailures)).toBe(true);
    const failure = (
      res.body.recentRefreshFailures as Array<Record<string, unknown>>
    ).find(
      (r) =>
        r.tenantId === TENANT_B && r.integrationId === UNHEALTHY_INTEGRATION_ID,
    );
    expect(
      failure,
      'recentRefreshFailures must include the seeded connector.token_refresh_failed audit row',
    ).toBeDefined();
    expect(failure!.tenantName).toBe(`ConnectorHealthGetE2E b`);
    expect(failure!.tenantSlug).toBe(`connector-health-get-e2e-b-${STAMP}`);
    expect(failure!.provider).toBe('hubspot');
    expect(failure!.errorMessage).toBe('invalid_grant');
    expect(typeof failure!.occurredAt).toBe('string');
    // Sanity: occurredAt should parse as an ISO-8601 timestamp.
    expect(Number.isNaN(Date.parse(failure!.occurredAt as string))).toBe(false);

    // The token-health fan-out is stubbed, but the route should still
    // expose the cycle / horizon constants used by the UI badge logic.
    expect(typeof res.body.tokenHealthRefreshIntervalMs).toBe('number');
    expect(typeof res.body.tokenHealthExpiringHorizonMs).toBe('number');
  });
});
