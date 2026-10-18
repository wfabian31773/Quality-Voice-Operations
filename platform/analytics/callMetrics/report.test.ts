import { describe, expect, it } from 'vitest';
import { bookedOrFiledReport, rateBasisPoints, type CallRecord } from './report';

const T1 = 'tenant-shop-1';
const T2 = 'tenant-shop-2';
const DAY = '2026-10-17'; // EDT: 2026-10-17T04:00Z .. 2026-10-18T04:00Z

const SUBSTANTIVE = ['Hi, this is Luis', 'I need a fade Friday'];

function call(callId: string, over: Partial<CallRecord> = {}): CallRecord {
  return {
    callId,
    tenantId: T1,
    direction: 'inbound',
    startedAt: new Date('2026-10-17T15:00:00Z'),
    callerLines: SUBSTANTIVE,
    callerName: 'Luis',
    bookings: [],
    tickets: [],
    ...over,
  };
}

const confirmed = { id: 'b-1', status: 'confirmed', cancellationReason: '' };

/** The fixture day, with the hand-computed numbers in the test below. */
const FIXTURE: CallRecord[] = [
  call('A-name-only', { callerLines: ['Hi, this is Luis.'] }),
  call('B-never-heard', { callerLines: [] }),
  call('C-outbound', { direction: 'outbound', bookings: [confirmed] }),
  call('D-booked', { bookings: [confirmed] }),
  call('E-message', { tickets: [{ id: 't-e', kind: 'message', floor: false }] }),
  call('F-floor', { tickets: [{ id: 't-f', kind: 'message', floor: true }] }),
  call('G-nothing'),
  // A hold that expired and one still held never became a booking.
  call('H-holds-only', {
    bookings: [
      { id: 'b-h1', status: 'cancelled', cancellationReason: 'hold_expired' },
      { id: 'b-h2', status: 'held', cancellationReason: '' },
    ],
  }),
  call('I-other-ticket', { tickets: [{ id: 't-i', kind: 'complaint', floor: false }] }),
  // 23:30 New York on the 17th (03:30Z on the 18th): belongs to the 17th.
  call('J-late-night', { startedAt: new Date('2026-10-18T03:30:00Z') }),
  // 23:30 New York on the 16th (03:30Z on the 17th): not this day.
  call('K-previous-day', { startedAt: new Date('2026-10-17T03:30:00Z'), bookings: [confirmed] }),
  // Name only, yet a booking exists: not in the denominator, counted on the side.
  call('M-name-only-booked', { callerLines: ['Hola, soy Ana'], callerName: 'Ana', bookings: [confirmed] }),
  call('N-other-tenant', { tenantId: T2 }),
  // A legacy create_ticket / escalation ticket: kind is only the column default.
  call('L-legacy-ticket', { tickets: [{ id: 't-l', kind: 'message', floor: false, legacy: true }] }),
  // "Hi, I'm <name>" as call_transcripts stores it (redactPHI), name unknown. It may have been
  // "Hi, I'm Marcus Johnson", which the floor counts as substantive, so it is never left out (Codex 4307374365).
  call('O-redacted-intro', { callerLines: ["Hi, I'm [NAME_REDACTED]"], callerName: undefined }),
];

describe('bookedOrFiledReport: fixture day, one tenant', () => {
  const report = bookedOrFiledReport({ day: DAY, tenantId: T1, calls: FIXTURE });

  it('matches the hand-computed numbers', () => {
    // In the day for T1: A B C D E F G H I J L M O = 13 (K is the 16th, N is T2).
    // Excluded: C outbound; B never heard; A and M said only their name.
    // Substantive: D E F G H I J L O = 9. Booked or filed: D E F I L = 5. 5/9 = 5556 bp.
    expect(report).toEqual({
      day: DAY,
      timeZone: 'America/New_York',
      tenantId: T1,
      window: { start: '2026-10-17T04:00:00.000Z', end: '2026-10-18T04:00:00.000Z' },
      calls: { total: 13, outbound: 1, neverHeard: 1, nothingSubstantive: 2, substantive: 9 },
      denominator: 9,
      numerator: 5,
      rate: { numerator: 5, denominator: 9, basisPoints: 5556 },
      breakdown: { booked: 1, filedMessage: 1, filedLegacy: 1, filedFloor: 1, filedOther: 1 },
      noArtifactCallIds: ['G-nothing', 'H-holds-only', 'J-late-night', 'O-redacted-intro'],
      artifactOnNonSubstantive: 1,
    });
  });

  it('breakdown adds up to the numerator, and the no-artifact list to the rest', () => {
    const b = report.breakdown;
    expect(b.booked + b.filedMessage + b.filedLegacy + b.filedFloor + b.filedOther).toBe(report.numerator);
    expect(report.numerator + report.noArtifactCallIds.length).toBe(report.denominator);
    const c = report.calls;
    expect(c.outbound + c.neverHeard + c.nothingSubstantive + c.substantive).toBe(c.total);
  });

  it('lists call ids only: no caller text, name or phone', () => {
    const text = JSON.stringify(report);
    expect(text).not.toMatch(/fade|Luis|Ana/);
  });
});

