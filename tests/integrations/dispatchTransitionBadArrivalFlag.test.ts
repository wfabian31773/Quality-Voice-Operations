// Locks down the auto bad-arrival flag on POST /dispatch/jobs/:id/transition.
//
// When a job transitions into a completion status (`completed` / `done`) we
// recompute the same closest-approach haversine the dispatch board badge
// uses; if the closest GPS ping was farther than 250 m from the geocoded
// customer address — a strong signal the tech serviced the wrong house —
// we auto-create a `dispatch_job_exceptions` row of type `other`, log a
// matching `exception_reported` event, and fire the existing 'exception'
// notification trigger so dispatchers see it on their feed.
//
// These tests pin:
//   * the SQL contract — the LATERAL haversine matches the list endpoint
//     and is gated on the cached address geocode being present, so a job
//     with no geocode or no breadcrumbs never produces a bogus flag;
//   * the trigger gate — only fires the *first* time a job enters a
//     completion status (a `completed → done` follow-up does not re-flag);
//   * the artifacts — the exception is type `other`, the event metadata
//     records `auto_flagged: 'bad_arrival'` with the measured distance,
//     and the 'exception' notification template is queried.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import request from 'supertest';

const queryMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
  withPrivilegedClient: vi.fn(),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../platform/notifications/dispatchPush', () => ({
  fireDispatchPush: vi.fn(),
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    req.user = {
      userId: 'user-1',
      tenantId: 'tenant-A',
      role: 'tenant_owner',
      email: 't@example.com',
    };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireMiniSystemWrite: (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
  requireRole: () => (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
}));

vi.mock('../../server/admin-api/middleware/apiKeyAuth', () => ({
  requireApiKeyOrJwt: (jwt: (req: Request, res: Response, next: NextFunction) => void) => jwt,
}));

