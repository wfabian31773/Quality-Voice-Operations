import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  getWidgetConfigMock: vi.fn(),
  upsertWidgetConfigMock: vi.fn(),
  generateWidgetTokenMock: vi.fn(),
  listWidgetTokensMock: vi.fn(),
  revokeWidgetTokenMock: vi.fn(),
  validateWidgetTokenMock: vi.fn(),
  getPublicWidgetConfigMock: vi.fn(),
  readFileSyncMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('fs', () => ({ default: { readFileSync: a.readFileSyncMock }, readFileSync: a.readFileSyncMock }));
vi.mock('../../../platform/widget/WidgetTokenService', () => ({
  getWidgetConfig: a.getWidgetConfigMock,
  upsertWidgetConfig: a.upsertWidgetConfigMock,
  generateWidgetToken: a.generateWidgetTokenMock,
  listWidgetTokens: a.listWidgetTokensMock,
  revokeWidgetToken: a.revokeWidgetTokenMock,
  validateWidgetToken: a.validateWidgetTokenMock,
  getPublicWidgetConfig: a.getPublicWidgetConfigMock,
}));

import router from './widget';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.getWidgetConfigMock.mockReset().mockResolvedValue(null);
  a.upsertWidgetConfigMock.mockReset().mockResolvedValue({ enabled: true });
  a.generateWidgetTokenMock.mockReset().mockResolvedValue({ token: { id: 'tok1' }, plaintextToken: 'secret' });
  a.listWidgetTokensMock.mockReset().mockResolvedValue([]);
  a.revokeWidgetTokenMock.mockReset();
  a.validateWidgetTokenMock.mockReset();
  a.getPublicWidgetConfigMock.mockReset();
  a.readFileSyncMock.mockReset().mockReturnValue('console.log("widget");');
});

describe('GET /widget/config', () => {
  it('returns the config', async () => {
    a.getWidgetConfigMock.mockResolvedValue({ enabled: true });
    expect((await request(app()).get('/widget/config')).body.config).toEqual({ enabled: true });
  });
  it('returns 500 on failure', async () => {
    a.getWidgetConfigMock.mockRejectedValue(new Error('boom'));
    expect((await request(app()).get('/widget/config')).status).toBe(500);
  });
});

describe('PUT /widget/config', () => {
  it('rejects an invalid primary_color', async () => {
    const res = await request(app()).put('/widget/config').send({ primary_color: 'blue' });
    expect(res.status).toBe(400);
  });
  it('rejects a viewer via rbac', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).put('/widget/config').send({ enabled: true })).status).toBe(403);
  });
  it('upserts allowed fields', async () => {
    const res = await request(app()).put('/widget/config').send({ enabled: true, primary_color: '#6366f1', bogus: 'x' });
    expect(res.status).toBe(200);
    const arg = a.upsertWidgetConfigMock.mock.calls[0][1];
    expect(arg).toHaveProperty('enabled');
    expect(arg).not.toHaveProperty('bogus');
  });
});

describe('widget tokens', () => {
  it('lists tokens', async () => {
    a.listWidgetTokensMock.mockResolvedValue([{ id: 't' }]);
    expect((await request(app()).get('/widget/tokens')).body.tokens).toHaveLength(1);
  });
  it('generates a token (plaintext once)', async () => {
    const res = await request(app()).post('/widget/tokens').send({ label: 'CI' });
    expect(res.status).toBe(201);
    expect(res.body.plaintextToken).toBe('secret');
  });
  it('revokes a token', async () => {
    a.revokeWidgetTokenMock.mockResolvedValue(true);
    expect((await request(app()).delete('/widget/tokens/tok1')).body).toEqual({ success: true });
  });
  it('returns 404 when the token is missing', async () => {
    a.revokeWidgetTokenMock.mockResolvedValue(false);
    expect((await request(app()).delete('/widget/tokens/ghost')).status).toBe(404);
  });
});

describe('GET /widget/public-config (public)', () => {
  it('requires a token', async () => {
    expect((await request(app()).get('/widget/public-config')).status).toBe(400);
  });
  it('rejects an invalid token', async () => {
    a.validateWidgetTokenMock.mockResolvedValue(null);
    expect((await request(app()).get('/widget/public-config?token=bad')).status).toBe(401);
  });
  it('returns the public config for a valid token', async () => {
    a.validateWidgetTokenMock.mockResolvedValue({ tenantId: 't1' });
    a.getWidgetConfigMock.mockResolvedValue({ allowed_domains: [] });
    a.getPublicWidgetConfigMock.mockResolvedValue({ greeting: 'hi' });
    const res = await request(app()).get('/widget/public-config?token=ok');
    expect(res.status).toBe(200);
    expect(res.body.config).toEqual({ greeting: 'hi' });
  });
  it('blocks an unauthorized domain with 403', async () => {
    a.validateWidgetTokenMock.mockResolvedValue({ tenantId: 't1' });
    a.getWidgetConfigMock.mockResolvedValue({ allowed_domains: ['example.com'] });
    const res = await request(app()).get('/widget/public-config?token=ok').set('Origin', 'https://evil.com');
    expect(res.status).toBe(403);
  });
  it('returns 404 when the widget is not configured', async () => {
    a.validateWidgetTokenMock.mockResolvedValue({ tenantId: 't1' });
    a.getWidgetConfigMock.mockResolvedValue({ allowed_domains: [] });
    a.getPublicWidgetConfigMock.mockResolvedValue(null);
    expect((await request(app()).get('/widget/public-config?token=ok')).status).toBe(404);
  });
});

describe('GET /widget/embed.js', () => {
  it('serves the embed script as javascript', async () => {
    const res = await request(app()).get('/widget/embed.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
  });
});
