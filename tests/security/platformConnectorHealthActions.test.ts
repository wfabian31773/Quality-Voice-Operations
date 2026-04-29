/**
 * End-to-end coverage for the Platform Admin connector "quick action" endpoints
 * (`POST /platform/connector-health/integrations/:tenantId/:integrationId/refresh`
 * and `.../alert`).
 *
 * The unit suite at `tests/integrations/platformConnectorHealthActions.test.ts`
 * exercises the route in isolation with every dependency mocked. This file
 * complements it by driving the real Express app, the real auth middleware,
 * the real RBAC check (`requirePlatformAdmin`), and a real `integrations`
 * row written to the platform DB. The only stubs are the two functions that
 * would reach external systems on success — `ensureFreshOAuthToken`
 * (provider OAuth exchange) and `dispatchConnectorAuthAlert` (email + SMS
 * notification fan-out). All other behaviour — JWT verification, role
 * resolution from `user_roles`, `is_platform_admin` lookup, integration row
 * load, audit log insertion — runs against the live module graph.
 *
 * Coverage assertions per endpoint:
 *   - 200 success path with a real platform-admin JWT
 *   - 403 RBAC denial for a tenant_owner who is not a platform admin
 *   - 401 when no Authorization header is supplied
 *   - audit_logs row was actually written for the success path
 *
 * Cleanup deletes every seeded row (integration, audit logs, user_roles,
 * users, tenants) to leave the platform DB pristine for other tests.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

// Stub only the two helpers that would hit a real provider / mailer on
// success. Everything else (DB access, audit log writes, RBAC, auth) runs
// against the real module graph via `importOriginal`. Hoisted by vitest so
// the route module picks them up the first time it imports the connectors
// barrel and the alert scheduler.
const ensureFreshOAuthTokenMock = vi.fn<(config: unknown, opts?: { force?: boolean }) => Promise<void>>();
const dispatchConnectorAuthAlertMock = vi.fn<(params: Record<string, unknown>) => Promise<{
  status: 'sent' | 'throttled' | 'no_recipients' | 'skipped';
  emailedRecipients: number;
}>>();

vi.mock('../../platform/integrations/connectors', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ensureFreshOAuthToken: (config: unknown, opts?: { force?: boolean }) =>
      ensureFreshOAuthTokenMock(config, opts),
  };
});

vi.mock('../../platform/integrations/connectors/ConnectorAuthAlertScheduler', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dispatchConnectorAuthAlert: (params: Record<string, unknown>) =>
      dispatchConnectorAuthAlertMock(params),
  };
});

const ADMIN_TENANT = randomUUID();
const TARGET_TENANT = randomUUID();
const STAMP = Date.now();
const ADMIN_USER = { id: randomUUID(), email: `admin-${STAMP}@connector-health-e2e.local` };
const NONADMIN_USER = { id: randomUUID(), email: `non-admin-${STAMP}@connector-health-e2e.local` };
const INTEGRATION_ID = randomUUID();

let app: import('express').Express;
let issueToken: typeof import('../../server/admin-api/middleware/auth').issueToken;
let withPrivilegedClient: typeof import('../../platform/db').withPrivilegedClient;
let getPlatformPool: typeof import('../../platform/db').getPlatformPool;
let adminToken: string;
let nonAdminToken: string;

const REFRESH_PATH = `/platform/connector-health/integrations/${TARGET_TENANT}/${INTEGRATION_ID}/refresh`;
const ALERT_PATH = `/platform/connector-health/integrations/${TARGET_TENANT}/${INTEGRATION_ID}/alert`;

async function seedPlatformAdminFixtures() {
  await withPrivilegedClient(async (client) => {
    // Two tenants: one houses the platform-admin user, the other owns the
    // integration the admin will act on. Both must be `active` so the
    // tenant-status gate inside requireAuth doesn't trip on the admin
    // tenant.
    for (const [tenantId, label] of [
      [ADMIN_TENANT, 'admin'],
      [TARGET_TENANT, 'target'],
    ] as const) {
      await client.query(
        `INSERT INTO tenants (id, name, slug, status)
         VALUES ($1, $2, $3, 'active')
         ON CONFLICT (id) DO NOTHING`,
        [tenantId, `ConnectorHealthE2E ${label}`, `connector-health-e2e-${label}-${STAMP}`],
      );
    }

    // Platform-admin user (real is_platform_admin=true so requireAuth's
    // privileged lookup returns true). Lives in ADMIN_TENANT.
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

    // Non-platform-admin user, also a tenant_owner in ADMIN_TENANT, but
    // is_platform_admin=false. Used to assert RBAC denial.
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

    // The integration row the route loads via loadIntegrationForAdminAction.
    // provider='hubspot' so isRefreshableProvider() returns true (hubspot
    // is registered in REFRESHERS), which lets the refresh path get past
    // the 400 "does not support refresh" gate without us having to mock
    // isRefreshableProvider.
    await client.query(
      `INSERT INTO integrations (
         id, tenant_id, name, integration_type, provider, is_enabled, config,
         last_sync_status, last_sync_error, last_sync_error_at
       ) VALUES (
         $1, $2, 'HubSpot E2E', 'crm', 'hubspot', true, '{}'::jsonb,
         'needs_reconnect', 'invalid_grant', NOW()
       )
       ON CONFLICT (id) DO NOTHING`,
      [INTEGRATION_ID, TARGET_TENANT],
    );
  });
}

async function cleanup() {
  await withPrivilegedClient(async (client) => {
    // Disable triggers in this transaction so audit_logs DELETEs and the
    // FK ON DELETE SET NULL on actor_user_id don't trip the immutable
    // audit_logs guard.
    await client.query(`SET LOCAL session_replication_role = replica`);
    await client.query(
      `DELETE FROM audit_logs
        WHERE tenant_id = $1 AND resource_type = 'connector' AND resource_id = $2`,
      [TARGET_TENANT, INTEGRATION_ID],
    );
    await client.query(`DELETE FROM connector_configs WHERE tenant_id = $1`, [TARGET_TENANT]);
    await client.query(`DELETE FROM integrations WHERE tenant_id = $1`, [TARGET_TENANT]);
    for (const tenantId of [ADMIN_TENANT, TARGET_TENANT]) {
      await client.query(`DELETE FROM user_roles WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM users WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    }
  });
}

async function countAuditRows(action: string): Promise<number> {
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT COUNT(*)::int AS n
         FROM audit_logs
        WHERE tenant_id = $1 AND resource_id = $2 AND action = $3`,
      [TARGET_TENANT, INTEGRATION_ID, action],
    );
    return Number(rows[0]?.n ?? 0);
  });
}

async function fetchAuditRow(action: string): Promise<Record<string, unknown> | null> {
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT tenant_id, actor_user_id, actor_role, action, resource_type, resource_id, changes, severity
         FROM audit_logs
        WHERE tenant_id = $1 AND resource_id = $2 AND action = $3
        ORDER BY occurred_at DESC
        LIMIT 1`,
      [TARGET_TENANT, INTEGRATION_ID, action],
    );
    return (rows[0] as Record<string, unknown> | undefined) ?? null;
  });
}

describe('Platform connector quick-action endpoints (end-to-end)', () => {
  beforeAll(async () => {
    process.env.ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET ?? 'qvo-connector-health-e2e-secret';

    const dbMod = await import('../../platform/db');
    withPrivilegedClient = dbMod.withPrivilegedClient;
    getPlatformPool = dbMod.getPlatformPool;

    const auth = await import('../../server/admin-api/middleware/auth');
    issueToken = auth.issueToken;

    app = (await import('../../server/admin-api/app')).default;

    await seedPlatformAdminFixtures();

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

  describe('POST /platform/connector-health/integrations/:tenantId/:integrationId/refresh', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app).post(REFRESH_PATH).send({});
      expect(res.status).toBe(401);
      expect(ensureFreshOAuthTokenMock).not.toHaveBeenCalled();
      expect(await countAuditRows('connector.admin_refresh_succeeded')).toBe(0);
    });

    it('returns 403 when the caller is authenticated but not a platform admin', async () => {
      const before = await countAuditRows('connector.admin_refresh_succeeded');
      const res = await request(app)
        .post(REFRESH_PATH)
        .set('Authorization', `Bearer ${nonAdminToken}`)
        .send({});
      expect(
        res.status,
        `expected 403, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`,
      ).toBe(403);
      expect(res.body.error).toMatch(/Platform admin/);
      expect(ensureFreshOAuthTokenMock).not.toHaveBeenCalled();
      // No new success audit row was written by the rejected call.
      expect(await countAuditRows('connector.admin_refresh_succeeded')).toBe(before);
    });

    it('refreshes the token and writes a real audit_logs row when the caller is a platform admin', async () => {
      ensureFreshOAuthTokenMock.mockReset();
      ensureFreshOAuthTokenMock.mockResolvedValue(undefined);

      const res = await request(app)
        .post(REFRESH_PATH)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(
        res.status,
        `expected 200, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`,
      ).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.provider).toBe('hubspot');

      expect(ensureFreshOAuthTokenMock).toHaveBeenCalledTimes(1);
      // The route MUST force-refresh from this panel (the cached
      // token_expires_at can lie when the provider already revoked the
      // token), so verify we passed force: true.
      expect(ensureFreshOAuthTokenMock.mock.calls[0][1]).toEqual({ force: true });

      const audit = await fetchAuditRow('connector.admin_refresh_succeeded');
      expect(audit, 'audit_logs row should exist after a successful refresh').not.toBeNull();
      expect(audit!.tenant_id).toBe(TARGET_TENANT);
      expect(audit!.actor_user_id).toBe(ADMIN_USER.id);
      expect(audit!.actor_role).toBe('platform_admin');
      expect(audit!.resource_type).toBe('connector');
      expect(audit!.resource_id).toBe(INTEGRATION_ID);
      const changes = (audit!.changes ?? {}) as Record<string, unknown>;
      expect(changes.provider).toBe('hubspot');
    });
  });

  describe('POST /platform/connector-health/integrations/:tenantId/:integrationId/alert', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app).post(ALERT_PATH).send({});
      expect(res.status).toBe(401);
      expect(dispatchConnectorAuthAlertMock).not.toHaveBeenCalled();
      expect(await countAuditRows('connector.admin_alert_reissued')).toBe(0);
    });

    it('returns 403 when the caller is authenticated but not a platform admin', async () => {
      const before = await countAuditRows('connector.admin_alert_reissued');
      const res = await request(app)
        .post(ALERT_PATH)
        .set('Authorization', `Bearer ${nonAdminToken}`)
        .send({});
      expect(
        res.status,
        `expected 403, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`,
      ).toBe(403);
      expect(res.body.error).toMatch(/Platform admin/);
      expect(dispatchConnectorAuthAlertMock).not.toHaveBeenCalled();
      expect(await countAuditRows('connector.admin_alert_reissued')).toBe(before);
    });

    it('dispatches the reconnect alert and writes a real audit_logs row when the caller is a platform admin', async () => {
      dispatchConnectorAuthAlertMock.mockReset();
      dispatchConnectorAuthAlertMock.mockResolvedValue({ status: 'sent', emailedRecipients: 2 });

      const res = await request(app)
        .post(ALERT_PATH)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});

      expect(
        res.status,
        `expected 200, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`,
      ).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.status).toBe('sent');
      expect(res.body.emailedRecipients).toBe(2);
      expect(res.body.reason).toBe('needs_reconnect');

      expect(dispatchConnectorAuthAlertMock).toHaveBeenCalledTimes(1);
      const params = dispatchConnectorAuthAlertMock.mock.calls[0][0];
      expect(params.force).toBe(true);
      expect(params.tenantId).toBe(TARGET_TENANT);
      expect(params.integrationId).toBe(INTEGRATION_ID);
      expect(params.provider).toBe('hubspot');
      expect(params.connectorType).toBe('crm');
      expect(params.reason).toBe('needs_reconnect');

      const audit = await fetchAuditRow('connector.admin_alert_reissued');
      expect(audit, 'audit_logs row should exist after a successful alert dispatch').not.toBeNull();
      expect(audit!.tenant_id).toBe(TARGET_TENANT);
      expect(audit!.actor_user_id).toBe(ADMIN_USER.id);
      expect(audit!.actor_role).toBe('platform_admin');
      expect(audit!.resource_type).toBe('connector');
      expect(audit!.resource_id).toBe(INTEGRATION_ID);
      const changes = (audit!.changes ?? {}) as Record<string, unknown>;
      expect(changes.provider).toBe('hubspot');
      expect(changes.status).toBe('sent');
      expect(changes.emailedRecipients).toBe(2);
      expect(changes.reason).toBe('needs_reconnect');
    });
  });
});
