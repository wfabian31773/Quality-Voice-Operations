import { describe, expect, it } from 'vitest';
import { checkInvariants, type InvariantInput } from './invariants';
import { buildFixture, snapshotOf } from './seed';
import type { BookingRow, TicketRow, ToolResult, TraceEvent } from './types';

const CALL = 'call-x';

function booking(overrides: Partial<BookingRow> = {}): BookingRow {
  return {
    id: 'hold_tok_1',
    status: 'confirmed',
    staffId: 'marco',
    staffName: 'Marco',
    serviceIds: ['mens-cut'],
    start: '2026-10-20T15:30:00-04:00',
    startLocal: '15:30',
    customerName: 'Luis',
    customerPhone: '+15555550142',
    callId: CALL,
    ...overrides,
  };
}

function tool(name: string, input: Record<string, unknown>, data: unknown, ok = true): TraceEvent {
  const result: ToolResult = ok
    ? { ok: true, data }
    : { ok: false, error: { code: 'NOT_FOUND', message: 'x', callerSafeMessage: 'x', retryable: false } };
  return { type: 'tool', name, input, result };
}

function input(rows: { bookings?: BookingRow[]; tickets?: TicketRow[] }, trace: TraceEvent[] = []): InvariantInput {
  const state = buildFixture('barbershop-marco');
  state.bookings = rows.bookings ?? [];
  state.tickets = rows.tickets ?? [];
  return { callId: CALL, trace, snapshot: snapshotOf(state), state };
}

const rules = (value: InvariantInput) => checkInvariants(value).map((failure) => failure.message.split(':')[0]);

describe('invariants', () => {
  it('a clean booked call has no violations', () => {
    const trace = [tool('scheduling.book.commit', { confirmationToken: 'tok_1' }, { bookingId: 'hold_tok_1' })];
    expect(checkInvariants(input({ bookings: [booking()] }, trace))).toEqual([]);
  });

  it('booking.confirmed_without_commit and booking.outside_slot', () => {
    expect(rules(input({ bookings: [booking()] }))).toEqual(['booking.confirmed_without_commit']);
    const offSlot = booking({ status: 'held', start: '2026-10-20T15:45:00-04:00' });
    expect(rules(input({ bookings: [offSlot] }))).toEqual(['booking.outside_slot']);
    // Seeded rows (no callId) are not this call's bookings.
    expect(rules(input({ bookings: [booking({ callId: undefined })] }))).toEqual([]);
  });

  it('booking.overlap: two live bookings of one barber that overlap in time', () => {
    const a = booking({ id: 'seeded', callId: undefined, start: '2026-10-20T15:15:00-04:00', serviceIds: ['mens-cut'] });
    const b = booking({ status: 'held' });
    expect(rules(input({ bookings: [a, b] }))).toEqual(['booking.overlap']);
    expect(rules(input({ bookings: [{ ...a, status: 'cancelled' }, b] }))).toEqual([]);
  });

  it('booking.overlap: a booking inside the previous one\'s service buffer overlaps (blocked_until)', () => {
    // 15:00-15:30 men's cut + 15-minute buffer blocks Marco through 15:45.
    const buffered = (bookings: BookingRow[]) => {
      const value = input({ bookings });
      value.state.services = value.state.services.map((service) => (service.id === 'mens-cut' ? { ...service, bufferMin: 15 } : service));
      return value;
    };
    const a = booking({ id: 'seeded', callId: undefined, start: '2026-10-20T15:00:00-04:00' });
    expect(rules(buffered([a, booking({ status: 'held' })]))).toEqual(['booking.overlap']);
    expect(rules(buffered([a, booking({ id: 'later', callId: undefined, start: '2026-10-20T15:45:00-04:00' })]))).toEqual([]);
    // Without the buffer, back to back at 15:30 is fine.
    expect(rules(input({ bookings: [a, booking({ status: 'held' })] }))).toEqual([]);
  });

  it('floor.more_than_one and floor.with_artifact', () => {
    const floor: TicketRow = { id: 'f1', status: 'open', kind: 'message', subject: 's', callId: CALL, floor: true, phone: '' };
    expect(rules(input({ tickets: [floor] }))).toEqual([]);
    expect(rules(input({ tickets: [floor, { ...floor, id: 'f2' }] }))).toEqual(['floor.more_than_one']);
    const filed: TicketRow = { ...floor, id: 't1', floor: false };
    expect(rules(input({ tickets: [floor, filed] }))).toEqual(['floor.with_artifact']);
    // A floor on another call doesn't count against this one.
    expect(rules(input({ tickets: [floor, { ...floor, id: 'f2', callId: 'other' }] }))).toEqual([]);
  });

  it('find.readback_before_name_match and change.unverified_booking', () => {
    const found = { verified: true, bookings: [{ bookingId: 'bk_1', customerName: 'Luis Garcia' }] };
    const rightName = tool('scheduling.find_bookings', { phone: '+15555550142', name: 'luis' }, found);
    const noName = tool('scheduling.find_bookings', { phone: '+15555550142' }, found);
    const cancel = tool('scheduling.cancel.prepare', { bookingId: 'bk_1' }, { confirmationToken: 'tok_9' });
    expect(rules(input({}, [rightName, cancel]))).toEqual([]);
    expect(rules(input({}, [noName]))).toEqual(['find.readback_before_name_match']);
    expect(rules(input({}, [cancel]))).toEqual(['change.unverified_booking']);
    // A refused prepare is not a change.
    expect(rules(input({}, [tool('scheduling.cancel.prepare', { bookingId: 'bk_1' }, null, false)]))).toEqual([]);
  });

  it('say.reference_number: ids and ticket numbers are never said aloud', () => {
    const committed = tool('tickets.open.commit', { confirmationToken: 'tok_3' }, { ticketId: 'tkt_tok_2', ticketNumber: 1042 });
    const said = (text: string): TraceEvent[] => [committed, { type: 'say', text }];
    expect(rules(input({}, said('Done, Marco will call you back.')))).toEqual([]);
    expect(rules(input({}, said('Your ticket number is 1042.')))).toEqual(['say.reference_number']);
    expect(rules(input({}, said('Reference tkt_tok_2.')))).toEqual(['say.reference_number']);
  });
});
