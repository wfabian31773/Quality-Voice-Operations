// Locks down GET /dispatch/jobs/:id/route — the new "Route taken" endpoint
// that powers the dispatcher's breadcrumb playback. Verifies tenant
// scoping, ordering, and the response shape (job + points + window).
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

describe('GET /dispatch/jobs/:id/route', () => {
  it('returns ordered breadcrumb scoped to the tenant + job', async () => {
    const t1 = '2026-04-28T15:00:00.000Z';
    const t2 = '2026-04-28T15:01:00.000Z';
    const t3 = '2026-04-28T15:02:00.000Z';

    queryMock
      // job lookup
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'job-1',
            title: 'Replace water heater',
            status: 'completed',
            scheduled_at: '2026-04-28T14:30:00.000Z',
            completed_at: '2026-04-28T15:30:00.000Z',
            resource_id: 'res-1',
            resource_name: 'Alex Chen',
          },
        ],
      })
      // points lookup
      .mockResolvedValueOnce({
        rows: [
          {
            latitude: 37.7749,
            longitude: -122.4194,
            accuracy_m: 8,
            heading_deg: 90,
            speed_mps: 12.5,
            recorded_at: t1,
            received_at: t1,
          },
          {
            latitude: 37.776,
            longitude: -122.418,
            accuracy_m: 6,
            heading_deg: 95,
            speed_mps: 10.1,
            recorded_at: t2,
            received_at: t2,
          },
          {
            latitude: 37.777,
            longitude: -122.4175,
            accuracy_m: 5,
            heading_deg: 100,
            speed_mps: 0,
            recorded_at: t3,
            received_at: t3,
          },
        ],
      });

    const app = await buildApp();
    const res = await request(app).get('/dispatch/jobs/job-1/route');

    expect(res.status).toBe(200);
    expect(res.body.job).toMatchObject({ id: 'job-1', resource_name: 'Alex Chen' });
    expect(res.body.points).toHaveLength(3);
    expect(res.body.points[0]).toMatchObject({ lat: 37.7749, lng: -122.4194 });
    expect(res.body.points[2]).toMatchObject({ lat: 37.777, lng: -122.4175 });
    expect(res.body.window).toEqual({ start: t1, end: t3 });

    // Tenant scoping is enforced on both queries.
    expect(queryMock.mock.calls[0][1]).toEqual(['job-1', 'tenant-A']);
    expect(queryMock.mock.calls[1][1]).toEqual(['tenant-A', 'job-1']);
    // History query orders by recorded_at ascending (oldest first).
    expect(queryMock.mock.calls[1][0]).toMatch(/ORDER BY recorded_at ASC/);
    expect(queryMock.mock.calls[1][0]).toMatch(/active_job_id = \$2/);
  });

  it('returns 404 when the job is not in this tenant', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] }); // job not found

    const app = await buildApp();
    const res = await request(app).get('/dispatch/jobs/missing/route');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    // Critically, we must not query the history table when the job is
    // not in the tenant — that would let a forged job id leak whether
    // any pings exist for a foreign tenant's job.
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('returns an empty points list and null window when no pings exist', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'job-2',
            title: 'Office HVAC',
            status: 'pending',
            scheduled_at: null,
            completed_at: null,
            resource_id: null,
            resource_name: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const app = await buildApp();
    const res = await request(app).get('/dispatch/jobs/job-2/route');

    expect(res.status).toBe(200);
    expect(res.body.points).toEqual([]);
    expect(res.body.window).toEqual({ start: null, end: null });
  });
});
