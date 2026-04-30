/**
 * End-to-end coverage for the `crmRevalidation` block of
 * `GET /platform/connector-health`.
 *
 * The route at `server/admin-api/routes/platformConnectorHealth.ts`
 * (lines ~450-471) imports `getCrmRevalidationMetricsSnapshot` from
 * `platform/integrations/connectors/CrmCallerIdentityRevalidationMetrics`
 * and surfaces the result as the `crmRevalidation` field on the response.
 * The block is wrapped in a defensive try/catch — if the snapshot helper
 * throws, the route still returns 200 and substitutes `null` so the rest
 * of the payload (connectors, summary, expiringSoon, stuckOutboxEvents,
 * etc.) keeps rendering.
 *
 * The sibling e2e suites at `platformConnectorHealthGet.test.ts` and
 * `platformConnectorHealthStuckExpiring.test.ts` cover every other top
 * level field on the response but ignore `crmRevalidation`. A regression
 * in either the in-memory metrics module or the route's defensive guard
 * would silently zero out the panel without any e2e suite catching it.
 *
 * This file fills that gap with two complementary tests:
 *
 *   1. Happy-path: drive the live metrics module via its real
 *      `recordRevalidationCycle` API to seed deterministic counters,
 *      then hit the endpoint and assert the `crmRevalidation` block on
 *      the response carries the expected `scanned` / `validated` /
 *      `staleScrubbed` / `failed` totals plus the per-tenant breakdown
 *      and `lastCycle` timestamps. This exercises the real end-to-end
 *      path: production code -> module binding -> snapshot helper -> JSON.
 *
 *   2. Defensive fallback: force the snapshot helper to throw and
 *      assert the response still returns 200 with `crmRevalidation`
 *      set to null (matching the route's best-effort fallback at
 *      lines 451-455). Without this, a regression that drops the
 *      try/catch would crash the entire health page.
 *
 * The `vi.mock` wrapper exposes a controllable indirection so the same
 * suite can run both the real-snapshot path and the throwing path
 * without spinning up two separate Express apps.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

// Wrap the snapshot helper so we can swap between "delegate to the real
// module" (positive test) and "throw" (negative test) per test case.
// Default behaviour (set in beforeAll once the real module is loaded)
// delegates to the genuine `getCrmRevalidationMetricsSnapshot` so the
// route exercises the real metrics aggregator end-to-end.
const snapshotMock = vi.fn<() => unknown>();

vi.mock(
  '../../platform/integrations/connectors/CrmCallerIdentityRevalidationMetrics',
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import('../../platform/integrations/connectors/CrmCallerIdentityRevalidationMetrics')
    >();
    return {
      ...actual,
      getCrmRevalidationMetricsSnapshot: () => snapshotMock(),
    };
  },
);

const STAMP = Date.now();
const ADMIN_TENANT = randomUUID();
// Two tenants whose per-tenant counters we will seed and assert against
// in the `crmRevalidation.perTenant` projection. The snapshot sorts by
// failures first, so TENANT_A (failed=2) must come before TENANT_B
// (failed=0) in the response.
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const ADMIN_USER = {
  id: randomUUID(),
  email: `admin-${STAMP}@connector-health-crm-reval.local`,
};
const NONADMIN_USER = {
  id: randomUUID(),
  email: `non-admin-${STAMP}@connector-health-crm-reval.local`,
};

let app: import('express').Express;
let issueToken: typeof import('../../server/admin-api/middleware/auth').issueToken;
let withPrivilegedClient: typeof import('../../platform/db').withPrivilegedClient;
let getPlatformPool: typeof import('../../platform/db').getPlatformPool;
let recordRevalidationCycle:
  typeof import('../../platform/integrations/connectors/CrmCallerIdentityRevalidationMetrics').recordRevalidationCycle;
let resetCrmRevalidationMetricsForTest:
  typeof import('../../platform/integrations/connectors/CrmCallerIdentityRevalidationMetrics').resetCrmRevalidationMetricsForTest;
let realGetCrmRevalidationMetricsSnapshot:
  typeof import('../../platform/integrations/connectors/CrmCallerIdentityRevalidationMetrics').getCrmRevalidationMetricsSnapshot;
let adminToken: string;
let nonAdminToken: string;

const GET_PATH = '/platform/connector-health';

async function seedTenantsAndUsers() {
  await withPrivilegedClient(async (client) => {
    // The two "data" tenants exist purely so the snapshot's per-tenant
    // entries point at real tenant_ids — handy for any future UI that
    // joins the snapshot back to tenants. The third (ADMIN_TENANT)
    // satisfies `requireAuth`'s tenant-status gate for the JWT issuer.
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
          `ConnectorHealthCrmReval ${label}`,
          `connector-health-crm-reval-${label}-${STAMP}`,
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
  });
}

async function cleanup() {
  await withPrivilegedClient(async (client) => {
    // Mirrors the cleanup pattern used by the sibling connector-health
    // e2e suites — disable triggers so audit_logs DELETEs cannot abort
    // the cascade.
    await client.query(`SET LOCAL session_replication_role = replica`);
    for (const tenantId of [TENANT_A, TENANT_B, ADMIN_TENANT]) {
      await client.query(`DELETE FROM audit_logs WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM user_roles WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM users WHERE tenant_id = $1`, [tenantId]);
      await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    }
  });
}

describe('GET /platform/connector-health crmRevalidation block (end-to-end)', () => {
  beforeAll(async () => {
    process.env.ADMIN_JWT_SECRET =
      process.env.ADMIN_JWT_SECRET ?? 'qvo-connector-health-crm-reval-secret';

    const dbMod = await import('../../platform/db');
    withPrivilegedClient = dbMod.withPrivilegedClient;
    getPlatformPool = dbMod.getPlatformPool;

    const auth = await import('../../server/admin-api/middleware/auth');
    issueToken = auth.issueToken;

    // Pull the metrics module via `vi.importActual` so the mocked
    // indirection above does NOT shadow the real bindings — otherwise
    // delegating the wrapped helper back through the imported binding
    // recurses infinitely. `recordRevalidationCycle` and the reset helper
    // mutate the same module-level singleton the route reads from, so
    // seeding via the actual module is what makes the snapshot reflect
    // our test fixtures end-to-end.
    const metricsMod = await vi.importActual<
      typeof import('../../platform/integrations/connectors/CrmCallerIdentityRevalidationMetrics')
    >('../../platform/integrations/connectors/CrmCallerIdentityRevalidationMetrics');
    recordRevalidationCycle = metricsMod.recordRevalidationCycle;
    resetCrmRevalidationMetricsForTest = metricsMod.resetCrmRevalidationMetricsForTest;
    realGetCrmRevalidationMetricsSnapshot = metricsMod.getCrmRevalidationMetricsSnapshot;

    app = (await import('../../server/admin-api/app')).default;

    await seedTenantsAndUsers();

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
    resetCrmRevalidationMetricsForTest();
    await cleanup();
    const pool = getPlatformPool();
    if (typeof (pool as { end?: () => Promise<void> }).end === 'function') {
      await (pool as { end: () => Promise<void> }).end().catch(() => {});
    }
  });

  beforeEach(() => {
    // Reset state between tests so seeded counters from one test don't
    // bleed into the next (the metrics module is process-global).
    resetCrmRevalidationMetricsForTest();
    // Clear any prior call history so per-test `toHaveBeenCalled()`
    // assertions only count invocations from THIS test, then reinstall
    // the default delegating implementation. Individual tests may
    // override this (the negative test swaps in a thrower).
    snapshotMock.mockReset();
    snapshotMock.mockImplementation(() => realGetCrmRevalidationMetricsSnapshot());
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

  it('surfaces real revalidation counters from the live metrics module', async () => {
    // Drive the production metrics aggregator directly. The route reads
    // from the same module-level singleton so anything we record here
    // shows up verbatim in the response.
    const cycleStartedAtMs = Date.now() - 5_000;
    const cycleFinishedAtMs = Date.now();

    recordRevalidationCycle({
      startedAtMs: cycleStartedAtMs,
      finishedAtMs: cycleFinishedAtMs,
      result: {
        scanned: 7,
        validated: 4,
        staleScrubbed: 2,
        skippedNoConfig: 1,
        failed: 2,
      },
      perTenantDeltas: new Map([
        [
          TENANT_A,
          {
            scanned: 5,
            validated: 2,
            staleScrubbed: 1,
            skippedNoConfig: 0,
            failed: 2,
          },
        ],
        [
          TENANT_B,
          {
            scanned: 2,
            validated: 2,
            staleScrubbed: 1,
            skippedNoConfig: 1,
            failed: 0,
          },
        ],
      ]),
      threw: false,
    });

    const res = await request(app)
      .get(GET_PATH)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(
      res.status,
      `expected 200, got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`,
    ).toBe(200);

    // The wrapped snapshot binding must have been invoked by the route.
    expect(snapshotMock).toHaveBeenCalled();

    const reval = res.body.crmRevalidation as Record<string, unknown> | null;
    expect(
      reval,
      'crmRevalidation must be present on the response when the snapshot succeeds',
    ).not.toBeNull();
    expect(reval).toBeTypeOf('object');

    // ----- totals reflect the single seeded cycle exactly -----
    const totals = reval!.totals as Record<string, number>;
    expect(totals.cyclesRun).toBe(1);
    expect(totals.cyclesThrew).toBe(0);
    expect(totals.scanned).toBe(7);
    expect(totals.validated).toBe(4);
    expect(totals.staleScrubbed).toBe(2);
    expect(totals.skippedNoConfig).toBe(1);
    expect(totals.failed).toBe(2);

    // ----- lastCycle carries the seeded breakdown + ISO timestamps -----
    const lastCycle = reval!.lastCycle as Record<string, unknown> | null;
    expect(lastCycle, 'lastCycle must be populated after one recorded cycle').not.toBeNull();
    expect(lastCycle!.scanned).toBe(7);
    expect(lastCycle!.validated).toBe(4);
    expect(lastCycle!.staleScrubbed).toBe(2);
    expect(lastCycle!.skippedNoConfig).toBe(1);
    expect(lastCycle!.failed).toBe(2);
    expect(lastCycle!.threw).toBe(false);
    expect(lastCycle!.startedAt).toBe(new Date(cycleStartedAtMs).toISOString());
    expect(lastCycle!.finishedAt).toBe(new Date(cycleFinishedAtMs).toISOString());
    expect(lastCycle!.durationMs).toBe(cycleFinishedAtMs - cycleStartedAtMs);

    // ----- recentCycles is a single-entry array mirroring lastCycle ---
    expect(Array.isArray(reval!.recentCycles)).toBe(true);
    const recent = reval!.recentCycles as Array<Record<string, unknown>>;
    expect(recent).toHaveLength(1);
    expect(recent[0].scanned).toBe(7);
    expect(recent[0].failed).toBe(2);

    // ----- perTenant projection contains both seeded tenants, sorted
    // ----- by failures desc (tenant A has more failures than B) -----
    const perTenant = reval!.perTenant as Array<Record<string, unknown>>;
    expect(Array.isArray(perTenant)).toBe(true);
    const tenantARow = perTenant.find((r) => r.tenantId === TENANT_A);
    const tenantBRow = perTenant.find((r) => r.tenantId === TENANT_B);
    expect(tenantARow, 'tenant A must appear in perTenant after recording a cycle').toBeDefined();
    expect(tenantBRow, 'tenant B must appear in perTenant after recording a cycle').toBeDefined();

    expect(tenantARow!.scanned).toBe(5);
    expect(tenantARow!.validated).toBe(2);
    expect(tenantARow!.staleScrubbed).toBe(1);
    expect(tenantARow!.skippedNoConfig).toBe(0);
    expect(tenantARow!.failed).toBe(2);
    expect(typeof tenantARow!.lastTouchedAt).toBe('string');
    expect(Number.isNaN(Date.parse(tenantARow!.lastTouchedAt as string))).toBe(false);

    expect(tenantBRow!.scanned).toBe(2);
    expect(tenantBRow!.validated).toBe(2);
    expect(tenantBRow!.staleScrubbed).toBe(1);
    expect(tenantBRow!.skippedNoConfig).toBe(1);
    expect(tenantBRow!.failed).toBe(0);

    // Snapshot orders by `failed` desc — A (2) must come before B (0).
    const tenantAIdx = perTenant.findIndex((r) => r.tenantId === TENANT_A);
    const tenantBIdx = perTenant.findIndex((r) => r.tenantId === TENANT_B);
    expect(tenantAIdx).toBeGreaterThanOrEqual(0);
    expect(tenantBIdx).toBeGreaterThanOrEqual(0);
    expect(
      tenantAIdx,
      'tenant A (failed=2) must sort ahead of tenant B (failed=0) in perTenant',
    ).toBeLessThan(tenantBIdx);

    // ----- bookkeeping fields surfaced for the admin UI -----
    expect(reval!.perTenantTracked).toBeGreaterThanOrEqual(2);
    expect(typeof reval!.perTenantLimit).toBe('number');
    expect((reval!.perTenantLimit as number) > 0).toBe(true);
    expect(typeof reval!.startedAt).toBe('string');
    expect(Number.isNaN(Date.parse(reval!.startedAt as string))).toBe(false);
  });

  it('falls back to crmRevalidation: null with HTTP 200 when the snapshot helper throws', async () => {
    // Force the wrapped snapshot helper to throw — exactly the failure
    // mode the route's try/catch at lines ~451-455 is meant to absorb.
    snapshotMock.mockImplementation(() => {
      throw new Error('forced metrics snapshot failure (e2e)');
    });

    const res = await request(app)
      .get(GET_PATH)
      .set('Authorization', `Bearer ${adminToken}`);

    // Defensive contract: the rest of the connector-health payload is
    // far too valuable to fail the response over a metrics snapshot
    // bug. The route MUST still return 200.
    expect(
      res.status,
      `expected 200 (defensive fallback), got ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`,
    ).toBe(200);

    // The wrapped snapshot binding must have been invoked, otherwise we
    // are not actually proving the catch block ran.
    expect(snapshotMock).toHaveBeenCalled();

    // The crmRevalidation field must be present and explicitly null
    // (NOT undefined or missing) so frontend code can render the
    // "metrics unavailable" placeholder without optional chaining.
    expect(
      Object.prototype.hasOwnProperty.call(res.body, 'crmRevalidation'),
      'crmRevalidation field must still be present on the response',
    ).toBe(true);
    expect(res.body.crmRevalidation).toBeNull();

    // Sibling fields must keep rendering — the rest of the payload is
    // the whole point of the defensive fallback.
    expect(Array.isArray(res.body.connectors)).toBe(true);
    expect(res.body.summary).toBeTypeOf('object');
    expect(typeof res.body.tokenHealthRefreshIntervalMs).toBe('number');
    expect(typeof res.body.tokenHealthExpiringHorizonMs).toBe('number');
  });
});
