import { createHash } from 'node:crypto';
import type { TenantTx } from '../core';
import { HOLD_SUPERSEDED_REASON } from '../scheduling/bookingRows';
import { HOLD_EXPIRED_REASON } from '../scheduling/types';
import { parseTenantIntakeSchemas, type TenantIntakeSchemas } from './intakeSchemas';
import type { TicketKind, TicketPriority, TicketStatus, TicketUrgency } from './schemas';

export interface TicketRecord {
  id: string;
  ticketNumber: number | null;
  kind: TicketKind;
  status: TicketStatus;
  priority: TicketPriority;
  urgency: TicketUrgency;
  subject: string;
  description: string;
  contactName: string;
  contactPhone: string;
  assigneeId: string | null;
  callId: string | null;
  sourceCallRef: string | null;
  callbackDueAt: Date | null;
  intake: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/** Ticket settings from `tenants.settings.tickets`. Missing values stay null; nothing is invented. */
export interface TicketSettings {
  businessName: string | null;
  ownerName: string | null;
  slaText: string | null;
  callbackSlaMinutes: number | null;
  /** `tenants.settings.tickets.intakeSchemas[kind]`; kinds without one use DEFAULT_INTAKE_SCHEMAS. */
  intakeSchemas: TenantIntakeSchemas;
}

export type TicketSource = 'manual' | 'api' | 'ai_agent';

export interface NewTicket {
  kind: TicketKind;
  subject: string;
  description: string;
  contactName: string;
  contactPhone: string;
  urgency: TicketUrgency;
  priority: TicketPriority;
  source: TicketSource;
  intake: Record<string, unknown>;
  callbackDueAt: Date | null;
  callRef: string | null;
  createdByUserId: string | null;
  now: Date;
}

export type ActivityType =
  | 'created'
  | 'note'
  | 'status_change'
  | 'priority_change'
  | 'assigned'
  | 'unassigned'
  | 'field_change'
  | 'reopened';

export interface NewActivity {
  ticketId: string;
  actorUserId: string | null;
  type: ActivityType;
  content?: string;
  fieldName?: string;
  oldValue?: string;
  newValue?: string;
  metadata?: Record<string, unknown>;
  now: Date;
}

export interface TicketPatch {
  status?: TicketStatus;
  assigneeId?: string | null;
  priority?: TicketPriority;
  urgency?: TicketUrgency;
  callbackDueAt?: Date | null;
}

export interface ListFilter {
  status: 'open' | 'overdue' | 'all';
  kind?: TicketKind;
  limit: number;
  now: Date;
}

export interface TicketNote {
  content: string;
  createdAt: Date;
}

/** A row for `ticket_outbox` (migration 002). The dispatcher reads only that table. */
export interface NewOutboxEvent {
  eventType: 'ticket.opened';
  payload: Record<string, unknown>;
}

/** An active `ticket_sla_policies` row. */
export interface SlaPolicy {
  id: string;
  firstResponseMinutes: number;
  resolutionMinutes: number;
}

/** A `ticket_sla_instances` row, read by the breach worker and the overdue/at-risk queues. */
export interface SlaInstance {
  ticketId: string;
  policyId: string;
  responseDueAt: Date;
  resolutionDueAt: Date;
}

export interface TicketsRepo {
  getSettings(): Promise<TicketSettings>;
  /** The oldest active `ticket_sla_policies` row for this priority, as the admin create route picks it. */
  slaPolicy(priority: TicketPriority): Promise<SlaPolicy | null>;
  /** Inserts the ticket's SLA instance, or moves an existing one's due times earlier (never later). */
  applySlaInstance(instance: SlaInstance): Promise<void>;
  /**
   * First assignment, as the admin PATCH records it: sets tickets.first_response_at if null and,
   * when it was null or the ticket had no assignee, settles response_met on open instances.
   */
  recordFirstResponse(ticketId: string, wasUnassigned: boolean, now: Date): Promise<void>;
  /** Status became resolved: settles resolution_met on open instances. */
  recordSlaResolved(ticketId: string, now: Date): Promise<void>;
  /** Status became pending: pauses running instances. */
  pauseSla(ticketId: string, now: Date): Promise<void>;
  /** Status left pending: pushes due times out by the paused interval and clears paused_at. */
  resumeSla(ticketId: string, now: Date): Promise<void>;
  /** Serializes same-call dedupe for (callRef, kind, phone) until the transaction ends. */
  lockCallDedupe(key: string): Promise<void>;
  findByCallRef(callRef: string, kind: TicketKind): Promise<TicketRecord[]>;
  /**
   * Whether this call already filed something: a ticket of any kind (by source_call_ref or
   * call_id, including a call_id whose call_sessions row has this call_sid), or a booking.
   * bookings has no call_id column; an agent booking carries its call in
   * intake_data.qvo.session (scheduling/bookingRows.ts). Holds that never became a
   * booking (still held, expired or superseded) do not count.
   */
  hasCallArtifact(callRef: string): Promise<boolean>;
  /** call_sessions.caller_number as stored (ciphertext or legacy plain text) for this call, or null. */
  callerNumber(callRef: string): Promise<string | null>;
  insert(ticket: NewTicket): Promise<TicketRecord>;
  addActivity(activity: NewActivity): Promise<void>;
  /** Writes a pending outbox row in the caller's transaction and returns its id. */
  enqueueOutbox(event: NewOutboxEvent): Promise<string>;
  get(id: string, opts?: { forUpdate?: boolean }): Promise<TicketRecord | null>;
  update(id: string, patch: TicketPatch, now: Date): Promise<TicketRecord>;
  list(filter: ListFilter): Promise<TicketRecord[]>;
  notes(ticketId: string, limit: number): Promise<TicketNote[]>;
  isTenantMember(userId: string): Promise<boolean>;
}

export type TicketsRepoFactory = (tx: TenantTx, tenantId: string) => TicketsRepo;

const ACTIVE_STATUS_SQL = `('open', 'in_progress', 'pending', 'escalated', 'reopened')`;

const TICKET_COLUMNS = `
  id, ticket_number, kind, status, priority, urgency, subject, description,
  contact_name, contact_phone, assignee_user_id, call_id, source_call_ref,
  callback_due_at, intake, created_at, updated_at`;

function asDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asIntake(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return asIntake(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function mapTicket(row: Record<string, unknown>): TicketRecord {
  return {
    id: String(row.id),
    ticketNumber: row.ticket_number === null || row.ticket_number === undefined ? null : Number(row.ticket_number),
    kind: (row.kind ?? 'message') as TicketKind,
    status: row.status as TicketStatus,
    priority: row.priority as TicketPriority,
    urgency: (row.urgency ?? 'normal') as TicketUrgency,
    subject: String(row.subject ?? ''),
    description: String(row.description ?? ''),
    contactName: String(row.contact_name ?? ''),
    contactPhone: String(row.contact_phone ?? ''),
    assigneeId: asNullableString(row.assignee_user_id),
    callId: asNullableString(row.call_id),
    sourceCallRef: asNullableString(row.source_call_ref),
    callbackDueAt: row.callback_due_at ? asDate(row.callback_due_at) : null,
    intake: asIntake(row.intake),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

function trimmedOrNull(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

export function parseTicketSettings(businessName: unknown, settings: unknown): TicketSettings {
  const root = asIntake(settings);
  const tickets = asIntake(root.tickets);
  const minutes = tickets.callbackSlaMinutes;
  return {
    businessName: trimmedOrNull(businessName, 255),
    ownerName: trimmedOrNull(tickets.ownerName, 100),
    slaText: trimmedOrNull(tickets.slaText, 120),
    callbackSlaMinutes:
      typeof minutes === 'number' && Number.isInteger(minutes) && minutes > 0 && minutes <= 60 * 24 * 30 ? minutes : null,
    intakeSchemas: parseTenantIntakeSchemas(tickets.intakeSchemas),
  };
}

/** Signed 64-bit advisory-lock key for pg_advisory_xact_lock(bigint). */
export function advisoryLockKey(key: string): string {
  return createHash('sha256').update(key).digest().readBigInt64BE(0).toString();
}

/**
 * FK columns (tickets.call_id, created_by_user_id, ticket_activity_log.user_id)
 * only get ids that resolve to an existing row; anything else (e.g. a call id
 * with no call_sessions row) is stored as NULL instead of failing the insert.
 * Calls must also belong to this tenant. That filter is explicit, so a foreign
 * call is never linked even while RLS is bypassed (app still on `postgres`).
 */
async function existingUserId(tx: TenantTx, id: string | null): Promise<string | null> {
  if (!id) return null;
  const { rows } = await tx.query(`SELECT id FROM users WHERE id = $1`, [id]);
  return rows[0] ? String(rows[0].id) : null;
}

async function tenantCallId(tx: TenantTx, tenantId: string, id: string | null): Promise<string | null> {
  if (!id) return null;
  const { rows } = await tx.query(`SELECT id FROM call_sessions WHERE id = $1 AND tenant_id = $2`, [id, tenantId]);
  return rows[0] ? String(rows[0].id) : null;
}

export const sqlTicketsRepo: TicketsRepoFactory = (tx, tenantId) => ({
  async getSettings() {
    const { rows } = await tx.query(`SELECT name, settings FROM tenants WHERE id = $1`, [tenantId]);
    const row = rows[0];
    return parseTicketSettings(row?.name, row?.settings);
  },

  async slaPolicy(priority) {
    const { rows } = await tx.query(
      `SELECT id, first_response_minutes, resolution_minutes
         FROM ticket_sla_policies
        WHERE tenant_id = $1 AND priority = $2 AND is_active = true AND category_id IS NULL
        ORDER BY created_at ASC
        LIMIT 1`,
      [tenantId, priority],
    );
    const row = rows[0];
    const minutes = row?.first_response_minutes;
    if (typeof minutes !== 'number' || minutes <= 0) return null;
    return { id: String(row.id), firstResponseMinutes: minutes, resolutionMinutes: Number(row.resolution_minutes) };
  },

  async applySlaInstance(instance) {
    const { rows } = await tx.query(
      `SELECT id, response_due_at, resolution_due_at
         FROM ticket_sla_instances
        WHERE tenant_id = $1 AND ticket_id = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [tenantId, instance.ticketId],
    );
    const current = rows[0];
    if (!current) {
      await tx.query(
        `INSERT INTO ticket_sla_instances (tenant_id, ticket_id, policy_id, response_due_at, resolution_due_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, instance.ticketId, instance.policyId, instance.responseDueAt, instance.resolutionDueAt],
      );
      return;
    }
    const earlier = (existing: unknown, next: Date) => !existing || next.getTime() < asDate(existing).getTime();
    const response = earlier(current.response_due_at, instance.responseDueAt);
    const resolution = earlier(current.resolution_due_at, instance.resolutionDueAt);
    if (!response && !resolution) return;
    await tx.query(
      `UPDATE ticket_sla_instances SET response_due_at = $3, resolution_due_at = $4, updated_at = NOW()
        WHERE tenant_id = $1 AND id = $2`,
      [
        tenantId,
        current.id,
        response ? instance.responseDueAt : current.response_due_at,
        resolution ? instance.resolutionDueAt : current.resolution_due_at,
      ],
    );
  },

  async recordFirstResponse(ticketId, wasUnassigned, now) {
    const { rows } = await tx.query(
      `UPDATE tickets SET first_response_at = $3
        WHERE tenant_id = $1 AND id = $2 AND first_response_at IS NULL
        RETURNING id`,
      [tenantId, ticketId, now],
    );
    if (rows.length === 0 && !wasUnassigned) return;
    await tx.query(
      `UPDATE ticket_sla_instances SET response_met = (response_due_at >= $3), updated_at = $3
        WHERE tenant_id = $1 AND ticket_id = $2 AND response_met IS NULL`,
      [tenantId, ticketId, now],
    );
  },

  async recordSlaResolved(ticketId, now) {
    await tx.query(
      `UPDATE ticket_sla_instances SET resolution_met = (resolution_due_at >= $3), updated_at = $3
        WHERE tenant_id = $1 AND ticket_id = $2 AND resolution_met IS NULL`,
      [tenantId, ticketId, now],
    );
  },

  async pauseSla(ticketId, now) {
    await tx.query(
      `UPDATE ticket_sla_instances SET paused_at = $3, updated_at = $3
        WHERE tenant_id = $1 AND ticket_id = $2 AND paused_at IS NULL`,
      [tenantId, ticketId, now],
    );
  },

  async resumeSla(ticketId, now) {
    // The shift is computed here from ctx.now, not the database clock.
    const { rows } = await tx.query(
      `SELECT id, paused_at, response_due_at, resolution_due_at, total_paused_minutes
         FROM ticket_sla_instances
        WHERE tenant_id = $1 AND ticket_id = $2 AND paused_at IS NOT NULL`,
      [tenantId, ticketId],
    );
    const shift = (value: unknown, ms: number) => (value ? new Date(asDate(value).getTime() + ms) : null);
    for (const row of rows) {
      const pausedMs = Math.max(0, now.getTime() - asDate(row.paused_at).getTime());
      await tx.query(
        `UPDATE ticket_sla_instances
            SET response_due_at = $3, resolution_due_at = $4, total_paused_minutes = $5, paused_at = NULL, updated_at = $6
          WHERE tenant_id = $1 AND id = $2`,
        [
          tenantId,
          row.id,
          shift(row.response_due_at, pausedMs),
          shift(row.resolution_due_at, pausedMs),
          Number(row.total_paused_minutes ?? 0) + Math.floor(pausedMs / 60_000),
          now,
        ],
      );
    }
  },

  async lockCallDedupe(key) {
    await tx.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [advisoryLockKey(`${tenantId}\0${key}`)]);
  },

  async findByCallRef(callRef, kind) {
    const { rows } = await tx.query(
      `SELECT ${TICKET_COLUMNS}
         FROM tickets
        WHERE tenant_id = $1 AND source_call_ref = $2 AND kind = $3
        ORDER BY created_at ASC`,
      [tenantId, callRef, kind],
    );
    return rows.map(mapTicket);
  },

  async hasCallArtifact(callRef) {
    const { rows: tickets } = await tx.query(
      `SELECT 1
         FROM tickets
        WHERE tenant_id = $1
          AND (source_call_ref = $2
               OR call_id = $2
               OR call_id IN (SELECT id FROM call_sessions WHERE tenant_id = $1 AND call_sid = $2))
        LIMIT 1`,
      [tenantId, callRef],
    );
    if (tickets.length > 0) return true;
    // Agent bookings store the call_sessions.id as session; map a CallSid the same way as above,
    // and a session id back to its CallSid for bookings stored under the CallSid.
    const { rows: bookings } = await tx.query(
      `SELECT 1
         FROM bookings
        WHERE tenant_id = $1
          AND (intake_data -> 'qvo' ->> 'session' = $2
               OR intake_data -> 'qvo' ->> 'session' IN (SELECT id FROM call_sessions WHERE tenant_id = $1 AND call_sid = $2)
               OR intake_data -> 'qvo' ->> 'session' IN (SELECT call_sid FROM call_sessions WHERE tenant_id = $1 AND id = $2))
          AND status <> 'held'
          AND COALESCE(cancellation_reason, '') NOT IN ($3, $4)
        LIMIT 1`,
      [tenantId, callRef, HOLD_EXPIRED_REASON, HOLD_SUPERSEDED_REASON],
    );
    return bookings.length > 0;
  },

  async callerNumber(callRef) {
    const { rows } = await tx.query(
      `SELECT caller_number
         FROM call_sessions
        WHERE tenant_id = $1 AND (id = $2 OR call_sid = $2)
        ORDER BY created_at DESC
        LIMIT 1`,
      [tenantId, callRef],
    );
    const value = rows[0]?.caller_number;
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  },

  async insert(ticket) {
    const { rows } = await tx.query(
      `INSERT INTO tickets
         (tenant_id, call_id, source_call_ref, subject, description, status, priority, source,
          contact_name, contact_phone, kind, urgency, intake, callback_due_at, created_by_user_id,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'open', $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $15)
       RETURNING ${TICKET_COLUMNS}`,
      [
        tenantId,
        await tenantCallId(tx, tenantId, ticket.callRef),
        ticket.callRef,
        ticket.subject,
        ticket.description,
        ticket.priority,
        ticket.source,
        ticket.contactName,
        ticket.contactPhone,
        ticket.kind,
        ticket.urgency,
        JSON.stringify(ticket.intake),
        ticket.callbackDueAt,
        await existingUserId(tx, ticket.createdByUserId),
        ticket.now,
      ],
    );
    return mapTicket(rows[0]);
  },

  async addActivity(activity) {
    await tx.query(
      `INSERT INTO ticket_activity_log
         (tenant_id, ticket_id, user_id, activity_type, content, field_name, old_value, new_value, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
      [
        tenantId,
        activity.ticketId,
        await existingUserId(tx, activity.actorUserId),
        activity.type,
        activity.content ?? '',
        activity.fieldName ?? '',
        activity.oldValue ?? '',
        activity.newValue ?? '',
        JSON.stringify(activity.metadata ?? {}),
        activity.now,
      ],
    );
  },

  async enqueueOutbox(event) {
    const { rows } = await tx.query(
      `INSERT INTO ticket_outbox (tenant_id, event_type, payload, status)
       VALUES ($1, $2, $3::jsonb, 'pending')
       RETURNING id`,
      [tenantId, event.eventType, JSON.stringify(event.payload)],
    );
    return String(rows[0].id);
  },

  async get(id, opts) {
    const { rows } = await tx.query(
      `SELECT ${TICKET_COLUMNS} FROM tickets WHERE tenant_id = $1 AND id = $2${opts?.forUpdate ? ' FOR UPDATE' : ''}`,
      [tenantId, id],
    );
    return rows[0] ? mapTicket(rows[0]) : null;
  },

  async update(id, patch, now) {
    const sets: string[] = [];
    const values: unknown[] = [tenantId, id];
    const add = (sql: string, value: unknown) => {
      values.push(value);
      sets.push(`${sql} = $${values.length}`);
    };
    if (patch.status !== undefined) {
      add('status', patch.status);
      if (patch.status === 'resolved') add('resolved_at', now);
      if (patch.status === 'closed') add('closed_at', now);
      if (patch.status === 'reopened') sets.push('reopened_count = COALESCE(reopened_count, 0) + 1');
    }
    if (patch.assigneeId !== undefined) add('assignee_user_id', patch.assigneeId);
    if (patch.priority !== undefined) add('priority', patch.priority);
    if (patch.urgency !== undefined) add('urgency', patch.urgency);
    if (patch.callbackDueAt !== undefined) add('callback_due_at', patch.callbackDueAt);
    add('updated_at', now);
    const { rows } = await tx.query(
      `UPDATE tickets SET ${sets.join(', ')} WHERE tenant_id = $1 AND id = $2 RETURNING ${TICKET_COLUMNS}`,
      values,
    );
    return mapTicket(rows[0]);
  },

  async list(filter) {
    const where = ['tenant_id = $1', 'archived_at IS NULL'];
    const values: unknown[] = [tenantId];
    if (filter.kind) {
      values.push(filter.kind);
      where.push(`kind = $${values.length}`);
    }
    if (filter.status !== 'all') where.push(`status IN ${ACTIVE_STATUS_SQL}`);
    if (filter.status === 'overdue') {
      values.push(filter.now);
      where.push(`callback_due_at IS NOT NULL AND callback_due_at < $${values.length}`);
    }
    values.push(filter.limit);
    const { rows } = await tx.query(
      `SELECT ${TICKET_COLUMNS}
         FROM tickets
        WHERE ${where.join(' AND ')}
        ORDER BY callback_due_at ASC NULLS LAST, created_at DESC
        LIMIT $${values.length}`,
      values,
    );
    return rows.map(mapTicket);
  },

  async notes(ticketId, limit) {
    // Newest `limit` notes, returned oldest first.
    const { rows } = await tx.query(
      `SELECT content, created_at
         FROM ticket_activity_log
        WHERE tenant_id = $1 AND ticket_id = $2 AND activity_type = 'note'
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [tenantId, ticketId, limit],
    );
    return rows.reverse().map((row) => ({ content: String(row.content ?? ''), createdAt: asDate(row.created_at) }));
  },

  async isTenantMember(userId) {
    const { rows } = await tx.query(
      `SELECT user_id FROM user_roles WHERE user_id = $1 AND tenant_id = $2 LIMIT 1`,
      [userId, tenantId],
    );
    return rows.length > 0;
  },
});
