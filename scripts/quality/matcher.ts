import type {
  CheckFailure,
  EndSnapshot,
  EndStateExpect,
  ExpectedAction,
  ScenarioExpect,
  TraceEvent,
} from './types';

export function partialMatch(expected: unknown, actual: unknown): boolean {
  if (expected === undefined) return true;
  if (expected === null) return actual === null;
  if (typeof expected === 'string') {
    if (typeof actual !== 'string') return String(actual) === expected;
    if (actual === expected) return true;
    return actual.toLowerCase().includes(expected.toLowerCase());
  }
  if (typeof expected === 'number' || typeof expected === 'boolean') {
    return expected === actual;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false;
    let cursor = 0;
    for (const item of expected) {
      while (cursor < actual.length && !partialMatch(item, actual[cursor])) cursor += 1;
      if (cursor >= actual.length) return false;
      cursor += 1;
    }
    return true;
  }
  if (typeof expected === 'object') {
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false;
    const actualRecord = actual as Record<string, unknown>;
    for (const [key, value] of Object.entries(expected as Record<string, unknown>)) {
      if (!partialMatch(value, actualRecord[key])) return false;
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

export function matchActions(expected: ExpectedAction[] | undefined, trace: TraceEvent[]): CheckFailure[] {
  if (!expected || expected.length === 0) return [];
  const actual = toolEvents(trace);
  const failures: CheckFailure[] = [];
  let cursor = 0;
  for (const exp of expected) {
    let found = -1;
    for (let i = cursor; i < actual.length; i += 1) {
      if (actual[i].name === exp.name && partialMatch(exp.input ?? {}, actual[i].input)) {
        found = i;
        break;
      }
    }
    if (found < 0) {
      const sameName = actual.slice(cursor).find((call) => call.name === exp.name);
      failures.push({
        check: 'actions',
        message: sameName
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
  const commitAt = firstSuccessfulCommitIndex(trace);
  const failures: CheckFailure[] = [];
  let index = 0;
  for (const event of trace) {
    if (commitAt >= 0 && index >= commitAt) break;
    if (event.type === 'say') {
      const lower = event.text.toLowerCase();
      for (const phrase of phrases) {
        if (lower.includes(phrase.toLowerCase())) {
          failures.push({
            check: 'mustNotSay',
            message: `said ${JSON.stringify(phrase)} before commit succeeded`,
            expected: { bannedUntilCommit: phrase },
            actual: event.text,
          });
        }
      }
    }
    index += 1;
  }
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
  const spoken = sayEvents(trace).map((event) => normalizeSpeech(event.text));
  for (const prepare of prepares) {
    const readback = normalizeSpeech(prepare.readback);
    const said = spoken.some((text) => text.includes(readback));
    if (said) return [];
  }
  return [
    {
      check: 'readbackRequired',
      message: 'agent did not read back the prepare readback string',
      expected: prepares.map((row) => row.readback),
      actual: sayEvents(trace).map((event) => event.text),
    },
  ];
}

function localMatches(expected: string, booking: EndSnapshot['bookings'][number]): boolean {
  return booking.startLocal === expected || booking.start.includes(expected);
}

export function matchEndState(expected: EndStateExpect | undefined, snapshot: EndSnapshot): CheckFailure[] {
  if (!expected) return [];
  const failures: CheckFailure[] = [];
  if (expected.bookings) {
    const wantedStatus = expected.bookings.items?.[0]?.status;
    const rows = wantedStatus ? snapshot.bookings.filter((row) => row.status === wantedStatus) : snapshot.bookings;
    if (expected.bookings.count !== undefined && rows.length !== expected.bookings.count) {
      failures.push({
        check: 'endState',
        message: `bookings count`,
        expected: expected.bookings.count,
        actual: rows.map((row) => ({
          status: row.status,
          startLocal: row.startLocal,
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
          (!item.startLocal || localMatches(item.startLocal, row)),
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
    const rows = snapshot.tickets.filter((row) => {
      if (expected.tickets?.status && row.status !== expected.tickets.status) return false;
      if (expected.tickets?.kind && row.kind !== expected.tickets.kind) return false;
      return true;
    });
    if (expected.tickets.count !== undefined && rows.length !== expected.tickets.count) {
      failures.push({
        check: 'endState',
        message: 'tickets count',
        expected: expected.tickets,
        actual: snapshot.tickets,
      });
    }
  }
  if (expected.transfers) {
    const rows = snapshot.transfers.filter((row) => {
      if (expected.transfers?.to && row.to !== expected.transfers.to) return false;
      return row.status === 'committed';
    });
    if (expected.transfers.count !== undefined && rows.length !== expected.transfers.count) {
      failures.push({
        check: 'endState',
        message: 'transfers count',
        expected: expected.transfers,
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

export function evaluateExpect(expect: ScenarioExpect, trace: TraceEvent[], snapshot: EndSnapshot): CheckFailure[] {
  return [
    ...matchActions(expect.actions, trace),
    ...matchEndState(expect.endState, snapshot),
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
