import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const names = [
  'getIndustryBenchmarks', 'getTenantBenchmarkComparison', 'getAllIndustryVerticals',
  'getGlobalPatterns', 'getGlobalPromptPatterns', 'getTenantRecommendations',
  'updateRecommendationStatus', 'getGinParticipation', 'updateGinParticipation',
  'getAggregationRuns', 'getPolicyAcceptanceHistory',
] as const;

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  mocks: Object.fromEntries(['getIndustryBenchmarks', 'getTenantBenchmarkComparison', 'getAllIndustryVerticals', 'getGlobalPatterns', 'getGlobalPromptPatterns', 'getTenantRecommendations', 'updateRecommendationStatus', 'getGinParticipation', 'updateGinParticipation', 'getAggregationRuns', 'getPolicyAcceptanceHistory'].map((n) => [n, vi.fn()])) as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/gin', () => a.mocks);

import router from './gin';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  for (const n of names) a.mocks[n].mockReset().mockResolvedValue({ ok: n });
});

describe('gin read routes', () => {
  it('GET /gin/benchmarks', async () => {
    a.mocks.getTenantBenchmarkComparison.mockResolvedValue({ score: 5 });
    expect((await request(app()).get('/gin/benchmarks')).body).toEqual({ score: 5 });
  });

  it('GET /gin/benchmarks/:vertical', async () => {
    a.mocks.getIndustryBenchmarks.mockResolvedValue([{ v: 1 }]);
    const res = await request(app()).get('/gin/benchmarks/dental');
    expect(res.body.benchmarks).toEqual([{ v: 1 }]);
    expect(a.mocks.getIndustryBenchmarks).toHaveBeenCalledWith('dental');
  });

  it('GET /gin/verticals', async () => {
    a.mocks.getAllIndustryVerticals.mockResolvedValue(['dental', 'legal']);
    expect((await request(app()).get('/gin/verticals')).body.verticals).toHaveLength(2);
  });

  it('GET /gin/patterns clamps the limit', async () => {
    await request(app()).get('/gin/patterns?limit=9999&type=greeting&industry=dental');
    expect(a.mocks.getGlobalPatterns).toHaveBeenCalledWith({ patternType: 'greeting', industry: 'dental', limit: 100 });
  });

  it('GET /gin/prompt-patterns', async () => {
    a.mocks.getGlobalPromptPatterns.mockResolvedValue([{ p: 1 }]);
    expect((await request(app()).get('/gin/prompt-patterns?category=intro')).body.patterns).toEqual([{ p: 1 }]);
  });

  it('GET /gin/recommendations', async () => {
    a.mocks.getTenantRecommendations.mockResolvedValue({ items: [] });
    const res = await request(app()).get('/gin/recommendations?status=pending&limit=10');
    expect(res.status).toBe(200);
    expect(a.mocks.getTenantRecommendations).toHaveBeenCalledWith('t1', { status: 'pending', limit: 10 });
  });

  it('GET /gin/participation', async () => {
    a.mocks.getGinParticipation.mockResolvedValue({ participate: true });
    expect((await request(app()).get('/gin/participation')).body).toEqual({ participate: true });
  });

  it('GET /gin/policy-history', async () => {
    a.mocks.getPolicyAcceptanceHistory.mockResolvedValue([{ at: 'now' }]);
    expect((await request(app()).get('/gin/policy-history')).body.records).toHaveLength(1);
  });

  it('GET /gin/runs', async () => {
    a.mocks.getAggregationRuns.mockResolvedValue([{ id: 'r1' }]);
    expect((await request(app()).get('/gin/runs')).body.runs).toHaveLength(1);
  });

  it('returns 500 when a source throws', async () => {
    a.mocks.getTenantBenchmarkComparison.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/gin/benchmarks')).status).toBe(500);
  });
});

describe('POST /gin/recommendations/:id/status', () => {
  it('rejects an invalid status', async () => {
    expect((await request(app()).post('/gin/recommendations/r1/status').send({ status: 'maybe' })).status).toBe(400);
  });

  it('updates the recommendation status', async () => {
    a.mocks.updateRecommendationStatus.mockResolvedValue({ id: 'r1', status: 'applied' });
    const res = await request(app()).post('/gin/recommendations/r1/status').send({ status: 'applied' });
    expect(res.body.recommendation).toMatchObject({ status: 'applied' });
  });

  it('returns 404 when the recommendation is missing', async () => {
    a.mocks.updateRecommendationStatus.mockResolvedValue(null);
    expect((await request(app()).post('/gin/recommendations/x/status').send({ status: 'dismissed' })).status).toBe(404);
  });
});

describe('POST /gin/participation', () => {
  it('requires a boolean participate flag', async () => {
    expect((await request(app()).post('/gin/participation').send({ participate: 'yes' })).status).toBe(400);
  });

  it('updates participation settings', async () => {
    a.mocks.updateGinParticipation.mockResolvedValue({ participate: false });
    const res = await request(app()).post('/gin/participation').send({ participate: false, acceptDataUsage: true });
    expect(res.status).toBe(200);
    expect(a.mocks.updateGinParticipation).toHaveBeenCalledWith('t1', false, true, 'u1');
  });
});
