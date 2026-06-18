import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const a = vi.hoisted(() => ({
  user: { userId: 'u1', tenantId: 't1', email: 'e@x.com', role: 'operations_manager', isPlatformAdmin: false },
  poolQueryMock: vi.fn(),
}));

vi.mock('../middleware/auth', () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.user = a.user as never;
    next();
  },
}));
// requireMiniSystemWrite from ../middleware/rbac stays real.
vi.mock('../../../platform/db', () => ({ getPlatformPool: () => ({ query: a.poolQueryMock, connect: async () => ({ query: a.poolQueryMock, release: vi.fn() }) }) }));
vi.mock('../../../platform/notifications/dispatchPush', () => ({ fireDispatchPush: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../../platform/integrations/connectors', () => ({
  connectorService: { dispatchEvent: vi.fn().mockResolvedValue(undefined), emit: vi.fn().mockResolvedValue(undefined) },
}));

import router from './scheduling';

function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

beforeEach(() => {
  a.user.role = 'operations_manager';
  a.poolQueryMock.mockReset().mockResolvedValue({ rows: [] });
});

describe('list endpoints (simple reads)', () => {
  const listPaths = [
    '/scheduling/bookings',
    '/scheduling/providers',
    '/scheduling/overrides',
    '/scheduling/appointment-types',
    '/scheduling/resources',
    '/scheduling/rules',
    '/scheduling/waitlist',
    '/scheduling/reminders',
    '/scheduling/recurring',
    '/scheduling/audit-log',
  ];
  for (const path of listPaths) {
    it(`GET ${path} returns 200`, async () => {
      expect((await request(app()).get(path)).status).toBe(200);
    });
  }
  it('GET /scheduling/bookings surfaces query failures as 500', async () => {
    a.poolQueryMock.mockRejectedValue(new Error('db down'));
    expect((await request(app()).get('/scheduling/bookings')).status).toBe(500);
  });
});

describe('GET /scheduling/bookings/:id', () => {
  it('404 when missing', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [] });
    expect((await request(app()).get('/scheduling/bookings/bk1')).status).toBe(404);
  });
  it('returns a booking', async () => {
    a.poolQueryMock.mockResolvedValue({ rows: [{ id: 'bk1', title: 'Consult' }] });
    const res = await request(app()).get('/scheduling/bookings/bk1');
    expect(res.status).toBe(200);
    expect(res.body.booking).toMatchObject({ id: 'bk1' });
  });
});

describe('POST /scheduling/bookings', () => {
  it('requires title/start/end', async () => {
    expect((await request(app()).post('/scheduling/bookings').send({ title: 'X' })).status).toBe(400);
  });
  it('rejects start_time after end_time', async () => {
    const res = await request(app()).post('/scheduling/bookings').send({
      title: 'X', start_time: '2030-01-02T10:00:00Z', end_time: '2030-01-02T09:00:00Z',
    });
    expect(res.status).toBe(400);
  });
  it('rejects a viewer via the mini-system-write gate', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).post('/scheduling/bookings').send({ title: 'X' })).status).toBe(403);
  });
});

describe('mini-system-write gate', () => {
  it('blocks a viewer from creating a provider', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).post('/scheduling/providers').send({ name: 'Dr. A' })).status).toBe(403);
  });
});
