import { formatLocalHm, localDate } from './fakeToolProvider';
import type {
  CheckFailure,
  EndSnapshot,
  EndStateExpect,
  ExpectedAction,
  ScenarioExpect,
  TimeMatchContext,
  TraceEvent,
} from './types';

const HM = /^\d{1,2}:\d{2}$/;

function isHourMinute(value: string): boolean {
  return HM.test(value);
}

function normalizeHm(value: string): string {
  const [hour, minute] = value.split(':');
  return `${hour.padStart(2, '0')}:${minute}`;
}

function looksLikeInstant(value: string): boolean {
  return value.includes('T') && !Number.isNaN(Date.parse(value));
}

function hmMatchesInstant(expectedHm: string, actualIso: string, ctx: TimeMatchContext): boolean {
  return (
    formatLocalHm(actualIso, ctx.timeZone) === normalizeHm(expectedHm) &&
    localDate(actualIso, ctx.timeZone) === ctx.date
  );
}

export function partialMatch(expected: unknown, actual: unknown, ctx?: TimeMatchContext): boolean {
  if (expected === undefined) return true;
  if (expected === null) return actual === null;
  if (typeof expected === 'string') {
    if (typeof actual !== 'string') return String(actual) === expected;
    if (actual === expected) return true;
    if (ctx && isHourMinute(expected) && looksLikeInstant(actual)) {
      return hmMatchesInstant(expected, actual, ctx);
    }
    return false;
  }
  if (typeof expected === 'number' || typeof expected === 'boolean') {
    return expected === actual;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    let cursor = 0;
    for (const item of expected) {
      while (cursor < actual.length && !partialMatch(item, actual[cursor], ctx)) cursor += 1;
      if (cursor >= actual.length) return false;
      cursor += 1;
    }
    return true;
  }
  if (typeof expected === 'object') {
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false;
    const actualRecord = actual as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
      if (!partialMatch(value, actualRecord[key], ctx)) return false;
    }
    return true;
  }
  return false;
}

function toolEvents(trace: TraceEvent[]) {
  return trace.filter((event): event is Extract<TraceEvent, { type: 'tool' }> => event.type === 'tool');
}

function prepareReadback(event: Extract<TraceEvent, { type: 'tool' }>): string | undefined {
  if (!event.name.endsWith('.prepare') || !event.result.ok) return undefined;
  return event.result.readback;
}

function sayEvents(trace: TraceEvent[]) {
  return trace.filter((event): event is Extract<TraceEvent, { type: 'say' }> => event.type === 'say');
}

export function firstSuccessfulCommitIndex(trace: TraceEvent[]): number {
  return trace.findIndex((event) => event.type === 'tool' && event.name.endsWith('.commit') && event.result.ok);
}

/**
 * Banned success phrases unlock only after the commit they describe.
 * Unmapped strings never unlock — a ticket commit must not clear "you're booked".
 */
