import { describe, expect, it } from 'vitest';
import { BOOKING_BOOK_V1 } from './bookingBook';
import { nextMissingSlot } from './enforce';

const FULL = {
  serviceIds: ['svc-1'],
  staffId: 'any',
  start: '2026-10-20T15:30:00-04:00',
  customer: { name: 'Luis', phone: '+15555550142' },
};

const next = (input: unknown, held = {}) => nextMissingSlot(BOOKING_BOOK_V1, input, held)?.name ?? null;

describe('nextMissingSlot', () => {
  it('follows the contract ask order', () => {
    expect(next({})).toBe('service');
    expect(next({ staffId: 'any', start: FULL.start })).toBe('service');
    expect(next({ serviceIds: ['svc-1'] })).toBe('staff');
    expect(next({ serviceIds: ['svc-1'], staffId: 'any' })).toBe('time');
    expect(next({ serviceIds: ['svc-1'], staffId: 'any', start: FULL.start })).toBe('customerName');
    expect(next({ ...FULL, customer: { name: 'Luis' } })).toBe('customerPhone');
    expect(next(FULL)).toBeNull();
  });

  it('treats blank strings, empty lists and null as missing', () => {
    expect(next({ ...FULL, serviceIds: [] })).toBe('service');
    expect(next({ ...FULL, staffId: '  ' })).toBe('staff');
    expect(next({ ...FULL, start: null })).toBe('time');
  });

  it('honors heldFrom: a held fact fills the slot without an ask', () => {
    const noCustomer = { serviceIds: ['svc-1'], staffId: 'any', start: FULL.start };
    expect(next(noCustomer, { callerPhone: '+15555550142' })).toBe('customerName');
    expect(next({ ...noCustomer, customer: { name: 'Luis' } }, { callerPhone: '+15555550142' })).toBeNull();
    expect(next(noCustomer, { verifiedName: 'Luis' })).toBe('customerPhone');
    expect(next(noCustomer, { verifiedName: 'Luis', callerPhone: '+15555550142' })).toBeNull();
    // A held fact only covers the slot that declares it.
    expect(next({ customer: { name: 'Luis' } }, { callerPhone: '+15555550142', verifiedName: 'Luis' })).toBe('service');
  });

  it('skips optional slots', () => {
    const contract = { slots: [{ ...BOOKING_BOOK_V1.slots[1], required: false }, BOOKING_BOOK_V1.slots[2]] };
    expect(nextMissingSlot(contract, {})?.name).toBe('time');
  });
});