vi.mock('../../server/admin-api/middleware/apiKeyScope', () => ({
  requireApiKeyPermission: () => (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
}));

vi.mock('../../platform/infra/rate-limit/createRateLimiter', () => ({
  createRateLimiter: () => (
    _req: Request,
    _res: Response,
    next: NextFunction,
  ) => next(),
}));

vi.mock('../../platform/integrations/routing', async () => {
  const actual = await vi.importActual<
    typeof import('../../platform/integrations/routing')
  >('../../platform/integrations/routing');
  return {
    ...actual,
    geocodeAddressCached: vi.fn(),
  };
});

beforeEach(() => {
  queryMock.mockReset();
});

async function buildApp(): Promise<express.Express> {
  const app = express();
  app.use(express.json());
  const { default: dispatchRouter } = await import(
    '../../server/admin-api/routes/dispatch'
  );
  app.use(dispatchRouter);
  return app;
}

// Helper to drain any fire-and-forget async work scheduled inside the
// handler (the bad-arrival flag is `void`-called so the response can
// return before the secondary INSERTs land). A small delay + microtask
// flush is enough; queryMock resolves synchronously.
async function flushAsync(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

describe('POST /dispatch/jobs/:id/transition — bad-arrival auto-flag', () => {
  it('creates an `other` exception + fires notifications when closest approach exceeds 250 m on first completion', async () => {
    // 1) lookup existing job  → in_progress
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-far', status: 'in_progress' }],
    });
    // 2) UPDATE dispatch_jobs → completed
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-far', status: 'completed' }],
    });
    // 3) INSERT dispatch_job_events (status_change)
    queryMock.mockResolvedValueOnce({ rows: [] });
    // 4) fireNotifications template lookup for 'completed' trigger — none
    queryMock.mockResolvedValueOnce({ rows: [] });
    // 5) clear active_job_id on dispatch_resource_locations
    queryMock.mockResolvedValueOnce({ rows: [] });
    // 6) flagBadArrivalIfNeeded — closest-approach + threshold SELECT
    //    (threshold is now per-tenant, joined via subquery in the same
    //    round-trip; default 250 returned here to match the historical
    //    constant.)
    queryMock.mockResolvedValueOnce({
      rows: [{ closest_approach_m: 612.7, threshold_m: 250 }],
    });
    // 7) INSERT dispatch_job_exceptions
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'exc-1' }] });
    // 8) INSERT dispatch_job_events (exception_reported)
    queryMock.mockResolvedValueOnce({ rows: [] });
    // 9) fireNotifications template lookup for 'exception' trigger — none
    queryMock.mockResolvedValueOnce({ rows: [] });

    const app = await buildApp();
    const res = await request(app)
      .post('/dispatch/jobs/job-far/transition')
      .send({ status: 'completed' });

    expect(res.status).toBe(200);
    await flushAsync();

    const calls = queryMock.mock.calls.map(c => String(c[0]));

    // The closest-approach SELECT mirrors the list endpoint's LATERAL
    // haversine and is gated on the cached geocode columns.
    const approachSql = calls.find(s =>
      /6371000 \* 2 \* ASIN/.test(s) && /dispatch_resource_location_history/.test(s),
    );
    expect(approachSql).toBeDefined();
    expect(approachSql!).toMatch(/d\.address_lat\s+IS NOT NULL/);
    expect(approachSql!).toMatch(/d\.address_lon\s+IS NOT NULL/);
    expect(approachSql!).toMatch(/h\.tenant_id\s*=\s*d\.tenant_id/);
    expect(approachSql!).toMatch(/h\.active_job_id\s*=\s*d\.id/);

    // The exception is created with type `other` and a clear, distance-
    // bearing reason so dispatchers know what to investigate.
    const insertExceptionIdx = calls.findIndex(s =>
      /INSERT INTO dispatch_job_exceptions/.test(s),
    );
    expect(insertExceptionIdx).toBeGreaterThan(-1);
    const insertExceptionParams = queryMock.mock.calls[insertExceptionIdx][1] as unknown[];
    // [jobId, tenantId, reason, performedBy] — type/resolution are inline
    expect(insertExceptionParams[0]).toBe('job-far');
    expect(insertExceptionParams[1]).toBe('tenant-A');
    expect(String(insertExceptionParams[2])).toMatch(/613 m/);
    expect(String(insertExceptionParams[2])).toMatch(/threshold 250 m/);
    expect(insertExceptionParams[3]).toBe('user-1');
    // Type `other` is hard-coded in the SQL, not a parameter.
    expect(calls[insertExceptionIdx]).toMatch(/'other'/);

    // The matching event row records the auto-flag metadata so the
    // event timeline distinguishes auto-flags from human-reported ones.
    const insertEventIdx = calls.findIndex((s, i) =>
      i > insertExceptionIdx
      && /INSERT INTO dispatch_job_events/.test(s)
      && /exception_reported/.test(s),
    );
    expect(insertEventIdx).toBeGreaterThan(-1);
    const insertEventParams = queryMock.mock.calls[insertEventIdx][1] as unknown[];
    const metadata = JSON.parse(insertEventParams[4] as string);
    expect(metadata).toMatchObject({
      exception_id: 'exc-1',
      exception_type: 'other',
      auto_flagged: 'bad_arrival',
      threshold_m: 250,
    });
    expect(metadata.closest_approach_m).toBeCloseTo(612.7, 1);

    // The 'exception' notification trigger is queried so dispatchers
    // see this on the same notification feed as a human-reported one.
    const exceptionTriggerCall = queryMock.mock.calls.find(c => {
      const sql = String(c[0]);
      const params = c[1] as unknown[] | undefined;
      return /dispatch_notification_templates/.test(sql)
        && Array.isArray(params)
        && params.includes('exception');
    });
    expect(exceptionTriggerCall).toBeDefined();
  });

  it('skips silently when the job has no breadcrumbs (closest_approach_m IS NULL)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-none', status: 'in_progress' }],
    });
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-none', status: 'completed' }],
    });
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({ rows: [] });
    // closest-approach SELECT returns a row but the aggregate is NULL
    // (no breadcrumbs) — no signal, must not insert an exception.
    queryMock.mockResolvedValueOnce({
      rows: [{ closest_approach_m: null, threshold_m: 250 }],
    });

    const app = await buildApp();
    const res = await request(app)
      .post('/dispatch/jobs/job-none/transition')
      .send({ status: 'completed' });

    expect(res.status).toBe(200);
    await flushAsync();

    const calls = queryMock.mock.calls.map(c => String(c[0]));
    expect(calls.some(s => /INSERT INTO dispatch_job_exceptions/.test(s))).toBe(false);
  });

  it('skips silently when the job has no cached geocode (SELECT returns no rows)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-no-geo', status: 'in_progress' }],
    });
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-no-geo', status: 'completed' }],
    });
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({ rows: [] });
    // The WHERE address_lat/lon IS NOT NULL filter dropped the row.
    queryMock.mockResolvedValueOnce({ rows: [] });

    const app = await buildApp();
    const res = await request(app)
      .post('/dispatch/jobs/job-no-geo/transition')
      .send({ status: 'completed' });

    expect(res.status).toBe(200);
    await flushAsync();

    const calls = queryMock.mock.calls.map(c => String(c[0]));
    expect(calls.some(s => /INSERT INTO dispatch_job_exceptions/.test(s))).toBe(false);
  });

  it('skips silently when closest approach is at or below the 250 m threshold', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-near', status: 'in_progress' }],
    });
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-near', status: 'completed' }],
    });
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({ rows: [] });
    // Right at the threshold — the gate is strict `>`, so this is a
    // good arrival and must not flag.
    queryMock.mockResolvedValueOnce({
      rows: [{ closest_approach_m: 250, threshold_m: 250 }],
    });

    const app = await buildApp();
    const res = await request(app)
      .post('/dispatch/jobs/job-near/transition')
      .send({ status: 'completed' });

    expect(res.status).toBe(200);
    await flushAsync();

    const calls = queryMock.mock.calls.map(c => String(c[0]));
    expect(calls.some(s => /INSERT INTO dispatch_job_exceptions/.test(s))).toBe(false);
  });

  it('does not re-flag on the `completed → done` follow-up transition', async () => {
    // Existing job is already in `completed` — moving to `done` must
    // not re-evaluate the bad-arrival check, otherwise dispatchers
    // would see the same exception twice on a single visit.
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-double', status: 'completed' }],
    });
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-double', status: 'done' }],
    });
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({ rows: [] });

    const app = await buildApp();
    const res = await request(app)
      .post('/dispatch/jobs/job-double/transition')
      .send({ status: 'done' });

    expect(res.status).toBe(200);
    await flushAsync();

    const calls = queryMock.mock.calls.map(c => String(c[0]));
    // No closest-approach SELECT, no exception INSERT.
    expect(calls.some(s => /6371000 \* 2 \* ASIN/.test(s))).toBe(false);
    expect(calls.some(s => /INSERT INTO dispatch_job_exceptions/.test(s))).toBe(false);
  });

  it('uses the per-tenant threshold (not the constant) when judging "too far"', async () => {
    // A rural HVAC tenant has loosened the threshold to 800 m so
    // multi-acre lots stop generating false positives. A 612 m closest
    // approach is now *under* the threshold and must not flag.
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-rural', status: 'in_progress' }],
    });
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-rural', status: 'completed' }],
    });
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({
      rows: [{ closest_approach_m: 612.7, threshold_m: 800 }],
    });

    const app = await buildApp();
    const res = await request(app)
      .post('/dispatch/jobs/job-rural/transition')
      .send({ status: 'completed' });

    expect(res.status).toBe(200);
    await flushAsync();

    const calls = queryMock.mock.calls.map(c => String(c[0]));
    // The tenant threshold lookup is part of the same closest-approach
    // round-trip — must read from the tenants table.
    const approachSql = calls.find(s =>
      /6371000 \* 2 \* ASIN/.test(s)
      && /dispatch_resource_location_history/.test(s),
    );
    expect(approachSql).toBeDefined();
    expect(approachSql!).toMatch(/dispatch_bad_arrival_threshold_m/);
    expect(approachSql!).toMatch(/FROM tenants/);

    // Under the tenant's loosened threshold → no auto-exception.
    expect(calls.some(s => /INSERT INTO dispatch_job_exceptions/.test(s))).toBe(false);
  });

  it('records the tenant-specific threshold in the auto-flag reason and event metadata', async () => {
    // Urban locksmith tightened to 100 m. A 180 m closest approach now
    // exceeds the threshold and must flag with the tenant value
    // visible in both the exception reason and the event metadata —
    // dispatchers need the actual threshold to make sense of the alert.
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-urban', status: 'in_progress' }],
    });
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-urban', status: 'completed' }],
    });
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({
      rows: [{ closest_approach_m: 180.0, threshold_m: 100 }],
    });
    queryMock.mockResolvedValueOnce({ rows: [{ id: 'exc-urban' }] });
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({ rows: [] });

    const app = await buildApp();
    const res = await request(app)
      .post('/dispatch/jobs/job-urban/transition')
      .send({ status: 'completed' });

    expect(res.status).toBe(200);
    await flushAsync();

    const calls = queryMock.mock.calls;
    const insertExceptionIdx = calls.findIndex(c =>
      /INSERT INTO dispatch_job_exceptions/.test(String(c[0])),
    );
    expect(insertExceptionIdx).toBeGreaterThan(-1);
    const reason = String((calls[insertExceptionIdx][1] as unknown[])[2]);
    expect(reason).toMatch(/threshold 100 m/);

    const insertEventIdx = calls.findIndex((c, i) =>
      i > insertExceptionIdx
      && /INSERT INTO dispatch_job_events/.test(String(c[0]))
      && /exception_reported/.test(String(c[0])),
    );
    expect(insertEventIdx).toBeGreaterThan(-1);
    const metadata = JSON.parse(
      (calls[insertEventIdx][1] as unknown[])[4] as string,
    );
    expect(metadata.threshold_m).toBe(100);
  });

  it('does not flag when transitioning to a non-completion status (e.g. cancelled)', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-cancel', status: 'in_progress' }],
    });
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'job-cancel', status: 'cancelled' }],
    });
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({ rows: [] });
    queryMock.mockResolvedValueOnce({ rows: [] });

    const app = await buildApp();
    const res = await request(app)
      .post('/dispatch/jobs/job-cancel/transition')
      .send({ status: 'cancelled' });

    expect(res.status).toBe(200);
    await flushAsync();

    const calls = queryMock.mock.calls.map(c => String(c[0]));
    expect(calls.some(s => /6371000 \* 2 \* ASIN/.test(s))).toBe(false);
    expect(calls.some(s => /INSERT INTO dispatch_job_exceptions/.test(s))).toBe(false);
  });
});
