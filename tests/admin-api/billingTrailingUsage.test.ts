/**
 * Coverage for `GET /billing/usage/trailing` (Task #1113):
 *
 *   GET /billing/usage/trailing?months=N
 *
 * Powers the BillingEstimator's "cheapest plan" recommendation banner.
 * The two non-obvious behaviors we need to lock down here are:
 *
 *   1. Zero-fill: months with no `usage_metrics` row (= 0 AI minutes that
 *      month) must still appear in the response with `aiMinutes: 0`. The
 *      original implementation skipped them, which inflated the trailing
 *      average and produced misleading downgrade recommendations for any
 *      tenant who had a quiet month.
 *   2. The `averageAiMinutes` returned to the client must be computed
 *      over the *full* requested window (= N months, zero-filled), not
 *      just the months that happened to have rows.
 *
 * The route is exercised against an in-memory express app with mocked
 * platform pool / auth / RBAC, matching the pattern used by every other
 * `tests/admin-api/*.test.ts` spec.
 */
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
    async (_client: unknown, _tenantId: string, fn: () => Promise<void>) => fn(),
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

vi.mock('../../platform/billing/stripe/checkout', () => ({
  createCheckoutSession: vi.fn(),
  createPortalSession: vi.fn(),
}));

vi.mock('../../platform/billing/stripe/webhook', () => ({
  constructStripeEvent: vi.fn(),
  handleStripeEvent: vi.fn(),
}));

vi.mock('../../platform/billing/stripe/effectiveRate', () => ({
  getTenantEffectiveRate: vi.fn(),
}));

vi.mock('../../platform/billing/budget/checkBudget', () => ({
  checkBudget: vi.fn(),
}));

const currentUser = {
  tenantId: 'tenant-trailing',
  userId: 'user-1',
  role: 'manager',
  isPlatformAdmin: false,
  email: 'manager@acme.test',
};

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: unknown }).user = { ...currentUser };
    next();
  },
}));

vi.mock('../../server/admin-api/middleware/rbac', () => ({
  requireRole: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requirePlatformAdmin: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import billingRoutes from '../../server/admin-api/routes/billing';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(billingRoutes);
  return app;
}

interface RowSet {
  rows: Array<Record<string, unknown>>;
}

/**
 * Install a stub that matches the trailing-usage CTE and returns the
 * given pre-zero-filled monthly series. Any other SQL (BEGIN/COMMIT/etc.)
 * gets an empty result set so the handler still completes cleanly.
 */
function stubTrailing(rowSet: RowSet): void {
  queryMock.mockImplementation(async (sql: string) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }
    if (/SET LOCAL/i.test(sql)) {
      return { rows: [], rowCount: 0 };
    }
    if (/window_months/i.test(sql) && /generate_series/i.test(sql)) {
      return { rows: rowSet.rows, rowCount: rowSet.rows.length };
    }
    return { rows: [], rowCount: 0 };
  });
}

