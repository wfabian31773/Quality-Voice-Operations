import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  queryMock: vi.fn(),
  readCacheMock: vi.fn(),
  writeCacheMock: vi.fn(),
  getCsatMock: vi.fn(),
  recordCsatMock: vi.fn(),
}));

vi.mock('../../../platform/db', () => ({ getPlatformPool: () => ({ query: a.queryMock }) }));
vi.mock('../../../platform/infra/rate-limit/createRateLimiter', () => ({
  createRateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../../platform/gin/publicBenchmarkCache', () => ({
  readCachedPublicBenchmark: a.readCacheMock,
  writeCachedPublicBenchmark: a.writeCacheMock,
}));
vi.mock('../../../platform/analytics/CsatSurveyService', () => ({
  getCsatByDispatchToken: a.getCsatMock,
  recordCsatResponse: a.recordCsatMock,
}));

import router from './publicGin';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.queryMock.mockReset().mockResolvedValue({ rows: [] });
  a.readCacheMock.mockReset().mockResolvedValue(null);
  a.writeCacheMock.mockReset().mockResolvedValue(undefined);
  a.getCsatMock.mockReset();
  a.recordCsatMock.mockReset().mockResolvedValue(true);
  delete process.env.GIN_PUBLIC_LIVE_APPROVED;
});
afterEach(() => { delete process.env.GIN_PUBLIC_LIVE_APPROVED; });

const benchRows = () => ([
  { industry_vertical: 'medical', metric_name: 'call_completion_rate', metric_value: 0.9, sample_size: 50, percentile_50: 0.92, percentile_75: 0.97, period_end: '2026-05-31', updated_at: '2026-06-01' },
  { industry_vertical: 'home_services', metric_name: 'avg_call_duration_seconds', metric_value: 125, sample_size: 40, percentile_50: 120, percentile_75: 90, period_end: '2026-05-31', updated_at: '2026-06-01' },
  { industry_vertical: 'dental', metric_name: 'booking_conversion_rate', metric_value: 0.55, sample_size: 30, percentile_50: 0.5, percentile_75: 0.7, period_end: '2026-05-31', updated_at: '2026-06-01' },
]);

describe('GET /public/gin/benchmarks', () => {
  it('serves a cache hit', async () => {
    a.readCacheMock.mockResolvedValue({ status: 'preview', rows: [{ vertical: 'X' }] });
    const res = await request(app()).get('/public/gin/benchmarks');
    expect(res.status).toBe(200);
    expect(res.headers['x-benchmark-cache']).toBe('hit');
    expect(a.queryMock).not.toHaveBeenCalled();
  });

  it('returns an illustrative payload when no rows clear the k threshold', async () => {
    a.queryMock.mockResolvedValue({ rows: [] });
    const res = await request(app()).get('/public/gin/benchmarks');
    expect(res.body.status).toBe('illustrative');
    expect(res.headers['x-benchmark-cache']).toBe('miss');
    expect(a.writeCacheMock).toHaveBeenCalled();
  });

  it('returns preview status with formatted rows (no live sign-off)', async () => {
    a.queryMock.mockResolvedValue({ rows: benchRows() });
    const res = await request(app()).get('/public/gin/benchmarks');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('preview');
    expect(res.body.rows.length).toBeGreaterThanOrEqual(3);
    // percent + duration formatting exercised
    expect(res.body.rows.some((r: { cohortAvg: string }) => r.cohortAvg.includes('%'))).toBe(true);
  });

  it('promotes to live when sign-off env is set and enough cohorts exist', async () => {
    process.env.GIN_PUBLIC_LIVE_APPROVED = 'true';
    a.queryMock.mockResolvedValue({ rows: benchRows() });
    const res = await request(app()).get('/public/gin/benchmarks');
    expect(res.body.status).toBe('live');
  });

  it('drops rows below the k-anonymity sample size', async () => {
    a.queryMock.mockResolvedValue({ rows: [{ industry_vertical: 'medical', metric_name: 'call_completion_rate', metric_value: 0.9, sample_size: 2, percentile_50: 0.9, percentile_75: 0.95, period_end: '2026-05-31', updated_at: '2026-06-01' }] });
    const res = await request(app()).get('/public/gin/benchmarks');
    expect(res.body.status).toBe('illustrative'); // the only row was below k
  });

  it('returns 503 on a DB error', async () => {
    a.queryMock.mockRejectedValue(new Error('db down'));
    const res = await request(app()).get('/public/gin/benchmarks');
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('benchmarks_unavailable');
  });
});

describe('POST /public/csat/:token', () => {
  const tok = 'a'.repeat(24);

  it('rejects an invalid token length', async () => {
    expect((await request(app()).post('/public/csat/short').send({ score: 5 })).status).toBe(400);
  });

  it('rejects a non-numeric score', async () => {
    expect((await request(app()).post(`/public/csat/${tok}`).send({ score: 'five' })).status).toBe(400);
  });

  it('returns 404 for an unknown token', async () => {
    a.getCsatMock.mockResolvedValue(null);
    expect((await request(app()).post(`/public/csat/${tok}`).send({ score: 5 })).status).toBe(404);
  });

  it('returns 409 when already recorded', async () => {
    a.getCsatMock.mockResolvedValue({ status: 'completed' });
    expect((await request(app()).post(`/public/csat/${tok}`).send({ score: 5 })).status).toBe(409);
  });

  it('returns 410 when expired', async () => {
    a.getCsatMock.mockResolvedValue({ status: 'pending', expiresAt: new Date(Date.now() - 1000) });
    expect((await request(app()).post(`/public/csat/${tok}`).send({ score: 5 })).status).toBe(410);
  });

  it('records a valid response', async () => {
    a.getCsatMock.mockResolvedValue({ status: 'pending', expiresAt: new Date(Date.now() + 60_000), scoreScale: 5, tenantId: 't1', id: 'c1' });
    a.recordCsatMock.mockResolvedValue(true);
    const res = await request(app()).post(`/public/csat/${tok}`).send({ score: 5, comment: 'great' });
    expect(res.body).toEqual({ ok: true });
  });

  it('returns 409 when the record race is lost', async () => {
    a.getCsatMock.mockResolvedValue({ status: 'pending', expiresAt: new Date(Date.now() + 60_000), scoreScale: 5, tenantId: 't1', id: 'c1' });
    a.recordCsatMock.mockResolvedValue(false);
    expect((await request(app()).post(`/public/csat/${tok}`).send({ score: 5 })).status).toBe(409);
  });

  it('returns 500 when recording throws', async () => {
    a.getCsatMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).post(`/public/csat/${tok}`).send({ score: 5 })).status).toBe(500);
  });
});