export function unlockCommitForBannedPhrase(phrase: string): string | undefined {
  const normalized = phrase.toLowerCase();
  if (/\bbooked\b/.test(normalized)) return 'scheduling.book.commit';
  if (
    /i['’]ve let them know/.test(normalized) ||
    /let them know/.test(normalized) ||
    /left a message/.test(normalized) ||
    /\bticket\b/.test(normalized)
  ) {
    return 'tickets.open.commit';
  }
  if (/\btransfer/.test(normalized) || /connect(?:ing)? you/.test(normalized)) {
    return 'calls.transfer_to_human.commit';
  }
  return undefined;
}

export function matchActions(
  expected: ExpectedAction[] | undefined,
  trace: TraceEvent[],
  ctx?: TimeMatchContext,
): CheckFailure[] {
  if (!expected || expected.length === 0) return [];
  const actual = toolEvents(trace);
  const failures: CheckFailure[] = [];
  let cursor = 0;
  for (const exp of expected) {
    const commitMustSucceed = exp.name.endsWith('.commit');
    let found = -1;
    for (let i = cursor; i < actual.length; i += 1) {
      if (actual[i].name !== exp.name || !partialMatch(exp.input ?? {}, actual[i].input, ctx)) continue;
      if (commitMustSucceed && !actual[i].result.ok) continue;
      found = i;
      break;
    }
    if (found < 0) {
      const sameName = actual.slice(cursor).find((call) => call.name === exp.name);
      const failedCommit =
        commitMustSucceed &&
        sameName &&
        !sameName.result.ok &&
        partialMatch(exp.input ?? {}, sameName.input, ctx);
      failures.push({
        check: 'actions',
        message: failedCommit
          ? `${exp.name} ran but did not succeed`
          : sameName
            ? `${exp.name} ran but input did not match`
            : `${exp.name} not found in order after prior expected calls`,
        expected: exp,
        actual: sameName ?? actual.slice(cursor).map((call) => ({ name: call.name, input: call.input })),
      });
      return failures;
    }
    cursor = found + 1;
  }
  return failures;
}

export function matchMustSay(phrases: string[] | undefined, trace: TraceEvent[]): CheckFailure[] {
  if (!phrases || phrases.length === 0) return [];
  const spoken = sayEvents(trace)
    .map((event) => event.text)
    .join('\n');
  const lower = spoken.toLowerCase();
  const failures: CheckFailure[] = [];
  for (const phrase of phrases) {
    if (!lower.includes(phrase.toLowerCase())) {
      failures.push({
        check: 'mustSay',
        message: `agent never said ${JSON.stringify(phrase)}`,
        expected: phrase,
        actual: spoken,
      });
    }
  }
  return failures;
}

export function matchMustNotSayBeforeCommit(phrases: string[] | undefined, trace: TraceEvent[]): CheckFailure[] {
  if (!phrases || phrases.length === 0) return [];
  const firstSuccessByName = new Map<string, number>();
  trace.forEach((event, index) => {
    if (event.type === 'tool' && event.name.endsWith('.commit') && event.result.ok) {
      if (!firstSuccessByName.has(event.name)) firstSuccessByName.set(event.name, index);
    }
  });
  const failures: CheckFailure[] = [];
  trace.forEach((event, index) => {
    if (event.type !== 'say') return;
    const lower = event.text.toLowerCase();
    for (const phrase of phrases) {
      if (!lower.includes(phrase.toLowerCase())) continue;
      const commit = unlockCommitForBannedPhrase(phrase);
      const unlockedAt = commit ? firstSuccessByName.get(commit) : undefined;
      if (commit && unlockedAt !== undefined && index > unlockedAt) continue;
      failures.push({
        check: 'mustNotSay',
        message: commit
          ? `said ${JSON.stringify(phrase)} before ${commit} succeeded`
          : `said ${JSON.stringify(phrase)} (not tied to a commit; never unlocks)`,
        expected: { bannedUntilCommit: phrase, commit: commit ?? null },
        actual: event.text,
      });
    }
  });
  return failures;
}

function normalizeSpeech(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function matchReadback(required: boolean | undefined, trace: TraceEvent[]): CheckFailure[] {
  if (!required) return [];
  const prepares = toolEvents(trace)
    .map((event) => ({ event, readback: prepareReadback(event) }))
    .filter((row): row is { event: Extract<TraceEvent, { type: 'tool' }>; readback: string } => Boolean(row.readback));
  if (prepares.length === 0) {
    return [
      {
        check: 'readbackRequired',
        message: 'no successful prepare returned a readback',
        expected: true,
        actual: toolEvents(trace).map((event) => event.name),
      },
    ];
  }
  const failures: CheckFailure[] = [];
  for (const prepare of prepares) {
    const prepareIndex = trace.indexOf(prepare.event);
    const commitName = prepare.event.name.replace(/\.prepare$/, '.commit');
    let spokenIndex = -1;
    let commitIndex = -1;
    for (let i = prepareIndex + 1; i < trace.length; i += 1) {
      const later = trace[i];
      if (later.type === 'tool' && later.name === commitName) {
        commitIndex = i;
        break;
      }
      if (
        spokenIndex < 0 &&
        later.type === 'say' &&
        normalizeSpeech(later.text).includes(normalizeSpeech(prepare.readback))
      ) {
        spokenIndex = i;
      }
    }
    if (spokenIndex < 0) {
      failures.push({
        check: 'readbackRequired',
        message: `${prepare.event.name} readback was not spoken before ${commitName}`,
        expected: prepare.readback,
        actual: trace
          .slice(prepareIndex + 1, commitIndex >= 0 ? commitIndex : undefined)
          .filter((event): event is Extract<TraceEvent, { type: 'say' }> => event.type === 'say')
          .map((event) => event.text),
      });
      continue;
    }
    if (commitIndex >= 0) {
      const confirmed = trace
        .slice(spokenIndex + 1, commitIndex)
        .some((event) => event.type === 'caller');
      if (!confirmed) {
        failures.push({
          check: 'readbackRequired',
          message: `${prepare.event.name} readback and ${commitName} ran in the same turn; caller must confirm after the spoken readback`,
          expected: prepare.readback,
          actual: trace[spokenIndex].type === 'say' ? trace[spokenIndex].text : undefined,
        });
      }
    }
  }
  return failures;
}

function localMatches(
  expected: string,
  booking: EndSnapshot['bookings'][number],
  ctx: TimeMatchContext | undefined,
  itemDate: string | undefined,
): boolean {
  const date = itemDate ?? ctx?.date;
  const timeZone = ctx?.timeZone;
  if (isHourMinute(expected)) {
    if (booking.startLocal !== normalizeHm(expected)) return false;
    if (!date || !timeZone) return false;
    return localDate(booking.start, timeZone) === date;
  }
  if (booking.start === expected || booking.startLocal === expected) return true;
  if (ctx && looksLikeInstant(expected)) {
    return booking.start === expected;
  }
  return false;
}

export function matchEndState(
  expected: EndStateExpect | undefined,
  snapshot: EndSnapshot,
  ctx?: TimeMatchContext,
): CheckFailure[] {
  if (!expected) return [];
  const failures: CheckFailure[] = [];
  if (expected.bookings) {
    if (expected.bookings.count !== undefined && snapshot.bookings.length !== expected.bookings.count) {
      failures.push({
        check: 'endState',
        message: `bookings count`,
        expected: expected.bookings.count,
        actual: snapshot.bookings.map((row) => ({
          status: row.status,
          startLocal: row.startLocal,
          date: ctx ? localDate(row.start, ctx.timeZone) : undefined,
          staffId: row.staffId,
          staffName: row.staffName,
        })),
      });
    }
    for (const item of expected.bookings.items ?? []) {
      const match = snapshot.bookings.find(
        (row) =>
          (!item.status || row.status === item.status) &&
          (!item.staffId || row.staffId === item.staffId) &&
          (!item.staffName || row.staffName === item.staffName) &&
          (!item.startLocal || localMatches(item.startLocal, row, ctx, item.date)) &&
          (!item.date || (ctx ? localDate(row.start, ctx.timeZone) === item.date : false)),
      );
      if (!match) {
        failures.push({
          check: 'endState',
          message: 'no booking matched',
          expected: item,
          actual: snapshot.bookings,
        });
      }
    }
  }
  if (expected.tickets) {
    if (expected.tickets.count !== undefined && snapshot.tickets.length !== expected.tickets.count) {
      failures.push({
        check: 'endState',
        message: 'tickets count',
        expected: expected.tickets,
        actual: snapshot.tickets,
      });
    }
    if (expected.tickets.status && snapshot.tickets.some((row) => row.status !== expected.tickets?.status)) {
      failures.push({
        check: 'endState',
        message: 'tickets status',
        expected: expected.tickets.status,
        actual: snapshot.tickets,
      });
    }
    if (expected.tickets.kind && snapshot.tickets.some((row) => row.kind !== expected.tickets?.kind)) {
      failures.push({
        check: 'endState',
        message: 'tickets kind',
        expected: expected.tickets.kind,
        actual: snapshot.tickets,
      });
    }
  }
  if (expected.transfers) {
    if (expected.transfers.count !== undefined && snapshot.transfers.length !== expected.transfers.count) {
      failures.push({
        check: 'endState',
        message: 'transfers count',
        expected: expected.transfers,
        actual: snapshot.transfers,
      });
    }
    if (expected.transfers.to && snapshot.transfers.some((row) => row.to !== expected.transfers?.to)) {
      failures.push({
        check: 'endState',
        message: 'transfers to',
        expected: expected.transfers.to,
        actual: snapshot.transfers,
      });
    }
    if (expected.transfers.status && snapshot.transfers.some((row) => row.status !== expected.transfers?.status)) {
      failures.push({
        check: 'endState',
        message: 'transfers status',
        expected: expected.transfers.status,
        actual: snapshot.transfers,
      });
    }
  }
  if (expected.waitlist?.count !== undefined && snapshot.waitlist.length !== expected.waitlist.count) {
    failures.push({
      check: 'endState',
      message: 'waitlist count',
      expected: expected.waitlist.count,
      actual: snapshot.waitlist,
    });
  }
  return failures;
}

export function evaluateExpect(
  expect: ScenarioExpect,
  trace: TraceEvent[],
  snapshot: EndSnapshot,
  ctx?: TimeMatchContext,
): CheckFailure[] {
  return [
    ...matchActions(expect.actions, trace, ctx),
    ...matchEndState(expect.endState, snapshot, ctx),
    ...matchMustSay(expect.mustSay, trace),
    ...matchMustNotSayBeforeCommit(expect.mustNotSay, trace),
    ...matchReadback(expect.readbackRequired, trace),
  ];
}

export function formatDiff(id: string, failures: CheckFailure[]): string {
  if (failures.length === 0) return '';
  const lines = [`FAIL ${id}`];
  for (const failure of failures) {
    lines.push(`  ${failure.check}: ${failure.message}`);
    if (failure.expected !== undefined) {
      lines.push(`    expected: ${JSON.stringify(failure.expected)}`);
    }
    if (failure.actual !== undefined) {
      lines.push(`    actual:   ${JSON.stringify(failure.actual)}`);
    }
  }
  return lines.join('\n');
}
