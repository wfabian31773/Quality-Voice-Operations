// Locks down GET/PUT /dispatch/settings — the per-tenant override for the
// "too far from address" threshold (meters) consumed by both the dispatch
// board's inline badge color and the auto bad-arrival exception.
//
// Pins:
//   * GET reads `tenants.dispatch_bad_arrival_threshold_m` and exposes it
//     alongside the validation bounds the UI needs to render the input;
//   * GET falls back to the platform default (250) if the tenant lookup
//     fails, so a hiccup never makes the dispatch board render a NaN
//     comparison;
//   * PUT validates the integer + range that mirror the column CHECK
//     constraint and persists via UPDATE tenants;
//   * PUT echoes back the canonical settings shape so the client doesn't
//     have to re-GET.
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

describe('GET /dispatch/settings', () => {
  it('returns the per-tenant threshold and the validation bounds the UI needs', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ m: 800 }],
    });

    const app = await buildApp();
    const res = await request(app).get('/dispatch/settings');

    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({
      bad_arrival_threshold_m: 800,
      bad_arrival_threshold_m_min: 10,
      bad_arrival_threshold_m_max: 5000,
      bad_arrival_threshold_m_default: 250,
    });

    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toMatch(/dispatch_bad_arrival_threshold_m/);
    expect(sql).toMatch(/FROM tenants/);
    expect(queryMock.mock.calls[0][1]).toEqual(['tenant-A']);
  });

  it('falls back to the platform default 250 when the tenant lookup hiccups', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'));

    const app = await buildApp();
    const res = await request(app).get('/dispatch/settings');

    // The endpoint must never 500 the dispatch board for a transient
    // settings read failure — the badge falls back to the historical
    // 250 m default.
    expect(res.status).toBe(200);
    expect(res.body.settings.bad_arrival_threshold_m).toBe(250);
  });
});

describe('PUT /dispatch/settings', () => {
  it('persists the threshold via UPDATE tenants and echoes the canonical shape', async () => {
    // 1) UPDATE tenants
    queryMock.mockResolvedValueOnce({ rows: [] });
    // 2) re-read for the response
    queryMock.mockResolvedValueOnce({ rows: [{ m: 400 }] });

    const app = await buildApp();
    const res = await request(app)
      .put('/dispatch/settings')
      .send({ bad_arrival_threshold_m: 400 });

    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({
      bad_arrival_threshold_m: 400,
      bad_arrival_threshold_m_min: 10,
      bad_arrival_threshold_m_max: 5000,
      bad_arrival_threshold_m_default: 250,
    });

    const updateSql = String(queryMock.mock.calls[0][0]);
    expect(updateSql).toMatch(/UPDATE tenants/);
    expect(updateSql).toMatch(/dispatch_bad_arrival_threshold_m\s*=\s*\$2/);
    expect(queryMock.mock.calls[0][1]).toEqual(['tenant-A', 400]);
  });

  it.each([
    ['below the floor', 5],
    ['above the ceiling', 9001],
    ['non-integer', 250.5],
    ['negative', -100],
    ['NaN', 'definitely-not-a-number'],
  ])('rejects threshold %s with a 400', async (_label, value) => {
    const app = await buildApp();
    const res = await request(app)
      .put('/dispatch/settings')
      .send({ bad_arrival_threshold_m: value });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/bad_arrival_threshold_m/);
    // No UPDATE issued for invalid input — input validation must
    // short-circuit before touching the DB.
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rejects an empty body with a clear 400 (nothing to update)', async () => {
    const app = await buildApp();
    const res = await request(app).put('/dispatch/settings').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No supported settings/);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
