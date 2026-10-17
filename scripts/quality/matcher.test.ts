import { describe, expect, it } from 'vitest';
import {
  evaluateExpect,
  formatDiff,
  firstSuccessfulCommitIndex,
  matchActions,
  matchEndState,
  matchMustNotSayBeforeCommit,
  matchMustSay,
  matchReadback,
  partialMatch,
} from './matcher';
import type { EndSnapshot, TraceEvent } from './types';

const emptySnapshot: EndSnapshot = { bookings: [], tickets: [], transfers: [], waitlist: [] };

function tool(name: string, input: Record<string, unknown>, ok = true, extra?: { readback?: string }): TraceEvent {
  return ok
    ? { type: 'tool', name, input, result: { ok: true, data: { confirmationToken: 'tok_1' }, readback: extra?.readback } }
    : { type: 'tool', name, input, result: { ok: false, error: { code: 'NOT_FOUND', message: 'no', callerSafeMessage: 'no', retryable: false } } };
}

describe('partialMatch', () => {
  it('allows extra keys on the actual object', () => {
    expect(partialMatch({ staffId: 'marco' }, { staffId: 'marco', start: '2026-10-20T15:30:00-04:00' })).toBe(true);
  });

  it('matches nested objects and string containment', () => {
    expect(
      partialMatch(
        { start: '15:30', customer: { name: 'Luis' } },
        { start: '2026-10-20T15:30:00-04:00', customer: { name: 'Luis', phone: '+15555550142' } },
      ),
    ).toBe(true);
  });

  it('rejects a missing nested field', () => {
    expect(partialMatch({ customer: { name: 'Luis' } }, { customer: { phone: '+1' } })).toBe(false);
  });

  it('matches arrays as an ordered subsequence', () => {
    expect(partialMatch([{ id: 'a' }, { id: 'c' }], [{ id: 'a' }, { id: 'b' }, { id: 'c' }])).toBe(true);
    expect(partialMatch([{ id: 'c' }, { id: 'a' }], [{ id: 'a' }, { id: 'c' }])).toBe(false);
  });
});

describe('matchActions (order + partial input)', () => {
  it('accepts extra calls between expected ones', () => {
    const trace: TraceEvent[] = [
      tool('scheduling.check_availability', { staffId: 'marco' }),
      tool('scheduling.book.prepare', { staffId: 'marco', start: '2026-10-20T15:30:00-04:00', notes: 'window' }),
      tool('scheduling.book.commit', { confirmationToken: 'tok_1' }),
    ];
    expect(
      matchActions(
        [
          { name: 'scheduling.book.prepare', input: { staffId: 'marco', start: '15:30' } },
          { name: 'scheduling.book.commit' },
        ],
        trace,
      ),
    ).toEqual([]);
  });

  it('fails when commit happens before prepare', () => {
    const trace: TraceEvent[] = [
      tool('scheduling.book.commit', {}),
      tool('scheduling.book.prepare', { staffId: 'marco' }),
    ];
    const failures = matchActions(
      [{ name: 'scheduling.book.prepare' }, { name: 'scheduling.book.commit' }],
      trace,
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].check).toBe('actions');
    expect(failures[0].message).toMatch(/not found in order/);
  });

  it('fails when the name matches but input does not', () => {
    const trace: TraceEvent[] = [tool('scheduling.book.prepare', { staffId: 'any' })];
    const failures = matchActions([{ name: 'scheduling.book.prepare', input: { staffId: 'marco' } }], trace);
    expect(failures[0].message).toMatch(/input did not match/);
  });
});

