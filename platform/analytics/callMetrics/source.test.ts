import { describe, expect, it } from 'vitest';
import { bookedOrFiledForDay } from './index';
import { sqlCallMetricsSource, type CallMetricsDb } from './source';

type Row = Record<string, unknown>;

/** Answers each of the source's queries by table, and records what it was asked. */
function fakeDb(tables: { calls: Row[]; lines: Row[]; tickets: Row[]; bookings: Row[]; toolRuns?: Row[] }) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const db: CallMetricsDb = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (/FROM call_sessions/.test(sql)) return { rows: tables.calls };
      if (/FROM call_transcripts/.test(sql)) return { rows: tables.lines };
      if (/FROM tickets/.test(sql)) return { rows: tables.tickets };
      if (/FROM tool_invocations/.test(sql)) return { rows: tables.toolRuns ?? [] };
      if (/FROM bookings/.test(sql)) return { rows: tables.bookings };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return { db, queries };
}

const T1 = 'tenant-1';
const AT = '2026-10-17T15:00:00.000Z';
const callRow = (id: string, callSid: string | null, direction = 'inbound', tenantId = T1) => ({
  id,
  tenant_id: tenantId,
  call_sid: callSid,
  direction,
  started_at: new Date(AT),
});
const line = (callId: string, content: string, tenantId = T1) => ({ call_session_id: callId, tenant_id: tenantId, content });
const FADE = 'I need a fade Friday';

/**
 * A tool_invocations row as the voice runtime leaves it (openaiSession.ts →
 * ToolExecutionService): `output` is the handler's return value, JSON round-
 * tripped; status 'failed' when the handler said success: false. The
 * booking_* / contact_name columns are the source's LEFT JOIN onto bookings.
 */
const toolRun = (callId: string, toolName: string, status: string, output: Row, booking: Row = {}, tenantId = T1) => ({
  tenant_id: tenantId,
  call_session_id: callId,
  tool_name: toolName,
  status,
  output: JSON.parse(JSON.stringify(output)),
  booking_status: null,
  cancellation_reason: null,
  contact_name: null,
  ...booking,
});
// Return values of executeCreateBooking / executeUpdateBooking (platform/tools/library/handlers/createBooking.ts).
const BOOKED_PENDING = 'Booking stored as pending. Do not tell the caller the appointment is confirmed until staff or calendar sync confirms it.';
const createBooked = (bookingId: string) => ({ success: true, message: BOOKED_PENDING, bookingId });
const createChallenge = { success: true, pending: true, status: 'needs_confirmation', confirmationToken: 'tok-1', message: 'Nothing is booked yet. Read back ...' };
const createFailed = { success: false, retryable: false, message: 'startTime must be a valid ISO-8601 timestamp.' };
const rescheduled = (bookingId: string) => ({
  success: true, action: 'reschedule', status: 'updated', bookingId,
  message: 'Existing booking rescheduled through the scheduling lifecycle. Do not create another booking.',
});
const cancelled = (bookingId: string) => ({
  success: true, action: 'cancel', status: 'updated', bookingId,
  message: 'Existing booking cancelled through the scheduling lifecycle. Do not claim a new appointment was booked.',
});
const updateChallenge = (bookingId: string) => ({
  success: true, pending: true, action: 'reschedule', status: 'needs_confirmation', needsConfirmation: true, bookingId,
  confirmationToken: 'tok-2', candidates: [{ bookingId, startTime: AT, endTime: AT, title: 'Fade', status: 'pending' }],
  message: 'Confirm with the caller before changing anything ...',
});

