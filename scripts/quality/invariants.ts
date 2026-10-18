/**
 * Invariants checked after every scenario, on top of its own `expect`. They
 * read the fake provider's end state and the tool results, never the agent's
 * wording, and hold for any correct call:
 *
 * - booking.confirmed_without_commit: a booking made on the call is confirmed
 *   only by an ok book/reschedule commit that returned its id.
 * - booking.outside_slot: every booking made on the call sits on a slot the
 *   shop offered (same barber, same start).
 * - booking.overlap: no two live (held/confirmed) bookings of one barber overlap.
 * - floor.more_than_one: at most one floor ticket per call.
 * - floor.with_artifact: no floor ticket when the call also filed a ticket or
 *   confirmed a booking.
 * - find.readback_before_name_match: find_bookings hands the agent a booking
 *   only for a name that matches the name on it (booking.find@1).
 * - change.unverified_booking: a reschedule/cancel is prepared only for a
 *   booking find_bookings returned to this call.
 * - say.reference_number: no booking, hold or ticket id or ticket number is
 *   said aloud (they are texted, never read).
 */
import { namesMatch } from './fakeToolProvider';
import type { TenantState } from './seed';
import type { BookingRow, CheckFailure, EndSnapshot, TraceEvent } from './types';

export const INVARIANT_RULES = [
  'booking.confirmed_without_commit',
  'booking.outside_slot',
  'booking.overlap',
  'floor.more_than_one',
  'floor.with_artifact',
  'find.readback_before_name_match',
  'change.unverified_booking',
  'say.reference_number',
] as const;
export type InvariantRule = (typeof INVARIANT_RULES)[number];

export type InvariantInput = {
  callId: string;
  trace: TraceEvent[];
  snapshot: EndSnapshot;
  /** The tenant state at the end of the call (slots, services, live rows). */
  state: TenantState;
};

type ToolEvent = Extract<TraceEvent, { type: 'tool' }>;

function toolEvents(trace: TraceEvent[]): ToolEvent[] {
  return trace.filter((event): event is ToolEvent => event.type === 'tool');
}

function dataOf(event: ToolEvent): Record<string, unknown> {
  return event.result.ok && event.result.data && typeof event.result.data === 'object'
    ? (event.result.data as Record<string, unknown>)
    : {};
}

function foundBookings(event: ToolEvent): Array<{ bookingId?: unknown; customerName?: unknown }> {
  const bookings = dataOf(event).bookings;
  return Array.isArray(bookings) ? (bookings as Array<{ bookingId?: unknown; customerName?: unknown }>) : [];
}

function violation(rule: InvariantRule, message: string, actual?: unknown): CheckFailure {
  return { check: 'invariant', message: `${rule}: ${message}`, ...(actual === undefined ? {} : { actual }) };
}

function endMs(row: BookingRow, state: TenantState): number {
  const minutes = row.serviceIds.reduce(
    (total, id) => total + (state.services.find((service) => service.id === id)?.durationMin ?? 0),
    0,
  );
  return Date.parse(row.start) + minutes * 60_000;
}

function bookingInvariants({ callId, trace, snapshot, state }: InvariantInput): CheckFailure[] {
  const failures: CheckFailure[] = [];
  const committedIds = new Set(
    toolEvents(trace)
      .filter((event) => event.name === 'scheduling.book.commit' || event.name === 'scheduling.reschedule.commit')
      .map((event) => dataOf(event).bookingId)
      .filter((id): id is string => typeof id === 'string'),
  );
  const made = snapshot.bookings.filter((row) => row.callId === callId);
  for (const row of made) {
    if (row.status === 'confirmed' && !committedIds.has(row.id)) {
      failures.push(violation('booking.confirmed_without_commit', `${row.id} is confirmed but no commit returned it`, row));
    }
    const onSlot = state.slots.some((slot) => slot.staffId === row.staffId && Date.parse(slot.start) === Date.parse(row.start));
    if (!onSlot) failures.push(violation('booking.outside_slot', `${row.id} (${row.staffId} ${row.start}) is not an offered slot`, row));
  }
  const live = state.bookings.filter((row) => row.status === 'held' || row.status === 'confirmed');
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const [a, b] = [live[i], live[j]];
      if (a.staffId !== b.staffId) continue;
      const overlap =
        Date.parse(a.start) === Date.parse(b.start) ||
        (Date.parse(a.start) < endMs(b, state) && Date.parse(b.start) < endMs(a, state));
      if (overlap) failures.push(violation('booking.overlap', `${a.id} and ${b.id} overlap for ${a.staffId}`, [a, b]));
    }
  }
  return failures;
}

