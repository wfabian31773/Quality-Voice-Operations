// Locks down GET/PUT /dispatch/settings — the per-tenant overrides for the
// dispatch board's tunable knobs:
//   * "too far from address" threshold (meters), used by both the inline
//     board badge color and the auto bad-arrival exception;
//   * "tech has been driving too long" threshold (minutes), used by the
//     inline "driving X min" badge color on each en_route board card;
//   * SMS segment cap (task #844), used to hard-block dispatch
//     notification template saves above the configured segment count.
//
// Pins:
//   * GET reads all three knobs in parallel and exposes them alongside
//     the validation bounds the UI needs to render the inputs;
//   * GET falls back to the platform defaults (250 m / 30 min /
//     unlimited sms cap) if any tenant lookup fails, so a hiccup never
//     makes the dispatch board render NaN comparisons or silently start
//     rejecting valid template saves;
//   * PUT validates each knob's integer + range against the column
//     CHECK constraint and persists via UPDATE tenants;
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

// Centralized helper: route every read query to a stable shape so tests
// don't have to track Promise.all read order. Each knob is keyed by the
// column name pattern in its SELECT.
function mockReads({
  badArrivalM,
  longEnRouteMin,
  smsLimit,
}: {
  badArrivalM?: number | null;
  longEnRouteMin?: number | null;
  smsLimit?: number | null;
}) {
  queryMock.mockImplementation((sql: string) => {
    if (/UPDATE tenants/.test(sql)) return Promise.resolve({ rows: [] });
    if (/dispatch_bad_arrival_threshold_m/.test(sql)) {
      return Promise.resolve({ rows: badArrivalM === undefined ? [] : [{ m: badArrivalM }] });
    }
    if (/dispatch_long_en_route_threshold_minutes/.test(sql)) {
      return Promise.resolve({ rows: longEnRouteMin === undefined ? [] : [{ m: longEnRouteMin }] });
    }
    if (/dispatch_sms_segment_limit/.test(sql)) {
      return Promise.resolve({ rows: smsLimit === undefined ? [] : [{ n: smsLimit }] });
    }
    return Promise.resolve({ rows: [] });
  });
}

describe('GET /dispatch/settings', () => {
  it('returns all per-tenant knobs and the validation bounds the UI needs', async () => {
    // GET reads all three per-tenant tunables in parallel: the
    // bad-arrival threshold (meters), the long-en-route threshold
    // (minutes) that drives the inline "driving X min" badge color
    // on each en_route board card, AND the dispatch SMS segment cap
    // (task #844). Order isn't asserted because Promise.all is
    // unordered; the dispatcher is keyed by the SELECT column name.
    mockReads({ badArrivalM: 800, longEnRouteMin: 45, smsLimit: null });

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
      sms_segment_limit: null,
      sms_segment_limit_min: 1,
      sms_segment_limit_max: 10,
    });

    const sqlByCall = queryMock.mock.calls.map((c) => String(c[0]));
    expect(sqlByCall.some((s) => /dispatch_bad_arrival_threshold_m/.test(s))).toBe(true);
    expect(sqlByCall.some((s) => /dispatch_long_en_route_threshold_minutes/.test(s))).toBe(true);
    expect(sqlByCall.some((s) => /dispatch_sms_segment_limit/.test(s))).toBe(true);
    for (const c of queryMock.mock.calls) {
      expect(c[1]).toEqual(['tenant-A']);
    }
  });

  it('exposes the per-tenant SMS segment cap when the tenant has opted in', async () => {
    mockReads({ badArrivalM: 250, longEnRouteMin: 30, smsLimit: 1 });

    const app = await buildApp();
    const res = await request(app).get('/dispatch/settings');

    expect(res.status).toBe(200);
    expect(res.body.settings.sms_segment_limit).toBe(1);

    const sqlByCall = queryMock.mock.calls.map((c) => String(c[0]));
    expect(sqlByCall.some((s) => /dispatch_sms_segment_limit/.test(s))).toBe(true);
  });

  it('falls back to the platform defaults when the tenant lookups hiccup', async () => {
    // All reads must independently degrade — neither should poison
    // the others' response. The dispatch board renders against the
    // hard-coded defaults (250 m / 30 min / unlimited cap) until the
    // next refresh; in particular the SMS cap must stay unlimited so
    // a transient settings read failure never silently starts
    // rejecting valid template saves.
    queryMock.mockRejectedValue(new Error('boom'));

    const app = await buildApp();
    const res = await request(app).get('/dispatch/settings');

    expect(res.status).toBe(200);
    expect(res.body.settings.bad_arrival_threshold_m).toBe(250);
    expect(res.body.settings.long_en_route_threshold_minutes).toBe(30);
    expect(res.body.settings.sms_segment_limit).toBeNull();
  });
});

describe('PUT /dispatch/settings', () => {
  it('persists the bad-arrival threshold via UPDATE tenants and echoes the canonical shape', async () => {
    // 1) UPDATE tenants — the only mutating query in the flow.
    // 2 + 3 + 4) Re-read all three knobs (parallel) for the response.
    mockReads({ badArrivalM: 400, longEnRouteMin: 30, smsLimit: null });

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
      sms_segment_limit: null,
      sms_segment_limit_min: 1,
      sms_segment_limit_max: 10,
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
    mockReads({ badArrivalM: 250, longEnRouteMin: 45, smsLimit: null });

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

  it('persists the SMS segment cap and echoes the canonical shape', async () => {
    mockReads({ badArrivalM: 250, longEnRouteMin: 30, smsLimit: 1 });

    const app = await buildApp();
    const res = await request(app)
      .put('/dispatch/settings')
      .send({ sms_segment_limit: 1 });

    expect(res.status).toBe(200);
    expect(res.body.settings.sms_segment_limit).toBe(1);

    const updateSql = String(queryMock.mock.calls[0][0]);
    expect(updateSql).toMatch(/dispatch_sms_segment_limit\s*=\s*\$2/);
    expect(queryMock.mock.calls[0][1]).toEqual(['tenant-A', 1]);
  });

  it('accepts null to disable the SMS segment cap (back to unlimited)', async () => {
    mockReads({ badArrivalM: 250, longEnRouteMin: 30, smsLimit: null });

    const app = await buildApp();
    const res = await request(app)
      .put('/dispatch/settings')
      .send({ sms_segment_limit: null });

    expect(res.status).toBe(200);
    expect(res.body.settings.sms_segment_limit).toBeNull();
    expect(queryMock.mock.calls[0][1]).toEqual(['tenant-A', null]);
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

  it.each([
    ['zero (would silently behave like unlimited)', 0],
    ['above the editor ceiling', 11],
    ['non-integer', 1.5],
    ['negative', -1],
    ['NaN', 'three'],
  ])('rejects sms_segment_limit %s with a 400', async (_label, value) => {
    const app = await buildApp();
    const res = await request(app)
      .put('/dispatch/settings')
      .send({ sms_segment_limit: value });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/sms_segment_limit/);
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
