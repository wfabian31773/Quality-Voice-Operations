// RT-13: booked-or-filed per substantive call, for one New York day (G10).
//
// Pure: takes already-fetched call records and returns the report. Of the
// inbound calls whose caller was heard and said more than their own name
// (the floor's rule, see substantive.ts), the share that left a booking or
// a ticket behind.
//
// Per call, in order:
//   1. not this New York day, or another tenant → not counted at all
//   2. direction 'outbound'                     → calls.outbound (as the floor skips it)
//   3. no caller line                           → calls.neverHeard
//   4. only a name / greetings / filler         → calls.nothingSubstantive
//   5. otherwise                                → calls.substantive (the denominator)
// A substantive call lands in one bucket: booked, else filedMessage, else
// filedOther, else filedLegacy, else filedFloor (the floor only files when
// nothing else did), else noArtifactCallIds.

import { HOLD_EXPIRED_REASON, HOLD_SUPERSEDED_REASON } from '../../actions/scheduling/bookingRows';
import { METRICS_TIME_ZONE, dayBounds, dayOf } from './nyDay';
import { callerVerdict } from './substantive';

/** A bookings row this call wrote (intake_data.qvo.session, or a library booking tool run). */
export interface CallBooking {
  id: string;
  status: string;
  cancellationReason: string | null;
}

/**
 * A tickets row this call created. `floor`: opened by tickets.file_floor.
 * `legacy`: written outside the action layer (library create_ticket, the
 * escalation auto-ticket, HumanEscalationService), so `kind` is only the
 * column default and says nothing about the ticket.
 */
export interface CallTicket {
  id: string;
  kind: string;
  floor: boolean;
  legacy?: boolean;
}

export interface CallRecord {
  /** call_sessions.id */
  callId: string;
  tenantId: string;
  /** call_sessions.direction; only 'outbound' is excluded, as in the floor. */
  direction: string;
  startedAt: Date;
  /** The caller's own transcript lines, in order (never the agent's). */
  callerLines: readonly string[];
  /** The caller's name when known; its words don't count as content. */
  callerName?: string;
  bookings: readonly CallBooking[];
  tickets: readonly CallTicket[];
}

export interface BookedOrFiledReport {
  day: string;
  timeZone: typeof METRICS_TIME_ZONE;
  /** null: all tenants. */
  tenantId: string | null;
  window: { start: string; end: string };
  calls: { total: number; outbound: number; neverHeard: number; nothingSubstantive: number; substantive: number };
  /** Substantive inbound calls. */
  denominator: number;
  /** Of those, the ones booked or filed. */
  numerator: number;
  /** numerator / denominator exactly, plus basis points rounded half up (null with no denominator). */
  rate: { numerator: number; denominator: number; basisPoints: number | null };
  /**
   * filedMessage / filedOther: action-layer tickets by kind (tickets.message@1
   * kinds, or any other). filedLegacy: a ticket from a legacy writer, whose
   * kind is unknown. filedFloor: only the floor's ticket.
   */
  breakdown: { booked: number; filedMessage: number; filedLegacy: number; filedFloor: number; filedOther: number };
  /** Substantive calls with no booking and no ticket, by call id only, to listen to. */
  noArtifactCallIds: string[];
  /** Calls left out as not substantive that still have an artifact (explains a gap, not in the rate). */
  artifactOnNonSubstantive: number;
}

export type CallOutcome = 'booked' | 'filedMessage' | 'filedOther' | 'filedLegacy' | 'filedFloor' | 'none';

/** Ticket kinds of the tickets.message@1 contract. */
const MESSAGE_KINDS: ReadonlySet<string> = new Set(['message', 'callback']);

/** A booking was written: not a hold, and not a hold that expired or was replaced (as hasCallArtifact). */
export function isWrittenBooking(booking: CallBooking): boolean {
  if (booking.status === 'held') return false;
  const reason = booking.cancellationReason ?? '';
  return reason !== HOLD_EXPIRED_REASON && reason !== HOLD_SUPERSEDED_REASON;
}

export function callOutcome(call: Pick<CallRecord, 'bookings' | 'tickets'>): CallOutcome {
  if (call.bookings.some(isWrittenBooking)) return 'booked';
  const filed = call.tickets.filter((t) => !t.floor && !t.legacy);
  if (filed.some((t) => MESSAGE_KINDS.has(t.kind))) return 'filedMessage';
  if (filed.length > 0) return 'filedOther';
  if (call.tickets.some((t) => !t.floor)) return 'filedLegacy';
  if (call.tickets.length > 0) return 'filedFloor';
  return 'none';
}

/** numerator/denominator in basis points, rounded half up, integer math only. */
export function rateBasisPoints(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Math.floor((numerator * 20_000 + denominator) / (2 * denominator));
}

export function bookedOrFiledReport(input: {
  day: string;
  tenantId: string | null;
  calls: readonly CallRecord[];
}): BookedOrFiledReport {
  const { start, end } = dayBounds(input.day);
  const calls = { total: 0, outbound: 0, neverHeard: 0, nothingSubstantive: 0, substantive: 0 };
  const breakdown = { booked: 0, filedMessage: 0, filedLegacy: 0, filedFloor: 0, filedOther: 0 };
  const noArtifactCallIds: string[] = [];
  let artifactOnNonSubstantive = 0;

  for (const call of input.calls) {
    if (input.tenantId !== null && call.tenantId !== input.tenantId) continue;
    if (dayOf(call.startedAt) !== input.day) continue;
    calls.total += 1;
    if (call.direction === 'outbound') {
      calls.outbound += 1;
      continue;
    }
    const verdict = callerVerdict(call.callerLines, call.callerName);
    const outcome = callOutcome(call);
    if (verdict !== 'substantive') {
      if (verdict === 'never_heard') calls.neverHeard += 1;
      else calls.nothingSubstantive += 1;
      if (outcome !== 'none') artifactOnNonSubstantive += 1;
      continue;
    }
    calls.substantive += 1;
    if (outcome === 'none') noArtifactCallIds.push(call.callId);
    else breakdown[outcome] += 1;
  }

  const numerator =
    breakdown.booked + breakdown.filedMessage + breakdown.filedLegacy + breakdown.filedFloor + breakdown.filedOther;
  return {
    day: input.day,
    timeZone: METRICS_TIME_ZONE,
    tenantId: input.tenantId,
    window: { start: start.toISOString(), end: end.toISOString() },
    calls,
    denominator: calls.substantive,
    numerator,
    rate: { numerator, denominator: calls.substantive, basisPoints: rateBasisPoints(numerator, calls.substantive) },
    breakdown,
    noArtifactCallIds: noArtifactCallIds.sort(),
    artifactOnNonSubstantive,
  };
}
