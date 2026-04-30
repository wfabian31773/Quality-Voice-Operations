/**
 * End-to-end coverage for the Platform Admin "Verified caller health"
 * endpoints:
 *
 *   - `GET  /platform/verified-caller-health`
 *   - `GET  /platform/verified-caller-health/:tenantId/:callerId/alert-history`
 *   - `POST /platform/verified-caller-health/:tenantId/:callerId/alert`
 *
 * The unit tests for the helpers these routes call already cover their
 * SQL shape in isolation. This file complements them by driving the real
 * Express app, the real auth middleware, the real RBAC check
 * (`requirePlatformAdmin`), real rows written to `verified_caller_ids` /
 * `verified_caller_alert_recipients`, and a real `audit_logs` write for
 * the POST. The only stub is the alert dispatcher itself
 * (`dispatchVerifiedCallerAlert`) — it would otherwise fan out
 * email + in-app notifications and re-stamp the throttle slot, all of
 * which require a full Twilio / SMTP / notifications setup. The same
 * pattern is used by `platformConnectorHealthActions.test.ts` to stub
 * `dispatchConnectorAuthAlert` while letting everything else run against
 * the live module graph.
 *
 * Coverage assertions per endpoint:
 *   - 401 when no Authorization header is supplied
 *   - 403 when the caller is authenticated but not a platform admin
 *   - 400 for a malformed UUID parameter (the two endpoints that take
 *     `:tenantId` / `:callerId` URL params)
 *   - 200 success path with a real platform-admin JWT, asserting the
 *     real seeded row is reflected in the response
 *   - For POST: the dispatcher mock is invoked with the route's expected
 *     `force: true`, `source: 'admin_reissue'`, and `triggeredByUserId`
 *     forwarding, AND a real `audit_logs` row is written with action
 *     `verified_caller.admin_alert_reissued`.
 *
 * Cleanup deletes every seeded row (audit logs, alert recipients,
 * verified callers, user_roles, users, tenants) to leave the platform DB
 * pristine for other tests.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

// Stub only the alert dispatcher. The route's contract for the dispatcher
// is "call it with `force: true` + `source: 'admin_reissue'`, forward
// the platform admin's user id, then audit-log the returned status /
// emailedRecipients". Stubbing here keeps the route's dispatcher-call
// shape under test while letting the real DB load
// (`getCallerId` / `withTenant` + RLS), the real RBAC pass, and the real
// `writeAuditLog` insert all run against the live module graph.
const dispatchVerifiedCallerAlertMock = vi.fn<
  (input: Record<string, unknown>) => Promise<{
    status: 'sent' | 'throttled' | 'no_recipients';
    emailedRecipients: number;
    dispatchId: string | null;
  }>
>();

vi.mock('../../platform/telephony/VerifiedCallerHealthScheduler', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    dispatchVerifiedCallerAlert: (input: Record<string, unknown>) =>
      dispatchVerifiedCallerAlertMock(input),
  };
});

const STAMP = Date.now();
const ADMIN_TENANT = randomUUID();
const TARGET_TENANT = randomUUID();
const ADMIN_USER = {
  id: randomUUID(),
  email: `admin-${STAMP}@verified-caller-health-e2e.local`,
};
const NONADMIN_USER = {
  id: randomUUID(),
  email: `non-admin-${STAMP}@verified-caller-health-e2e.local`,
};
const CALLER_ID = randomUUID();
const CALLER_PHONE = '+15551231234';
// One pre-existing dispatch in the alert-history table so the GET
// alert-history endpoint has something to return from the real query.
const SEED_DISPATCH_ID = randomUUID();
const SEED_RECIPIENT_EMAIL = `recipient-${STAMP}@verified-caller-health-e2e.local`;

let app: import('express').Express;
let issueToken: typeof import('../../server/admin-api/middleware/auth').issueToken;
let withPrivilegedClient: typeof import('../../platform/db').withPrivilegedClient;
let getPlatformPool: typeof import('../../platform/db').getPlatformPool;
let adminToken: string;
let nonAdminToken: string;

const LIST_PATH = '/platform/verified-caller-health';
const HISTORY_PATH = `/platform/verified-caller-health/${TARGET_TENANT}/${CALLER_ID}/alert-history`;
const ALERT_PATH = `/platform/verified-caller-health/${TARGET_TENANT}/${CALLER_ID}/alert`;
const BAD_TENANT = 'not-a-uuid';
const BAD_CALLER = 'also-not-a-uuid';

async function seedFixtures() {
  await withPrivilegedClient(async (client) => {
    // Two tenants: ADMIN_TENANT houses the platform-admin user (so the
    // tenant-status gate inside requireAuth doesn't trip), TARGET_TENANT
    // owns the verified caller the admin acts on.
    for (const [tenantId, label] of [
      [ADMIN_TENANT, 'admin'],
      [TARGET_TENANT, 'target'],
    ] as const) {
      await client.query(
        `INSERT INTO tenants (id, name, slug, status)
         VALUES ($1, $2, $3, 'active')
         ON CONFLICT (id) DO NOTHING`,
        [
          tenantId,
          `VerifiedCallerHealthE2E ${label}`,
          `verified-caller-health-e2e-${label}-${STAMP}`,
        ],
      );
    }

    // Platform-admin user in ADMIN_TENANT. is_platform_admin=true so
    // requireAuth's privileged lookup returns true and requirePlatformAdmin
    // lets the request through.
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
    // is_platform_admin=false. Used to assert the 403 RBAC denial.
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

    // The verified caller row the routes load. status='verified' so
    // listUnhealthyVerifiedCallers picks it up; last_health_status='expired'
    // (an alertable state) so the POST gets past the 409 guard;
    // expires_at set to the past so the listing helper sorts deterministically.
    await client.query(
      `INSERT INTO verified_caller_ids (
         id, tenant_id, phone_number, friendly_name, status,
         attestation_level, expires_at, last_health_check_at,
         last_health_status, last_health_message
       ) VALUES (
         $1, $2, $3, 'VerifiedCallerHealthE2E target', 'verified',
         'A', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 hour',
         'expired', 'Trust Hub product valid_until elapsed'
       )
       ON CONFLICT (id) DO NOTHING`,
      [CALLER_ID, TARGET_TENANT, CALLER_PHONE],
    );

    // One pre-existing dispatch row in verified_caller_alert_recipients
    // so the GET alert-history endpoint returns a real row from the real
    // SQL (not just an empty list). Two recipient rows under the same
    // dispatch id so the listing endpoint's "lastAlert" summary embeds
    // a non-trivial sent/skipped breakdown.
    await client.query(
      `INSERT INTO verified_caller_alert_recipients (
         tenant_id, caller_id, dispatch_id, health_status,
         user_id, recipient_name, recipient_email,
         delivery_status, delivery_error, permanent_failure,
         source, triggered_by_user_id, dispatched_at
       ) VALUES
         ($1, $2, $3, 'expired', NULL, 'Recipient One', $4, 'sent',    NULL, false, 'scheduler', NULL, NOW() - INTERVAL '2 hours'),
         ($1, $2, $3, 'expired', NULL, 'Recipient Two', $5, 'skipped', 'opted_out_integration_emails', false, 'scheduler', NULL, NOW() - INTERVAL '2 hours')
      `,
      [
        TARGET_TENANT,
        CALLER_ID,
        SEED_DISPATCH_ID,
        SEED_RECIPIENT_EMAIL,
        `other-${SEED_RECIPIENT_EMAIL}`,
      ],
    );
  });
}

async function cleanup() {
  await withPrivilegedClient(async (client) => {
    // Disable triggers in this transaction so the audit_logs DELETE
    // doesn't trip the immutable audit_logs guard. Mirrors the cleanup
    // pattern used by platformConnectorHealthActions.test.ts.
    await client.query(`SET LOCAL session_replication_role = replica`);
    await client.query(
      `DELETE FROM audit_logs
        WHERE tenant_id = $1
          AND resource_type = 'verified_caller_id'
          AND resource_id = $2`,
      [TARGET_TENANT, CALLER_ID],
    );
    await client.query(
      `DELETE FROM verified_caller_alert_recipients
        WHERE tenant_id = $1 AND caller_id = $2`,
      [TARGET_TENANT, CALLER_ID],
    );
    await client.query(
      `DELETE FROM verified_caller_ids WHERE id = $1`,
      [CALLER_ID],
    );
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
      [TARGET_TENANT, CALLER_ID, action],
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
      [TARGET_TENANT, CALLER_ID, action],
    );
    return (rows[0] as Record<string, unknown> | undefined) ?? null;
  });
}

describe('Platform verified-caller-health endpoints (end-to-end)', () => {
  beforeAll(async () => {
    process.env.ADMIN_JWT_SECRET =
      process.env.ADMIN_JWT_SECRET ?? 'qvo-verified-caller-health-e2e-secret';

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

  describe('GET /platform/verified-caller-health', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app).get(LIST_PATH);
      expect(res.status).toBe(401);
    });

    it('returns 403 when the caller is authenticated but not a platform admin', async () => {
      const res = await request(app)
        .get(LIST_PATH)
        .set('Authorization', `Bearer ${nonAdminToken}`);
      expect(
        res.status,
        `expected 403, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`,
      ).toBe(403);
      expect(res.body.error).toMatch(/Platform admin/);
    });

    it('returns the seeded unhealthy verified caller in the cross-tenant snapshot', async () => {
      const res = await request(app)
        .get(LIST_PATH)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(
        res.status,
        `expected 200, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`,
      ).toBe(200);

      expect(Array.isArray(res.body.callers)).toBe(true);
      const seeded = (res.body.callers as Array<Record<string, unknown>>).find(
        (c) => c.id === CALLER_ID,
      );
      expect(seeded, 'seeded verified caller must appear in callers[]').toBeDefined();
      expect(seeded!.tenantId).toBe(TARGET_TENANT);
      expect(seeded!.tenantName).toBe(`VerifiedCallerHealthE2E target`);
      expect(seeded!.tenantSlug).toBe(`verified-caller-health-e2e-target-${STAMP}`);
      expect(seeded!.phoneNumber).toBe(CALLER_PHONE);
      expect(seeded!.status).toBe('expired');
      // The bulk lastAlert lookup should embed the seeded dispatch's
      // sent/skipped breakdown for our caller.
      const lastAlert = seeded!.lastAlert as Record<string, unknown> | null;
      expect(lastAlert, 'lastAlert must be populated from the seeded dispatch').not.toBeNull();
      expect(lastAlert!.dispatchId).toBe(SEED_DISPATCH_ID);
      expect(lastAlert!.healthStatus).toBe('expired');
      expect(lastAlert!.source).toBe('scheduler');
      expect(lastAlert!.sentCount).toBe(1);
      expect(lastAlert!.skippedCount).toBe(1);
      expect(lastAlert!.totalCount).toBe(2);

      // Summary aggregates across the full platform DB so other suites
      // running in parallel may bump these counters; assert lower bounds
      // that prove our row contributed.
      const summary = res.body.summary as Record<string, number>;
      expect(typeof summary.expired).toBe('number');
      expect(summary.expired).toBeGreaterThanOrEqual(1);
      expect(summary.total).toBeGreaterThanOrEqual(1);
      expect(summary.affectedTenants).toBeGreaterThanOrEqual(1);
    });
  });

  describe('GET /platform/verified-caller-health/:tenantId/:callerId/alert-history', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app).get(HISTORY_PATH);
      expect(res.status).toBe(401);
    });

    it('returns 403 when the caller is authenticated but not a platform admin', async () => {
      const res = await request(app)
        .get(HISTORY_PATH)
        .set('Authorization', `Bearer ${nonAdminToken}`);
      expect(
        res.status,
        `expected 403, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`,
      ).toBe(403);
      expect(res.body.error).toMatch(/Platform admin/);
    });

    it('returns 400 for a malformed tenantId or callerId UUID', async () => {
      const res = await request(app)
        .get(`/platform/verified-caller-health/${BAD_TENANT}/${BAD_CALLER}/alert-history`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid tenantId or callerId/);
    });

    it('returns the seeded recipient rows for the (tenant, caller) pair', async () => {
      const res = await request(app)
        .get(HISTORY_PATH)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(
        res.status,
        `expected 200, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`,
      ).toBe(200);

      expect(Array.isArray(res.body.recipients)).toBe(true);
      expect(typeof res.body.limit).toBe('number');
      expect(typeof res.body.truncated).toBe('boolean');

      const recipients = res.body.recipients as Array<Record<string, unknown>>;
      // The two seeded rows belong to the same dispatch and the same
      // caller so they must both come back.
      expect(recipients.length).toBeGreaterThanOrEqual(2);
      const sent = recipients.find((r) => r.recipientEmail === SEED_RECIPIENT_EMAIL);
      expect(sent, 'seeded sent recipient row must appear in the response').toBeDefined();
      expect(sent!.dispatchId).toBe(SEED_DISPATCH_ID);
      expect(sent!.healthStatus).toBe('expired');
      expect(sent!.deliveryStatus).toBe('sent');
      expect(sent!.source).toBe('scheduler');
      expect(sent!.permanentFailure).toBe(false);

      const skipped = recipients.find(
        (r) => r.recipientEmail === `other-${SEED_RECIPIENT_EMAIL}`,
      );
      expect(skipped, 'seeded skipped recipient row must appear in the response').toBeDefined();
      expect(skipped!.deliveryStatus).toBe('skipped');
      expect(skipped!.deliveryError).toBe('opted_out_integration_emails');
    });
  });

  describe('POST /platform/verified-caller-health/:tenantId/:callerId/alert', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app).post(ALERT_PATH).send({});
      expect(res.status).toBe(401);
      expect(dispatchVerifiedCallerAlertMock).not.toHaveBeenCalled();
      expect(await countAuditRows('verified_caller.admin_alert_reissued')).toBe(0);
    });

    it('returns 403 when the caller is authenticated but not a platform admin', async () => {
      const before = await countAuditRows('verified_caller.admin_alert_reissued');
      const res = await request(app)
        .post(ALERT_PATH)
        .set('Authorization', `Bearer ${nonAdminToken}`)
        .send({});
      expect(
        res.status,
        `expected 403, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`,
      ).toBe(403);
      expect(res.body.error).toMatch(/Platform admin/);
      expect(dispatchVerifiedCallerAlertMock).not.toHaveBeenCalled();
      expect(await countAuditRows('verified_caller.admin_alert_reissued')).toBe(before);
    });

    it('returns 400 for a malformed tenantId or callerId UUID', async () => {
      const before = await countAuditRows('verified_caller.admin_alert_reissued');
      const res = await request(app)
        .post(`/platform/verified-caller-health/${BAD_TENANT}/${BAD_CALLER}/alert`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Invalid tenantId or callerId/);
      // Bad UUID must short-circuit before the dispatcher and before any
      // audit row is written.
      expect(dispatchVerifiedCallerAlertMock).not.toHaveBeenCalled();
      expect(await countAuditRows('verified_caller.admin_alert_reissued')).toBe(before);
    });

    it('dispatches the alert and writes a real audit_logs row when the caller is a platform admin', async () => {
      dispatchVerifiedCallerAlertMock.mockReset();
      const stubbedDispatchId = randomUUID();
      dispatchVerifiedCallerAlertMock.mockResolvedValue({
        status: 'sent',
        emailedRecipients: 3,
        dispatchId: stubbedDispatchId,
      });

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
      expect(res.body.emailedRecipients).toBe(3);
      expect(typeof res.body.message).toBe('string');

      // The dispatcher MUST be invoked exactly once with the route's
      // contractually-required flags.
      expect(dispatchVerifiedCallerAlertMock).toHaveBeenCalledTimes(1);
      const params = dispatchVerifiedCallerAlertMock.mock.calls[0][0];
      expect(params.force).toBe(true);
      expect(params.source).toBe('admin_reissue');
      expect(params.triggeredByUserId).toBe(ADMIN_USER.id);
      const callerArg = params.caller as Record<string, unknown>;
      expect(callerArg.id).toBe(CALLER_ID);
      expect(callerArg.tenantId).toBe(TARGET_TENANT);
      expect(callerArg.phoneNumber).toBe(CALLER_PHONE);
      // The route reconstructs CallerHealthResult from the persisted
      // row, so the dispatcher must see `expired` (the seeded health
      // status) and `force: true` so attestation isn't demoted from the
      // operator nudge.
      const resultArg = params.result as Record<string, unknown>;
      expect(resultArg.status).toBe('expired');
      expect(resultArg.demoteAttestation).toBe(false);

      // A real audit_logs row must exist. The route uses
      // resource_type='verified_caller_id', action='verified_caller.admin_alert_reissued',
      // and severity='info'.
      const audit = await fetchAuditRow('verified_caller.admin_alert_reissued');
      expect(audit, 'audit_logs row should exist after a successful alert dispatch').not.toBeNull();
      expect(audit!.tenant_id).toBe(TARGET_TENANT);
      expect(audit!.actor_user_id).toBe(ADMIN_USER.id);
      expect(audit!.actor_role).toBe('platform_admin');
      expect(audit!.resource_type).toBe('verified_caller_id');
      expect(audit!.resource_id).toBe(CALLER_ID);
      expect(audit!.severity).toBe('info');
      const changes = (audit!.changes ?? {}) as Record<string, unknown>;
      expect(changes.phoneNumber).toBe(CALLER_PHONE);
      expect(changes.healthStatus).toBe('expired');
      expect(changes.status).toBe('sent');
      expect(changes.emailedRecipients).toBe(3);
    });
  });
});