describe('mustNotSay before commit', () => {
  it('flags success language spoken before a successful commit', () => {
    const trace: TraceEvent[] = [
      { type: 'say', text: "You're booked with Marco at 3:30." },
      tool('scheduling.book.prepare', {}, true, { readback: 'a cut with Marco' }),
      tool('scheduling.book.commit', {}),
    ];
    const failures = matchMustNotSayBeforeCommit(["you're booked"], trace);
    expect(failures).toHaveLength(1);
    expect(failures[0].actual).toMatch(/You're booked/i);
  });

  it('allows the same phrase after commit succeeds', () => {
    const trace: TraceEvent[] = [
      tool('scheduling.book.prepare', {}, true, { readback: 'a cut with Marco' }),
      { type: 'say', text: 'a cut with Marco' },
      tool('scheduling.book.commit', {}),
      { type: 'say', text: "You're booked with Marco at 3:30." },
    ];
    expect(matchMustNotSayBeforeCommit(["you're booked"], trace)).toEqual([]);
  });

  it('still flags the phrase when commit never succeeds', () => {
    const trace: TraceEvent[] = [
      tool('scheduling.book.commit', {}, false),
      { type: 'say', text: "You're booked!" },
    ];
    expect(matchMustNotSayBeforeCommit(["you're booked"], trace)).toHaveLength(1);
  });
});

describe('mustSay and readback', () => {
  it('requires every mustSay phrase somewhere in agent speech', () => {
    const trace: TraceEvent[] = [{ type: 'say', text: 'a men\'s cut with Marco, Tuesday at 3:30 PM, for Luis' }];
    expect(matchMustSay(['Marco', '3:30'], trace)).toEqual([]);
    expect(matchMustSay(['Dana'], trace)[0].check).toBe('mustSay');
  });

  it('requires the prepare readback to be spoken verbatim', () => {
    const readback = "a men's cut with Marco, Tuesday, October 20 at 3:30 PM, for Luis, at +15555550142";
    const okTrace: TraceEvent[] = [
      tool('scheduling.book.prepare', {}, true, { readback }),
      { type: 'say', text: readback },
      tool('scheduling.book.commit', {}),
    ];
    expect(matchReadback(true, okTrace)).toEqual([]);
    const missing: TraceEvent[] = [
      tool('scheduling.book.prepare', {}, true, { readback }),
      { type: 'say', text: 'Does 3:30 work?' },
    ];
    expect(matchReadback(true, missing)[0].check).toBe('readbackRequired');
  });

  it('rejects a readback spoken only after its matching commit', () => {
    const readback = 'a cut with Marco, Tuesday at 3:30 PM, for Luis';
    const late: TraceEvent[] = [
      tool('scheduling.book.prepare', {}, true, { readback }),
      tool('scheduling.book.commit', {}),
      { type: 'say', text: readback },
    ];
    expect(matchReadback(true, late)[0].message).toMatch(/before scheduling\.book\.commit/);
  });

  it('requires every prepare readback, not just one', () => {
    const book = 'a cut with Marco at 3:30';
    const ticket = "I'll pass this to Dana: callback about a haircut";
    const trace: TraceEvent[] = [
      tool('scheduling.book.prepare', {}, true, { readback: book }),
      { type: 'say', text: book },
      tool('scheduling.book.commit', {}),
      tool('tickets.open.prepare', {}, true, { readback: ticket }),
      tool('tickets.open.commit', {}),
    ];
    expect(matchReadback(true, trace)[0].message).toMatch(/tickets\.open\.prepare/);
  });
});

describe('matchEndState', () => {
  it('counts every leftover booking, including held rows, so count: 1 fails when a held slot remains', () => {
    const snapshot: EndSnapshot = {
      bookings: [
        {
          id: 'bk_held',
          staffId: 'marco',
          staffName: 'Marco',
          status: 'held',
          start: '2026-10-20T15:30:00-04:00',
          startLocal: '15:30',
          serviceIds: ['svc_cut'],
          customerName: 'Luis',
          customerPhone: '+15555550142',
        },
        {
          id: 'bk_ok',
          staffId: 'marco',
          staffName: 'Marco',
          status: 'confirmed',
          start: '2026-10-20T16:00:00-04:00',
          startLocal: '16:00',
          serviceIds: ['svc_cut'],
          customerName: 'Luis',
          customerPhone: '+15555550142',
        },
      ],
      tickets: [],
      transfers: [],
      waitlist: [],
    };
    const failures = matchEndState({ bookings: { count: 1, items: [{ status: 'confirmed', startLocal: '16:00' }] } }, snapshot);
    expect(failures.some((row) => row.message === 'bookings count')).toBe(true);
    expect(failures.find((row) => row.message === 'bookings count')?.actual).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'held' }),
        expect.objectContaining({ status: 'confirmed' }),
      ]),
    );
  });
});

describe('evaluateExpect + formatDiff', () => {
  it('formats a readable diff covering each failed check', () => {
    const trace: TraceEvent[] = [{ type: 'say', text: "You're booked." }];
    const failures = evaluateExpect(
      {
        actions: [{ name: 'scheduling.book.commit' }],
        mustNotSay: ["you're booked"],
        readbackRequired: true,
        endState: { bookings: { count: 1 } },
      },
      trace,
      emptySnapshot,
    );
    const diff = formatDiff('broken-success-before-commit', failures);
    expect(diff).toMatch(/^FAIL broken-success-before-commit/m);
    expect(diff).toMatch(/mustNotSay/);
    expect(diff).toMatch(/you're booked/);
    expect(diff).toMatch(/actions/);
    expect(diff).toMatch(/endState/);
    expect(firstSuccessfulCommitIndex(trace)).toBe(-1);
  });
});
