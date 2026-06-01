import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ALL_CONVERSION_STAGES } from '../../../shared/analytics/conversionStages';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: true },
  recordConversionEventMock: vi.fn(),
  getWebsiteFunnelMock: vi.fn(),
  getConversionTrendsMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/analytics/WebsiteConversionService', () => ({
  recordConversionEvent: a.recordConversionEventMock,
  getWebsiteFunnel: a.getWebsiteFunnelMock,
  getConversionTrends: a.getConversionTrendsMock,
}));

import conversionRouter from './conversion';

function app() {
  const app = express();
  app.use(express.json());
  app.use(conversionRouter);
  return app;
}

const VALID_STAGE = ALL_CONVERSION_STAGES[0];

beforeEach(() => {
  a.user.isPlatformAdmin = true;
  a.recordConversionEventMock.mockReset().mockResolvedValue(undefined);
  a.getWebsiteFunnelMock.mockReset().mockResolvedValue({ stages: [] });
  a.getConversionTrendsMock.mockReset().mockResolvedValue({ points: [] });
});

describe('POST /conversion/event (public)', () => {
  it('records a valid event', async () => {
    const res = await request(app()).post('/conversion/event').send({ visitorId: 'v1', stage: VALID_STAGE, landingPage: '/pricing' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(a.recordConversionEventMock).toHaveBeenCalled();
  });

  it('rejects a missing visitorId', async () => {
    expect((await request(app()).post('/conversion/event').send({ stage: VALID_STAGE })).status).toBe(400);
  });

  it('rejects an invalid stage', async () => {
    expect((await request(app()).post('/conversion/event').send({ visitorId: 'v1', stage: 'not-a-stage' })).status).toBe(400);
  });

  it('rejects an over-long utm value', async () => {
    const res = await request(app()).post('/conversion/event').send({ visitorId: 'v1', stage: VALID_STAGE, utm: { source: 'x'.repeat(201) } });
    expect(res.status).toBe(400);
  });

  it('returns 500 when recording throws', async () => {
    a.recordConversionEventMock.mockRejectedValue(new Error('boom'));
    const res = await request(app()).post('/conversion/event').send({ visitorId: 'v9', stage: VALID_STAGE });
    expect(res.status).toBe(500);
  });

  // Runs last: it exhausts the module-level per-IP counter, which would
  // otherwise make subsequent same-IP requests in this file return 429.
  it('rate-limits a burst from the same ip with 429', async () => {
    let last = 200;
    for (let i = 0; i < 65; i++) {
      const res = await request(app()).post('/conversion/event').send({ visitorId: 'v1', stage: VALID_STAGE });
      last = res.status;
    }
    expect(last).toBe(429);
  });
});

describe('GET /admin/conversion/funnel & /trends', () => {
  it('returns funnel data for a platform admin', async () => {
    a.getWebsiteFunnelMock.mockResolvedValue({ stages: [{ name: 's' }] });
    const res = await request(app()).get('/admin/conversion/funnel?range=7d');
    expect(res.status).toBe(200);
    expect(res.body.stages).toHaveLength(1);
  });

  it('rejects a non-platform-admin with 403', async () => {
    a.user.isPlatformAdmin = false;
    expect((await request(app()).get('/admin/conversion/funnel')).status).toBe(403);
  });

  it('returns trends data', async () => {
    a.getConversionTrendsMock.mockResolvedValue({ points: [1, 2] });
    const res = await request(app()).get('/admin/conversion/trends?from=2026-01-01&to=2026-02-01');
    expect(res.body.points).toEqual([1, 2]);
  });

  it('returns 500 when the funnel query fails', async () => {
    a.getWebsiteFunnelMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/admin/conversion/funnel')).status).toBe(500);
  });
});
