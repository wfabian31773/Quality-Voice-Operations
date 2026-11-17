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

import router, { materializeRecurringSeries, type RecurringSeriesRow } from './scheduling';
import {
  createBookingFingerprint,
  parseCreateBookingBody,
  parseTransitionBookingBody,
  parseUiIdempotencyKey,
  phoneHoldConflictBody,
} from './schedulingSchemas';

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
    const res = await request(app()).post('/scheduling/bookings').send({ title: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.fields).toMatchObject({ start_time: expect.any(String), end_time: expect.any(String) });
  });
  it('rejects start_time after end_time', async () => {
    const res = await request(app()).post('/scheduling/bookings').send({
      title: 'X', start_time: '2030-01-02T10:00:00Z', end_time: '2030-01-02T09:00:00Z',
    });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: 'Validation failed',
      fields: { end_time: 'end_time must be after start_time' },
    });
  });
  it('rejects a viewer via the mini-system-write gate', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).post('/scheduling/bookings').send({ title: 'X' })).status).toBe(403);
  });
});

const CUT = {
  id: 'bk1',
  title: 'Cut',
  description: '',
  start_time: '2030-01-02T09:00:00.000Z',
  end_time: '2030-01-02T09:30:00.000Z',
  status: 'confirmed',
  contact_name: '',
  contact_phone: '',
  contact_email: '',
  agent_id: null,
  notes: '',
  provider_id: null,
  appointment_type_id: null,
  resource_id: null,
  recurring_series_id: null,
  location: '',
  booking_source: 'manual',
};

describe('booking write validation', () => {
  it('accepts datetime-local start/end from the Scheduling page', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      if (/INSERT INTO bookings/.test(sql)) return { rows: [CUT] };
      return { rows: [] };
    });
    const res = await request(app()).post('/scheduling/bookings').send({
      title: 'Cut', start_time: '2030-01-02T09:00', end_time: '2030-01-02T09:30',
      provider_id: null, appointment_type_id: null, resource_id: null,
      status: 'confirmed', contact_name: '', contact_phone: '', contact_email: '',
      notes: '', location: '', timezone: 'America/New_York', booking_source: 'manual',
    });
    expect(res.status).toBe(201);
  });

  it('rejects an oversized title with fields', async () => {
    const res = await request(app()).post('/scheduling/bookings').send({
      title: 'x'.repeat(501), start_time: '2030-01-02T09:00:00Z', end_time: '2030-01-02T09:30:00Z',
    });
    expect(res.status).toBe(400);
    expect(res.body.fields.title).toMatch(/500|too big|too_big|at most/i);
  });

  it('rejects an unknown status', async () => {
    const res = await request(app()).post('/scheduling/bookings').send({
      title: 'Cut', start_time: '2030-01-02T09:00:00Z', end_time: '2030-01-02T09:30:00Z', status: 'held',
    });
    expect(res.status).toBe(400);
    expect(res.body.fields.status).toBeTruthy();
  });

  it('rejects an unknown transition action', async () => {
    const res = await request(app()).post('/scheduling/bookings/bk1/transition').send({ action: 'explode' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Validation failed');
    expect(res.body.fields.action).toBeTruthy();
  });

  it('rejects a reschedule whose end is not after start', async () => {
    const res = await request(app()).post('/scheduling/bookings/bk1/transition').send({
      action: 'reschedule', new_start_time: '2030-01-02T10:00:00Z', new_end_time: '2030-01-02T10:00:00Z',
    });
    expect(res.status).toBe(400);
    expect(res.body.fields.new_end_time).toMatch(/after/);
  });
});

