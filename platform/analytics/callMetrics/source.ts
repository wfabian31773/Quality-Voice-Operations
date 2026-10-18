// Data adapter for the booked-or-filed report: reads one window of calls and
// what each call left behind. Read-only (five SELECTs, no writes).
//
// How a call links to its artifacts mirrors TicketsRepo.hasCallArtifact
// (platform/actions/tickets/repo.ts), keyed on call_sessions.id and its call_sid:
//   tickets:  source_call_ref IN (id, call_sid) OR call_id = id
//   bookings: intake_data.qvo.session IN (id, call_sid)   (scheduling.book.*)
// plus the link hasCallArtifact lacks, for the legacy library tools the live
// templates still use (create_booking / update_booking, which write no call
// reference on the booking):
//   tool_invocations: call_session_id = id, a successful run whose output
//                     names the booking it stored (bookingFromToolRun)
// A booking found by both links is listed once.
// Held and expired/superseded holds are fetched too; report.ts decides what
// counts as written (isWrittenBooking), and their contact name still names the caller.
//
// Every artifact query is also filtered on the tenant when one is given; the
// in-code tenant keying (key()) stays as the guard for the all-tenants report.
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
     AND ($2::varchar IS NULL OR tenant_id = $2)
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
   WHERE (t.call_id = ANY($1::varchar[]) OR t.source_call_ref = ANY($2::varchar[]))
     AND ($3::varchar IS NULL OR t.tenant_id = $3)`;

const BOOKINGS_SQL = `
  SELECT id, tenant_id, status, cancellation_reason, contact_name,
         intake_data -> 'qvo' ->> 'session' AS session
    FROM bookings
   WHERE intake_data -> 'qvo' ->> 'session' = ANY($1::varchar[])
     AND ($2::varchar IS NULL OR tenant_id = $2)`;

/** Library tools whose successful run can store a booking for the call. */
export const BOOKING_TOOLS: readonly string[] = ['create_booking', 'update_booking'];

// openaiSession.ts records every tool run (ToolExecutionService): call_session_id
// is call_sessions.id, output the handler's return value. The booking row is
// joined for its status and contact name; it may be gone, so it is a LEFT JOIN.
const TOOL_BOOKINGS_SQL = `
  SELECT ti.tenant_id, ti.call_session_id, ti.tool_name, ti.status, ti.output,
         b.status AS booking_status, b.cancellation_reason, b.contact_name
    FROM tool_invocations ti
    LEFT JOIN bookings b
      ON b.tenant_id = ti.tenant_id
     AND b.id = ti.output ->> 'bookingId'
   WHERE ti.call_session_id = ANY($1::varchar[])
     AND ti.tool_name = ANY($2::varchar[])
     AND ti.status = 'success'
     AND ($3::varchar IS NULL OR ti.tenant_id = $3)`;

const str = (value: unknown): string => (value == null ? '' : String(value));
const toDate = (value: unknown): Date => (value instanceof Date ? value : new Date(str(value)));

function jsonObject(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

/**
 * The booking a library tool run stored, or null. Read from what the handlers
 * return (platform/tools/library/handlers/createBooking.ts):
 *   create_booking: { success: true, bookingId } once stored; the readback
 *     challenge is { success: true, pending: true } with no booking.
 *   update_booking: only an applied reschedule ({ status: 'updated', action:
 *     'reschedule' }) stores a booking, the replacement row, whose id is
 *     bookingId. A cancel stores none, and a challenge (pending) names the
 *     booking it would change without changing it.
 */
export function bookingFromToolRun(toolName: string, status: string, output: unknown): string | null {
  const result = jsonObject(output);
  if (status !== 'success' || !result || result.success !== true || result.pending === true) return null;
  const bookingId = str(result.bookingId).trim();
  if (!bookingId) return null;
  if (toolName === 'create_booking') return bookingId;
  if (toolName === 'update_booking' && result.status === 'updated' && result.action === 'reschedule') return bookingId;
  return null;
}

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

const uniqueById = <T extends { id: string }>(list: T[]): T[] => [...new Map(list.map((a) => [a.id, a])).values()];

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
      const [lines, tickets, bookings, toolRuns] = await Promise.all([
        db.query(CALLER_LINES_SQL, [ids, tenantId]),
        db.query(TICKETS_SQL, [ids, refs, tenantId]),
        db.query(BOOKINGS_SQL, [refs, tenantId]),
        db.query(TOOL_BOOKINGS_SQL, [ids, BOOKING_TOOLS, tenantId]),
      ]);

      const linesByCall = new Map<string, string[]>();
      for (const row of lines.rows) push(linesByCall, key(str(row.tenant_id), str(row.call_session_id)), str(row.content));

      // Tickets by every ref they carry; a ticket is listed once per call below.
      // Only the action layer sets source_call_ref (tickets.open, the floor);
      // a ticket without it is a legacy writer's, whose kind is the column default.
      const ticketsByRef = new Map<string, Array<CallTicket & { contactName: string }>>();
      for (const row of tickets.rows) {
        const ticket = {
          id: str(row.id),
          kind: str(row.kind),
          floor: row.floor === true,
          legacy: !row.source_call_ref,
          contactName: str(row.contact_name),
        };
        const tenant = str(row.tenant_id);
        if (row.call_id) push(ticketsByRef, key(tenant, `id:${str(row.call_id)}`), ticket);
        if (row.source_call_ref) push(ticketsByRef, key(tenant, `ref:${str(row.source_call_ref)}`), ticket);
      }

      const bookingsByRef = new Map<string, Array<CallBooking & { contactName: string }>>();
      for (const row of bookings.rows) {
        push(bookingsByRef, key(str(row.tenant_id), `session:${str(row.session)}`), {
          id: str(row.id),
          status: str(row.status),
          cancellationReason: str(row.cancellation_reason),
          contactName: str(row.contact_name),
        });
      }
      for (const row of toolRuns.rows) {
        const bookingId = bookingFromToolRun(str(row.tool_name), str(row.status), row.output);
        if (!bookingId) continue;
        // A row that is gone (or not visible) was still written by this call.
        push(bookingsByRef, key(str(row.tenant_id), `call:${str(row.call_session_id)}`), {
          id: bookingId,
          status: str(row.booking_status),
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
        const bookingList = [
          ...callRefs.flatMap((ref) => bookingsByRef.get(key(call.tenantId, `session:${ref}`)) ?? []),
          ...(bookingsByRef.get(key(call.tenantId, `call:${call.id}`)) ?? []),
        ];
        const callTickets = uniqueById(ticketList);
        const callBookings = uniqueById(bookingList);
        // The floor drops the caller's name from the content words; the runtime
        // takes it from tool arguments, which land as these rows' contact name.
        const callerName = [...ticketList, ...bookingList].map((a) => a.contactName.trim()).find(Boolean);
        return {
          callId: call.id,
          tenantId: call.tenantId,
          direction: call.direction,
          startedAt: call.startedAt,
          callerLines: linesByCall.get(key(call.tenantId, call.id)) ?? [],
          ...(callerName ? { callerName } : {}),
          bookings: callBookings.map(({ id, status, cancellationReason }) => ({ id, status, cancellationReason })),
          tickets: callTickets.map(({ id, kind, floor, legacy }) => ({ id, kind, floor, legacy })),
        };
      });
    },
  };
}
