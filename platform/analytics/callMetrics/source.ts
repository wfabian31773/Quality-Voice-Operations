// Data adapter for the booked-or-filed report: reads one window of calls and
// what each call left behind. Read-only (four SELECTs, no writes).
//
// How a call links to its artifacts mirrors TicketsRepo.hasCallArtifact
// (platform/actions/tickets/repo.ts), keyed on call_sessions.id and its call_sid:
//   tickets:  source_call_ref IN (id, call_sid) OR call_id = id
//   bookings: intake_data.qvo.session IN (id, call_sid)
// Held and expired/superseded holds are fetched too; report.ts decides what
// counts as written (isWrittenBooking), and their contact name still names the caller.
//
// RLS: inside a tenant scope the caller sees one tenant; the all-tenants
// report needs the privileged pool.

import type { CallBooking, CallRecord, CallTicket } from './report';

export interface CallMetricsDb {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface CallMetricsSource {
  /** Calls whose start_time is in [start, end), for one tenant or all (null). */
  callsStartedBetween(window: { start: Date; end: Date }, tenantId: string | null): Promise<CallRecord[]>;
}

// call_sessions.start_time is TIMESTAMP (no zone) written with NOW() by a UTC
// database, so it is read and compared as UTC wall clock.
const CALLS_SQL = `
  SELECT id, tenant_id, call_sid, direction, start_time AT TIME ZONE 'UTC' AS started_at
    FROM call_sessions
   WHERE start_time >= ($1::timestamptz AT TIME ZONE 'UTC')
     AND start_time <  ($2::timestamptz AT TIME ZONE 'UTC')
     AND ($3::varchar IS NULL OR tenant_id = $3)
   ORDER BY start_time, id`;

// callPersistence writes the caller's lines with role 'user' (the agent's are 'assistant').
const CALLER_LINES_SQL = `
  SELECT call_session_id, tenant_id, content
    FROM call_transcripts
   WHERE call_session_id = ANY($1::varchar[])
     AND role = 'user'
   ORDER BY call_session_id, sequence_number, occurred_at`;

// A floor ticket is marked on its 'created' activity (metadata.floor = true, floor.ts).
const TICKETS_SQL = `
  SELECT t.id, t.tenant_id, t.kind, t.call_id, t.source_call_ref, t.contact_name,
         EXISTS (SELECT 1
                   FROM ticket_activity_log a
                  WHERE a.tenant_id = t.tenant_id
                    AND a.ticket_id = t.id
                    AND a.activity_type = 'created'
                    AND a.metadata ->> 'floor' = 'true') AS floor
    FROM tickets t
   WHERE t.call_id = ANY($1::varchar[])
      OR t.source_call_ref = ANY($2::varchar[])`;

const BOOKINGS_SQL = `
  SELECT id, tenant_id, status, cancellation_reason, contact_name,
         intake_data -> 'qvo' ->> 'session' AS session
    FROM bookings
   WHERE intake_data -> 'qvo' ->> 'session' = ANY($1::varchar[])`;

const str = (value: unknown): string => (value == null ? '' : String(value));
const toDate = (value: unknown): Date => (value instanceof Date ? value : new Date(str(value)));

interface CallRow {
  id: string;
  tenantId: string;
  callSid: string;
  direction: string;
  startedAt: Date;
}

/** `${tenantId}\0${ref}`: refs only match inside one tenant. */
const key = (tenantId: string, ref: string) => `${tenantId}\0${ref}`;

function push<T>(map: Map<string, T[]>, k: string, value: T): void {
  const list = map.get(k);
  if (list) list.push(value);
  else map.set(k, [value]);
}

export function sqlCallMetricsSource(db: CallMetricsDb): CallMetricsSource {
  return {
    async callsStartedBetween(window, tenantId) {
      const { rows } = await db.query(CALLS_SQL, [window.start.toISOString(), window.end.toISOString(), tenantId]);
      const calls: CallRow[] = rows.map((row) => ({
        id: str(row.id),
        tenantId: str(row.tenant_id),
        callSid: str(row.call_sid),
        direction: str(row.direction),
        startedAt: toDate(row.started_at),
      }));
      if (calls.length === 0) return [];

      const ids = calls.map((c) => c.id);
      const refs = [...new Set(calls.flatMap((c) => (c.callSid ? [c.id, c.callSid] : [c.id])))];
      const [lines, tickets, bookings] = await Promise.all([
        db.query(CALLER_LINES_SQL, [ids]),
        db.query(TICKETS_SQL, [ids, refs]),
        db.query(BOOKINGS_SQL, [refs]),
      ]);

      const linesByCall = new Map<string, string[]>();
      for (const row of lines.rows) push(linesByCall, key(str(row.tenant_id), str(row.call_session_id)), str(row.content));

      // Tickets by every ref they carry; a ticket is listed once per call below.
      const ticketsByRef = new Map<string, Array<CallTicket & { contactName: string }>>();
      for (const row of tickets.rows) {
        const ticket = { id: str(row.id), kind: str(row.kind), floor: row.floor === true, contactName: str(row.contact_name) };
        const tenant = str(row.tenant_id);
        if (row.call_id) push(ticketsByRef, key(tenant, `id:${str(row.call_id)}`), ticket);
        if (row.source_call_ref) push(ticketsByRef, key(tenant, `ref:${str(row.source_call_ref)}`), ticket);
      }

      const bookingsBySession = new Map<string, Array<CallBooking & { contactName: string }>>();
      for (const row of bookings.rows) {
        push(bookingsBySession, key(str(row.tenant_id), str(row.session)), {
          id: str(row.id),
          status: str(row.status),
          cancellationReason: str(row.cancellation_reason),
          contactName: str(row.contact_name),
        });
      }

      return calls.map((call) => {
        const callRefs = call.callSid ? [call.id, call.callSid] : [call.id];
        const ticketList = [
          ...(ticketsByRef.get(key(call.tenantId, `id:${call.id}`)) ?? []),
          ...callRefs.flatMap((ref) => ticketsByRef.get(key(call.tenantId, `ref:${ref}`)) ?? []),
        ];
        const callTickets = [...new Map(ticketList.map((t) => [t.id, t])).values()];
        const callBookings = callRefs.flatMap((ref) => bookingsBySession.get(key(call.tenantId, ref)) ?? []);
        // The floor drops the caller's name from the content words; the runtime
        // takes it from tool arguments, which land as these rows' contact name.
        const callerName = [...callTickets, ...callBookings].map((a) => a.contactName.trim()).find(Boolean);
        return {
          callId: call.id,
          tenantId: call.tenantId,
          direction: call.direction,
          startedAt: call.startedAt,
          callerLines: linesByCall.get(key(call.tenantId, call.id)) ?? [],
          ...(callerName ? { callerName } : {}),
          bookings: callBookings.map(({ id, status, cancellationReason }) => ({ id, status, cancellationReason })),
          tickets: callTickets.map(({ id, kind, floor }) => ({ id, kind, floor })),
        };
      });
    },
  };
}