describe('held-by-phone CONFLICT (spec §1.6 #10)', () => {
  const holdRow = { id: 'hold1', hold_expires_at: '2030-01-02T20:34:00.000Z' };

  it('create into a live phone hold returns 409 with expiry in the tenant timezone', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      if (/SELECT id, title, start_time, end_time FROM bookings/.test(sql)) {
        return { rows: [{ id: 'hold1', title: 'Hold', start_time: '2030-01-02T20:00:00.000Z', end_time: '2030-01-02T20:30:00.000Z' }] };
      }
      if (/hold_expires_at/.test(sql) && /status = 'held'/.test(sql)) return { rows: [holdRow] };
      if (/timezone FROM tenants/.test(sql)) return { rows: [{ timezone: 'America/New_York' }] };
      return { rows: [] };
    });
    const res = await request(app()).post('/scheduling/bookings').send({
      title: 'Cut', start_time: '2030-01-02T20:00:00.000Z', end_time: '2030-01-02T20:30:00.000Z', provider_id: 'p1',
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'CONFLICT',
      heldBy: 'phone_call',
      holdExpiresAt: '2030-01-02T20:34:00.000Z',
    });
    expect(res.body.error).toMatch(/Held by a phone call until 3:34 PM/);
    expect(res.body.message).toBe(res.body.error);
    const holdSql = a.poolQueryMock.mock.calls.map(([sql]) => String(sql)).find((sql) => /hold_expires_at/.test(sql) && /status = 'held'/.test(sql));
    expect(holdSql).toMatch(/booking_source IN \('ai_agent', 'phone'\)/);
  });

  it('a live UI/MCP hold is a generic slot conflict, not heldBy phone_call', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      if (/SELECT id, title, start_time, end_time FROM bookings/.test(sql)) {
        return { rows: [{ id: 'hold1', title: 'Hold', start_time: '2030-01-02T20:00:00.000Z', end_time: '2030-01-02T20:30:00.000Z' }] };
      }
      if (/hold_expires_at/.test(sql) && /status = 'held'/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const res = await request(app()).post('/scheduling/bookings').send({
      title: 'Cut', start_time: '2030-01-02T20:00:00.000Z', end_time: '2030-01-02T20:30:00.000Z', provider_id: 'p1',
    });
    expect(res.status).toBe(409);
    expect(res.body.heldBy).toBeUndefined();
    expect(res.body.error).toBe('Time slot conflict detected');
  });

  it('confirm into a live phone hold returns 409 and rolls back', async () => {
    const overlapErr = Object.assign(new Error('conflicting key value violates exclusion constraint'), {
      code: '23P01', constraint: 'bookings_no_provider_overlap',
    });
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      if (/^SELECT \* FROM bookings/.test(sql)) {
        return { rows: [{ id: 'b1', status: 'pending', start_time: '2030-01-02T20:00:00.000Z', end_time: '2030-01-02T20:30:00.000Z', provider_id: 'p1' }] };
      }
      if (/UPDATE bookings SET/.test(sql)) throw overlapErr;
      if (/hold_expires_at/.test(sql) && /status = 'held'/.test(sql)) return { rows: [holdRow] };
      if (/timezone FROM tenants/.test(sql)) return { rows: [{ timezone: 'America/New_York' }] };
      return { rows: [] };
    });
    const res = await request(app()).post('/scheduling/bookings/b1/transition').send({ action: 'confirm' });
    expect(res.status).toBe(409);
    expect(res.body.heldBy).toBe('phone_call');
    const sqls = a.poolQueryMock.mock.calls.map(([sql]) => sql);
    expect(sqls).toContain('ROLLBACK');
    expect(sqls).not.toContain('COMMIT');
  });
});

