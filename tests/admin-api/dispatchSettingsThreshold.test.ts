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
    // GET reads both per-tenant tunables in parallel: the bad-arrival
    // threshold (meters) AND the long-en-route threshold (minutes)
    // that drives the inline "driving X min" badge color on each
    // en_route board card. Order isn't asserted because Promise.all
    // is unordered; both queries are mocked with the same shape.
    queryMock.mockImplementation((sql: string) => {
      if (/dispatch_bad_arrival_threshold_m/.test(sql)) {
        return Promise.resolve({ rows: [{ m: 800 }] });
      }
      if (/dispatch_long_en_route_threshold_minutes/.test(sql)) {
        return Promise.resolve({ rows: [{ m: 45 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const app = await buildApp();
    const res = await request(app).get('/dispatch/settings');

    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({
      bad_arrival_threshold_m: 800,
      bad_arrival_threshold_m_min: 10,
      bad_arrival_threshold_m_max: 5000,
      bad_arrival_threshold_m_default: 250,
      long_en_route_threshold_minutes: 45,
      long_en_route_threshold_minutes_min: 5,
      long_en_route_threshold_minutes_max: 480,
      long_en_route_threshold_minutes_default: 30,
    });

    const sqlByCall = queryMock.mock.calls.map((c) => String(c[0]));
    expect(sqlByCall.some((s) => /dispatch_bad_arrival_threshold_m/.test(s))).toBe(true);
    expect(sqlByCall.some((s) => /dispatch_long_en_route_threshold_minutes/.test(s))).toBe(true);
    for (const c of queryMock.mock.calls) {
      expect(c[1]).toEqual(['tenant-A']);
    }
  });

  it('falls back to the platform defaults when the tenant lookups hiccup', async () => {
    // Both reads must independently degrade — neither should poison
    // the other's response. The dispatch board renders against the
    // hard-coded defaults (250 m / 30 min) until the next refresh.
    queryMock.mockRejectedValue(new Error('boom'));

    const app = await buildApp();
    const res = await request(app).get('/dispatch/settings');

    expect(res.status).toBe(200);
    expect(res.body.settings.bad_arrival_threshold_m).toBe(250);
    expect(res.body.settings.long_en_route_threshold_minutes).toBe(30);
  });
});

describe('PUT /dispatch/settings', () => {
  it('persists the threshold via UPDATE tenants and echoes the canonical shape', async () => {
    // 1) UPDATE tenants — the only mutating query in the flow.
    // 2 + 3) Re-read for the response (parallel read of both knobs).
    queryMock.mockImplementation((sql: string) => {
      if (/UPDATE tenants/.test(sql)) return Promise.resolve({ rows: [] });
      if (/dispatch_bad_arrival_threshold_m/.test(sql)) {
        return Promise.resolve({ rows: [{ m: 400 }] });
      }
      if (/dispatch_long_en_route_threshold_minutes/.test(sql)) {
        return Promise.resolve({ rows: [{ m: 30 }] });
      }
      return Promise.resolve({ rows: [] });
    });

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
      long_en_route_threshold_minutes: 30,
      long_en_route_threshold_minutes_min: 5,
      long_en_route_threshold_minutes_max: 480,
      long_en_route_threshold_minutes_default: 30,
    });

    const updateSql = String(queryMock.mock.calls[0][0]);
    expect(updateSql).toMatch(/UPDATE tenants/);
    expect(updateSql).toMatch(/dispatch_bad_arrival_threshold_m\s*=\s*\$2/);
    expect(queryMock.mock.calls[0][1]).toEqual(['tenant-A', 400]);
  });

  it('persists the long-en-route threshold and echoes the canonical shape', async () => {
    // The "tech has been driving too long" knob lives on the same
    // endpoint so the UI doesn't need a second round-trip; the
    // handler validates against the column's CHECK range (5–480 min).
    queryMock.mockImplementation((sql: string) => {
      if (/UPDATE tenants/.test(sql)) return Promise.resolve({ rows: [] });
      if (/dispatch_bad_arrival_threshold_m/.test(sql)) {
        return Promise.resolve({ rows: [{ m: 250 }] });
      }
      if (/dispatch_long_en_route_threshold_minutes/.test(sql)) {
        return Promise.resolve({ rows: [{ m: 45 }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const app = await buildApp();
    const res = await request(app)
      .put('/dispatch/settings')
      .send({ long_en_route_threshold_minutes: 45 });

    expect(res.status).toBe(200);
    expect(res.body.settings.long_en_route_threshold_minutes).toBe(45);

    const updateSql = String(queryMock.mock.calls[0][0]);
    expect(updateSql).toMatch(/UPDATE tenants/);
    expect(updateSql).toMatch(/dispatch_long_en_route_threshold_minutes\s*=\s*\$2/);
    expect(queryMock.mock.calls[0][1]).toEqual(['tenant-A', 45]);
  });

  it.each([
    ['below the floor', 5],
    ['above the ceiling', 9001],
    ['non-integer', 250.5],
    ['negative', -100],
    ['NaN', 'definitely-not-a-number'],
  ])('rejects bad-arrival threshold %s with a 400', async (_label, value) => {
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

  it.each([
    ['below the floor', 1],
    ['above the ceiling', 9001],
    ['non-integer', 30.5],
    ['negative', -10],
    ['NaN', 'definitely-not-a-number'],
  ])('rejects long-en-route threshold %s with a 400', async (_label, value) => {
    const app = await buildApp();
    const res = await request(app)
      .put('/dispatch/settings')
      .send({ long_en_route_threshold_minutes: value });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/long_en_route_threshold_minutes/);
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
