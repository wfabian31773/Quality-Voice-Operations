import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  getTenantCsatSettingsMock: vi.fn(),
  updateTenantCsatSettingsMock: vi.fn(),
  validateCsatSettingsUpdateMock: vi.fn(),
  listRecentCsatResponsesMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/analytics', () => ({
  getTenantCsatSettings: a.getTenantCsatSettingsMock,
  updateTenantCsatSettings: a.updateTenantCsatSettingsMock,
  validateCsatSettingsUpdate: a.validateCsatSettingsUpdateMock,
  listRecentCsatResponses: a.listRecentCsatResponsesMock,
}));

import csatRouter from './csat';

function app() {
  const app = express();
  app.use(express.json());
  app.use(csatRouter);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.getTenantCsatSettingsMock.mockReset().mockResolvedValue({ enabled: true });
  a.updateTenantCsatSettingsMock.mockReset().mockResolvedValue({ enabled: false });
  a.validateCsatSettingsUpdateMock.mockReset().mockReturnValue(null);
  a.listRecentCsatResponsesMock.mockReset().mockResolvedValue([]);
});

describe('GET /csat/settings', () => {
  it('returns the tenant settings', async () => {
    const res = await request(app()).get('/csat/settings');
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({ enabled: true });
  });

  it('returns 500 on failure', async () => {
    a.getTenantCsatSettingsMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/csat/settings')).status).toBe(500);
  });
});

describe('PATCH /csat/settings', () => {
  it('requires the owner role', async () => {
    // manager is below owner — real rbac gate blocks
    expect((await request(app()).patch('/csat/settings').send({ enabled: false })).status).toBe(403);
  });

  it('rejects invalid settings with 400', async () => {
    a.user.role = 'tenant_owner';
    a.validateCsatSettingsUpdateMock.mockReturnValue('threshold must be positive');
    const res = await request(app()).patch('/csat/settings').send({ threshold: -1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('threshold');
  });

  it('updates settings for an owner', async () => {
    a.user.role = 'tenant_owner';
    const res = await request(app()).patch('/csat/settings').send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.settings).toEqual({ enabled: false });
  });
});

describe('GET /csat/responses/recent', () => {
  it('validates the limit bounds', async () => {
    expect((await request(app()).get('/csat/responses/recent?limit=0')).status).toBe(400);
    expect((await request(app()).get('/csat/responses/recent?limit=500')).status).toBe(400);
  });

  it('returns a UI-friendly mapped shape', async () => {
    a.listRecentCsatResponsesMock.mockResolvedValue([
      { id: 'r1', callSessionId: 'cs1', requestChannel: 'sms', responseChannel: 'sms', scoreRaw: '5', scoreScale: 5, scoreNormalized: 1, comment: 'great', respondedAt: 'now', dispatchToken: 'SECRET' },
    ]);
    const res = await request(app()).get('/csat/responses/recent?limit=20');
    expect(res.status).toBe(200);
    expect(res.body.responses[0]).toMatchObject({ id: 'r1', scoreNormalized: 1 });
    expect(res.body.responses[0]).not.toHaveProperty('dispatchToken');
  });

  it('returns 500 on failure', async () => {
    a.listRecentCsatResponsesMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/csat/responses/recent')).status).toBe(500);
  });
});
