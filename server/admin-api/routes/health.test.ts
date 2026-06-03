import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({ getPoolMock: vi.fn() }));

vi.mock('../../../platform/db', () => ({ getPlatformPool: a.getPoolMock }));

import healthRouter from './health';

function app() {
  const app = express();
  app.use(healthRouter);
  return app;
}

beforeEach(() => a.getPoolMock.mockReset());

describe('GET /health (admin-api)', () => {
  it('reports healthy (200) when the DB responds', async () => {
    a.getPoolMock.mockReturnValue({ query: () => Promise.resolve({ rows: [{ '?column?': 1 }] }) });
    const res = await request(app()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'healthy', service: 'admin-api', db: 'connected' });
  });

  it('reports degraded (503) when the DB is unreachable', async () => {
    // The route awaits pool.query inside a try/catch. We return a rejected
    // promise with a no-op catch pre-attached so vitest's unhandled-rejection
    // detector stays quiet in the window before the route's await attaches —
    // the route still receives and catches the rejection.
    a.getPoolMock.mockReturnValue({
      query: () => {
        const p = Promise.reject(new Error('no db'));
        p.catch(() => {});
        return p;
      },
    });
    const res = await request(app()).get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: 'degraded', db: 'error' });
  });
});
