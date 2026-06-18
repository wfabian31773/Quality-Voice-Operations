import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'tenant_owner', isPlatformAdmin: false },
  queryMock: vi.fn(),
  clientQueryMock: vi.fn(),
  releaseMock: vi.fn(),
  listJobsHandler: vi.fn((_req: express.Request, res: express.Response) => res.json({ route: 'listJobs' })),
}));

vi.mock('../middleware/auth', () => ({ requireAuth: (_r: unknown, _s: unknown, n: () => void) => n() }));
vi.mock('../middleware/apiKeyAuth', () => ({
  requireApiKeyOrJwt: () => (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
vi.mock('../middleware/apiKeyScope', () => ({
  requireApiKeyPermission: () => (_r: unknown, _s: unknown, n: () => void) => n(),
}));
vi.mock('../../../platform/infra/rate-limit/createRateLimiter', () => ({
  createRateLimiter: () => (_r: unknown, _s: unknown, n: () => void) => n(),
}));
vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({
    query: a.queryMock,
    connect: async () => ({ query: a.clientQueryMock, release: a.releaseMock }),
  }),
}));
vi.mock('./dispatch', () => ({
  listJobsHandler: a.listJobsHandler,
  getJobHandler: vi.fn(), transitionJobHandler: vi.fn(), listResourcesHandler: vi.fn(),
  addAttachmentHandler: vi.fn(), requestAttachmentUploadUrlHandler: vi.fn(),
  getAttachmentFileHandler: vi.fn(), recordResourceLocationHandler: vi.fn(),
}));
vi.mock('./scheduling', () => ({
  listBookingsHandler: vi.fn(), getBookingHandler: vi.fn(), transitionBookingHandler: vi.fn(),
}));

import router from './mobileApi';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.userId = 'u1';
  a.queryMock.mockReset().mockResolvedValue({ rows: [], rowCount: 0 });
  a.clientQueryMock.mockReset().mockResolvedValue({ rows: [] });
  a.releaseMock.mockReset();
  a.listJobsHandler.mockClear();
});

describe('mounted dispatch wiring', () => {
  it('routes GET /api/v1/dispatch/jobs to the dispatch handler', async () => {
    expect((await request(app()).get('/api/v1/dispatch/jobs')).body).toEqual({ route: 'listJobs' });
    expect(a.listJobsHandler).toHaveBeenCalled();
  });
});

describe('POST /api/v1/mobile/devices (register)', () => {
  const TOKEN = 'ExponentPushToken[abc123]';
  it('requires a token', async () => {
    expect((await request(app()).post('/api/v1/mobile/devices').send({})).status).toBe(400);
  });
  it('rejects a non-Expo token', async () => {
    expect((await request(app()).post('/api/v1/mobile/devices').send({ token: 'plain' })).status).toBe(400);
  });
  it('rejects a resource_id from another tenant', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('FROM dispatch_resources') ? { rows: [] } : { rows: [] },
    );
    const res = await request(app()).post('/api/v1/mobile/devices').send({ token: TOKEN, resource_id: 'r1' });
    expect(res.status).toBe(400);
  });
  it('registers a device (upsert)', async () => {
    a.queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM dispatch_resources')) return { rows: [{ id: 'r1' }] };
      if (sql.includes('INSERT INTO user_devices')) return { rows: [{ id: 'd1', push_token: TOKEN }] };
      return { rows: [] };
    });
    const res = await request(app()).post('/api/v1/mobile/devices').send({ token: TOKEN, resource_id: 'r1', platform: 'ios' });
    expect(res.status).toBe(200);
    expect(res.body.device).toMatchObject({ id: 'd1' });
  });
  it('returns 500 on insert failure', async () => {
    a.queryMock.mockRejectedValue(new Error('db down'));
    expect((await request(app()).post('/api/v1/mobile/devices').send({ token: TOKEN })).status).toBe(500);
  });
});

