import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  getTenantMetricsMock: vi.fn(),
  getRecentErrorsMock: vi.fn(),
  getSystemMetricsMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/core/observability', () => ({
  getTenantMetrics: a.getTenantMetricsMock,
  getRecentErrors: a.getRecentErrorsMock,
  getSystemMetrics: a.getSystemMetricsMock,
}));

import observabilityRouter from './observability';

function app() {
  const app = express();
  app.use(express.json());
  app.use(observabilityRouter);
  return app;
}

const fetchMock = vi.fn();

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.user.isPlatformAdmin = false;
  a.getTenantMetricsMock.mockReset().mockResolvedValue({ calls: 10 });
  a.getRecentErrorsMock.mockReset().mockResolvedValue([]);
  a.getSystemMetricsMock.mockReset().mockResolvedValue({ cpu: 0.5 });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ADMIN_INTERNAL_TOKEN;
});

describe('GET /observability/metrics', () => {
  it('maps the window and returns metrics', async () => {
    a.getTenantMetricsMock.mockResolvedValue({ calls: 99 });
    const res = await request(app()).get('/observability/metrics?window=30d');
    expect(res.body).toMatchObject({ window: '30d', calls: 99 });
    expect(a.getTenantMetricsMock).toHaveBeenCalledWith('t1', 30);
  });

  it('returns 500 on failure', async () => {
    a.getTenantMetricsMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/observability/metrics')).status).toBe(500);
  });
});

describe('GET /observability/errors', () => {
  it('caps the limit at 200', async () => {
    await request(app()).get('/observability/errors?limit=9999');
    expect(a.getRecentErrorsMock).toHaveBeenCalledWith('t1', 200);
  });

  it('returns 500 on failure', async () => {
    a.getRecentErrorsMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/observability/errors')).status).toBe(500);
  });
});

describe('GET /observability/twilio-webhook-security', () => {
  beforeEach(() => { a.user.isPlatformAdmin = true; });

  it('rejects a non-platform-admin with 403', async () => {
    a.user.isPlatformAdmin = false;
    expect((await request(app()).get('/observability/twilio-webhook-security')).status).toBe(403);
  });

  it('returns 503 when ADMIN_INTERNAL_TOKEN is not configured', async () => {
    expect((await request(app()).get('/observability/twilio-webhook-security')).status).toBe(503);
  });

  it('proxies the voice-gateway snapshot when upstream is OK', async () => {
    process.env.ADMIN_INTERNAL_TOKEN = 'tok';
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ verified: 5 }) });
    const res = await request(app()).get('/observability/twilio-webhook-security');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ verified: 5 });
  });

  it('returns 502 when the voice gateway responds non-OK', async () => {
    process.env.ADMIN_INTERNAL_TOKEN = 'tok';
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'err' });
    expect((await request(app()).get('/observability/twilio-webhook-security')).status).toBe(502);
  });

  it('returns 504 when the upstream request aborts (timeout)', async () => {
    process.env.ADMIN_INTERNAL_TOKEN = 'tok';
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    expect((await request(app()).get('/observability/twilio-webhook-security')).status).toBe(504);
  });

  it('returns 502 on a generic fetch failure', async () => {
    process.env.ADMIN_INTERNAL_TOKEN = 'tok';
    fetchMock.mockRejectedValue(new Error('network'));
    expect((await request(app()).get('/observability/twilio-webhook-security')).status).toBe(502);
  });
});

describe('GET /observability/realtime-stream', () => {
  beforeEach(() => { a.user.isPlatformAdmin = true; });

  it('rejects a non-platform-admin with 403', async () => {
    a.user.isPlatformAdmin = false;
    expect((await request(app()).get('/observability/realtime-stream')).status).toBe(403);
  });

  it('returns 503 when ADMIN_INTERNAL_TOKEN is not configured', async () => {
    expect((await request(app()).get('/observability/realtime-stream')).status).toBe(503);
  });

  it('proxies the realtime-stream snapshot when upstream is OK', async () => {
    process.env.ADMIN_INTERNAL_TOKEN = 'tok';
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ attempts: 7, successes: 6, latency: {} }) });
    const res = await request(app()).get('/observability/realtime-stream');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ attempts: 7, successes: 6 });
    // It hits the gateway's realtime-stream metrics path with the admin token.
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/admin/diagnostics/realtime-stream/metrics'),
      expect.objectContaining({ headers: expect.objectContaining({ 'x-admin-token': 'tok' }) }),
    );
  });

  it('returns 502 when the voice gateway responds non-OK', async () => {
    process.env.ADMIN_INTERNAL_TOKEN = 'tok';
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'err' });
    expect((await request(app()).get('/observability/realtime-stream')).status).toBe(502);
  });

  it('returns 504 when the upstream request aborts (timeout)', async () => {
    process.env.ADMIN_INTERNAL_TOKEN = 'tok';
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    expect((await request(app()).get('/observability/realtime-stream')).status).toBe(504);
  });
});

describe('GET /observability/system', () => {
  it('returns system metrics for a platform admin', async () => {
    a.user.isPlatformAdmin = true;
    a.getSystemMetricsMock.mockResolvedValue({ cpu: 0.9 });
    const res = await request(app()).get('/observability/system');
    expect(res.body).toEqual({ cpu: 0.9 });
  });

  it('rejects a non-platform-admin with 403', async () => {
    expect((await request(app()).get('/observability/system')).status).toBe(403);
  });
});
