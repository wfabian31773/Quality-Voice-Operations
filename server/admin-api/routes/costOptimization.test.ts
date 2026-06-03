import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  getCostOptimizationAnalyticsMock: vi.fn(),
  getConversationCostsMock: vi.fn(),
  getCostBudgetSettingsMock: vi.fn(),
  upsertCostBudgetSettingsMock: vi.fn(),
  getCacheStatsMock: vi.fn(),
  getRoutingDistributionMock: vi.fn(),
  getConversationCostMock: vi.fn(),
  recomputeCostAnalyticsMock: vi.fn(),
  getTenantBillingCurrencyMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/billing/cost', () => ({
  getCostOptimizationAnalytics: a.getCostOptimizationAnalyticsMock,
  getConversationCosts: a.getConversationCostsMock,
  getCostBudgetSettings: a.getCostBudgetSettingsMock,
  upsertCostBudgetSettings: a.upsertCostBudgetSettingsMock,
  getCacheStats: a.getCacheStatsMock,
  getRoutingDistribution: a.getRoutingDistributionMock,
  getConversationCost: a.getConversationCostMock,
  recomputeCostAnalytics: a.recomputeCostAnalyticsMock,
}));
vi.mock('../../../platform/billing/tenantCurrency', () => ({ getTenantBillingCurrency: a.getTenantBillingCurrencyMock }));

import router from './costOptimization';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.getTenantBillingCurrencyMock.mockReset().mockResolvedValue('USD');
  a.getCostOptimizationAnalyticsMock.mockReset().mockResolvedValue({ total: 100 });
  a.getConversationCostsMock.mockReset().mockResolvedValue({ rows: [], total: 0 });
  a.getCostBudgetSettingsMock.mockReset();
  a.upsertCostBudgetSettingsMock.mockReset().mockResolvedValue({ enabled: true });
  a.getCacheStatsMock.mockReset().mockResolvedValue({ hits: 5 });
  a.getRoutingDistributionMock.mockReset().mockResolvedValue({ gpt: 3 });
  a.getConversationCostMock.mockReset();
  a.recomputeCostAnalyticsMock.mockReset();
});

describe('GET /cost-optimization/analytics', () => {
  it('returns analytics with the tenant currency', async () => {
    const res = await request(app()).get('/cost-optimization/analytics?range=7d');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ total: 100, currency: 'USD' });
  });

  it('rejects invalid date params', async () => {
    expect((await request(app()).get('/cost-optimization/analytics?to=not-a-date')).status).toBe(400);
  });

  it('returns 500 on failure', async () => {
    a.getCostOptimizationAnalyticsMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/cost-optimization/analytics')).status).toBe(500);
  });
});

describe('POST /cost-optimization/recompute', () => {
  it('recomputes and returns the analytics summary', async () => {
    a.recomputeCostAnalyticsMock.mockResolvedValue({
      tenantId: 't1', from: 'a', to: 'b', rowsScanned: 10, rowsRepaired: 1, durationMs: 5, recomputedAt: 'now', summary: { total: 9 },
    });
    const res = await request(app()).post('/cost-optimization/recompute').send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ rowsScanned: 10, analytics: { total: 9, currency: 'USD' } });
  });
});

describe('GET /cost-optimization/conversation/:sessionId', () => {
  it('returns the cost record when found', async () => {
    a.getConversationCostMock.mockResolvedValue({ cents: 42 });
    const res = await request(app()).get('/cost-optimization/conversation/s1');
    expect(res.body).toMatchObject({ cents: 42, currency: 'USD' });
  });

  it('returns 404 when not found', async () => {
    a.getConversationCostMock.mockResolvedValue(null);
    expect((await request(app()).get('/cost-optimization/conversation/missing')).status).toBe(404);
  });
});

describe('budget settings', () => {
  it('returns defaults when none are stored', async () => {
    a.getCostBudgetSettingsMock.mockResolvedValue(null);
    const res = await request(app()).get('/cost-optimization/budget');
    expect(res.body).toMatchObject({ tenantId: 't1', enabled: false, maxCostPerConversationCents: 500 });
  });

  it('updates budget settings', async () => {
    const res = await request(app()).put('/cost-optimization/budget').send({ enabled: true });
    expect(res.status).toBe(200);
    expect(a.upsertCostBudgetSettingsMock).toHaveBeenCalled();
  });
});

describe('cache-stats & routing-distribution', () => {
  it('returns cache stats', async () => {
    expect((await request(app()).get('/cost-optimization/cache-stats')).body).toEqual({ hits: 5 });
  });

  it('returns routing distribution', async () => {
    expect((await request(app()).get('/cost-optimization/routing-distribution')).body).toEqual({ gpt: 3 });
  });

  it('returns conversation cost list', async () => {
    a.getConversationCostsMock.mockResolvedValue({ rows: [{ id: 'c1' }], total: 1 });
    const res = await request(app()).get('/cost-optimization/conversations?limit=10');
    expect(res.body).toMatchObject({ total: 1, currency: 'USD' });
  });
});
