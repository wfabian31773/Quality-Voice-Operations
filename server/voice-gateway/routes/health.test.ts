import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const h = vi.hoisted(() => ({
  poolQueryMock: vi.fn(),
  getActiveCountMock: vi.fn(),
  isDrainingMock: vi.fn(),
  getMetricsMock: vi.fn(),
  getDrainStatusMock: vi.fn(),
}));

vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({ query: h.poolQueryMock }),
  pingDatabasePools: (sql = 'SELECT 1') => h.poolQueryMock(sql),
}));
vi.mock('../services/sessionManager', () => ({
  sessionManager: {
    getActiveCount: h.getActiveCountMock,
    isDraining: h.isDrainingMock,
    getMetrics: h.getMetricsMock,
    getDrainStatus: h.getDrainStatusMock,
  },
}));

import healthRouter from './health';
import {
  __resetReadinessForTests,
  markEnvValidated,
  markRegistriesLoaded,
} from '../../../platform/runtime/health';
import { __resetBuildInfoForTests } from '../../../platform/runtime/buildInfo';

const TOKEN = 'test-admin-token-0123456789';

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
  h.getDrainStatusMock.mockReset().mockReturnValue({ draining: false, activeSessions: 3, oldestSessionAgeSec: 12, openStreams: 3 });
  __resetReadinessForTests();
  markEnvValidated(true);
  markRegistriesLoaded();
  process.env.ADMIN_INTERNAL_TOKEN = TOKEN;
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
    expect(typeof res.body.marker).toBe('string');
  });
});

describe('GET /health deploy marker (VA-14)', () => {
  const SHA = '32164aa8f00dbabe0123456789abcdef01234567';
  const prev = process.env.RENDER_GIT_COMMIT;

  beforeEach(() => __resetBuildInfoForTests());
  afterEach(() => {
    if (prev === undefined) delete process.env.RENDER_GIT_COMMIT;
    else process.env.RENDER_GIT_COMMIT = prev;
    __resetBuildInfoForTests();
  });

  it('includes commit and marker next to the existing fields', async () => {
    process.env.RENDER_GIT_COMMIT = SHA;
    h.poolQueryMock.mockResolvedValue({ rows: [{ ok: 1 }] });
    const res = await request(app()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'healthy', db: 'connected', activeSessions: 3, draining: false, commit: SHA });
    expect(res.body).toHaveProperty('version');
    expect(res.body).toHaveProperty('timestamp');
    expect(typeof res.body.buildTime).toBe('string');
    expect(res.body.marker).toBe(`32164aa@${res.body.buildTime}`);
  });

  it('reports unknown when RENDER_GIT_COMMIT is unset', async () => {
    delete process.env.RENDER_GIT_COMMIT;
    h.poolQueryMock.mockResolvedValue({ rows: [{ ok: 1 }] });
    const res = await request(app()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.commit).toBe('unknown');
    expect(res.body.marker).toMatch(/^unknown@/);
  });
});

describe('GET /metrics', () => {
  it('returns session metrics plus process stats with the admin token', async () => {
    const res = await request(app()).get('/metrics').set('x-admin-token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ activeSessions: 3, totalSessions: 100 });
    expect(typeof res.body.uptime).toBe('number');
    expect(typeof res.body.memoryMB).toBe('number');
  });

  it('rejects a missing or wrong token', async () => {
    expect((await request(app()).get('/metrics')).status).toBe(403);
    expect((await request(app()).get('/metrics').set('x-admin-token', 'nope')).status).toBe(403);
    expect(h.getMetricsMock).not.toHaveBeenCalled();
  });

  it('is unavailable when ADMIN_INTERNAL_TOKEN is not configured', async () => {
    delete process.env.ADMIN_INTERNAL_TOKEN;
    expect((await request(app()).get('/metrics').set('x-admin-token', TOKEN)).status).toBe(503);
  });
});

describe('GET /internal/drain-status', () => {
  it('requires the admin token', async () => {
    expect((await request(app()).get('/internal/drain-status')).status).toBe(403);
    expect(h.getDrainStatusMock).not.toHaveBeenCalled();
  });

  it('returns {draining, activeSessions, oldestSessionAgeSec}', async () => {
    const res = await request(app()).get('/internal/drain-status').set('x-admin-token', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ draining: false, activeSessions: 3, oldestSessionAgeSec: 12, openStreams: 3 });
  });
});

describe('GET /healthz', () => {
  it('is 200 with the DB down and never queries it', async () => {
    h.poolQueryMock.mockRejectedValue(new Error('no db'));
    const res = await request(app()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', service: 'voice-gateway' });
    expect(h.poolQueryMock).not.toHaveBeenCalled();
  });

  it('is 200 while draining', async () => {
    h.isDrainingMock.mockReturnValue(true);
    expect((await request(app()).get('/healthz')).status).toBe(200);
  });
});

describe('GET /readyz', () => {
  it('is 200 when env, DB, registries are fine and not draining', async () => {
    h.poolQueryMock.mockResolvedValue({ rows: [{ '?column?': 1 }] });
    const res = await request(app()).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ready', reasons: [] });
  });

  it('is 503 db_unreachable with the DB down', async () => {
    h.poolQueryMock.mockRejectedValue(new Error('password=supersecret host=db'));
    const res = await request(app()).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.reasons).toEqual(['db_unreachable']);
    expect(JSON.stringify(res.body)).not.toContain('supersecret');
  });

  it('is 503 draining while the session manager drains', async () => {
    h.poolQueryMock.mockResolvedValue({ rows: [] });
    h.isDrainingMock.mockReturnValue(true);
    const res = await request(app()).get('/readyz');
    expect(res.status).toBe(503);
    expect(res.body.reasons).toEqual(['draining']);
  });
});