describe('POST /api/v1/mobile/devices/enroll', () => {
  const code = 'ABCD2345';
  const install = 'install-12345';
  it('rejects an invalid pairing code', async () => {
    expect((await request(app()).post('/api/v1/mobile/devices/enroll').send({ pairing_code: 'bad' })).status).toBe(400);
  });
  it('returns 404 for an unknown code', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) =>
      sql.includes('pairing_codes') ? { rows: [] } : { rows: [] },
    );
    expect((await request(app()).post('/api/v1/mobile/devices/enroll').send({ pairing_code: code })).status).toBe(404);
  });
  it('returns 409 when the code was already consumed', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) =>
      sql.includes('pairing_codes') && sql.includes('FOR UPDATE')
        ? { rows: [{ id: 'pc1', resource_id: 'r1', expires_at: new Date(Date.now() + 60000), consumed_at: new Date() }] }
        : { rows: [] },
    );
    expect((await request(app()).post('/api/v1/mobile/devices/enroll').send({ pairing_code: code })).status).toBe(409);
  });
  it('returns 410 when the code expired', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) =>
      sql.includes('pairing_codes') && sql.includes('FOR UPDATE')
        ? { rows: [{ id: 'pc1', resource_id: 'r1', expires_at: new Date(Date.now() - 60000), consumed_at: null }] }
        : { rows: [] },
    );
    expect((await request(app()).post('/api/v1/mobile/devices/enroll').send({ pairing_code: code })).status).toBe(410);
  });
  it('mints a device secret on success', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('pairing_codes') && sql.includes('FOR UPDATE')) return { rows: [{ id: 'pc1', resource_id: 'r1', expires_at: new Date(Date.now() + 60000), consumed_at: null }] };
      if (sql.includes('FROM dispatch_resources')) return { rows: [{ id: 'r1', name: 'Truck 1' }] };
      if (sql.includes('INSERT INTO user_devices')) return { rows: [{ id: 'd1' }] };
      return { rows: [] };
    });
    const res = await request(app()).post('/api/v1/mobile/devices/enroll').send({ pairing_code: code, install_id: install });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ resource_id: 'r1', resource_name: 'Truck 1' });
    expect(typeof res.body.device_secret).toBe('string');
  });
  it('requires a valid install_id', async () => {
    a.clientQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('pairing_codes') && sql.includes('FOR UPDATE')) return { rows: [{ id: 'pc1', resource_id: 'r1', expires_at: new Date(Date.now() + 60000), consumed_at: null }] };
      if (sql.includes('FROM dispatch_resources')) return { rows: [{ id: 'r1', name: 'Truck 1' }] };
      return { rows: [] };
    });
    expect((await request(app()).post('/api/v1/mobile/devices/enroll').send({ pairing_code: code, install_id: 'x' })).status).toBe(400);
  });
});

describe('PATCH/DELETE /api/v1/mobile/devices/:token', () => {
  it('rejects an empty patch', async () => {
    expect((await request(app()).patch('/api/v1/mobile/devices/tok').send({})).status).toBe(400);
  });
  it('updates a device', async () => {
    a.queryMock.mockImplementation(async (sql: string) =>
      sql.includes('UPDATE user_devices') ? { rows: [{ id: 'd1', push_enabled: false }] } : { rows: [] },
    );
    const res = await request(app()).patch('/api/v1/mobile/devices/tok').send({ push_enabled: false });
    expect(res.status).toBe(200);
  });
  it('404 when the device to update is missing', async () => {
    a.queryMock.mockResolvedValue({ rows: [] });
    expect((await request(app()).patch('/api/v1/mobile/devices/tok').send({ push_enabled: true })).status).toBe(404);
  });
  it('deletes a device', async () => {
    a.queryMock.mockResolvedValue({ rows: [], rowCount: 1 });
    expect((await request(app()).delete('/api/v1/mobile/devices/tok')).body).toEqual({ success: true, removed: 1 });
  });
});
