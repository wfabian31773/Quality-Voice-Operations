import { describe, expect, it } from 'vitest';
import { bookedOrFiledForDay } from './index';
import { sqlCallMetricsSource, type CallMetricsDb } from './source';

type Row = Record<string, unknown>;

/** Answers each of the source's four queries by table, and records what it was asked. */
function fakeDb(tables: { calls: Row[]; lines: Row[]; tickets: Row[]; bookings: Row[] }) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const db: CallMetricsDb = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      if (/FROM call_sessions/.test(sql)) return { rows: tables.calls };
      if (/FROM call_transcripts/.test(sql)) return { rows: tables.lines };
      if (/FROM tickets/.test(sql)) return { rows: tables.tickets };
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
    expect(report.breakdown).toEqual({ booked: 1, filedMessage: 2, filedFloor: 1, filedOther: 0 });
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
