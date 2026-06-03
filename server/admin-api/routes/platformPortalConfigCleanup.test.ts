import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  getLatestSnapshotMock: vi.fn(),
  runCycleMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/billing/PortalConfigCleanupScheduler', () => ({
  PORTAL_CONFIG_CLEANUP_DEFAULTS: { intervalMs: 86_400_000 },
  getLatestPortalConfigCleanupSnapshot: a.getLatestSnapshotMock,
  runPortalConfigCleanupCycle: a.runCycleMock,
}));

import router from './platformPortalConfigCleanup';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.isPlatformAdmin = true;
  a.getLatestSnapshotMock.mockReset().mockReturnValue({ deactivated: 0 });
  a.runCycleMock.mockReset().mockResolvedValue({ deactivated: 3 });
});

describe('GET /platform/portal-config-cleanup', () => {
  it('returns the latest snapshot for a platform admin', async () => {
    const res = await request(app()).get('/platform/portal-config-cleanup');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ intervalMs: 86_400_000, lastRun: { deactivated: 0 } });
  });

  it('rejects a non-platform-admin with 403', async () => {
    a.user.isPlatformAdmin = false;
    expect((await request(app()).get('/platform/portal-config-cleanup')).status).toBe(403);
  });

  it('returns 500 when snapshot loading throws', async () => {
    a.getLatestSnapshotMock.mockImplementation(() => { throw new Error('boom'); });
    expect((await request(app()).get('/platform/portal-config-cleanup')).status).toBe(500);
  });
});

describe('POST /platform/portal-config-cleanup/run', () => {
  it('runs a manual cleanup cycle', async () => {
    const res = await request(app()).post('/platform/portal-config-cleanup/run');
    expect(res.status).toBe(200);
    expect(res.body.lastRun).toEqual({ deactivated: 3 });
    expect(a.runCycleMock).toHaveBeenCalledWith({ source: 'manual' });
  });

  it('returns 500 when the cycle bookkeeping throws', async () => {
    a.runCycleMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).post('/platform/portal-config-cleanup/run')).status).toBe(500);
  });
});