describe('POST /scheduling/bookings Idempotency-Key', () => {
  const payload = { title: 'Cut', start_time: '2030-01-02T09:00:00Z', end_time: '2030-01-02T09:30:00Z' };

  it('same key + same body returns the original booking without a second insert', async () => {
    let inserts = 0;
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      if (/FROM bookings WHERE tenant_id = \$1 AND idempotency_key = \$2/.test(sql)) {
        return inserts === 0 ? { rows: [] } : { rows: [CUT] };
      }
      if (/INSERT INTO bookings/.test(sql)) {
        inserts += 1;
        return { rows: [CUT] };
      }
      return { rows: [] };
    });
    const first = await request(app()).post('/scheduling/bookings').set('Idempotency-Key', 'click-1').send(payload);
    const second = await request(app()).post('/scheduling/bookings').set('Idempotency-Key', 'click-1').send(payload);
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.booking.id).toBe('bk1');
    expect(inserts).toBe(1);
  });

  it('same key + different body returns 409 IDEMPOTENCY_KEY_REUSED', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      if (/idempotency_key = \$2/.test(sql)) return { rows: [CUT] };
      return { rows: [] };
    });
    const res = await request(app()).post('/scheduling/bookings').set('Idempotency-Key', 'click-1').send({
      ...payload, title: 'Beard',
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: 'Idempotency key was reused with a different payload',
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('a unique-violation race still replays the stored row', async () => {
    const uniqueErr = Object.assign(new Error('duplicate key'), {
      code: '23505', constraint: 'uq_bookings_tenant_idempotency_key',
    });
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      if (/INSERT INTO bookings/.test(sql)) throw uniqueErr;
      if (/idempotency_key = \$2/.test(sql)) return { rows: [CUT] };
      return { rows: [] };
    });
    const res = await request(app()).post('/scheduling/bookings').set('Idempotency-Key', 'click-1').send(payload);
    expect(res.status).toBe(200);
    expect(res.body.booking.id).toBe('bk1');
  });

  it('a concurrent same-key POST that hits a slot conflict still replays', async () => {
    const stored = { ...CUT, provider_id: 'p1' };
    let keyLookups = 0;
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      if (/FROM bookings WHERE tenant_id = \$1 AND idempotency_key = \$2/.test(sql)) {
        keyLookups += 1;
        return keyLookups === 1 ? { rows: [] } : { rows: [stored] };
      }
      if (/SELECT id, title, start_time, end_time FROM bookings/.test(sql)) {
        return { rows: [{ id: 'bk1', title: 'Cut', start_time: stored.start_time, end_time: stored.end_time }] };
      }
      return { rows: [] };
    });
    const res = await request(app()).post('/scheduling/bookings').set('Idempotency-Key', 'click-1').send({
      ...payload, provider_id: 'p1',
    });
    expect(res.status).toBe(200);
    expect(res.body.booking.id).toBe('bk1');
    expect(a.poolQueryMock.mock.calls.some(([sql]) => /INSERT INTO bookings/.test(String(sql)))).toBe(false);
  });

  it('same key + different intake_data returns 409 IDEMPOTENCY_KEY_REUSED', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      if (/idempotency_key = \$2/.test(sql)) return { rows: [{ ...CUT, intake_data: {} }] };
      return { rows: [] };
    });
    const res = await request(app()).post('/scheduling/bookings').set('Idempotency-Key', 'click-1').send({
      ...payload, intake_data: { source: 'walk-in' },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('same key + different explicit timezone returns 409 IDEMPOTENCY_KEY_REUSED', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      if (/idempotency_key = \$2/.test(sql)) return { rows: [{ ...CUT, timezone: 'America/New_York' }] };
      return { rows: [] };
    });
    const res = await request(app()).post('/scheduling/bookings').set('Idempotency-Key', 'click-1').send({
      ...payload, timezone: 'America/Los_Angeles',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('transition / delete tenant miss', () => {
  it('a second transition against a stale status returns 409', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      if (/FOR UPDATE/.test(sql) || /^SELECT \* FROM bookings WHERE id/.test(sql)) {
        return { rows: [{ id: 'bk1', status: 'cancelled', start_time: '2030-01-02T09:00:00Z', end_time: '2030-01-02T09:30:00Z' }] };
      }
      return { rows: [] };
    });
    const res = await request(app()).post('/scheduling/bookings/bk1/transition').send({ action: 'cancel' });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe('stale_status');
  });

  it('transition 404s when this tenant has no such booking', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      if (/^SELECT \* FROM bookings WHERE id/.test(sql)) return { rows: [] };
      return { rows: [] };
    });
    const res = await request(app()).post('/scheduling/bookings/bk-missing/transition').send({ action: 'cancel' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Booking not found' });
  });

  it('delete records who deleted which booking', async () => {
    a.poolQueryMock.mockImplementation(async (sql: string) => {
      if (/SELECT id, status FROM bookings/.test(sql)) return { rows: [{ id: 'bk1', status: 'confirmed' }] };
      if (/DELETE FROM bookings/.test(sql)) return { rowCount: 1, rows: [] };
      return { rows: [] };
    });
    const res = await request(app()).delete('/scheduling/bookings/bk1');
    expect(res.status).toBe(200);
    const audit = a.poolQueryMock.mock.calls.find(([sql]) => /INSERT INTO scheduling_audit_log/.test(String(sql)));
    expect(audit?.[1]).toEqual(expect.arrayContaining(['t1', 'bk1', 'deleted', 'confirmed', null, 'u1']));
  });
});