describe('sqlCallMetricsSource', () => {
  it('asks for the New York day window and the tenant, read-only', async () => {
    const { db, queries } = fakeDb({ calls: [], lines: [], tickets: [], bookings: [] });
    await bookedOrFiledForDay(sqlCallMetricsSource(db), '2026-10-17', T1);
    expect(queries).toHaveLength(1); // no calls → nothing else to read
    expect(queries[0].values).toEqual(['2026-10-17T04:00:00.000Z', '2026-10-18T04:00:00.000Z', T1]);
    for (const q of queries) expect(q.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });

  it('links tickets and bookings to a call the way hasCallArtifact does', async () => {
    const { db, queries } = fakeDb({
      calls: [
        callRow('cs-ref', 'CA-ref'),
        callRow('cs-sid', 'CA-sid'),
        callRow('cs-fk', null),
        callRow('cs-book-sid', 'CA-book'),
        callRow('cs-none', 'CA-none'),
        callRow('cs-foreign', 'CA-foreign'),
      ],
      lines: ['cs-ref', 'cs-sid', 'cs-fk', 'cs-book-sid', 'cs-none', 'cs-foreign'].map((id) => line(id, FADE)),
      tickets: [
        // source_call_ref = call_sessions.id (tickets.open / the floor)
        { id: 't1', tenant_id: T1, kind: 'message', call_id: null, source_call_ref: 'cs-ref', contact_name: 'Luis', floor: true },
        // source_call_ref = the Twilio CallSid
        { id: 't2', tenant_id: T1, kind: 'callback', call_id: null, source_call_ref: 'CA-sid', contact_name: '', floor: false },
        // call_id FK (legacy escalation ticket)
        { id: 't3', tenant_id: T1, kind: 'message', call_id: 'cs-fk', source_call_ref: null, contact_name: '', floor: false },
        // another tenant's ticket pointing at the same ref never counts
        { id: 't4', tenant_id: 'tenant-2', kind: 'message', call_id: null, source_call_ref: 'cs-foreign', contact_name: '', floor: false },
      ],
      bookings: [
        // intake_data.qvo.session = the CallSid
        { id: 'b1', tenant_id: T1, status: 'confirmed', cancellation_reason: '', contact_name: '', session: 'CA-book' },
        // an expired hold on the no-artifact call
        { id: 'b2', tenant_id: T1, status: 'cancelled', cancellation_reason: 'hold_expired', contact_name: '', session: 'cs-none' },
      ],
    });
    const report = await bookedOrFiledForDay(sqlCallMetricsSource(db), '2026-10-17', null);
    expect(report.denominator).toBe(6);
    // t3 has no source_call_ref: a legacy writer, so its 'message' kind is only the column default.
    expect(report.breakdown).toEqual({ booked: 1, filedMessage: 1, filedLegacy: 1, filedFloor: 1, filedOther: 0 });
    expect(report.noArtifactCallIds).toEqual(['cs-foreign', 'cs-none']);

    // Ref lists sent to the artifact queries: session ids and CallSids both.
    const ticketQuery = queries.find((q) => /FROM tickets/.test(q.sql))!;
    expect(ticketQuery.values[1]).toEqual(expect.arrayContaining(['cs-ref', 'CA-sid', 'cs-fk']));
    const bookingQuery = queries.find((q) => /FROM bookings/.test(q.sql))!;
    expect(bookingQuery.values[0]).toEqual(expect.arrayContaining(['cs-none', 'CA-book']));
  });

  it('reads only the caller lines, in sequence order, and a contact name for the call', async () => {
    const { db, queries } = fakeDb({
      calls: [callRow('cs-1', 'CA-1')],
      // The name alone is not substantive once the hold's contact name is known.
      lines: [line('cs-1', 'Hi, this is'), line('cs-1', 'Luis Garcia')],
      tickets: [],
      bookings: [{ id: 'b', tenant_id: T1, status: 'held', cancellation_reason: '', contact_name: 'Luis Garcia', session: 'cs-1' }],
    });
    const report = await bookedOrFiledForDay(sqlCallMetricsSource(db), '2026-10-17', T1);
    expect(report.calls).toEqual({ total: 1, outbound: 0, neverHeard: 0, nothingSubstantive: 1, substantive: 0 });
    const lineQuery = queries.find((q) => /FROM call_transcripts/.test(q.sql))!;
    expect(lineQuery.sql).toMatch(/role = 'user'/);
    expect(lineQuery.sql).toMatch(/ORDER BY call_session_id, sequence_number/);
  });

  it('a call with no caller lines is never heard; an outbound call is excluded', async () => {
    const { db } = fakeDb({
      calls: [callRow('cs-silent', 'CA-1'), callRow('cs-out', 'CA-2', 'outbound')],
      lines: [line('cs-out', FADE)],
      tickets: [],
      bookings: [],
    });
    const report = await bookedOrFiledForDay(sqlCallMetricsSource(db), '2026-10-17', T1);
    expect(report.calls).toEqual({ total: 2, outbound: 1, neverHeard: 1, nothingSubstantive: 0, substantive: 0 });
  });
});

describe('sqlCallMetricsSource: bookings made by the legacy library tools (live barbershop path)', () => {
  it('a call that booked through create_booking counts as booked', async () => {
    // executeCreateBooking inserts a 'pending' booking with no intake_data, so
    // only the tool run links it to the call.
    const { db } = fakeDb({
      calls: [callRow('cs-lib', 'CA-lib')],
      lines: [line('cs-lib', FADE)],
      tickets: [],
      bookings: [],
      toolRuns: [toolRun('cs-lib', 'create_booking', 'success', createBooked('b-lib'), { booking_status: 'pending', contact_name: 'Luis Garcia' })],
    });
    const report = await bookedOrFiledForDay(sqlCallMetricsSource(db), '2026-10-17', T1);
    expect(report.breakdown.booked).toBe(1);
    expect(report.noArtifactCallIds).toEqual([]);
  });

  it('only a stored booking counts: not the readback challenge, a failed run, a cancel, or an unapplied reschedule', async () => {
    const ids = ['cs-challenge', 'cs-failed', 'cs-cancel', 'cs-resched-challenge', 'cs-resched', 'cs-foreign'];
    const { db } = fakeDb({
      calls: ids.map((id) => callRow(id, `CA-${id}`)),
      lines: ids.map((id) => line(id, FADE)),
      tickets: [],
      bookings: [],
      toolRuns: [
        toolRun('cs-challenge', 'create_booking', 'success', createChallenge),
        toolRun('cs-failed', 'create_booking', 'failed', createFailed),
        // A cancel moves no new booking onto the call (policy question, PR_NOTES).
        toolRun('cs-cancel', 'update_booking', 'success', cancelled('b-old')),
        // The challenge names the booking it would change, but nothing changed.
        toolRun('cs-resched-challenge', 'update_booking', 'success', updateChallenge('b-old')),
        // An applied reschedule writes a replacement row: its id is in the output.
        toolRun('cs-resched', 'update_booking', 'success', rescheduled('b-new'), { booking_status: 'pending' }),
        // Another tenant's run on the same call id never counts.
        toolRun('cs-foreign', 'create_booking', 'success', createBooked('b-x'), {}, 'tenant-2'),
      ],
    });
    const report = await bookedOrFiledForDay(sqlCallMetricsSource(db), '2026-10-17', null);
    expect(report.breakdown.booked).toBe(1);
    expect(report.noArtifactCallIds).toEqual(['cs-cancel', 'cs-challenge', 'cs-failed', 'cs-foreign', 'cs-resched-challenge']);
  });

  it('a booking found by both links is listed once; the joined booking row names the caller', async () => {
    const { db } = fakeDb({
      calls: [callRow('cs-both', 'CA-both')],
      lines: [line('cs-both', FADE)],
      tickets: [],
      // The session-linked row has no name; the name comes from the tool run's joined row.
      bookings: [{ id: 'b-1', tenant_id: T1, status: 'confirmed', cancellation_reason: '', contact_name: '', session: 'cs-both' }],
      toolRuns: [
        toolRun('cs-both', 'create_booking', 'success', createBooked('b-1'), { booking_status: 'confirmed', contact_name: 'Luis Garcia' }),
        toolRun('cs-both', 'create_booking', 'success', createBooked('b-1'), { booking_status: 'confirmed', contact_name: 'Luis Garcia' }),
      ],
    });
    const [call] = await sqlCallMetricsSource(db).callsStartedBetween({ start: new Date(0), end: new Date(AT) }, T1);
    expect(call.bookings).toEqual([{ id: 'b-1', status: 'confirmed', cancellationReason: '' }]);
    expect(call.callerName).toBe('Luis Garcia');
  });

  it('a tool-linked booking whose row is gone still counts as written', async () => {
    const { db } = fakeDb({
      calls: [callRow('cs-gone', 'CA-gone')],
      lines: [line('cs-gone', FADE)],
      tickets: [],
      bookings: [],
      toolRuns: [toolRun('cs-gone', 'create_booking', 'success', createBooked('b-gone'))],
    });
    const report = await bookedOrFiledForDay(sqlCallMetricsSource(db), '2026-10-17', T1);
    expect(report.breakdown.booked).toBe(1);
  });
});

describe('sqlCallMetricsSource: tenant filter in SQL', () => {
  const tables = {
    calls: [callRow('cs-1', 'CA-1')],
    lines: [line('cs-1', FADE)],
    tickets: [],
    bookings: [],
    toolRuns: [],
  };

  it('every artifact query filters on the tenant when one is given', async () => {
    const { db, queries } = fakeDb(tables);
    await bookedOrFiledForDay(sqlCallMetricsSource(db), '2026-10-17', T1);
    const artifactQueries = queries.filter((q) => !/FROM call_sessions/.test(q.sql));
    expect(artifactQueries).toHaveLength(4);
    for (const table of ['bookings', 'call_transcripts', 'tickets', 'tool_invocations']) {
      expect(artifactQueries.some((q) => new RegExp(`FROM ${table}\\b`).test(q.sql))).toBe(true);
    }
    for (const q of artifactQueries) {
      expect(q.sql).toMatch(/tenant_id = \$\d+/);
      expect(q.values).toContain(T1);
      expect(q.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    }
  });

  it('all tenants passes null, so the filter is off', async () => {
    const { db, queries } = fakeDb(tables);
    await bookedOrFiledForDay(sqlCallMetricsSource(db), '2026-10-17', null);
    for (const q of queries) expect(q.values).not.toContain(T1);
  });
});
