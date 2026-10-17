// SQL for the scheduling write actions. Every statement runs on the action's
// tenant transaction (RLS bound to app.tenant_id) and also filters by
// tenant_id. QVO's own bookings table only: no calendar sync.
//
// A hold is a `bookings` row with status 'held'. Its idempotency_key is the
// confirmation token of the proposal that owns it, and intake_data.qvo
// carries what the commit needs back (services, the call/session it was
// prepared in, and for a reschedule the booking it replaces).

import type { ActionContext, TenantTx } from '../core';
import { HOLD_EXPIRED_REASON } from './types';

/** How long a prepared slot stays held (spec §1.4: +5 min). */
export const HOLD_TTL_MS = 5 * 60_000;
/**
 * How long after the hold runs out a commit may still try to re-take the
 * same slot. The proposal (confirmation token) lives HOLD_TTL_MS + this.
 */
export const COMMIT_GRACE_MS = 10 * 60_000;
/** cancellation_reason of a hold released by a newer prepare in the same call. */
export const HOLD_SUPERSEDED_REASON = 'hold_superseded';
export { HOLD_EXPIRED_REASON };

/** Statuses the admin lifecycle lets a reschedule/cancel start from (bookingLifecycle.ts). */
export const RESCHEDULABLE_STATUSES = ['pending', 'confirmed'] as const;
export const CANCELLABLE_STATUSES = ['pending', 'confirmed', 'checked_in'] as const;

export interface HoldMeta {
  serviceIds: string[];
  /** ActionContext.callId (else conversationId) of the prepare; null for UI/MCP holds. */
  session: string | null;
  /** Booking a reschedule hold replaces. */
  rescheduleOf?: string;
}

export interface BookingRecord {
  id: string;
  status: string;
  startTime: Date;
  endTime: Date;
  blockedUntil: Date;
  holdExpiresAt: Date | null;
  providerId: string | null;
  providerName: string | null;
  appointmentTypeId: string | null;
  title: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  cancellationReason: string;
  idempotencyKey: string | null;
  /** intake_data.qvo.serviceIds, else the single appointment type. */
  serviceIds: string[];
  session: string | null;
  rescheduleOf: string | null;
}