describe('bookedOrFiledReport: exclusions and boundaries', () => {
  it('never counts an outbound call, even a substantive one with a booking', () => {
    const report = bookedOrFiledReport({ day: DAY, tenantId: T1, calls: [call('C-outbound', { direction: 'outbound', bookings: [confirmed] })] });
    expect(report.calls).toEqual({ total: 1, outbound: 1, neverHeard: 0, nothingSubstantive: 0, substantive: 0 });
    expect(report.numerator).toBe(0);
    expect(report.rate.basisPoints).toBeNull();
  });

  it('treats any direction other than outbound as inbound, like the floor', () => {
    const report = bookedOrFiledReport({ day: DAY, tenantId: T1, calls: [call('X', { direction: '' })] });
    expect(report.calls.substantive).toBe(1);
  });

  it('puts a call on the New York day it started', () => {
    const at = (iso: string) => [call('X', { startedAt: new Date(iso) })];
    // 00:00 New York is in; one millisecond before is the previous day.
    expect(bookedOrFiledReport({ day: DAY, tenantId: T1, calls: at('2026-10-17T04:00:00.000Z') }).calls.total).toBe(1);
    expect(bookedOrFiledReport({ day: DAY, tenantId: T1, calls: at('2026-10-17T03:59:59.999Z') }).calls.total).toBe(0);
    expect(bookedOrFiledReport({ day: DAY, tenantId: T1, calls: at('2026-10-18T03:59:59.999Z') }).calls.total).toBe(1);
    expect(bookedOrFiledReport({ day: DAY, tenantId: T1, calls: at('2026-10-18T04:00:00.000Z') }).calls.total).toBe(0);
  });

  it('all tenants: counts every tenant together', () => {
    const report = bookedOrFiledReport({ day: DAY, tenantId: null, calls: FIXTURE });
    expect(report.tenantId).toBeNull();
    expect(report.calls.total).toBe(14);
    expect(report.denominator).toBe(10);
    expect(report.noArtifactCallIds).toEqual(['G-nothing', 'H-holds-only', 'J-late-night', 'N-other-tenant', 'O-redacted-intro']);
  });

  it('a booking cancelled later, or moved by a reschedule, still counts as written', () => {
    const report = bookedOrFiledReport({
      day: DAY,
      tenantId: T1,
      calls: [
        call('P', { bookings: [{ id: 'b', status: 'cancelled', cancellationReason: 'Customer cancelled' }] }),
        call('Q', { bookings: [{ id: 'b', status: 'rescheduled', cancellationReason: '' }] }),
        call('R', { bookings: [{ id: 'b', status: 'cancelled', cancellationReason: 'hold_superseded' }] }),
      ],
    });
    expect(report.breakdown.booked).toBe(2);
    expect(report.noArtifactCallIds).toEqual(['R']);
  });

  it('a call with several artifacts lands in one bucket: booked, then message, then other, then legacy, then floor', () => {
    const floor = { id: 't1', kind: 'message', floor: true };
    const message = { id: 't2', kind: 'message', floor: false };
    const callback = { id: 't3', kind: 'callback', floor: false };
    const other = { id: 't4', kind: 'quote_request', floor: false };
    const legacy = { id: 't5', kind: 'message', floor: false, legacy: true };
    const report = bookedOrFiledReport({
      day: DAY,
      tenantId: T1,
      calls: [
        call('booked+floor', { bookings: [confirmed], tickets: [floor] }),
        call('floor+message', { tickets: [floor, message] }),
        call('callback', { tickets: [callback] }),
        call('floor+other', { tickets: [floor, other] }),
        call('legacy+other', { tickets: [legacy, other] }),
        call('floor+legacy', { tickets: [floor, legacy] }),
      ],
    });
    expect(report.breakdown).toEqual({ booked: 1, filedMessage: 2, filedLegacy: 1, filedFloor: 0, filedOther: 2 });
  });

  it("a legacy ticket's default kind is never counted as a message", () => {
    const report = bookedOrFiledReport({
      day: DAY,
      tenantId: T1,
      calls: [call('legacy', { tickets: [{ id: 't', kind: 'message', floor: false, legacy: true }] })],
    });
    expect(report.breakdown).toEqual({ booked: 0, filedMessage: 0, filedLegacy: 1, filedFloor: 0, filedOther: 0 });
  });

  it('rejects a day that is not YYYY-MM-DD', () => {
    expect(() => bookedOrFiledReport({ day: '2026-10-32', tenantId: T1, calls: [] })).toThrow(/day/);
    expect(() => bookedOrFiledReport({ day: '10/17/2026', tenantId: T1, calls: [] })).toThrow(/day/);
  });
});

describe('rateBasisPoints', () => {
  it('is exact integer math, rounded half up, null with no denominator', () => {
    expect(rateBasisPoints(4, 7)).toBe(5714);
    expect(rateBasisPoints(2, 3)).toBe(6667);
    expect(rateBasisPoints(1, 8)).toBe(1250);
    expect(rateBasisPoints(1, 20000)).toBe(1); // 0.5 bp rounds up
    expect(rateBasisPoints(0, 5)).toBe(0);
    expect(rateBasisPoints(5, 5)).toBe(10000);
    expect(rateBasisPoints(0, 0)).toBeNull();
  });
});
