import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  verifyStripePricesMock: vi.fn(),
  getLatestSnapshotMock: vi.fn(),
  getLiveSummaryMock: vi.fn(),
  getLatestScreenshotMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/billing/stripe/verifyPrices', () => ({ verifyStripePrices: a.verifyStripePricesMock }));
vi.mock('../../../platform/billing/StripePriceVerificationScheduler', () => ({
  getLatestStripePriceVerificationSnapshot: a.getLatestSnapshotMock,
}));
vi.mock('../../../platform/billing/githubLiveBillingHealthArtifact', () => ({
  getLatestSuccessScreenshot: a.getLatestScreenshotMock,
  getLiveBillingHealthSummary: a.getLiveSummaryMock,
}));

import router from './platformBillingHealth';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.isPlatformAdmin = true;
  a.verifyStripePricesMock.mockReset().mockResolvedValue({ ok: true, mismatches: [] });
  a.getLatestSnapshotMock.mockReset().mockReturnValue({ ranAt: 'now' });
  a.getLiveSummaryMock.mockReset().mockResolvedValue({ lastRun: 'green' });
  a.getLatestScreenshotMock.mockReset().mockResolvedValue(null);
});

describe('GET /platform/billing-config-health', () => {
  it('returns the verification report plus the last scheduled run', async () => {
    const res = await request(app()).get('/platform/billing-config-health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, lastScheduledRun: { ranAt: 'now' } });
  });

  it('rejects a non-platform-admin with 403', async () => {
    a.user.isPlatformAdmin = false;
    expect((await request(app()).get('/platform/billing-config-health')).status).toBe(403);
  });

  it('returns 500 when verification throws', async () => {
    a.verifyStripePricesMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/platform/billing-config-health')).status).toBe(500);
  });
});

describe('GET /platform/billing-config-health/last-live-run', () => {
  it('returns the live summary and honors refresh', async () => {
    a.getLiveSummaryMock.mockResolvedValue({ lastRun: 'red' });
    const res = await request(app()).get('/platform/billing-config-health/last-live-run?refresh=1');
    expect(res.body).toEqual({ lastRun: 'red' });
    expect(a.getLiveSummaryMock).toHaveBeenCalledWith({ forceRefresh: true });
  });

  it('returns 500 on failure', async () => {
    a.getLiveSummaryMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/platform/billing-config-health/last-live-run')).status).toBe(500);
  });
});

describe('GET /platform/billing-config-health/last-live-screenshot.png', () => {
  it('returns 404 when no screenshot is available', async () => {
    expect((await request(app()).get('/platform/billing-config-health/last-live-screenshot.png')).status).toBe(404);
  });

  it('streams the PNG when a screenshot exists', async () => {
    a.getLatestScreenshotMock.mockResolvedValue({ contentType: 'image/png', buffer: Buffer.from('PNGDATA') });
    const res = await request(app()).get('/platform/billing-config-health/last-live-screenshot.png');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
  });

  it('returns 500 when streaming throws', async () => {
    a.getLatestScreenshotMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/platform/billing-config-health/last-live-screenshot.png')).status).toBe(500);
  });
});
