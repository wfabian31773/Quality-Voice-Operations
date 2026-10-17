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
vi.mock('../../../platform/db', () => ({
  getPlatformPool: () => ({ query: a.poolQueryMock, connect: async () => ({ query: a.poolQueryMock, release: vi.fn() }) }),
  withTenantContext: vi.fn(async () => {}),
}));
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

describe('booking overlap (122 exclusion constraint, 23P01) → 409', () => {
  const overlapErr = Object.assign(new Error('conflicting key value violates exclusion constraint'), {
    code: '23P01', constraint: 'bookings_no_provider_overlap',
  });
  const SLOT_UNAVAILABLE = { error: 'That time slot is no longer available', reason: 'slot_unavailable' };

  it('create with allow_double_book = true returns 409 instead of 500', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      if (/scheduling_booking_rules/.test(sql)) return { rows: [{ allow_double_book: true, allow_same_day: true }] };
      if (/INSERT INTO bookings/.test(sql)) throw overlapErr;
      return { rows: [] };
    });
    const res = await request(app()).post('/scheduling/bookings').send({
      title: 'X', start_time: '2030-01-02T09:00:00Z', end_time: '2030-01-02T09:30:00Z', provider_id: 'p1',
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual(SLOT_UNAVAILABLE);
  });

  it('create still returns 500 for other database errors', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      if (/INSERT INTO bookings/.test(sql)) throw Object.assign(new Error('boom'), { code: '23P01', constraint: 'other_constraint' });
      return { rows: [] };
    });
    const res = await request(app()).post('/scheduling/bookings').send({
      title: 'X', start_time: '2030-01-02T09:00:00Z', end_time: '2030-01-02T09:30:00Z', override_reason: 'ok',
    });
    expect(res.status).toBe(500);
  });

  it('update into an overlapping held/confirmed slot returns 409', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      if (/^SELECT \* FROM bookings/.test(sql)) return { rows: [{ id: 'b1', status: 'pending', start_time: '2030-01-02T09:00:00Z', end_time: '2030-01-02T09:30:00Z', provider_id: 'p1' }] };
      if (/UPDATE bookings SET/.test(sql)) throw overlapErr;
      return { rows: [] };
    });
    const res = await request(app()).put('/scheduling/bookings/b1').send({
      start_time: '2030-01-02T10:00:00Z', end_time: '2030-01-02T10:30:00Z', status: 'confirmed', override_reason: 'double book',
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual(SLOT_UNAVAILABLE);
  });

  it('confirm into an occupied slot returns 409 and rolls back', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      if (/^SELECT \* FROM bookings/.test(sql)) return { rows: [{ id: 'b1', status: 'pending', start_time: '2030-01-02T09:00:00Z', end_time: '2030-01-02T09:30:00Z', provider_id: 'p1' }] };
      if (/UPDATE bookings SET/.test(sql)) throw overlapErr;
      return { rows: [] };
    });
    const res = await request(app()).post('/scheduling/bookings/b1/transition').send({ action: 'confirm', override_reason: 'double book' });
    expect(res.status).toBe(409);
    expect(res.body).toEqual(SLOT_UNAVAILABLE);
    const sqls = a.poolQueryMock.mock.calls.map(([sql]) => sql);
    expect(sqls).toContain('BEGIN');
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
  });

  it('override reschedule whose replacement INSERT overlaps returns 409 and rolls back the original UPDATE', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      if (/^SELECT \* FROM bookings/.test(sql)) return { rows: [{ id: 'b1', status: 'confirmed', start_time: '2030-01-02T09:00:00Z', end_time: '2030-01-02T09:30:00Z', provider_id: 'p1' }] };
      if (/UPDATE bookings SET/.test(sql)) return { rows: [], rowCount: 1 };
      if (/INSERT INTO bookings/.test(sql)) throw overlapErr;
      return { rows: [] };
    });
    const res = await request(app()).post('/scheduling/bookings/b1/transition').send({
      action: 'reschedule', new_start_time: '2030-01-02T10:00:00Z', new_end_time: '2030-01-02T10:30:00Z', override_reason: 'double book',
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual(SLOT_UNAVAILABLE);
    const sqls = a.poolQueryMock.mock.calls.map(([sql]) => String(sql));
    expect(sqls.indexOf('ROLLBACK')).toBeGreaterThan(sqls.findIndex((s) => /UPDATE bookings SET/.test(s)));
    expect(sqls).not.toContain('COMMIT');
  });
});

describe('mini-system-write gate', () => {
  it('blocks a viewer from creating a provider', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).post('/scheduling/providers').send({ name: 'Dr. A' })).status).toBe(403);
  });
});
