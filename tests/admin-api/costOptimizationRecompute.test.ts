// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

// Route-level coverage for POST /cost-optimization/recompute: range
// forwarding, response shape, 400 on bad input, 500 on failure.

const recomputeCostAnalyticsMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: vi.fn(), connect: vi.fn() }),
  withTenantContext: vi.fn(
    async (_client: unknown, _tenantId: string, fn: () => Promise<void>) => fn(),
  ),
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

vi.mock('../../platform/billing/cost', () => ({
  getCostOptimizationAnalytics: vi.fn(),
  getConversationCosts: vi.fn(),
  getCostBudgetSettings: vi.fn(),
  upsertCostBudgetSettings: vi.fn(),
  getCacheStats: vi.fn(),
  getRoutingDistribution: vi.fn(),
  getConversationCost: vi.fn(),
  recomputeCostAnalytics: recomputeCostAnalyticsMock,
}));

vi.mock('../../platform/billing/tenantCurrency', () => ({
  getTenantBillingCurrency: vi.fn(async () => 'eur'),
}));

vi.mock('../../server/admin-api/middleware/auth', () => ({
  requireAuth: (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user?: unknown }).user = {
      tenantId: 'tenant-eur',
      userId: 'user-1',
      email: 'eu@acme.test',
      role: 'tenant_owner',
      isPlatformAdmin: false,
    };
    next();
  },
}));

beforeEach(() => {
  recomputeCostAnalyticsMock.mockReset();
});

async function buildApp(): Promise<express.Express> {
  const router = (await import('../../server/admin-api/routes/costOptimization')).default;
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

const SAMPLE_SUMMARY = {
  totalConversations: 9,
  totalCostCents: 1800,
  avgCostPerConversationCents: 200,
  totalSttCostCents: 200,
  totalLlmCostCents: 1100,
  totalTtsCostCents: 350,
  totalInfraCostCents: 150,
  totalTokensSaved: 0,
  totalCacheHits: 1,
  totalCacheMisses: 1,
  cacheHitRate: 50,
  modelEfficiencyRatio: 1,
  dailyBreakdown: [],
  tierDistribution: [],
  monthlyCostTrend: [],
  savingsBreakdown: {
    cacheSavingsCents: 0,
    routingSavingsCents: 0,
    compressionSavingsCents: 0,
    totalSavingsCents: 0,
  },
};

describe('POST /cost-optimization/recompute', () => {
  it('runs a real recompute and returns the report + analytics with currency', async () => {
    recomputeCostAnalyticsMock.mockResolvedValueOnce({
      tenantId: 'tenant-eur',
      from: '2026-04-01T00:00:00.000Z',
      to: '2026-04-30T23:59:59.999Z',
      rowsScanned: 12,
      rowsRepaired: 3,
      durationMs: 87,
      recomputedAt: '2026-05-01T10:11:12.000Z',
      summary: SAMPLE_SUMMARY,
    });

    const app = await buildApp();
    const res = await request(app).post('/cost-optimization/recompute?range=30d');

    expect(res.status).toBe(200);
    expect(recomputeCostAnalyticsMock).toHaveBeenCalledTimes(1);
    const [tenantId, from, to] = recomputeCostAnalyticsMock.mock.calls[0];
    expect(tenantId).toBe('tenant-eur');
    expect(from).toBeInstanceOf(Date);
    expect(to).toBeInstanceOf(Date);
    // 30d window — should be ~30 days wide.
    const diffMs = (to as Date).getTime() - (from as Date).getTime();
    expect(diffMs).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    expect(diffMs).toBeLessThan(31 * 24 * 60 * 60 * 1000);

    expect(res.body).toMatchObject({
      tenantId: 'tenant-eur',
      rowsScanned: 12,
      rowsRepaired: 3,
      durationMs: 87,
      recomputedAt: '2026-05-01T10:11:12.000Z',
    });
    // Analytics is stitched together with the tenant currency so the
    // client can hydrate the dashboard from this single response.
    expect(res.body.analytics).toMatchObject({
      ...SAMPLE_SUMMARY,
      currency: 'eur',
    });
  });

  it('honors a 7d range override', async () => {
    recomputeCostAnalyticsMock.mockResolvedValueOnce({
      tenantId: 'tenant-eur',
      from: '2026-04-24T00:00:00.000Z',
      to: '2026-05-01T00:00:00.000Z',
      rowsScanned: 0,
      rowsRepaired: 0,
      durationMs: 4,
      recomputedAt: '2026-05-01T10:11:12.000Z',
      summary: SAMPLE_SUMMARY,
    });

    const app = await buildApp();
    const res = await request(app).post('/cost-optimization/recompute?range=7d');

    expect(res.status).toBe(200);
    const [, from, to] = recomputeCostAnalyticsMock.mock.calls[0];
    const diffMs = (to as Date).getTime() - (from as Date).getTime();
    expect(diffMs).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(diffMs).toBeLessThan(8 * 24 * 60 * 60 * 1000);
  });

  it('returns 400 when the range parameters are malformed', async () => {
    const app = await buildApp();
    const res = await request(app).post('/cost-optimization/recompute?from=not-a-date');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid date/i);
    expect(recomputeCostAnalyticsMock).not.toHaveBeenCalled();
  });

  it('returns 500 when the recompute itself fails', async () => {
    recomputeCostAnalyticsMock.mockRejectedValueOnce(new Error('boom'));
    const app = await buildApp();
    const res = await request(app).post('/cost-optimization/recompute');

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/failed to recompute/i);
  });
});
