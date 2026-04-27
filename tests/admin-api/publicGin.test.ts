/**
 * Coverage for `GET /public/gin/benchmarks`.
 *
 * The endpoint reads the most-recent (industry_vertical, metric_name) row
 * from `industry_benchmarks`, enforces a k-anonymity threshold per row,
 * and shapes the result for the public marketing page. We mount the real
 * router with a mocked platform pool and assert:
 *   - rows below the k threshold are suppressed
 *   - status flips to "live" once enough rows are above k
 *   - empty/missing data returns the honest "illustrative" payload
 *   - values are formatted (percent / duration) for display
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const queryMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
}));

vi.mock('../../platform/infra/rate-limit/createRateLimiter', () => ({
  createRateLimiter: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import publicGinRoutes from '../../server/admin-api/routes/publicGin';

function buildApp() {
  const app = express();
  app.use(publicGinRoutes);
  return app;
}

beforeEach(() => {
  queryMock.mockReset();
  process.env.GIN_PUBLIC_K_ANONYMITY = '8';
});

describe('GET /public/gin/benchmarks', () => {
  it('returns illustrative payload with no rows when industry_benchmarks is empty', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp()).get('/public/gin/benchmarks');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('illustrative');
    expect(res.body.rows).toEqual([]);
    expect(res.body.kAnonymity).toBe(8);
  });

  it('suppresses rows below the k-anonymity threshold', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          industry_vertical: 'medical',
          metric_name: 'call_completion_rate',
          metric_value: '0.85',
          sample_size: 3,
          percentile_50: '0.78',
          percentile_75: '0.94',
          period_end: '2026-04-15',
          updated_at: '2026-04-15T00:00:00Z',
        },
      ],
    });

    const res = await request(buildApp()).get('/public/gin/benchmarks');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('illustrative');
    expect(res.body.rows).toEqual([]);
  });

  it('returns live cohort rows with formatted values when data is above k', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          industry_vertical: 'medical',
          metric_name: 'call_completion_rate',
          metric_value: '0.85',
          sample_size: 12,
          percentile_50: '0.78',
          percentile_75: '0.94',
          period_end: '2026-04-15',
          updated_at: '2026-04-15T00:00:00Z',
        },
        {
          industry_vertical: 'dental',
          metric_name: 'booking_conversion_rate',
          metric_value: '0.58',
          sample_size: 9,
          percentile_50: '0.54',
          percentile_75: '0.71',
          period_end: '2026-04-10',
          updated_at: '2026-04-10T00:00:00Z',
        },
        {
          industry_vertical: 'home_services',
          metric_name: 'avg_call_duration_seconds',
          metric_value: '330',
          sample_size: 11,
          percentile_50: '450',
          percentile_75: '190',
          period_end: '2026-04-12',
          updated_at: '2026-04-12T00:00:00Z',
        },
      ],
    });

    const res = await request(buildApp()).get('/public/gin/benchmarks');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('live');
    expect(res.body.snapshotAt).toBe('2026-04-15');
    expect(res.body.kAnonymity).toBe(8);
    expect(res.body.source).toBe('industry_benchmarks');

    const byVertical = Object.fromEntries(
      (res.body.rows as Array<{ vertical: string }>).map((r) => [r.vertical, r]),
    );

    expect(byVertical.Healthcare).toMatchObject({
      metric: 'After-hours answer rate',
      cohortAvg: '85%',
      median: '78%',
      topQuartile: '94%',
      cohortSize: 12,
    });
    expect(byVertical.Dental).toMatchObject({
      metric: 'Booking conversion',
      cohortAvg: '58%',
      median: '54%',
      topQuartile: '71%',
      cohortSize: 9,
    });
    expect(byVertical['Field service']).toMatchObject({
      metric: 'Average call duration',
      cohortAvg: '5m 30s',
      median: '7m 30s',
      topQuartile: '3m 10s',
      cohortSize: 11,
    });

    expect(res.body.rows.every((r: { cohortSize: number }) => r.cohortSize > 0)).toBe(true);
  });

  it('returns preview status when only one or two cohorts pass k', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          industry_vertical: 'dental',
          metric_name: 'booking_conversion_rate',
          metric_value: '0.6',
          sample_size: 10,
          percentile_50: '0.55',
          percentile_75: '0.7',
          period_end: '2026-04-10',
          updated_at: '2026-04-10T00:00:00Z',
        },
      ],
    });

    const res = await request(buildApp()).get('/public/gin/benchmarks');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('preview');
    expect(res.body.rows).toHaveLength(1);
  });

  it('falls back to a 503 illustrative payload when the database errors', async () => {
    queryMock.mockRejectedValueOnce(new Error('connection refused'));

    const res = await request(buildApp()).get('/public/gin/benchmarks');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('illustrative');
    expect(res.body.error).toBe('benchmarks_unavailable');
    expect(res.body.rows).toEqual([]);
  });
});