describe('schedulingSchemas', () => {
  it('namespaces UI idempotency keys', () => {
    expect(parseUiIdempotencyKey('abc-1')).toEqual({ ok: true, key: 'ui:abc-1' });
    expect(parseUiIdempotencyKey(undefined)).toEqual({ ok: true, key: null });
  });

  it('fingerprints two equivalent create bodies the same way', () => {
    const aBody = parseCreateBookingBody({ title: 'Cut', start_time: '2030-01-02T09:00:00Z', end_time: '2030-01-02T09:30:00Z' });
    const bBody = parseCreateBookingBody({ title: 'Cut', start_time: '2030-01-02T09:00:00.000Z', end_time: '2030-01-02T09:30:00.000Z' });
    expect(aBody.ok && bBody.ok).toBe(true);
    if (aBody.ok && bBody.ok) {
      expect(createBookingFingerprint(aBody.data)).toBe(createBookingFingerprint(bBody.data));
    }
  });

  it('fingerprints intake_data with JSONB-stable key order', () => {
    const aBody = parseCreateBookingBody({
      title: 'Cut', start_time: '2030-01-02T09:00:00Z', end_time: '2030-01-02T09:30:00Z',
      intake_data: { longKey: 1, a: 2 },
    });
    const bBody = parseCreateBookingBody({
      title: 'Cut', start_time: '2030-01-02T09:00:00Z', end_time: '2030-01-02T09:30:00Z',
      intake_data: { a: 2, longKey: 1 },
    });
    expect(aBody.ok && bBody.ok).toBe(true);
    if (aBody.ok && bBody.ok) {
      expect(createBookingFingerprint(aBody.data)).toBe(createBookingFingerprint(bBody.data));
    }
  });

  it('requires reschedule times', () => {
    const parsed = parseTransitionBookingBody({ action: 'reschedule' });
    expect(parsed.ok).toBe(false);
  });

  it('formats the phone-hold message in the tenant timezone', () => {
    expect(phoneHoldConflictBody(new Date('2030-01-02T20:34:00.000Z'), 'America/New_York').error)
      .toBe('Held by a phone call until 3:34 PM');
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

  describe('materializeRecurringSeries', () => {
    const series: RecurringSeriesRow = {
      id: 's1', tenant_id: 't1', title: 'Trim', provider_id: 'p1', appointment_type_id: null, resource_id: null,
      recurrence_pattern: 'daily', recurrence_day_of_week: null, recurrence_time: '10:00', duration_minutes: 30,
      series_start: '2030-01-01', series_end: '2030-01-03',
    };
    const pool = () => ({ query: a.poolQueryMock }) as unknown as Parameters<typeof materializeRecurringSeries>[0];

    it('skips an overlapping occurrence as slot_unavailable and keeps going', async () => {
      let n = 0;
      a.poolQueryMock.mockImplementation(async (sql: string) => {
        if (/INSERT INTO bookings/.test(sql)) {
          n += 1;
          if (n === 2) throw overlapErr;
          return { rows: [{ id: `b${n}` }] };
        }
        return { rows: [] };
      });
      await expect(materializeRecurringSeries(pool(), series, 'u1', 'UTC')).resolves.toEqual({
        created: ['b1', 'b3'],
        skipped: [{ date: '2030-01-02', reason: 'slot_unavailable' }],
      });
    });

    it('re-throws any other insert error', async () => {
      a.poolQueryMock.mockImplementation(async (sql: string) => {
        if (/INSERT INTO bookings/.test(sql)) throw Object.assign(new Error('boom'), { code: '23P01', constraint: 'other_constraint' });
        return { rows: [] };
      });
      await expect(materializeRecurringSeries(pool(), series, 'u1', 'UTC')).rejects.toThrow('boom');
    });
  });
});

describe('mini-system-write gate', () => {
  it('blocks a viewer from creating a provider', async () => {
    a.user.role = 'support_reviewer';
    expect((await request(app()).post('/scheduling/providers').send({ name: 'Dr. A' })).status).toBe(403);
  });
});
