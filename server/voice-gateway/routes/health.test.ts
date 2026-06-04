import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  getActiveCountMock: vi.fn(),
  isDrainingMock: vi.fn(),
  getMetricsMock: vi.fn(),
}));

vi.mock('../../../platform/db', () => ({ getPlatformPool: () => ({ query: h.poolQueryMock }) }));
vi.mock('../services/sessionManager', () => ({
  sessionManager: {
    getActiveCount: h.getActiveCountMock,
    isDraining: h.isDrainingMock,
    getMetrics: h.getMetricsMock,
  },
}));

import healthRouter from './health';

function app() {
  const a = express();
  a.use(healthRouter);
  return a;
}

beforeEach(() => {
  h.poolQueryMock.mockReset();
  h.getActiveCountMock.mockReset().mockReturnValue(3);
  h.isDrainingMock.mockReset().mockReturnValue(false);
  h.getMetricsMock.mockReset().mockReturnValue({ activeSessions: 3, totalSessions: 100 });
});

describe('GET /health', () => {
  it('reports healthy when the DB responds', async () => {
    h.poolQueryMock.mockResolvedValue({ rows: [{ ok: 1 }] });
    const res = await request(app()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'healthy', db: 'connected', activeSessions: 3, draining: false });
  });

  it('reports degraded when the DB check returns an unexpected value', async () => {
    h.poolQueryMock.mockResolvedValue({ rows: [{ ok: 0 }] });
    const res = await request(app()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'degraded', db: 'unreachable' });
  });

  it('returns 503 when the DB is unreachable', async () => {
    h.poolQueryMock.mockRejectedValue(new Error('no db'));
    const res = await request(app()).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'unhealthy', error: 'Database unreachable' });
  });
});

describe('GET /metrics', () => {
  it('returns session metrics plus process stats', async () => {
    const res = await request(app()).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ activeSessions: 3, totalSessions: 100 });
    expect(typeof res.body.uptime).toBe('number');
    expect(typeof res.body.memoryMB).toBe('number');
  });
});