function floorInvariants({ callId, snapshot }: InvariantInput): CheckFailure[] {
  const failures: CheckFailure[] = [];
  const onCall = snapshot.tickets.filter((row) => row.callId === callId);
  const floors = onCall.filter((row) => row.floor);
  if (floors.length > 1) {
    failures.push(violation('floor.more_than_one', `${floors.length} floor tickets on one call`, floors));
  }
  if (floors.length > 0) {
    const filed = onCall.filter((row) => !row.floor && row.status === 'open');
    const booked = snapshot.bookings.filter((row) => row.callId === callId && row.status === 'confirmed');
    if (filed.length > 0 || booked.length > 0) {
      failures.push(violation('floor.with_artifact', 'a floor ticket was filed on a call that already filed or booked', { floors, filed, booked }));
    }
  }
  return failures;
}

function identityInvariants({ trace }: InvariantInput): CheckFailure[] {
  const failures: CheckFailure[] = [];
  const returned = new Set<string>();
  for (const event of toolEvents(trace)) {
    if (event.name === 'scheduling.find_bookings') {
      const name = typeof event.input.name === 'string' ? event.input.name : '';
      for (const booking of foundBookings(event)) {
        const onBooking = typeof booking.customerName === 'string' ? booking.customerName : '';
        if (!name || !namesMatch(name, onBooking)) {
          failures.push(
            violation('find.readback_before_name_match', `find_bookings returned ${String(booking.bookingId)} for name ${JSON.stringify(name)}`, {
              input: event.input,
              customerName: onBooking,
            }),
          );
        }
        if (typeof booking.bookingId === 'string') returned.add(booking.bookingId);
      }
    }
    if ((event.name === 'scheduling.reschedule.prepare' || event.name === 'scheduling.cancel.prepare') && event.result.ok) {
      const id = event.input.bookingId;
      if (typeof id !== 'string' || !returned.has(id)) {
        failures.push(violation('change.unverified_booking', `${event.name} for ${String(id)}, which find_bookings never returned`, event.input));
      }
    }
  }
  return failures;
}

const REF_KEYS = ['bookingId', 'holdId', 'ticketId', 'ticketNumber', 'previousBookingId', 'confirmationToken'];

function sayInvariants({ trace }: InvariantInput): CheckFailure[] {
  const refs = new Set<string>();
  for (const event of toolEvents(trace)) {
    const data = dataOf(event);
    for (const key of REF_KEYS) {
      const value = data[key];
      if ((typeof value === 'string' || typeof value === 'number') && String(value).length >= 4) refs.add(String(value).toLowerCase());
    }
    for (const booking of foundBookings(event)) {
      if (typeof booking.bookingId === 'string') refs.add(booking.bookingId.toLowerCase());
    }
  }
  const failures: CheckFailure[] = [];
  for (const event of trace) {
    if (event.type !== 'say') continue;
    const text = event.text.toLowerCase();
    const spoken = [...refs].filter((ref) => new RegExp(`(^|[^a-z0-9_])${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9_])`).test(text));
    if (spoken.length > 0) failures.push(violation('say.reference_number', `said ${spoken.join(', ')} aloud`, event.text));
  }
  return failures;
}

export function checkInvariants(input: InvariantInput): CheckFailure[] {
  return [...bookingInvariants(input), ...floorInvariants(input), ...identityInvariants(input), ...sayInvariants(input)];
}
