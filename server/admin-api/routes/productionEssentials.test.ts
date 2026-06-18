import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  queryMock: vi.fn(),
  getUserPreferencesMock: vi.fn(),
  setUserPreferencesMock: vi.fn(),
  getConnectorAlertSettingsMock: vi.fn(),
  setConnectorAlertSettingsMock: vi.fn(),
  getConnectorAlertMutesMock: vi.fn(),
  replaceConnectorAlertMutesMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../../../platform/db', () => ({ getPlatformPool: () => ({ query: a.queryMock }) }));
vi.mock('../../../platform/notifications/NotificationPreferences', () => ({
  getUserPreferences: a.getUserPreferencesMock,
  setUserPreferences: a.setUserPreferencesMock,
  NOTIFICATION_CATEGORIES: ['billing'],
  NOTIFICATION_CHANNELS: ['email'],
  isNotificationCategory: (c: string) => c === 'billing',
  isNotificationChannel: (c: string) => c === 'email',
}));
vi.mock('../../../platform/integrations/connectors/ConnectorAlertPreferences', () => ({
  getConnectorAlertSettings: a.getConnectorAlertSettingsMock,
  setConnectorAlertSettings: a.setConnectorAlertSettingsMock,
  getConnectorAlertMutes: a.getConnectorAlertMutesMock,
  replaceConnectorAlertMutes: a.replaceConnectorAlertMutesMock,
}));

import router from './productionEssentials';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.user.isPlatformAdmin = false;
  a.queryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  a.getUserPreferencesMock.mockReset().mockResolvedValue({ billing: { email: true } });
  a.setUserPreferencesMock.mockReset().mockResolvedValue({ billing: { email: false } });
  a.getConnectorAlertSettingsMock.mockReset().mockResolvedValue({ digestMode: false, digestLastSentAt: null, updatedAt: null });
  a.setConnectorAlertSettingsMock.mockReset().mockResolvedValue({ digestMode: true, digestLastSentAt: null, updatedAt: null });
  a.getConnectorAlertMutesMock.mockReset().mockResolvedValue([]);
  a.replaceConnectorAlertMutesMock.mockReset().mockResolvedValue([]);
});

describe('maintenance', () => {
  it('GET returns payload + ETag, and 304 on matching If-None-Match', async () => {
    a.queryMock.mockResolvedValue({ rows: [{ value: { enabled: true, message: 'down' }, updated_at: new Date('2026-05-01T00:00:00Z') }] });
    const res = await request(app()).get('/platform/maintenance');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: true, message: 'down' });
    const etag = res.headers.etag;
    const res2 = await request(app()).get('/platform/maintenance').set('If-None-Match', etag);
    expect(res2.status).toBe(304);
  });

  it('PUT requires platform admin', async () => {
    expect((await request(app()).put('/platform/maintenance').send({ enabled: true })).status).toBe(403);
  });

  it('PUT updates maintenance for a platform admin', async () => {
    a.user.isPlatformAdmin = true;
    const res = await request(app()).put('/platform/maintenance').send({ enabled: true, message: 'brb' });
    expect(res.body).toEqual({ success: true });
    expect(a.queryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO platform_settings'))).toBe(true);
  });
});

describe('changelog', () => {
  it('lists entries', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('FROM changelog_entries e') && sql.includes('ORDER BY') ? { rows: [{ id: 'c1', title: 'T', read: false }] } : { rows: [] },
    );
    expect((await request(app()).get('/platform/changelog')).body.entries).toHaveLength(1);
  });
  it('unread count', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('COUNT(*)::int AS c') ? { rows: [{ c: 3 }] } : { rows: [] },
    );
    expect((await request(app()).get('/platform/changelog/unread-count')).body).toEqual({ count: 3 });
  });
  it('marks one read', async () => {
    expect((await request(app()).post('/platform/changelog/c1/read')).body).toEqual({ success: true });
  });
  it('marks all read', async () => {
    expect((await request(app()).post('/platform/changelog/read-all')).body).toEqual({ success: true });
  });
  it('create requires title/body', async () => {
    a.user.isPlatformAdmin = true;
    expect((await request(app()).post('/platform/changelog').send({ title: 'T' })).status).toBe(400);
  });
  it('create entry (platform admin)', async () => {
    a.user.isPlatformAdmin = true;
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('INSERT INTO changelog_entries') ? { rows: [{ id: 'c9', title: 'T' }] } : { rows: [] },
    );
    expect((await request(app()).post('/platform/changelog').send({ title: 'T', body: 'B' })).status).toBe(201);
  });
});