describe('GET /billing/usage/trailing', () => {
  beforeEach(() => {
    queryMock.mockReset();
    releaseMock.mockReset();
    connectMock.mockClear();
  });

  it('builds a CTE with generate_series + LEFT JOIN so months with zero AI minutes are zero-filled', async () => {
    stubTrailing({
      rows: [
        { month: '2026-03', minutes: '300' },
        { month: '2026-02', minutes: '0' },
        { month: '2026-01', minutes: '0' },
      ],
    });

    const res = await request(buildApp()).get('/billing/usage/trailing?months=3');

    expect(res.status).toBe(200);
    // Locks in the zero-fill SQL contract — if a future refactor drops
    // the LEFT JOIN against `generate_series`, this assertion fires
    // before the bug ever reaches a tenant.
    const sqls = queryMock.mock.calls.map(([sql]) => String(sql));
    const trailingSql = sqls.find((s) => /window_months/i.test(s));
    expect(trailingSql).toBeDefined();
    expect(trailingSql).toMatch(/generate_series/i);
    expect(trailingSql).toMatch(/LEFT JOIN/i);
  });

  it('averages over the full N-month window (zero-filled), not just months with data', async () => {
    // 0 / 0 / 300 across 3 months → average should be 100, NOT 300.
    // Skipping zero months would push a Pro tenant toward Starter on the
    // strength of a single month's usage.
    stubTrailing({
      rows: [
        { month: '2026-03', minutes: '300' },
        { month: '2026-02', minutes: '0' },
        { month: '2026-01', minutes: '0' },
      ],
    });

    const res = await request(buildApp()).get('/billing/usage/trailing?months=3');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      months: 3,
      monthsWithData: 1,
      averageAiMinutes: 100,
    });
    expect(res.body.monthly).toHaveLength(3);
    expect(res.body.monthly.map((m: { aiMinutes: number }) => m.aiMinutes))
      .toEqual([300, 0, 0]);
  });

  it('returns averageAiMinutes = 0 and monthsWithData = 0 for an all-zero window (new tenant)', async () => {
    stubTrailing({
      rows: [
        { month: '2026-03', minutes: '0' },
        { month: '2026-02', minutes: '0' },
        { month: '2026-01', minutes: '0' },
      ],
    });

    const res = await request(buildApp()).get('/billing/usage/trailing?months=3');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      months: 3,
      monthsWithData: 0,
      averageAiMinutes: 0,
    });
    expect(res.body.monthly).toHaveLength(3);
  });

  it('clamps months to [1, 12] and falls back to 3 for non-numeric / out-of-range inputs', async () => {
    const cases: Array<{ query: string; expected: number }> = [
      { query: '?months=6', expected: 6 },
      { query: '?months=12', expected: 12 },
      { query: '?months=0', expected: 3 },
      { query: '?months=99', expected: 3 },
      { query: '?months=garbage', expected: 3 },
      { query: '', expected: 3 },
    ];

    for (const { query, expected } of cases) {
      queryMock.mockReset();
      stubTrailing({ rows: [] });
      const res = await request(buildApp()).get(`/billing/usage/trailing${query}`);
      expect(res.status).toBe(200);
      expect(res.body.months).toBe(expected);
      // The route passes `months` as the second bound parameter; verify
      // it actually flows through to the SQL invocation.
      const trailingCall = queryMock.mock.calls.find(([sql]) =>
        /window_months/i.test(String(sql)),
      );
      expect(trailingCall).toBeDefined();
      expect(trailingCall![1]).toEqual(['tenant-trailing', expected]);
    }
  });

  describe('compareToPriorYear=true (year-over-year overlay)', () => {
    it('omits monthlyPriorYear and uses the original SQL when the param is absent', async () => {
      stubTrailing({
        rows: [
          { month: '2026-03', minutes: '300' },
          { month: '2026-02', minutes: '250' },
          { month: '2026-01', minutes: '200' },
        ],
      });

      const res = await request(buildApp()).get('/billing/usage/trailing?months=3');

      expect(res.status).toBe(200);
      expect(res.body.monthlyPriorYear).toBeUndefined();
      const trailingSql = queryMock.mock.calls
        .map(([sql]) => String(sql))
        .find((s) => /window_months/i.test(s));
      expect(trailingSql).toBeDefined();
      expect(trailingSql).not.toMatch(/prior_minutes/i);
      expect(trailingSql).not.toMatch(/\$2::int \+ 12/);
    });

    it('returns monthlyPriorYear aligned 1:1 with monthly when compareToPriorYear=true', async () => {
      stubTrailing({
        rows: [
          { month: '2026-03', minutes: '300', prior_month: '2025-03', prior_minutes: '250' },
          { month: '2026-02', minutes: '320', prior_month: '2025-02', prior_minutes: '180' },
          { month: '2026-01', minutes: '280', prior_month: '2025-01', prior_minutes: '210' },
        ],
      });

      const res = await request(buildApp()).get(
        '/billing/usage/trailing?months=3&compareToPriorYear=true',
      );

      expect(res.status).toBe(200);
      expect(res.body.monthly).toEqual([
        { month: '2026-03', aiMinutes: 300 },
        { month: '2026-02', aiMinutes: 320 },
        { month: '2026-01', aiMinutes: 280 },
      ]);
      expect(res.body.monthlyPriorYear).toEqual([
        { month: '2025-03', aiMinutes: 250 },
        { month: '2025-02', aiMinutes: 180 },
        { month: '2025-01', aiMinutes: 210 },
      ]);
    });

    it('passes through null prior_minutes as aiMinutes: null (no fabricated zero)', async () => {
      stubTrailing({
        rows: [
          { month: '2026-03', minutes: '300', prior_month: '2025-03', prior_minutes: '250' },
          { month: '2026-02', minutes: '320', prior_month: '2025-02', prior_minutes: null },
          { month: '2026-01', minutes: '280', prior_month: '2025-01', prior_minutes: null },
        ],
      });

      const res = await request(buildApp()).get(
        '/billing/usage/trailing?months=3&compareToPriorYear=true',
      );

      expect(res.status).toBe(200);
      expect(res.body.monthlyPriorYear).toEqual([
        { month: '2025-03', aiMinutes: 250 },
        { month: '2025-02', aiMinutes: null },
        { month: '2025-01', aiMinutes: null },
      ]);
    });

    it('uses the widened SQL (12+N month window, prior_minutes column) when YoY is requested', async () => {
      stubTrailing({ rows: [] });

      await request(buildApp()).get(
        '/billing/usage/trailing?months=6&compareToPriorYear=1',
      );

      const trailingSql = queryMock.mock.calls
        .map(([sql]) => String(sql))
        .find((s) => /window_months/i.test(s));
      expect(trailingSql).toBeDefined();
      expect(trailingSql).toMatch(/prior_minutes/i);
      expect(trailingSql).toMatch(/\(\$2::int \+ 12\)/);
      expect(trailingSql).toMatch(/LEFT JOIN monthly_totals pt/i);
    });

    it('accepts compareToPriorYear=true and compareToPriorYear=1 as truthy', async () => {
      for (const value of ['true', '1']) {
        queryMock.mockReset();
        stubTrailing({
          rows: [
            { month: '2026-03', minutes: '300', prior_month: '2025-03', prior_minutes: '100' },
          ],
        });
        const res = await request(buildApp()).get(
          `/billing/usage/trailing?months=1&compareToPriorYear=${value}`,
        );
        expect(res.status).toBe(200);
        expect(res.body.monthlyPriorYear).toEqual([
          { month: '2025-03', aiMinutes: 100 },
        ]);
      }
    });

    it('treats other compareToPriorYear values as falsy (no overlay)', async () => {
      stubTrailing({
        rows: [
          { month: '2026-03', minutes: '300' },
        ],
      });
      const res = await request(buildApp()).get(
        '/billing/usage/trailing?months=1&compareToPriorYear=yes',
      );
      expect(res.status).toBe(200);
      expect(res.body.monthlyPriorYear).toBeUndefined();
    });
  });

  it('rolls back and 500s when the query throws (no leaked client)', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (/^(BEGIN|COMMIT)\b/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/^ROLLBACK\b/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/SET LOCAL/i.test(sql)) return { rows: [], rowCount: 0 };
      if (/window_months/i.test(sql)) {
        throw new Error('boom');
      }
      return { rows: [], rowCount: 0 };
    });

    const res = await request(buildApp()).get('/billing/usage/trailing?months=3');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Failed to retrieve trailing usage' });
    // Connection must always be released even on the error path.
    expect(releaseMock).toHaveBeenCalled();
    // ROLLBACK must be issued so we don't leave a zombie transaction.
    const sqls = queryMock.mock.calls.map(([sql]) => String(sql).trim().toUpperCase());
    expect(sqls.some((s) => s.startsWith('ROLLBACK'))).toBe(true);
  });
});
