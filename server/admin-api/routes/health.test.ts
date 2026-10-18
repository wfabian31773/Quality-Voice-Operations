import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({ getPoolMock: vi.fn() }));

vi.mock('../../../platform/db', () => ({
  getPlatformPool: a.getPoolMock,
  pingDatabasePools: (sql = 'SELECT 1') => a.getPoolMock().query(sql),
}));

import healthRouter from './health';
import { __resetBuildInfoForTests } from '../../../platform/runtime/buildInfo';

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
    expect(typeof res.body.marker).toBe('string');
  });
});

describe('GET /health deploy marker (admin-api, VA-14)', () => {
  const SHA = '32164aa8f00dbabe0123456789abcdef01234567';
  const prev = process.env.RENDER_GIT_COMMIT;

  beforeEach(() => {
    __resetBuildInfoForTests();
    a.getPoolMock.mockReturnValue({ query: () => Promise.resolve({ rows: [{ '?column?': 1 }] }) });
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.RENDER_GIT_COMMIT;
    else process.env.RENDER_GIT_COMMIT = prev;
    __resetBuildInfoForTests();
  });

  it('includes commit and marker next to the existing fields', async () => {
    process.env.RENDER_GIT_COMMIT = SHA;
    const res = await request(app()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'healthy', service: 'admin-api', version: '1.0.0', db: 'connected', commit: SHA });
    expect(res.body).toHaveProperty('timestamp');
    expect(typeof res.body.buildTime).toBe('string');
    expect(res.body.marker).toBe(`32164aa@${res.body.buildTime}`);
  });

  it('reports unknown when RENDER_GIT_COMMIT is unset', async () => {
    delete process.env.RENDER_GIT_COMMIT;
    const res = await request(app()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.commit).toBe('unknown');
    expect(res.body.marker).toMatch(/^unknown@/);
  });
});

describe('GET /healthz + /readyz (admin-api, PR-00)', () => {
  it('/healthz is 200 with the DB down and never touches the pool', async () => {
    const res = await request(app()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'admin-api' });
    expect(a.getPoolMock).not.toHaveBeenCalled();
  });

  it('/readyz is 503 with the DB down and 200 once it answers', async () => {
    const { __resetReadinessForTests, markEnvValidated, markRegistriesLoaded, markDraining } = await import(
      '../../../platform/runtime/health'
    );
    __resetReadinessForTests();
    markEnvValidated(true);
    markRegistriesLoaded();

    a.getPoolMock.mockReturnValue({ query: () => Promise.reject(new Error('down')) });
    let res = await request(app()).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.reasons).toEqual(['db_unreachable']);

    a.getPoolMock.mockReturnValue({ query: () => Promise.resolve({ rows: [] }) });
    res = await request(app()).get('/readyz');
    expect(res.status).toBe(200);

    markDraining();
    res = await request(app()).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.reasons).toEqual(['draining']);
    __resetReadinessForTests();
  });
});
