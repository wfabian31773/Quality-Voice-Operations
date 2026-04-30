import { describe, it, expect, beforeEach, vi } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({
  query: queryMock,
  release: releaseMock,
}));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock, connect: connectMock }),
  withTenantContext: vi.fn(
    async (_client: unknown, _tenantId: string, fn: () => Promise<unknown>) => fn(),
  ),
  // Mirror the real helper closely enough that the route under test
  // doesn't notice — we just need a `client.query` it can call inside
  // the callback.
  withPrivilegedClient: vi.fn(
    async (fn: (c: { query: typeof queryMock }) => Promise<unknown>) => {
      await queryMock('BEGIN');
      await queryMock('SET LOCAL row_security = off');
      try {
        const result = await fn({ query: queryMock });
        await queryMock('COMMIT');
        return result;
      } catch (err) {
        await queryMock('ROLLBACK');
        throw err;
      }
    },
  ),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../platform/audit/AuditService', () => ({
  writeAuditLog: vi.fn(),
  extractIp: () => '127.0.0.1',
}));

vi.mock('../../platform/messaging/SlackWebhookNotifier', () => ({
  postToOpsSlackWebhook: vi.fn(),
  getOpsSlackWebhookUrl: vi.fn(() => null),
}));
vi.mock('../../platform/email/EmailService', () => ({
  sendEmail: vi.fn(),
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: unknown }).user = {
      tenantId: 'tenant-x',
      userId: 'user-x',
      role: 'platform_admin',
      isPlatformAdmin: true,
      email: 'admin@acme.test',
    };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePlatformAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireMiniSystemWrite: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import platformAdminRoutes from '../../server/admin-api/routes/platformAdmin';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(platformAdminRoutes);
  return app;
}

describe('GET /platform/checkout-directions', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockClear();
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  });

  it('aggregates direction counts across both audit-log actions and computes per-day buckets', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (/GROUP BY day, direction/i.test(s)) {
        return {
          rows: [
            { day: new Date('2026-04-28T00:00:00Z'), direction: 'upgrade', count: '4' },
            { day: new Date('2026-04-28T00:00:00Z'), direction: 'downgrade', count: '1' },
            { day: new Date('2026-04-29T00:00:00Z'), direction: 'upgrade', count: '2' },
            { day: new Date('2026-04-29T00:00:00Z'), direction: 'interval_change', count: '3' },
          ],
        };
      }
      if (/GROUP BY direction/i.test(s)) {
        return {
          rows: [
            { direction: 'upgrade', count: '6' },
            { direction: 'downgrade', count: '1' },
            { direction: 'interval_change', count: '3' },
            { direction: 'new', count: '5' },
          ],
        };
      }
      if (/GROUP BY from_plan, to_plan/i.test(s)) {
        return {
          rows: [
            { from_plan: 'enterprise', to_plan: 'pro', count: '7' },
            { from_plan: 'pro', to_plan: 'starter', count: '2' },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/platform/checkout-directions?days=14');

    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(14);
    expect(res.body.totals).toEqual({
      upgrade: 6,
      downgrade: 1,
      interval_change: 3,
      same: 0,
      new: 5,
      unknown: 0,
    });
    expect(res.body.byDay).toEqual([
      { day: '2026-04-28', direction: 'upgrade', count: 4 },
      { day: '2026-04-28', direction: 'downgrade', count: 1 },
      { day: '2026-04-29', direction: 'upgrade', count: 2 },
      { day: '2026-04-29', direction: 'interval_change', count: 3 },
    ]);
    expect(res.body.topDowngradeTransitions).toEqual([
      { fromPlan: 'enterprise', toPlan: 'pro', count: 7 },
      { fromPlan: 'pro', toPlan: 'starter', count: 2 },
    ]);
  });

  it('clamps the days param into [1, 365] so a hostile query can never trigger a multi-year scan', async () => {
    await request(buildApp()).get('/platform/checkout-directions?days=99999');
    // First call to client.query is BEGIN; check the parameterised value
    // we passed to make_interval(days => $1::int).
    const intervalCall = queryMock.mock.calls.find(([sql]) =>
      /make_interval/i.test(String(sql)),
    );
    expect(intervalCall).toBeDefined();
    expect(intervalCall![1]).toEqual([365]);

    queryMock.mockClear();
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    await request(buildApp()).get('/platform/checkout-directions?days=-7');
    const intervalCall2 = queryMock.mock.calls.find(([sql]) =>
      /make_interval/i.test(String(sql)),
    );
    expect(intervalCall2![1]).toEqual([1]);
  });

  it('defaults to a 30-day window when no days param is provided', async () => {
    const res = await request(buildApp()).get('/platform/checkout-directions');
    expect(res.status).toBe(200);
    expect(res.body.windowDays).toBe(30);
  });

  it("buckets unknown direction values under 'unknown' instead of leaking raw input", async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (/GROUP BY day, direction/i.test(s)) {
        return { rows: [] };
      }
      if (/GROUP BY direction/i.test(s)) {
        return {
          rows: [
            { direction: 'upgrade', count: '1' },
            { direction: 'something-weird', count: '2' },
          ],
        };
      }
      if (/GROUP BY from_plan, to_plan/i.test(s)) {
        return { rows: [] };
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/platform/checkout-directions');
    expect(res.status).toBe(200);
    expect(res.body.totals.upgrade).toBe(1);
    expect(res.body.totals.unknown).toBe(2);
    // Make sure the weird value never leaks back to the client as a key.
    expect(Object.keys(res.body.totals)).toEqual(
      expect.arrayContaining(['upgrade', 'downgrade', 'interval_change', 'same', 'new', 'unknown']),
    );
    expect(Object.keys(res.body.totals)).not.toContain('something-weird');
  });

  it('returns 500 when the underlying query throws', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)\b/i.test(s)) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error('simulated DB outage');
    });

    const res = await request(buildApp()).get('/platform/checkout-directions');
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/checkout direction/i);
  });
});