describe('notifications', () => {
  it('unread count', async () => {
    a.queryMock.mockResolvedValue({ rows: [{ c: 2 }] });
    expect((await request(app()).get('/platform/notifications/unread-count')).body).toEqual({ count: 2 });
  });
  it('read-all', async () => {
    expect((await request(app()).post('/platform/notifications/read-all')).body).toEqual({ success: true });
  });
  it('clears notifications', async () => {
    expect((await request(app()).delete('/platform/notifications')).body).toEqual({ success: true });
  });
  it('GET preferences', async () => {
    const res = await request(app()).get('/platform/notifications/preferences');
    expect(res.body).toMatchObject({ categories: ['billing'], channels: ['email'] });
  });
  it('PUT preferences requires an object', async () => {
    expect((await request(app()).put('/platform/notifications/preferences').send({ preferences: 'no' })).status).toBe(400);
  });
  it('PUT preferences sanitizes and saves', async () => {
    const res = await request(app()).put('/platform/notifications/preferences').send({
      preferences: { billing: { email: false, sms: true }, bogus: { email: true } },
    });
    expect(res.status).toBe(200);
    const arg = a.setUserPreferencesMock.mock.calls[0][1];
    expect(arg).toHaveProperty('billing');
    expect(arg).not.toHaveProperty('bogus');
  });
});

describe('connector-alert preferences', () => {
  it('GET returns settings + mutes', async () => {
    a.getConnectorAlertMutesMock.mockResolvedValue([{ scope: 'provider', target: 'hubspot' }]);
    const res = await request(app()).get('/platform/notifications/connector-alerts');
    expect(res.body.settings).toMatchObject({ digestMode: false });
    expect(res.body.mutes).toHaveLength(1);
  });
  it('PUT rejects a non-array mutes', async () => {
    expect((await request(app()).put('/platform/notifications/connector-alerts').send({ mutes: 'no' })).status).toBe(400);
  });
  it('PUT rejects a non-boolean digestMode', async () => {
    expect((await request(app()).put('/platform/notifications/connector-alerts').send({ digestMode: 'yes' })).status).toBe(400);
  });
  it('PUT saves sanitized settings + mutes', async () => {
    a.replaceConnectorAlertMutesMock.mockResolvedValue([{ scope: 'provider', target: 'hubspot' }]);
    const res = await request(app()).put('/platform/notifications/connector-alerts').send({
      digestMode: true,
      mutes: [{ scope: 'provider', target: 'hubspot' }, { scope: 'bogus', target: 'x' }],
    });
    expect(res.status).toBe(200);
    expect(a.replaceConnectorAlertMutesMock).toHaveBeenCalledWith('t1', [{ scope: 'provider', target: 'hubspot' }], 'u1');
  });
});

describe('GET /tenants/me/trial-status', () => {
  it('reports an active trial with days remaining', async () => {
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM tenants WHERE id = $1')) return { rows: [{ trial_expires_at: future, status: 'trialing', plan: 'starter' }] };
      if (sql.includes('FROM subscriptions')) return { rows: [{ plan: 'starter', status: 'trialing', trial_end: future }] };
      return { rows: [] };
    });
    const res = await request(app()).get('/tenants/me/trial-status');
    expect(res.body.onTrial).toBe(true);
    expect(res.body.daysRemaining).toBeGreaterThan(0);
  });
  it('reports a paid plan', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM tenants WHERE id = $1')) return { rows: [{ status: 'active', plan: 'pro' }] };
      if (sql.includes('FROM subscriptions')) return { rows: [{ plan: 'pro', status: 'active', trial_end: null }] };
      return { rows: [] };
    });
    const res = await request(app()).get('/tenants/me/trial-status');
    expect(res.body.onPaidPlan).toBe(true);
    expect(res.body.onTrial).toBe(false);
  });
});
