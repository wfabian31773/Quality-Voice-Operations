import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const fns = [
  'getCallAnalytics', 'getCampaignAnalytics', 'getAgentAnalytics', 'getCostAnalytics',
  'getRevenueAttribution', 'getSentimentTrends', 'getAgentSentiments', 'getTopicDistribution',
  'getTopicTrends', 'getConversionFunnel', 'getConversionTrends', 'getQualityAnalytics',
] as const;

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  mocks: Object.fromEntries((['getCallAnalytics', 'getCampaignAnalytics', 'getAgentAnalytics', 'getCostAnalytics', 'getRevenueAttribution', 'getSentimentTrends', 'getAgentSentiments', 'getTopicDistribution', 'getTopicTrends', 'getConversionFunnel', 'getConversionTrends', 'getQualityAnalytics']).map((n) => [n, vi.fn()])) as Record<string, ReturnType<typeof vi.fn>>,
  getTenantBillingCurrencyMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/analytics', () => a.mocks);
vi.mock('../../../platform/billing/tenantCurrency', () => ({ getTenantBillingCurrency: a.getTenantBillingCurrencyMock }));

import router from './analytics';

function app() {
  const app = express();
  app.use(router);
  return app;
}

beforeEach(() => {
  for (const n of fns) a.mocks[n].mockReset().mockResolvedValue({ ok: n });
  a.getTenantBillingCurrencyMock.mockReset().mockResolvedValue('USD');
});

describe('analytics routes', () => {
  it('rejects invalid date params (shared guard)', async () => {
    expect((await request(app()).get('/analytics/calls?to=not-a-date')).status).toBe(400);
  });

  it('GET /analytics/calls', async () => {
    expect((await request(app()).get('/analytics/calls?range=7d')).body).toEqual({ ok: 'getCallAnalytics' });
  });

  it('GET /analytics/campaigns', async () => {
    expect((await request(app()).get('/analytics/campaigns')).body).toEqual({ ok: 'getCampaignAnalytics' });
  });

  it('GET /analytics/agents', async () => {
    expect((await request(app()).get('/analytics/agents')).body).toEqual({ ok: 'getAgentAnalytics' });
  });

  it('GET /analytics/costs merges the tenant currency', async () => {
    a.mocks.getCostAnalytics.mockResolvedValue({ total: 5 });
    expect((await request(app()).get('/analytics/costs')).body).toEqual({ total: 5, currency: 'USD' });
  });

  it('GET /analytics/revenue honors avgTicketValueCents', async () => {
    a.mocks.getRevenueAttribution.mockResolvedValue({ revenue: 100 });
    const res = await request(app()).get('/analytics/revenue?avgTicketValueCents=20000');
    expect(res.body).toEqual({ revenue: 100, currency: 'USD' });
    expect(a.mocks.getRevenueAttribution).toHaveBeenCalledWith('t1', expect.any(Date), expect.any(Date), 20000);
  });

  it('GET /analytics/sentiment', async () => {
    a.mocks.getSentimentTrends.mockResolvedValue([{ t: 1 }]);
    a.mocks.getAgentSentiments.mockResolvedValue([{ a: 1 }]);
    const res = await request(app()).get('/analytics/sentiment');
    expect(res.body).toEqual({ trends: [{ t: 1 }], agentSentiments: [{ a: 1 }] });
  });

  it('GET /analytics/topics', async () => {
    const res = await request(app()).get('/analytics/topics');
    expect(res.body).toHaveProperty('distribution');
    expect(res.body).toHaveProperty('trends');
  });

  it('GET /analytics/funnel', async () => {
    const res = await request(app()).get('/analytics/funnel');
    expect(res.body).toHaveProperty('funnel');
    expect(res.body).toHaveProperty('trends');
  });

  it('GET /analytics/performance aggregates several sources', async () => {
    const res = await request(app()).get('/analytics/performance');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('revenue');
    expect(res.body).toHaveProperty('sentiment');
    expect(res.body).toHaveProperty('qualityTrends');
  });

  it('returns 500 when an analytics source throws', async () => {
    a.mocks.getCallAnalytics.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/analytics/calls')).status).toBe(500);
  });
});
