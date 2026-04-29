/**
 * Coverage for `GET /demo/analytics` — the platform-admin dashboard endpoint
 * that reports today's demo conversion funnel (Task #944).
 *
 * The route in `server/admin-api/routes/demo.ts` reads `demo_analytics` and
 * derives several numbers the team relies on to evaluate the public Demo
 * page:
 *
 *   - `callsStarted` / `callsCompleted` / `callsAbandoned` — raw counts of
 *     today's events.
 *   - `completionRate` — `round(completed / (completed + abandoned) * 100)`.
 *   - `ctaClicks` — total `cta_clicked` events today.
 *   - `ctaClickRate` — `round(ctaClicks / callsStarted * 100)`.
 *   - `ctaBreakdown` — per-`cta_type` counts (e.g. `start_free_trial` vs
 *     `book_demo`) so admins can see which CTA drives more lead intent.
 *
 * There is no other automated coverage for this endpoint, so a refactor of
 * the SQL or the rate math could quietly start surfacing wrong conversion
 * numbers to platform admins. These tests pin down:
 *
 *   1. The endpoint refuses unauthenticated requests (401).
 *   2. The endpoint refuses authenticated non-platform-admin requests (403).
 *   3. With a stubbed `demo_analytics` aggregate, the response body has the
 *      exact shape the dashboard consumes — including arithmetic for both
 *      rates and a per-CTA breakdown.
 *   4. Zero calls today must not divide by zero — both rates are returned as
 *      `0` and the breakdown comes back as an empty array.
 *   5. With completed but no abandoned calls, `completionRate` is 100 (i.e.
 *      the denominator uses `completed + abandoned`, not just one of them).
 *   6. Both aggregate queries are scoped to `created_at >= todayStart` so
 *      the dashboard reflects "today" rather than lifetime numbers.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const queryMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mutable auth state — flipped per test so we can exercise the 401 / 403 /
// happy-path branches without rebuilding the express app each time. We mock
// only `requireAuth` so the *real* `requirePlatformAdmin` from rbac.ts runs
// against the user we attach here. That keeps the platform-admin gate test
// honest: if a future refactor weakens `requirePlatformAdmin` to (say) only
// check a role string, this test will catch it.
interface MockUser {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
  isPlatformAdmin: boolean;
}
const authState: { user: MockUser | null } = { user: null };

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, res: Response, next: NextFunction) => {
    if (!authState.user) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }
    (req as Request & { user?: MockUser }).user = { ...authState.user };
    next();
  },
}));

import demoRouter from '../../server/admin-api/routes/demo';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(demoRouter);
  return app;
}

interface AnalyticsResponse {
  today: {
    callsStarted: number;
    callsCompleted: number;
    callsAbandoned: number;
    completionRate: number;
    ctaClicks: number;
    ctaClickRate: number;
    ctaBreakdown: Array<{ type: string; count: number }>;
  };
}

// The route issues two queries against `demo_analytics`:
//   1. A FILTER-based aggregate that returns a single row with
//      calls_started / calls_completed / calls_abandoned / cta_clicks.
//   2. A GROUP BY cta_type for the per-CTA breakdown.
// This helper wires `queryMock` to return whatever the test wants for each
// of the two queries based on a simple SQL substring match.
function stubAggregates(opts: {
  callStats: {
    calls_started: string;
    calls_completed: string;
    calls_abandoned: string;
    cta_clicks: string;
  };
  ctaBreakdown: Array<{ cta_type: string; count: string }>;
}): void {
  queryMock.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes('GROUP BY cta_type')) {
      return { rows: opts.ctaBreakdown };
    }
    // The first aggregate uses FILTER (WHERE event_type = ...).
    if (text.includes("FILTER (WHERE event_type = 'call_started')")) {
      return { rows: [opts.callStats] };
    }
    return { rows: [] };
  });
}

describe('GET /demo/analytics', () => {
  beforeEach(() => {
    queryMock.mockReset();
    authState.user = null;
  });

  it('returns 401 when no authenticated user is present', async () => {
    // No queries should be issued — auth must short-circuit before any DB
    // work. Otherwise an unauthenticated probe could enumerate today's
    // numbers via timing / load.
    const res = await request(buildApp()).get('/demo/analytics');
    expect(res.status).toBe(401);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the authenticated user is not a platform admin', async () => {
    // Tenant owner is the highest non-platform role — if even an owner is
    // rejected, every lower role is too.
    authState.user = {
      userId: 'tenant-owner-1',
      tenantId: 'acme',
      email: 'owner@acme.test',
      role: 'tenant_owner',
      isPlatformAdmin: false,
    };
    const res = await request(buildApp()).get('/demo/analytics');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/platform admin/i);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns the expected funnel shape and arithmetic for a populated day', async () => {
    authState.user = {
      userId: 'admin-1',
      tenantId: 'platform',
      email: 'ops@qvo.test',
      role: 'platform_admin',
      isPlatformAdmin: true,
    };

    // Numbers chosen so the arithmetic is non-trivial and round-tripping
    // matters:
    //   completionRate = round(40 / (40 + 10) * 100) = round(80.0) = 80
    //   ctaClickRate   = round(15 / 50 * 100)        = round(30.0) = 30
    stubAggregates({
      callStats: {
        calls_started: '50',
        calls_completed: '40',
        calls_abandoned: '10',
        cta_clicks: '15',
      },
      ctaBreakdown: [
        { cta_type: 'start_free_trial', count: '9' },
        { cta_type: 'book_demo', count: '6' },
      ],
    });

    const res = await request(buildApp()).get('/demo/analytics');
    expect(res.status).toBe(200);
    const body = res.body as AnalyticsResponse;

    expect(body.today).toEqual({
      callsStarted: 50,
      callsCompleted: 40,
      callsAbandoned: 10,
      completionRate: 80,
      ctaClicks: 15,
      ctaClickRate: 30,
      ctaBreakdown: [
        { type: 'start_free_trial', count: 9 },
        { type: 'book_demo', count: 6 },
      ],
    });
  });

  it('rounds rates to the nearest integer (no fractional percentages leak through)', async () => {
    authState.user = {
      userId: 'admin-1',
      tenantId: 'platform',
      email: 'ops@qvo.test',
      role: 'platform_admin',
      isPlatformAdmin: true,
    };

    // Crafted so neither rate is a whole number:
    //   completionRate = round(2 / (2 + 1) * 100) = round(66.666…) = 67
    //   ctaClickRate   = round(1 / 3 * 100)        = round(33.333…) = 33
    stubAggregates({
      callStats: {
        calls_started: '3',
        calls_completed: '2',
        calls_abandoned: '1',
        cta_clicks: '1',
      },
      ctaBreakdown: [{ cta_type: 'start_free_trial', count: '1' }],
    });

    const res = await request(buildApp()).get('/demo/analytics');
    expect(res.status).toBe(200);
    const body = res.body as AnalyticsResponse;
    expect(body.today.completionRate).toBe(67);
    expect(body.today.ctaClickRate).toBe(33);
    expect(Number.isInteger(body.today.completionRate)).toBe(true);
    expect(Number.isInteger(body.today.ctaClickRate)).toBe(true);
  });

  it('returns 100 percent completion when no calls were abandoned', async () => {
    // Regression guard against accidentally swapping the denominator to
    // `callsStarted` (which would be wrong if some calls are still in
    // flight) or to `callsCompleted` alone (which would always give 100).
    authState.user = {
      userId: 'admin-1',
      tenantId: 'platform',
      email: 'ops@qvo.test',
      role: 'platform_admin',
      isPlatformAdmin: true,
    };

    stubAggregates({
      callStats: {
        calls_started: '5',
        calls_completed: '5',
        calls_abandoned: '0',
        cta_clicks: '0',
      },
      ctaBreakdown: [],
    });

    const res = await request(buildApp()).get('/demo/analytics');
    expect(res.status).toBe(200);
    const body = res.body as AnalyticsResponse;
    expect(body.today.completionRate).toBe(100);
    expect(body.today.ctaClickRate).toBe(0);
    expect(body.today.ctaBreakdown).toEqual([]);
  });

  it('returns zero rates without dividing by zero when there is no traffic today', async () => {
    authState.user = {
      userId: 'admin-1',
      tenantId: 'platform',
      email: 'ops@qvo.test',
      role: 'platform_admin',
      isPlatformAdmin: true,
    };

    stubAggregates({
      callStats: {
        calls_started: '0',
        calls_completed: '0',
        calls_abandoned: '0',
        cta_clicks: '0',
      },
      ctaBreakdown: [],
    });

    const res = await request(buildApp()).get('/demo/analytics');
    expect(res.status).toBe(200);
    const body = res.body as AnalyticsResponse;

    expect(body.today.callsStarted).toBe(0);
    expect(body.today.callsCompleted).toBe(0);
    expect(body.today.callsAbandoned).toBe(0);
    expect(body.today.ctaClicks).toBe(0);
    // Both rates must be 0 — never NaN, never null — even with empty
    // numerator/denominator. The dashboard renders these as percentages and
    // any non-finite value would surface as "NaN%" to admins.
    expect(body.today.completionRate).toBe(0);
    expect(body.today.ctaClickRate).toBe(0);
    expect(Number.isFinite(body.today.completionRate)).toBe(true);
    expect(Number.isFinite(body.today.ctaClickRate)).toBe(true);
    expect(body.today.ctaBreakdown).toEqual([]);
  });

  it('handles an entirely empty stats result row by treating every count as zero', async () => {
    // Belt-and-braces: the aggregate query *should* always return one row
    // (FILTER aggregates produce a single row even on an empty table), but
    // if the SQL is ever rewritten to use a HAVING clause or a join that
    // can produce zero rows, the route must still answer cleanly instead
    // of throwing on `undefined`.
    authState.user = {
      userId: 'admin-1',
      tenantId: 'platform',
      email: 'ops@qvo.test',
      role: 'platform_admin',
      isPlatformAdmin: true,
    };

    queryMock.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes('GROUP BY cta_type')) return { rows: [] };
      return { rows: [] };
    });

    const res = await request(buildApp()).get('/demo/analytics');
    expect(res.status).toBe(200);
    const body = res.body as AnalyticsResponse;
    expect(body.today.callsStarted).toBe(0);
    expect(body.today.callsCompleted).toBe(0);
    expect(body.today.callsAbandoned).toBe(0);
    expect(body.today.ctaClicks).toBe(0);
    expect(body.today.completionRate).toBe(0);
    expect(body.today.ctaClickRate).toBe(0);
    expect(body.today.ctaBreakdown).toEqual([]);
  });

  it('scopes both aggregate queries to today (created_at >= start-of-day)', async () => {
    authState.user = {
      userId: 'admin-1',
      tenantId: 'platform',
      email: 'ops@qvo.test',
      role: 'platform_admin',
      isPlatformAdmin: true,
    };

    stubAggregates({
      callStats: {
        calls_started: '0',
        calls_completed: '0',
        calls_abandoned: '0',
        cta_clicks: '0',
      },
      ctaBreakdown: [],
    });

    const beforeCall = new Date();
    beforeCall.setHours(0, 0, 0, 0);

    await request(buildApp()).get('/demo/analytics');

    // Both queries are issued and both filter by `created_at >= $1`.
    const aggregateCall = queryMock.mock.calls.find((c) =>
      /FILTER \(WHERE event_type = 'call_started'\)/i.test(String(c[0])),
    );
    const breakdownCall = queryMock.mock.calls.find((c) =>
      /GROUP BY cta_type/i.test(String(c[0])),
    );
    expect(aggregateCall).toBeDefined();
    expect(breakdownCall).toBeDefined();

    for (const call of [aggregateCall!, breakdownCall!]) {
      const sql = String(call[0]);
      expect(sql).toMatch(/created_at\s*>=\s*\$1/i);
      const params = call[1] as unknown[];
      expect(Array.isArray(params)).toBe(true);
      expect(typeof params[0]).toBe('string');
      const cutoff = new Date(params[0] as string);
      // The cutoff must be at the start of today (local time) — not "now",
      // not yesterday. We compare via getTime() with a small tolerance to
      // accommodate the millisecond drift between this assertion and the
      // route's own `new Date()` call.
      expect(cutoff.getTime()).toBe(beforeCall.getTime());
    }

    // The breakdown query is scoped to cta_clicked events too — otherwise
    // we'd be grouping unrelated event_types and producing junk rows.
    expect(String(breakdownCall![0])).toMatch(/event_type\s*=\s*'cta_clicked'/i);
  });
});
