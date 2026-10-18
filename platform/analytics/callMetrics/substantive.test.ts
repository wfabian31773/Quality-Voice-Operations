import { describe, expect, it } from 'vitest';
import { createMemoryStore, runAction, type ActionContext } from '../../actions/core';
import { createTicketsActions } from '../../actions/tickets';
import { createMemoryTicketsRepo } from '../../actions/tickets/__fixtures__/memoryRepo';
import { FILE_FLOOR, FLOOR_MAX_LINES, floorIdempotencyKey } from '../../actions/tickets/floor';
import { saidMoreThanTheirOwnName } from '../../actions/tickets/floorHeuristics';
import { callerVerdict, floorCallerLines, type CallerVerdict } from './substantive';

/**
 * Caller lines taken from the floor's own tests (floor.test.ts and
 * floorHeuristics.test.ts), with the callerName they were run with.
 */
const FLOOR_FIXTURES: Array<[string[], string | undefined]> = [
  [[], undefined],
  [['', '   '], undefined],
  [['', '  ...  '], undefined],
  [['Hi, this is Luis.'], undefined],
  [['Hi, this is Luis.'], 'Luis'],
  [['Hola, soy Ana'], 'Ana'],
  [['Hola', 'me llamo Ana María'], 'Ana María'],
  [['Hello?', 'My name is Luis Garcia', 'yes', 'thank you, bye'], 'Luis Garcia'],
  [["it's José"], 'Jose'],
  [['uh', 'um, hmm', 'okay, yeah', 'sí, bueno, gracias', 'adiós'], undefined],
  [['I need a fade Friday'], undefined],
  [['quiero una cita el viernes'], undefined],
  [['Hi, this is Luis', 'haircut', 'tomorrow'], 'Luis'],
  [['Hi this is Luis', 'haircut'], 'Luis'],
  [['Hi, this is Luis', 'I need a fade Friday'], 'Luis'],
  [["Hi, I'm Luis"], undefined],
  [['Luis here'], undefined],
  [['Luis speaking'], undefined],
  [['buenos días'], undefined],
  [["Hi, I'm Luis, I need a fade"], 'Luis'],
  [['Hi, this is Luis, 5552013344'], 'Luis'],
  [['Hi, this is Luis (555)201-3344'], 'Luis'],
  [['Luis 42'], 'Luis'],
  [['Hi, this is Luis, 555201'], 'Luis'],
  [['Hi, this is Luis Garcia'], undefined],
  [['My name is Luis Garcia Lopez'], undefined],
  [['Hola, habla María José López'], undefined],
  [['Buenas tardes, le habla Ana Ruiz'], undefined],
  [['Hi, this is Luis Garcia, I need a fade Friday'], undefined],
  [['this is about my booking Friday'], undefined],
  [['this is my booking'], undefined],
  [['soy de la tienda'], undefined],
  [["I'm canceling tomorrow"], 'Luis'],
  [['Hi, this is Luis Garcia, thanks'], undefined],
  [['Hi, this is Dr. Patel'], undefined],
  [['This is Luis A. Garcia'], undefined],
  [['Hi, this is Ana, running late, thanks'], 'Ana'],
  [['This is Ana. Cancel Friday'], 'Ana'],
  [['This is Luis — cancel Friday'], 'Luis'],
  [['Buenas tardes, habla Ana, cancelo'], 'Ana'],
  [['Buenas tardes, habla Ana, cancelo'], undefined],
  [['soy cliente nuevo, quiero una cita'], undefined],
  [['  Hi,\n this   is Luis  '], 'Luis'],
];

const FLOOR_TO_VERDICT: Record<string, CallerVerdict> = {
  never_heard: 'never_heard',
  nothing_substantive: 'nothing_substantive',
  filed: 'substantive',
};

/** Runs the real tickets.file_floor action on a call with no artifact and returns its reason. */
async function floorReason(callId: string, lines: string[], callerName: string | undefined): Promise<string> {
  const store = createMemoryStore();
  const tickets = createMemoryTicketsRepo();
  const registry = createTicketsActions({ repo: tickets.repo, decryptCallerNumber: async () => null });
  const ctx: ActionContext = {
    tenantId: 'tenant-a',
    actor: { type: 'system', id: 'voice-runtime' },
    now: new Date('2026-10-17T15:00:00.000Z'),
    tenantTimezone: 'America/New_York',
    callId,
    idempotencyKey: floorIdempotencyKey(callId),
  };
  // What the runtime sends: the CallerLineBuffer's lines, and the name as given.
  const input = { callId, callerLines: floorCallerLines(lines), ...(callerName ? { callerName } : {}) };
  const result = await runAction(FILE_FLOOR, ctx, input, { store, registry, withTenantTx: store.withTenantTx.bind(store) });
  if (!result.ok) throw new Error(`floor failed: ${result.error.code}`);
  return (result.data as { reason: string }).reason;
}

describe('callerVerdict is the floor rule', () => {
  it.each(FLOOR_FIXTURES.map((fixture, i) => [i, ...fixture] as const))(
    'fixture %i classifies exactly as tickets.file_floor does',
    async (i, lines, callerName) => {
      const reason = await floorReason(`CA-fixture-${i}`, lines, callerName);
      expect(callerVerdict(lines, callerName)).toBe(FLOOR_TO_VERDICT[reason]);
    },
  );

  it('agrees with saidMoreThanTheirOwnName on every heard fixture', () => {
    for (const [lines, callerName] of FLOOR_FIXTURES) {
      const heard = floorCallerLines(lines);
      if (heard.length === 0) continue;
      expect(callerVerdict(lines, callerName) === 'substantive').toBe(saidMoreThanTheirOwnName(heard, callerName));
    }
  });

  it('covers all three verdicts', () => {
    const verdicts = new Set(FLOOR_FIXTURES.map(([lines, name]) => callerVerdict(lines, name)));
    expect(verdicts).toEqual(new Set(['never_heard', 'nothing_substantive', 'substantive']));
  });
});

describe('floorCallerLines (the runtime CallerLineBuffer bounds)', () => {
  it('collapses whitespace, drops blanks, and keeps the latest FLOOR_MAX_LINES lines', () => {
    expect(floorCallerLines(['  a \n b ', '', '   ', 'c'])).toEqual(['a b', 'c']);
    const many = Array.from({ length: FLOOR_MAX_LINES + 5 }, (_, i) => `line ${i}`);
    const kept = floorCallerLines(many);
    expect(kept).toHaveLength(FLOOR_MAX_LINES);
    expect(kept[0]).toBe('line 5');
  });

  it('a long call still classifies (the floor schema caps lines at FLOOR_MAX_LINES)', () => {
    const many = [...Array.from({ length: 80 }, () => 'uh'), 'I need a fade Friday'];
    expect(callerVerdict(many, undefined)).toBe('substantive');
  });

  it('an over-long caller name is cut to the column size, as the runtime does', () => {
    expect(callerVerdict(['I need a fade Friday'], 'x'.repeat(400))).toBe('substantive');
  });
});
