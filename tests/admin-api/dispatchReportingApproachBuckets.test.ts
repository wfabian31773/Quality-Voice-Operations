// Locks down the "visit-the-right-house" rollup that the Dispatch
// Reporting tab renders: bucket distribution + per-day "% within 50 m"
// trend. Pins:
//   * The bucket query restricts to completed jobs (status IN
//     'completed','done') in the same date window the rest of the
//     reporting metrics use, so the rate denominators stay aligned.
//   * The handler folds the raw bucket counts into a `with_data` total
//     and `good_rate` / `bad_rate` percentages so the UI doesn't have
//     to recompute them (and to lock down the rounding contract).
//   * `no_data` (jobs with no geocode or no breadcrumbs) is exposed
//     separately so the UI can footnote it without polluting the rate.
//   * Empty windows return a zero-shape payload (not 500, not omitted).
//   * The trend rows are passed through with their `date / with_data /
//     good` shape so the client can render the sparkline directly.
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
  requireApiKeyOrJwt: (
    jwt: (req: Request, res: Response, next: NextFunction) => void,
  ) => jwt,
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

// The reporting handler issues 7 queries in a fixed order:
//   1. overview metrics      2. exception breakdown
//   3. reassignment count    4. territory perf
//   5. resource perf         6. daily trend
//   7. approach buckets      8. approach trend
// `mockOverview` lets each test pin the one row that drives the metrics
// header without re-spelling the whole shape every time.
function queueReportingMocks(opts: {
  overview?: Record<string, unknown>;
  buckets: Record<string, number>;
  trendRows?: { date: string; with_data: number; good: number }[];
}) {
  const overview = opts.overview ?? {
    total_jobs: 0, completed_jobs: 0, incomplete_jobs: 0, cancelled_jobs: 0,
    pending_jobs: 0, active_jobs: 0,
    avg_completion_hours: 0, avg_time_on_job_minutes: 0,
    avg_time_to_dispatch_minutes: 0,
  };
  queryMock.mockResolvedValueOnce({ rows: [overview] }); // overview
  queryMock.mockResolvedValueOnce({ rows: [] });          // exceptions
  queryMock.mockResolvedValueOnce({ rows: [{ count: 0 }] }); // reassignments
  queryMock.mockResolvedValueOnce({ rows: [] });          // territory perf
  queryMock.mockResolvedValueOnce({ rows: [] });          // resource perf
  queryMock.mockResolvedValueOnce({ rows: [] });          // daily trend
  queryMock.mockResolvedValueOnce({ rows: [opts.buckets] }); // approach buckets
  queryMock.mockResolvedValueOnce({ rows: opts.trendRows ?? [] }); // approach trend
}

describe('GET /dispatch/reporting — visit-the-right-house rollup', () => {
  it('returns bucket counts, totals, and good/bad rates for completed jobs', async () => {
    queueReportingMocks({
      buckets: {
        under_50: 60,
        m_50_100: 20,
        m_100_250: 15,
        over_250: 5,
        no_data: 7,
      },
      trendRows: [
        { date: '2026-04-20', with_data: 10, good: 8 },
        { date: '2026-04-21', with_data: 0, good: 0 },
        { date: '2026-04-22', with_data: 5, good: 5 },
      ],
    });

    const app = await buildApp();
    const res = await request(app).get('/dispatch/reporting');

    expect(res.status).toBe(200);
    expect(res.body.approachBuckets).toEqual({
      under_50: 60,
      m_50_100: 20,
      m_100_250: 15,
      over_250: 5,
      no_data: 7,
      with_data: 100,
      good_rate: 60.0,
      bad_rate: 5.0,
    });
    expect(res.body.approachTrend).toEqual([
      { date: '2026-04-20', with_data: 10, good: 8 },
      { date: '2026-04-21', with_data: 0, good: 0 },
      { date: '2026-04-22', with_data: 5, good: 5 },
    ]);
  });

  it('returns a zero-shape rollup when no completed jobs landed in the window', async () => {
    queueReportingMocks({
      buckets: {
        under_50: 0,
        m_50_100: 0,
        m_100_250: 0,
        over_250: 0,
        no_data: 0,
      },
      trendRows: [],
    });

    const app = await buildApp();
    const res = await request(app).get('/dispatch/reporting');

    expect(res.status).toBe(200);
    // The card key still has to be present so the UI can render its
    // empty-state copy without first checking for `undefined`.
    expect(res.body.approachBuckets).toEqual({
      under_50: 0,
      m_50_100: 0,
      m_100_250: 0,
      over_250: 0,
      no_data: 0,
      with_data: 0,
      // 0/0 must collapse to 0% — never NaN, never null.
      good_rate: 0,
      bad_rate: 0,
    });
    expect(res.body.approachTrend).toEqual([]);
  });

  it('issues bucket + trend queries restricted to completed jobs in the same date window', async () => {
    queueReportingMocks({
      buckets: {
        under_50: 1, m_50_100: 0, m_100_250: 0, over_250: 0, no_data: 0,
      },
    });

    const app = await buildApp();
    await request(app)
      .get('/dispatch/reporting')
      .query({ date_from: '2026-04-01T00:00:00Z', date_to: '2026-04-30T23:59:59Z' });

    // The bucket query is the 7th; the trend query is the 8th.
    const bucketCall = queryMock.mock.calls[6];
    const trendCall = queryMock.mock.calls[7];

    expect(String(bucketCall[0])).toMatch(/d\.status IN \('completed','done'\)/);
    // Reuses the same haversine LATERAL join the per-job board badge
    // uses, so the per-job number and the rollup never disagree.
    expect(String(bucketCall[0])).toMatch(/dispatch_resource_location_history/);
    expect(String(bucketCall[0])).toMatch(/closest_approach_m\s*<\s*50/);
    // The upper bucket label is "> 250 m" — the SQL must use strict
    // greater-than so that a job at exactly 250 m lands in the
    // "100–250 m" bucket, not in the bad-arrivals bucket. Lock that
    // boundary semantic in so a future tidy doesn't quietly flip it
    // back to `>=`.
    expect(String(bucketCall[0])).toMatch(/closest_approach_m\s*<=\s*250/);
    expect(String(bucketCall[0])).toMatch(/closest_approach_m\s*>\s*250\b/);
    expect(String(bucketCall[0])).not.toMatch(/closest_approach_m\s*>=\s*250/);
    expect(bucketCall[1]).toEqual([
      'tenant-A',
      '2026-04-01T00:00:00Z',
      '2026-04-30T23:59:59Z',
    ]);

    expect(String(trendCall[0])).toMatch(/d\.status IN \('completed','done'\)/);
    expect(String(trendCall[0])).toMatch(/GROUP BY DATE\(d\.created_at\)/);
    expect(trendCall[1]).toEqual([
      'tenant-A',
      '2026-04-01T00:00:00Z',
      '2026-04-30T23:59:59Z',
    ]);
  });
});
