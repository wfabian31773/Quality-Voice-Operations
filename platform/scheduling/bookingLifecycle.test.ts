import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectorService } from '../integrations/connectors';
import { fireDispatchPush } from '../notifications/dispatchPush';
import { checkBookingConflicts, transitionBooking } from './bookingLifecycle';

vi.mock('../integrations/connectors', () => ({
  connectorService: { dispatchEvent: vi.fn(async () => ({ dispatched: 0, results: [] })) },
}));

vi.mock('../notifications/dispatchPush', () => ({
  fireDispatchPush: vi.fn(),
}));

describe('checkBookingConflicts', () => {
  it('queries overlapping live bookings and excludes the current id', async () => {
    const query = vi.fn(async () => ({ rows: [{ id: 'other', title: 'Cut', start_time: 't', end_time: 't2' }] }));
    const rows = await checkBookingConflicts(
      { query },
      'tenant-1',
      '2026-10-21T16:00:00.000Z',
      '2026-10-21T16:30:00.000Z',
      'prov-1',
      undefined,
      'bk-self',
    );
    expect(rows).toHaveLength(1);
    const [sql, values] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('FROM bookings');
    expect(sql).toMatch(/status NOT IN/);
    expect(values).toContain('bk-self');
    expect(values).toContain('prov-1');
  });
});

describe('transitionBooking', () => {
  beforeEach(() => {
    vi.mocked(fireDispatchPush).mockClear();
    vi.mocked(connectorService.dispatchEvent).mockClear();
  });

  it('rejects a conflicting reschedule before writing the new row', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT * FROM bookings WHERE id')) {
        return {
          rows: [{
            id: 'bk-1',
            status: 'confirmed',
            provider_id: 'prov-1',
            resource_id: null,
            start_time: '2026-10-20T15:00:00.000Z',
            end_time: '2026-10-20T15:30:00.000Z',
          }],
        };
      }
      if (sql.includes('SELECT id, title, start_time, end_time FROM bookings')) {
        return { rows: [{ id: 'bk-other', title: 'Taken' }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await transitionBooking({ query }, {
      tenantId: 'tenant-1',
      bookingId: 'bk-1',
      action: 'reschedule',
      newStartTime: '2026-10-21T16:00:00.000Z',
      newEndTime: '2026-10-21T16:30:00.000Z',
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected conflict');
    expect(result.httpStatus).toBe(409);
    expect(result.body.error).toMatch(/conflict/i);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('UPDATE bookings'))).toBe(false);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO bookings'))).toBe(false);
  });

  it('cancels through waitlist and audit instead of a raw status-only write', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT * FROM bookings WHERE id') && !sql.includes('scheduling_waitlist')) {
        return {
          rows: [{
            id: 'bk-1',
            status: 'confirmed',
            provider_id: null,
            appointment_type_id: null,
            resource_id: null,
            start_time: '2026-10-20T15:00:00.000Z',
            contact_phone: '+15551230000',
          }],
        };
      }
      if (sql.includes('UPDATE bookings')) return { rows: [], rowCount: 1 };
      if (sql.includes('FROM scheduling_waitlist')) return { rows: [] };
      if (sql.includes('INSERT INTO scheduling_audit_log')) return { rows: [] };
      if (sql.includes('SELECT * FROM bookings WHERE id')) {
        return { rows: [{ id: 'bk-1', status: 'cancelled' }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await transitionBooking({ query }, {
      tenantId: 'tenant-1',
      bookingId: 'bk-1',
      action: 'cancel',
      cancellationReason: 'Caller asked',
    });

    expect(result.ok).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('scheduling_waitlist'))).toBe(true);
    expect(query.mock.calls.some(([sql]) => String(sql).includes('scheduling_audit_log'))).toBe(true);
  });

  function successfulRescheduleQuery(originalStatus: string) {
    return vi.fn(async (sql: string) => {
      if (sql.includes('SELECT * FROM bookings WHERE id')) {
        return {
          rows: [{
            id: 'bk-1',
            status: originalStatus,
            provider_id: null,
            resource_id: null,
            start_time: '2026-10-20T15:00:00.000Z',
            end_time: '2026-10-20T15:30:00.000Z',
          }],
        };
      }
      if (sql.includes('SELECT id, title, start_time, end_time FROM bookings')) {
        return { rows: [] };
      }
      if (sql.includes('UPDATE bookings')) return { rows: [], rowCount: 1 };
      if (sql.includes('INSERT INTO bookings')) {
        return { rows: [{ id: 'bk-2', status: originalStatus === 'pending' ? 'pending' : 'confirmed' }] };
      }
      if (sql.includes('INSERT INTO scheduling_audit_log')) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
  }

  it('keeps a pending request pending when rescheduling', async () => {
    const query = successfulRescheduleQuery('pending');
    const result = await transitionBooking({ query }, {
      tenantId: 'tenant-1',
      bookingId: 'bk-1',
      action: 'reschedule',
      newStartTime: '2026-10-21T16:00:00.000Z',
      newEndTime: '2026-10-21T16:30:00.000Z',
    });

    expect(result.ok).toBe(true);
    const insert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO bookings'));
    expect(insert?.[1]?.[5]).toBe('pending');
    expect(insert?.[0]).not.toMatch(/'confirmed'/);
  });

  it('keeps a confirmed booking confirmed when rescheduling', async () => {
    const query = successfulRescheduleQuery('confirmed');
    const result = await transitionBooking({ query }, {
      tenantId: 'tenant-1',
      bookingId: 'bk-1',
      action: 'reschedule',
      newStartTime: '2026-10-21T16:00:00.000Z',
      newEndTime: '2026-10-21T16:30:00.000Z',
    });

    expect(result.ok).toBe(true);
    const insert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO bookings'));
    expect(insert?.[1]?.[5]).toBe('confirmed');
  });

  it('defers calendar dispatch and staff push until afterCommit when asked', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT * FROM bookings WHERE id') && !sql.includes('scheduling_waitlist')) {
        return {
          rows: [{
            id: 'bk-1',
            status: 'confirmed',
            provider_id: null,
            appointment_type_id: null,
            resource_id: 'tech-1',
            start_time: '2026-10-20T15:00:00.000Z',
            title: 'Haircut',
          }],
        };
      }
      if (sql.includes('UPDATE bookings')) return { rows: [], rowCount: 1 };
      if (sql.includes('FROM scheduling_waitlist')) return { rows: [] };
      if (sql.includes('INSERT INTO scheduling_audit_log')) return { rows: [] };
      if (sql.includes('SELECT * FROM bookings WHERE id')) {
        return { rows: [{ id: 'bk-1', status: 'cancelled' }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });

    const result = await transitionBooking({ query }, {
      tenantId: 'tenant-1',
      bookingId: 'bk-1',
      action: 'cancel',
      cancellationReason: 'Caller asked',
    }, { deferSideEffects: true });

    expect(result.ok).toBe(true);
    expect(fireDispatchPush).not.toHaveBeenCalled();
    expect(connectorService.dispatchEvent).not.toHaveBeenCalled();
    if (!result.ok) throw new Error('expected ok');
    expect(result.afterCommit).toHaveLength(2);
    for (const effect of result.afterCommit ?? []) effect();
    expect(fireDispatchPush).toHaveBeenCalledWith(expect.objectContaining({ event: 'booking_cancelled' }));
    expect(connectorService.dispatchEvent).toHaveBeenCalled();
  });
});
