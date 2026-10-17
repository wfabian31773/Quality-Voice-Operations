import { describe, expect, it, vi } from 'vitest';
import type { TenantTx } from '../core/types';
import { bookingOverlapKind, expireStaleHolds } from './holds';

function fakeTx(rows: Record<string, unknown>[] = []) {
  const query = vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows, rowCount: rows.length }));
  return { tx: { query } as TenantTx, query };
}

describe('expireStaleHolds', () => {
  it('cancels expired holds for the provider with the injected clock', async () => {
    const { tx, query } = fakeTx([{ id: 'b1' }, { id: 'b2' }]);
    const now = new Date('2026-11-01T15:00:00Z');
    const result = await expireStaleHolds(tx, 't1', 'p1', { now });
    expect(result).toEqual({ expiredBookingIds: ['b1', 'b2'] });
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, values] = query.mock.calls[0];
    expect(sql).toMatch(/UPDATE bookings/);
    expect(sql).toMatch(/status = 'cancelled'/);
    expect(sql).toMatch(/status = 'held'/);
    expect(sql).not.toMatch(/DELETE/i);
    expect(values).toEqual(['t1', 'p1', null, 'hold_expired', now]);
  });

  it('passes the resource and falls back to the database clock', async () => {
    const { tx, query } = fakeTx();
    await expireStaleHolds(tx, 't1', null, { resourceId: 'r1' });
    expect(query.mock.calls[0][1]).toEqual(['t1', null, 'r1', 'hold_expired', null]);
  });

  it('does nothing without a provider or resource', async () => {
    const { tx, query } = fakeTx();
    expect(await expireStaleHolds(tx, 't1', null)).toEqual({ expiredBookingIds: [] });
    expect(query).not.toHaveBeenCalled();
  });
});

describe('bookingOverlapKind', () => {
  it('maps the 122 exclusion constraints', () => {
    expect(bookingOverlapKind({ code: '23P01', constraint: 'bookings_no_provider_overlap' })).toBe('provider');
    expect(bookingOverlapKind({ code: '23P01', constraint: 'bookings_no_resource_overlap' })).toBe('resource');
  });

  it('ignores other errors', () => {
    expect(bookingOverlapKind({ code: '23P01', constraint: 'something_else' })).toBeNull();
    expect(bookingOverlapKind({ code: '23505', constraint: 'bookings_no_provider_overlap' })).toBeNull();
    expect(bookingOverlapKind(new Error('boom'))).toBeNull();
    expect(bookingOverlapKind(null)).toBeNull();
  });
});