function str(value: unknown): string {
  return value == null ? '' : String(value);
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function intakeMeta(value: unknown): Partial<HoldMeta> {
  const data = typeof value === 'string' ? safeJson(value) : value;
  const qvo = data && typeof data === 'object' ? (data as { qvo?: unknown }).qvo : undefined;
  return qvo && typeof qvo === 'object' ? (qvo as Partial<HoldMeta>) : {};
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function mapBooking(row: Record<string, unknown>): BookingRecord {
  const meta = intakeMeta(row.intake_data);
  const typeId = row.appointment_type_id == null ? null : str(row.appointment_type_id);
  const serviceIds = Array.isArray(meta.serviceIds) && meta.serviceIds.every((id) => typeof id === 'string')
    ? meta.serviceIds
    : typeId ? [typeId] : [];
  return {
    id: str(row.id),
    status: str(row.status),
    startTime: toDate(row.start_time),
    endTime: toDate(row.end_time),
    blockedUntil: toDate(row.blocked_until ?? row.end_time),
    holdExpiresAt: row.hold_expires_at == null ? null : toDate(row.hold_expires_at),
    providerId: row.provider_id == null ? null : str(row.provider_id),
    providerName: row.provider_name == null ? null : str(row.provider_name),
    appointmentTypeId: typeId,
    title: str(row.title),
    contactName: str(row.contact_name),
    contactPhone: str(row.contact_phone),
    contactEmail: str(row.contact_email),
    cancellationReason: str(row.cancellation_reason),
    idempotencyKey: row.idempotency_key == null ? null : str(row.idempotency_key),
    serviceIds,
    session: typeof meta.session === 'string' ? meta.session : null,
    rescheduleOf: typeof meta.rescheduleOf === 'string' ? meta.rescheduleOf : null,
  };
}

const SELECT_BOOKING = `
  SELECT b.id, b.status, b.start_time, b.end_time, b.blocked_until, b.hold_expires_at,
         b.provider_id, sp.name AS provider_name, b.appointment_type_id, b.title,
         b.contact_name, b.contact_phone, b.contact_email, b.cancellation_reason,
         b.idempotency_key, b.intake_data
    FROM bookings b
    LEFT JOIN scheduling_providers sp ON sp.id = b.provider_id AND sp.tenant_id = b.tenant_id`;

export async function loadBooking(
  tx: TenantTx,
  tenantId: string,
  bookingId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<BookingRecord | null> {
  const { rows } = await tx.query(
    `${SELECT_BOOKING}
      WHERE b.tenant_id = $1 AND b.id = $2${opts.forUpdate ? '\n      FOR UPDATE OF b' : ''}`,
    [tenantId, bookingId],
  );
  return rows[0] ? mapBooking(rows[0]) : null;
}

/** Most bookings one phone lookup returns. */
export const FIND_LIMIT = 20;

/**
 * Upcoming confirmed bookings whose contact phone is `phone` (E.164), soonest
 * first. Matched on digits so a legacy "(555) 555-0142" row is found too;
 * held, cancelled, rescheduled (superseded) and past rows never are.
 */
export async function upcomingByPhone(tx: TenantTx, tenantId: string, phone: string, now: Date): Promise<BookingRecord[]> {
  const digits = phone.replace(/\D/g, '');
  const variants = phone.startsWith('+1') && digits.length === 11 ? [digits, digits.slice(1)] : [digits];
  const { rows } = await tx.query(
    `${SELECT_BOOKING}
      WHERE b.tenant_id = $1
        AND b.status = 'confirmed'
        AND b.start_time > $2
        AND regexp_replace(b.contact_phone, '[^0-9]', '', 'g') = ANY($3::text[])
      ORDER BY b.start_time, b.id
      LIMIT ${FIND_LIMIT}`,
    [tenantId, now.toISOString(), variants],
  );
  return rows.map(mapBooking);
}

/** The hold owned by a confirmation token (bookings.idempotency_key), locked for the commit. */
export async function lockHoldByToken(tx: TenantTx, tenantId: string, token: string): Promise<BookingRecord | null> {
  const { rows } = await tx.query(
    `${SELECT_BOOKING}
      WHERE b.tenant_id = $1 AND b.idempotency_key = $2
      FOR UPDATE OF b`,
    [tenantId, token],
  );
  return rows[0] ? mapBooking(rows[0]) : null;
}

/** Names of a booking's services in booking order (inactive ones too), for readbacks. */
export async function serviceNames(tx: TenantTx, tenantId: string, serviceIds: string[]): Promise<string[]> {
  if (serviceIds.length === 0) return [];
  const { rows } = await tx.query(
    `SELECT id, name FROM scheduling_appointment_types WHERE tenant_id = $1 AND id = ANY($2::text[])`,
    [tenantId, serviceIds],
  );
  const byId = new Map(rows.map((r) => [str(r.id), str(r.name)]));
  return serviceIds.map((id) => byId.get(id)).filter((name): name is string => Boolean(name));
}

/** The call/session a prepare belongs to; corrections release earlier holds of the same session. */
export function sessionOf(ctx: ActionContext): string | null {
  return ctx.callId ?? ctx.conversationId ?? null;
}

/**
 * Supersedes every earlier hold of this session that never became a booking
 * (spec §1.6 #6: a correction is a new prepare and the old hold is released):
 * still-held rows, and rows the sweeper or another prepare's expireStaleHolds
 * already cancelled as hold_expired (they stay cancelled, re-marked
 * hold_superseded). Their tokens then commit as CONFIRMATION_INVALID instead
 * of re-taking the slot, never as a second booking.
 */
export async function releaseSessionHolds(tx: TenantTx, tenantId: string, session: string | null): Promise<string[]> {
  if (!session) return [];
  const { rows } = await tx.query(
    `UPDATE bookings
        SET status = 'cancelled',
            cancellation_reason = $3,
            updated_at = NOW()
      WHERE tenant_id = $1
        AND (status = 'held' OR (status = 'cancelled' AND cancellation_reason = $4))
        AND intake_data -> 'qvo' ->> 'session' = $2
      RETURNING id`,
    [tenantId, session, HOLD_SUPERSEDED_REASON, HOLD_EXPIRED_REASON],
  );
  return rows.map((r) => str(r.id));
}

/**
 * Whether a later prepare in the same session wrote a row after this hold.
 * A re-take must not reopen a hold the caller has already corrected, even if
 * a sweep re-marked it hold_expired after the release. A tie on created_at
 * counts as newer.
 */
export async function hasNewerSessionPrepare(tx: TenantTx, tenantId: string, hold: BookingRecord): Promise<boolean> {
  if (!hold.session) return false;
  const { rows } = await tx.query(
    `SELECT 1
       FROM bookings n
       JOIN bookings h ON h.tenant_id = n.tenant_id AND h.id = $2
      WHERE n.tenant_id = $1
        AND n.id <> h.id
        AND n.intake_data -> 'qvo' ->> 'session' = $3
        AND n.created_at >= h.created_at
      LIMIT 1`,
    [tenantId, hold.id, hold.session],
  );
  return rows.length > 0;
}

export function bookingSource(ctx: ActionContext): 'ai_agent' | 'manual' | 'api' {
  if (ctx.actor.type === 'agent') return 'ai_agent';
  if (ctx.actor.type === 'user') return 'manual';
  return 'api';
}

export interface NewHold {
  tenantId: string;
  title: string;
  start: Date;
  end: Date;
  blockedUntil: Date;
  holdExpiresAt: Date;
  providerId: string;
  appointmentTypeId: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  notes: string;
  timezone: string;
  source: 'ai_agent' | 'manual' | 'api';
  createdBy: string | null;
  meta: HoldMeta;
}

/** Inserts the held row; the 122 exclusion constraint raises 23P01 on an overlap. */
export async function insertHold(tx: TenantTx, hold: NewHold): Promise<string> {
  const { rows } = await tx.query(
    `INSERT INTO bookings (tenant_id, title, start_time, end_time, blocked_until, status, hold_expires_at,
        provider_id, appointment_type_id, contact_name, contact_phone, contact_email, notes,
        timezone, booking_source, created_by, intake_data)
     VALUES ($1, $2, $3, $4, $5, 'held', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb)
     RETURNING id`,
    [
      hold.tenantId,
      hold.title,
      hold.start.toISOString(),
      hold.end.toISOString(),
      hold.blockedUntil.toISOString(),
      hold.holdExpiresAt.toISOString(),
      hold.providerId,
      hold.appointmentTypeId,
      hold.contactName,
      hold.contactPhone,
      hold.contactEmail,
      hold.notes,
      hold.timezone,
      hold.source,
      hold.createdBy,
      JSON.stringify({ qvo: hold.meta }),
    ],
  );
  return str(rows[0]?.id);
}

/** Ties the hold to the proposal that owns it. */
export async function setHoldOwner(tx: TenantTx, tenantId: string, holdId: string, token: string): Promise<void> {
  await tx.query(
    `UPDATE bookings SET idempotency_key = $3, updated_at = NOW() WHERE tenant_id = $1 AND id = $2`,
    [tenantId, holdId, token],
  );
}

/**
 * held (or an expired hold being re-taken) → confirmed/pending. Moving a row
 * back into ('held','confirmed') re-runs the exclusion constraint, so a
 * re-take of a slot someone else took raises 23P01.
 */
export async function confirmHold(tx: TenantTx, tenantId: string, holdId: string, status: 'confirmed' | 'pending'): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE bookings
        SET status = $3,
            hold_expires_at = NULL,
            cancellation_reason = '',
            updated_at = NOW()
      WHERE tenant_id = $1 AND id = $2 AND status IN ('held', 'cancelled')`,
    [tenantId, holdId, status],
  );
  return (rowCount ?? 0) > 0;
}

/** Status move guarded by the status read at lock time (stale writers get 0 rows). */
export async function moveStatus(
  tx: TenantTx,
  tenantId: string,
  bookingId: string,
  from: string,
  to: 'cancelled' | 'rescheduled',
  cancellationReason?: string,
): Promise<boolean> {
  const { rowCount } = await tx.query(
    `UPDATE bookings
        SET status = $4,
            cancellation_reason = COALESCE($5, cancellation_reason),
            updated_at = NOW()
      WHERE tenant_id = $1 AND id = $2 AND status = $3`,
    [tenantId, bookingId, from, to, cancellationReason ?? null],
  );
  return (rowCount ?? 0) > 0;
}

/** Same table and shape as writeSchedulingAuditLog (admin routes). */
export async function writeBookingAudit(
  tx: TenantTx,
  ctx: ActionContext,
  entry: { bookingId: string; action: string; previousStatus: string | null; newStatus: string; details: Record<string, unknown> },
): Promise<void> {
  await tx.query(
    `INSERT INTO scheduling_audit_log (tenant_id, booking_id, action, previous_status, new_status, changed_by, details, override_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, '')`,
    [
      ctx.tenantId,
      entry.bookingId,
      entry.action,
      entry.previousStatus,
      entry.newStatus,
      ctx.actor.type === 'user' ? ctx.actor.id : null,
      JSON.stringify({ ...entry.details, actor: ctx.actor.type, callId: ctx.callId ?? null }),
    ],
  );
}

/**
 * scheduling_booking_rules.cancellation_window_hours (migration 052) for a
 * booking's service: its own row, else the tenant-wide row, else the column
 * default (24), like the engine's other rule defaults.
 */
export async function cancellationWindowHours(tx: TenantTx, tenantId: string, serviceIds: string[]): Promise<number> {
  const { rows } = await tx.query(
    `SELECT appointment_type_id, cancellation_window_hours
       FROM scheduling_booking_rules
      WHERE tenant_id = $1
        AND (appointment_type_id IS NULL OR appointment_type_id = ANY($2::text[]))
      ORDER BY created_at, id`,
    [tenantId, serviceIds],
  );
  const hoursOf = (row: Record<string, unknown> | undefined) => {
    const n = Number(row?.cancellation_window_hours);
    return Number.isFinite(n) ? Math.max(0, n) : 24;
  };
  const tenantRow = rows.find((r) => r.appointment_type_id == null);
  const fallback = tenantRow ? hoursOf(tenantRow) : 24;
  if (serviceIds.length === 0) return fallback;
  // The strictest window of the booked services wins, like the engine's rules.
  return Math.max(
    ...serviceIds.map((id) => {
      const row = rows.find((r) => r.appointment_type_id != null && String(r.appointment_type_id) === id);
      return row ? hoursOf(row) : fallback;
    }),
  );
}
