// Locks down the closest-approach plumbing on GET /dispatch/jobs.
//
// The dispatch board shows "X m from address" inline on on-site /
// in-progress cards using a value computed by a LATERAL haversine
// against the breadcrumb history. These tests pin:
//   * the SQL contract — a single round-trip that joins the history
//     ring and exposes `closest_approach_m` alongside the existing job
//     fields, gated on the cached address geocode being present.
//   * the response normalization — null when the underlying aggregate
//     is empty/NULL, a JS number otherwise, with the internal
//     `_total_count` paging marker stripped before serialization.
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

describe('GET /dispatch/jobs — closest_approach_m', () => {
  it('issues a single LATERAL haversine query gated on the cached address coords', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const app = await buildApp();
    const res = await request(app).get('/dispatch/jobs');

    expect(res.status).toBe(200);
    expect(queryMock).toHaveBeenCalledTimes(1);

    const sql = String(queryMock.mock.calls[0][0]);
    // Single-round-trip pagination is preserved.
    expect(sql).toMatch(/COUNT\(\*\)\s+OVER\(\)/);
    // The closest-approach value is exposed alongside the existing fields.
    expect(sql).toMatch(/ca\.closest_approach_m/);
    // Computed via a LATERAL against the breadcrumb history table —
    // a correlated subquery here would re-run per row and is exactly
    // the regression the listHandlersPerformance test guards against.
    expect(sql).toMatch(
      /LEFT JOIN LATERAL[\s\S]*dispatch_resource_location_history/,
    );
    // Skip the work entirely when the job has no cached geocode (the
    // route replay path lazily backfills these — a brand-new job with
    // no geocode just gets null).
    expect(sql).toMatch(/d\.address_lat\s+IS NOT NULL/);
    expect(sql).toMatch(/d\.address_lon\s+IS NOT NULL/);
    // Tenant scope flows into the LATERAL — cross-tenant breadcrumbs
    // must never leak into the closest-approach number.
    expect(sql).toMatch(/h\.tenant_id\s*=\s*d\.tenant_id/);
    expect(sql).toMatch(/h\.active_job_id\s*=\s*d\.id/);
  });

  it('normalizes closest_approach_m: number when present, null when absent, _total_count stripped', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'job-near',
          title: 'Reached the house',
          status: 'completed',
          closest_approach_m: '12.345',
          _total_count: '3',
        },
        {
          id: 'job-far',
          title: 'Way off',
          status: 'on_site',
          closest_approach_m: 612.7,
          _total_count: '3',
        },
        {
          id: 'job-no-coords',
          title: 'No geocode yet',
          status: 'in_progress',
          closest_approach_m: null,
          _total_count: '3',
        },
      ],
    });

    const app = await buildApp();
    const res = await request(app).get('/dispatch/jobs');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);

    const jobs = res.body.jobs as Array<Record<string, unknown>>;
    expect(jobs).toHaveLength(3);
    // The internal pagination marker must not bleed into the API.
    for (const j of jobs) expect(j._total_count).toBeUndefined();

    // Numeric values come through as JS numbers regardless of whether
    // pg returned a string (NUMERIC) or a number (DOUBLE PRECISION).
    expect(jobs[0].closest_approach_m).toBeCloseTo(12.345, 3);
    expect(typeof jobs[0].closest_approach_m).toBe('number');
    expect(jobs[1].closest_approach_m).toBeCloseTo(612.7, 1);
    expect(typeof jobs[1].closest_approach_m).toBe('number');

    // No breadcrumbs / no cached geocode → explicit null, never NaN
    // (the UI keys the badge off `!= null`, so NaN would render a
    // garbage "NaN m from address" pill).
    expect(jobs[2].closest_approach_m).toBeNull();
  });
});
