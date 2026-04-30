/**
 * End-to-end coverage for the platform admin's per-tenant connectors view
 * (`GET /platform/tenants/:tenantId/connectors`).
 *
 * The unit suite at `tests/integrations/platformConnectorHealthActions.test.ts`
 * exercises the GET handler with every dependency mocked, which catches
 * shape regressions but cannot detect:
 *   - regressions in `requireAuth` / `requirePlatformAdmin` middleware,
 *   - the inline UUID validator on the `:tenantId` path param,
 *   - the tenant-not-found 404 branch (real `tenants` lookup),
 *   - the `listConnectorConfigs` SQL contract (real JOIN onto
 *     `connector_configs`),
 *   - the `platform_admin.tenant_connectors_viewed` audit-log write
 *     actually landing in `audit_logs` with the expected actor metadata.
 *
 * This file complements it by driving the real Express app, the real auth
 * middleware, the real RBAC check, and real rows written to the platform
 * DB. Nothing is mocked — `listConnectorConfigs` is exercised against the
 * seeded `integrations` rows directly.
 *
 * Cleanup deletes every seeded row (integrations, audit logs, user_roles,
 * users, tenants) to leave the platform DB pristine for other tests, and
 * mirrors the pattern in `tests/security/platformConnectorHealthGet.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

const STAMP = Date.now();
const ADMIN_TENANT = randomUUID();
const TARGET_TENANT = randomUUID();
const UNKNOWN_TENANT = randomUUID();
const ADMIN_USER = { id: randomUUID(), email: `admin-${STAMP}@tenant-connectors-get-e2e.local` };
const NONADMIN_USER = { id: randomUUID(), email: `non-admin-${STAMP}@tenant-connectors-get-e2e.local` };
const INTEGRATION_HEALTHY_ID = randomUUID();
const INTEGRATION_WEDGED_ID = randomUUID();

let app: import('express').Express;
let issueToken: typeof import('../../server/admin-api/middleware/auth').issueToken;
let withPrivilegedClient: typeof import('../../platform/db').withPrivilegedClient;
let getPlatformPool: typeof import('../../platform/db').getPlatformPool;
let adminToken: string;
let nonAdminToken: string;

const pathFor = (tenantId: string) => `/platform/tenants/${tenantId}/connectors`;

async function seedFixtures() {
  await withPrivilegedClient(async (client) => {
    // Two tenants: one houses the platform-admin / non-admin users (so
    // requireAuth's tenant-status gate passes), the other owns the
    // integrations that we expect to see in the response.
    for (const [tenantId, label] of [
      [ADMIN_TENANT, 'admin'],
      [TARGET_TENANT, 'target'],
    ] as const) {
      await client.query(
        `INSERT INTO tenants (id, name, slug, status)
         VALUES ($1, $2, $3, 'active')
         ON CONFLICT (id) DO NOTHING`,
        [tenantId, `TenantConnectorsGetE2E ${label}`, `tenant-connectors-get-e2e-${label}-${STAMP}`],
      );
    }

    // Platform-admin user (real is_platform_admin=true so requireAuth's
    // privileged lookup returns true).
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

    // Non-platform-admin user, used to assert RBAC denial.
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

    // Two integrations on the target tenant — one healthy, one wedged.
    // listConnectorConfigs() returns BOTH (the per-tenant view does not
    // filter on status), so we can assert the response contains both
    // rows by integrationId. They must use distinct providers because of
    // the (tenant_id, provider) unique constraint on `integrations`.
    await client.query(
      `INSERT INTO integrations (
         id, tenant_id, name, integration_type, provider, is_enabled, config,
         last_sync_status, last_sync_at
       ) VALUES (
         $1, $2, 'HubSpot Healthy', 'crm', 'hubspot', true, '{}'::jsonb,
         'success', NOW()
       )
       ON CONFLICT (id) DO NOTHING`,
      [INTEGRATION_HEALTHY_ID, TARGET_TENANT],
    );
    await client.query(
      `INSERT INTO integrations (
         id, tenant_id, name, integration_type, provider, is_enabled, config,
         last_sync_status, last_sync_error, last_sync_error_at
       ) VALUES (
         $1, $2, 'Salesforce Wedged', 'crm', 'salesforce', true, '{}'::jsonb,
         'needs_reconnect', 'invalid_grant', NOW()
       )
       ON CONFLICT (id) DO NOTHING`,
      [INTEGRATION_WEDGED_ID, TARGET_TENANT],
    );
  });
}

async function cleanup() {
  await withPrivilegedClient(async (client) => {
    // Disable triggers in this transaction so audit_logs DELETEs don't
    // trip the immutable audit_logs guard (mirrors the cleanup pattern
    // used by the GET cross-tenant e2e suite).
    await client.query(`SET LOCAL session_replication_role = replica`);
    for (const tenantId of [TARGET_TENANT, ADMIN_TENANT]) {
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

async function fetchTenantViewedAuditRows(tenantId: string): Promise<Array<Record<string, unknown>>> {
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, changes, severity
         FROM audit_logs
        WHERE tenant_id = $1
          AND action = 'platform_admin.tenant_connectors_viewed'
        ORDER BY occurred_at DESC`,
      [tenantId],
    );
    return rows as Array<Record<string, unknown>>;
  });
}

describe('GET /platform/tenants/:tenantId/connectors (end-to-end)', () => {
  beforeAll(async () => {
    process.env.ADMIN_JWT_SECRET =
      process.env.ADMIN_JWT_SECRET ?? 'qvo-tenant-connectors-get-e2e-secret';

    const dbMod = await import('../../platform/db');
    withPrivilegedClient = dbMod.withPrivilegedClient;
    getPlatformPool = dbMod.getPlatformPool;

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
    const before = await fetchTenantViewedAuditRows(TARGET_TENANT);
    const res = await request(app).get(pathFor(TARGET_TENANT));
    expect(res.status).toBe(401);
    // The handler must not run, so no audit row should be added.
    const after = await fetchTenantViewedAuditRows(TARGET_TENANT);
    expect(after.length).toBe(before.length);
  });

  it('returns 403 when the caller is authenticated but not a platform admin', async () => {
    const before = await fetchTenantViewedAuditRows(TARGET_TENANT);
    const res = await request(app)
      .get(pathFor(TARGET_TENANT))
      .set('Authorization', `Bearer ${nonAdminToken}`);
    expect(
      res.status,
      `expected 403, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`,
    ).toBe(403);
    expect(res.body.error).toMatch(/Platform admin/);
    const after = await fetchTenantViewedAuditRows(TARGET_TENANT);
    expect(after.length).toBe(before.length);
  });

  it('returns 400 when the :tenantId path param is not a valid UUID', async () => {
    const res = await request(app)
      .get('/platform/tenants/not-a-uuid/connectors')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(
      res.status,
      `expected 400, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`,
    ).toBe(400);
    expect(res.body.error).toMatch(/Invalid tenantId/);
  });

  it('returns 404 when the tenant UUID does not match any tenants row', async () => {
    const res = await request(app)
      .get(pathFor(UNKNOWN_TENANT))
      .set('Authorization', `Bearer ${adminToken}`);
    expect(
      res.status,
      `expected 404, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`,
    ).toBe(404);
    expect(res.body.error).toMatch(/Tenant not found/);
    // 404 short-circuits before the audit write — no audit row for the
    // unknown tenant should exist.
    const audits = await fetchTenantViewedAuditRows(UNKNOWN_TENANT);
    expect(audits.length).toBe(0);
  });

  it('returns 200 with the seeded connectors and writes an audit_logs row when the caller is a platform admin', async () => {
    const before = await fetchTenantViewedAuditRows(TARGET_TENANT);

    const res = await request(app)
      .get(`${pathFor(TARGET_TENANT)}?integration=${INTEGRATION_WEDGED_ID}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(
      res.status,
      `expected 200, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`,
    ).toBe(200);

    // ----- tenant block reflects the seeded tenants row -----
    expect(res.body.tenant).toBeDefined();
    expect(res.body.tenant.id).toBe(TARGET_TENANT);
    expect(res.body.tenant.name).toBe('TenantConnectorsGetE2E target');
    expect(res.body.tenant.slug).toBe(`tenant-connectors-get-e2e-target-${STAMP}`);
    expect(res.body.tenant.status).toBe('active');

    // ----- connectors[] contains BOTH seeded integrations -----
    expect(Array.isArray(res.body.connectors)).toBe(true);
    const connectorsById = new Map<string, Record<string, unknown>>(
      (res.body.connectors as Array<Record<string, unknown>>).map((c) => [
        c.integrationId as string,
        c,
      ]),
    );

    const healthy = connectorsById.get(INTEGRATION_HEALTHY_ID);
    expect(healthy, 'healthy integration must appear in connectors[]').toBeDefined();
    expect(healthy!.provider).toBe('hubspot');
    expect(healthy!.connectorType).toBe('crm');
    expect(healthy!.name).toBe('HubSpot Healthy');
    expect(healthy!.isEnabled).toBe(true);
    expect(healthy!.lastSyncStatus).toBe('success');
    expect(healthy!.lastSyncError).toBeNull();

    const wedged = connectorsById.get(INTEGRATION_WEDGED_ID);
    expect(wedged, 'wedged integration must appear in connectors[]').toBeDefined();
    expect(wedged!.provider).toBe('salesforce');
    expect(wedged!.connectorType).toBe('crm');
    expect(wedged!.name).toBe('Salesforce Wedged');
    expect(wedged!.isEnabled).toBe(true);
    expect(wedged!.lastSyncStatus).toBe('needs_reconnect');
    expect(wedged!.lastSyncError).toBe('invalid_grant');

    // ----- audit_logs row was written -----
    const after = await fetchTenantViewedAuditRows(TARGET_TENANT);
    expect(
      after.length,
      'audit_logs should have one new platform_admin.tenant_connectors_viewed row',
    ).toBe(before.length + 1);

    const audit = after[0];
    expect(audit.tenant_id).toBe(TARGET_TENANT);
    expect(audit.actor_user_id).toBe(ADMIN_USER.id);
    expect(audit.actor_role).toBe('platform_admin');
    expect(audit.action).toBe('platform_admin.tenant_connectors_viewed');
    expect(audit.resource_type).toBe('tenant');
    expect(audit.resource_id).toBe(TARGET_TENANT);
    expect(audit.severity).toBe('info');

    const changes = (audit.changes ?? {}) as Record<string, unknown>;
    expect(changes.connectorCount).toBe(2);
    // The route echoes back ?integration=... in the audit payload so we
    // can later see which row the admin clicked through from.
    expect(changes.integrationFocus).toBe(INTEGRATION_WEDGED_ID);
  });
});
