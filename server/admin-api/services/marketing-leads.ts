import { getPlatformPool } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';
import { postToOpsSlackWebhook, getOpsSlackWebhookUrl } from '../../../platform/messaging/SlackWebhookNotifier';
import { sendEmail } from '../../../platform/email/EmailService';
import {
  getSalesAlertSettings,
  getSalesInboxDeepLink,
  type SalesAlertSettings,
} from './sales-alert-settings';

const logger = createLogger('MARKETING_LEADS');

export type LeadSource = 'book_demo' | 'roi_calculator' | 'contact';

export interface LeadRecord {
  source: LeadSource;
  name: string | null;
  email: string;
  company: string | null;
  phone?: string | null;
  payload: Record<string, unknown>;
}

export interface BookingDetails {
  provider: 'cal.com' | 'calendly' | 'other';
  eventType?: 'created' | 'rescheduled' | 'cancelled';
  bookingId?: string | number | null;
  bookingUid?: string | null;
  startTime?: string | null;
  endTime?: string | null;
  timezone?: string | null;
  attendeeEmail?: string | null;
  attendeeName?: string | null;
  meetingUrl?: string | null;
  rescheduleUrl?: string | null;
  cancelUrl?: string | null;
  title?: string | null;
  raw?: Record<string, unknown>;
}

let tableEnsured = false;

async function ensureTable(): Promise<void> {
  if (tableEnsured) return;
  const pool = getPlatformPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketing_leads (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL,
      name TEXT,
      email TEXT NOT NULL,
      company TEXT,
      phone TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      notified BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS marketing_leads_source_created_at_idx
      ON marketing_leads (source, created_at DESC);
    CREATE INDEX IF NOT EXISTS marketing_leads_email_lower_idx
      ON marketing_leads (LOWER(email));
    ALTER TABLE marketing_leads
      ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'new',
      ADD COLUMN IF NOT EXISTS status_notes TEXT,
      ADD COLUMN IF NOT EXISTS status_updated_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS status_updated_by TEXT;
    CREATE INDEX IF NOT EXISTS marketing_leads_status_idx
      ON marketing_leads (status, created_at DESC);
    CREATE TABLE IF NOT EXISTS marketing_lead_events (
      id BIGSERIAL PRIMARY KEY,
      lead_id BIGINT NOT NULL REFERENCES marketing_leads(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL CHECK (event_type IN ('created', 'status_change', 'note')),
      previous_status TEXT,
      new_status TEXT,
      notes TEXT,
      author TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS marketing_lead_events_lead_id_created_at_idx
      ON marketing_lead_events (lead_id, created_at DESC);
  `);
  tableEnsured = true;
}

export type LeadEventType = 'created' | 'status_change' | 'note';

export interface LeadEvent {
  id: number;
  lead_id: number;
  event_type: LeadEventType;
  previous_status: LeadStatus | null;
  new_status: LeadStatus | null;
  notes: string | null;
  author: string | null;
  created_at: string;
}

async function recordLeadEvent(
  leadId: number,
  event: {
    eventType: LeadEventType;
    previousStatus?: LeadStatus | null;
    newStatus?: LeadStatus | null;
    notes?: string | null;
    author?: string | null;
  },
): Promise<void> {
  try {
    const pool = getPlatformPool();
    await pool.query(
      `INSERT INTO marketing_lead_events
         (lead_id, event_type, previous_status, new_status, notes, author)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        leadId,
        event.eventType,
        event.previousStatus ?? null,
        event.newStatus ?? null,
        event.notes ?? null,
        event.author ?? null,
      ],
    );
  } catch (err) {
    logger.warn('Failed to record lead event', {
      leadId,
      eventType: event.eventType,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Returns the distinct, non-empty authors recorded against marketing lead
 * events, sorted alphabetically. Powers the "Acted on by" dropdown in the
 * Sales Inbox so reps can pick from the list of teammates who have actually
 * touched a lead. Excludes auto-generated rows (e.g. the inbound-email
 * "created" events whose author is the lead's own email).
 */
export async function listLeadEventAuthors(): Promise<string[]> {
  await ensureTable();
  const pool = getPlatformPool();
  const result = await pool.query<{ author: string }>(
    `SELECT DISTINCT author
       FROM marketing_lead_events
      WHERE author IS NOT NULL
        AND TRIM(author) <> ''
        AND event_type <> 'created'
      ORDER BY author ASC`,
  );
  return result.rows.map((r) => r.author);
}

export async function listLeadEvents(leadId: number): Promise<LeadEvent[]> {
  await ensureTable();
  const pool = getPlatformPool();
  const result = await pool.query(
    `SELECT id, lead_id, event_type, previous_status, new_status, notes, author, created_at
       FROM marketing_lead_events
      WHERE lead_id = $1
      ORDER BY created_at ASC, id ASC`,
    [leadId],
  );
  return result.rows.map((r): LeadEvent => ({
    id: Number(r.id),
    lead_id: Number(r.lead_id),
    event_type: r.event_type as LeadEventType,
    previous_status: (r.previous_status as LeadStatus | null) ?? null,
    new_status: (r.new_status as LeadStatus | null) ?? null,
    notes: r.notes ?? null,
    author: r.author ?? null,
    created_at: new Date(r.created_at).toISOString(),
  }));
}

export type LeadStatus = 'new' | 'contacted' | 'closed';
export type BookingStatusFilter = 'all' | 'booked' | 'no_booking' | 'cancelled';

export interface LeadListFilters {
  source?: LeadSource | 'all';
  status?: LeadStatus | 'all';
  bookingStatus?: BookingStatusFilter;
  q?: string;
  /**
   * Filter to leads that have at least one event in `marketing_lead_events`
   * whose `author` matches (case-insensitive substring).  Allows reps to
   * narrow the inbox to "leads I touched" or "leads Alice touched".
   */
  actedOnBy?: string;
  /**
   * Filter to leads with no events recorded in the last N days. Useful for
   * surfacing stale leads that need a follow-up.
   */
  inactiveForDays?: number;
  limit?: number;
  offset?: number;
}

export interface LeadListItem {
  id: number;
  source: LeadSource;
  name: string | null;
  email: string;
  company: string | null;
  phone: string | null;
  payload: Record<string, unknown>;
  notified: boolean;
  status: LeadStatus;
  status_notes: string | null;
  status_updated_at: string | null;
  status_updated_by: string | null;
  created_at: string;
}

export interface LeadListResult {
  leads: LeadListItem[];
  total: number;
  counts: {
    by_status: Record<LeadStatus, number>;
    by_source: Record<LeadSource, number>;
    by_booking: Record<'booked' | 'cancelled' | 'no_booking', number>;
    total: number;
  };
}

function buildLeadWhereClause(filters: LeadListFilters): { where: string; values: unknown[] } {
  const conditions: string[] = [];
  const values: unknown[] = [];

  if (filters.source && filters.source !== 'all') {
    values.push(filters.source);
    conditions.push(`source = $${values.length}`);
  }
  if (filters.status && filters.status !== 'all') {
    values.push(filters.status);
    conditions.push(`status = $${values.length}`);
  }
  if (filters.bookingStatus && filters.bookingStatus !== 'all') {
    if (filters.bookingStatus === 'booked') {
      conditions.push(
        `(payload ? 'booking') AND COALESCE(payload->'booking'->>'eventType','created') IN ('created','rescheduled')`,
      );
    } else if (filters.bookingStatus === 'cancelled') {
      conditions.push(
        `(payload ? 'booking') AND payload->'booking'->>'eventType' = 'cancelled'`,
      );
    } else if (filters.bookingStatus === 'no_booking') {
      conditions.push(`NOT (payload ? 'booking')`);
    }
  }
  if (filters.q && filters.q.trim()) {
    const term = `%${filters.q.trim()}%`;
    values.push(term);
    const idx = values.length;
    conditions.push(`(LOWER(email) LIKE LOWER($${idx}) OR LOWER(COALESCE(name,'')) LIKE LOWER($${idx}) OR LOWER(COALESCE(company,'')) LIKE LOWER($${idx}))`);
  }
  if (filters.actedOnBy && filters.actedOnBy.trim()) {
    const term = `%${filters.actedOnBy.trim()}%`;
    values.push(term);
    const idx = values.length;
    conditions.push(
      `EXISTS (
        SELECT 1 FROM marketing_lead_events e
        WHERE e.lead_id = marketing_leads.id
          AND e.author IS NOT NULL
          AND LOWER(e.author) LIKE LOWER($${idx})
      )`,
    );
  }
  if (
    typeof filters.inactiveForDays === 'number' &&
    Number.isFinite(filters.inactiveForDays) &&
    filters.inactiveForDays > 0
  ) {
    values.push(filters.inactiveForDays);
    const idx = values.length;
    // Lead is "inactive" when *no* event row exists in the last N days. Leads
    // with no events at all (e.g. legacy rows from before event tracking) also
    // qualify, which is the desired behaviour.
    conditions.push(
      `NOT EXISTS (
        SELECT 1 FROM marketing_lead_events e
        WHERE e.lead_id = marketing_leads.id
          AND e.created_at > NOW() - make_interval(days => $${idx}::int)
      )`,
    );
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    values,
  };
}

function mapLeadRow(r: Record<string, unknown>): LeadListItem {
  return {
    id: Number(r.id),
    source: r.source as LeadSource,
    name: (r.name as string | null) ?? null,
    email: r.email as string,
    company: (r.company as string | null) ?? null,
    phone: (r.phone as string | null) ?? null,
    payload: (r.payload as Record<string, unknown>) ?? {},
    notified: Boolean(r.notified),
    status: ((r.status as LeadStatus) ?? 'new'),
    status_notes: (r.status_notes as string | null) ?? null,
    status_updated_at: r.status_updated_at ? new Date(r.status_updated_at as string).toISOString() : null,
    status_updated_by: (r.status_updated_by as string | null) ?? null,
    created_at: new Date(r.created_at as string).toISOString(),
  };
}

export async function listLeads(filters: LeadListFilters = {}): Promise<LeadListResult> {
  await ensureTable();
  const pool = getPlatformPool();

  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
  const offset = Math.max(filters.offset ?? 0, 0);

  const { where, values } = buildLeadWhereClause(filters);

  const listQuery = `
    SELECT id, source, name, email, company, phone, payload, notified,
           status, status_notes, status_updated_at, status_updated_by, created_at
    FROM marketing_leads
    ${where}
    ORDER BY created_at DESC
    LIMIT $${values.length + 1} OFFSET $${values.length + 2}
  `;
  const countQuery = `SELECT COUNT(*)::int AS total FROM marketing_leads ${where}`;

  const [listRes, countRes, summaryRes] = await Promise.all([
    pool.query(listQuery, [...values, limit, offset]),
    pool.query(countQuery, values),
    pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'new')::int AS status_new,
        COUNT(*) FILTER (WHERE status = 'contacted')::int AS status_contacted,
        COUNT(*) FILTER (WHERE status = 'closed')::int AS status_closed,
        COUNT(*) FILTER (WHERE source = 'book_demo')::int AS source_book_demo,
        COUNT(*) FILTER (WHERE source = 'roi_calculator')::int AS source_roi_calculator,
        COUNT(*) FILTER (WHERE source = 'contact')::int AS source_contact,
        COUNT(*) FILTER (
          WHERE (payload ? 'booking')
            AND COALESCE(payload->'booking'->>'eventType','created') IN ('created','rescheduled')
        )::int AS booked,
        COUNT(*) FILTER (
          WHERE (payload ? 'booking')
            AND payload->'booking'->>'eventType' = 'cancelled'
        )::int AS cancelled,
        COUNT(*) FILTER (WHERE NOT (payload ? 'booking'))::int AS no_booking
      FROM marketing_leads
    `),
  ]);

  const leads = listRes.rows.map(mapLeadRow);

  const summary = summaryRes.rows[0] ?? {};
  return {
    leads,
    total: countRes.rows[0]?.total ?? 0,
    counts: {
      by_status: {
        new: summary.status_new ?? 0,
        contacted: summary.status_contacted ?? 0,
        closed: summary.status_closed ?? 0,
      },
      by_source: {
        book_demo: summary.source_book_demo ?? 0,
        roi_calculator: summary.source_roi_calculator ?? 0,
        contact: summary.source_contact ?? 0,
      },
      by_booking: {
        booked: summary.booked ?? 0,
        cancelled: summary.cancelled ?? 0,
        no_booking: summary.no_booking ?? 0,
      },
      total: summary.total ?? 0,
    },
  };
}

export type LeadExportFilters = Pick<
  LeadListFilters,
  'source' | 'status' | 'bookingStatus' | 'q' | 'actedOnBy' | 'inactiveForDays'
>;

export async function* iterateLeadsForExport(
  filters: LeadExportFilters = {},
  batchSize = 500,
): AsyncGenerator<LeadListItem> {
  await ensureTable();
  const pool = getPlatformPool();
  const { where, values } = buildLeadWhereClause(filters);
  const safeBatch = Math.min(Math.max(batchSize, 50), 1000);

  let offset = 0;
  // Stream rows in batches so very large result sets do not load entirely into memory.
  for (;;) {
    const result = await pool.query(
      `
        SELECT id, source, name, email, company, phone, payload, notified,
               status, status_notes, status_updated_at, status_updated_by, created_at
        FROM marketing_leads
        ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}
      `,
      [...values, safeBatch, offset],
    );
    if (result.rows.length === 0) return;
    for (const row of result.rows) {
      yield mapLeadRow(row);
    }
    if (result.rows.length < safeBatch) return;
    offset += result.rows.length;
  }
}

export async function updateLeadStatus(
  leadId: number,
  status: LeadStatus,
  options: { notes?: string | null; updatedBy?: string | null } = {},
): Promise<LeadListItem | null> {
  await ensureTable();
  const pool = getPlatformPool();

  // Capture the previous status so we can record an event row that reflects
  // exactly what changed (status flip vs. note-only update).
  const beforeRes = await pool.query<{ status: string; status_notes: string | null }>(
    `SELECT status, status_notes FROM marketing_leads WHERE id = $1`,
    [leadId],
  );
  if (beforeRes.rowCount === 0) return null;
  const previousStatus = (beforeRes.rows[0].status as LeadStatus) ?? 'new';
  const previousNotes = beforeRes.rows[0].status_notes ?? null;

  const result = await pool.query(
    `UPDATE marketing_leads
        SET status = $1,
            status_notes = COALESCE($2, status_notes),
            status_updated_at = NOW(),
            status_updated_by = $3
      WHERE id = $4
      RETURNING id, source, name, email, company, phone, payload, notified,
                status, status_notes, status_updated_at, status_updated_by, created_at`,
    [status, options.notes ?? null, options.updatedBy ?? null, leadId],
  );
  const row = result.rows[0];
  if (!row) return null;

  const newNotes = (row.status_notes as string | null) ?? null;
  const noteChanged = (options.notes ?? null) !== null && newNotes !== previousNotes;
  const statusChanged = previousStatus !== (row.status as LeadStatus);

  if (statusChanged) {
    await recordLeadEvent(leadId, {
      eventType: 'status_change',
      previousStatus,
      newStatus: row.status as LeadStatus,
      notes: noteChanged ? newNotes : null,
      author: options.updatedBy ?? null,
    });
  } else if (noteChanged) {
    await recordLeadEvent(leadId, {
      eventType: 'note',
      previousStatus,
      newStatus: row.status as LeadStatus,
      notes: newNotes,
      author: options.updatedBy ?? null,
    });
  }
  return {
    id: Number(row.id),
    source: row.source as LeadSource,
    name: row.name,
    email: row.email,
    company: row.company,
    phone: row.phone,
    payload: row.payload ?? {},
    notified: Boolean(row.notified),
    status: row.status as LeadStatus,
    status_notes: row.status_notes,
    status_updated_at: row.status_updated_at ? new Date(row.status_updated_at).toISOString() : null,
    status_updated_by: row.status_updated_by,
    created_at: new Date(row.created_at).toISOString(),
  };
}

export async function recordLead(lead: LeadRecord): Promise<{ id: number | null }> {
  try {
    await ensureTable();
    const pool = getPlatformPool();
    const result = await pool.query<{ id: string }>(
      `INSERT INTO marketing_leads (source, name, email, company, phone, payload)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id`,
      [lead.source, lead.name, lead.email, lead.company, lead.phone ?? null, JSON.stringify(lead.payload)],
    );
    const id = Number(result.rows[0]?.id ?? 0);
    logger.info('Marketing lead persisted', { source: lead.source, leadId: id, email: lead.email });
    if (id) {
      await recordLeadEvent(id, {
        eventType: 'created',
        newStatus: 'new',
        author: lead.email,
      });
    }
    notifyAdmins(lead, id).catch((err) => {
      logger.warn('Admin notification dispatch failed', { error: err instanceof Error ? err.message : String(err) });
    });
    return { id };
  } catch (err) {
    logger.error('Failed to persist marketing lead — falling back to log only', {
      error: err instanceof Error ? err.message : String(err),
      source: lead.source,
      email: lead.email,
    });
    return { id: null };
  }
}

export async function findLeadById(
  leadId: number,
): Promise<{ id: number; email: string; payload: Record<string, unknown>; name: string | null; company: string | null; notified: boolean } | null> {
  try {
    await ensureTable();
    const pool = getPlatformPool();
    const result = await pool.query<{
      id: string;
      email: string;
      payload: Record<string, unknown>;
      name: string | null;
      company: string | null;
      notified: boolean;
    }>(
      `SELECT id, email, payload, name, company, notified FROM marketing_leads WHERE id = $1 LIMIT 1`,
      [leadId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      email: row.email,
      payload: row.payload ?? {},
      name: row.name,
      company: row.company,
      notified: Boolean(row.notified),
    };
  } catch (err) {
    logger.warn('findLeadById failed', { error: err instanceof Error ? err.message : String(err), leadId });
    return null;
  }
}

function isDuplicateBooking(history: unknown[], booking: BookingDetails): boolean {
  if (!booking.bookingUid && !booking.bookingId) return false;
  for (const entry of history) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    if (e.eventType !== booking.eventType) continue;
    const sameUid = booking.bookingUid && e.bookingUid && e.bookingUid === booking.bookingUid;
    const sameId =
      booking.bookingId != null &&
      e.bookingId != null &&
      String(e.bookingId) === String(booking.bookingId);
    if (sameUid || sameId) return true;
  }
  return false;
}

export async function attachBookingToLeadById(
  leadId: number,
  booking: BookingDetails,
): Promise<{ leadId: number | null; duplicate: boolean }> {
  try {
    await ensureTable();
    const existing = await findLeadById(leadId);
    if (!existing) {
      logger.warn('attachBookingToLeadById: lead not found', { leadId });
      return { leadId: null, duplicate: false };
    }
    const pool = getPlatformPool();
    const bookingPayload = { ...booking, recordedAt: new Date().toISOString() };
    const history = Array.isArray((existing.payload as { bookingHistory?: unknown[] }).bookingHistory)
      ? ((existing.payload as { bookingHistory?: unknown[] }).bookingHistory as unknown[])
      : [];

    if (isDuplicateBooking(history, booking)) {
      logger.info('Duplicate Cal.com webhook ignored (already recorded)', {
        leadId: existing.id,
        eventType: booking.eventType,
        bookingUid: booking.bookingUid,
        bookingId: booking.bookingId,
      });
      return { leadId: existing.id, duplicate: true };
    }

    const nextPayload = {
      ...existing.payload,
      booking: bookingPayload,
      bookingHistory: [...history, bookingPayload].slice(-10),
    };
    await pool.query(
      `UPDATE marketing_leads SET payload = $1::jsonb WHERE id = $2`,
      [JSON.stringify(nextPayload), existing.id],
    );
    logger.info('Booking attached to lead by id', {
      leadId: existing.id,
      eventType: booking.eventType,
      bookingId: booking.bookingId,
    });
    return { leadId: existing.id, duplicate: false };
  } catch (err) {
    logger.error('attachBookingToLeadById failed', {
      error: err instanceof Error ? err.message : String(err),
      leadId,
    });
    return { leadId: null, duplicate: false };
  }
}

export async function findLatestLeadByEmail(
  email: string,
  source?: LeadSource,
): Promise<{ id: number; payload: Record<string, unknown>; name: string | null; company: string | null } | null> {
  try {
    await ensureTable();
    const pool = getPlatformPool();
    const result = source
      ? await pool.query<{ id: string; payload: Record<string, unknown>; name: string | null; company: string | null }>(
          `SELECT id, payload, name, company FROM marketing_leads
           WHERE LOWER(email) = LOWER($1) AND source = $2
           ORDER BY created_at DESC LIMIT 1`,
          [email, source],
        )
      : await pool.query<{ id: string; payload: Record<string, unknown>; name: string | null; company: string | null }>(
          `SELECT id, payload, name, company FROM marketing_leads
           WHERE LOWER(email) = LOWER($1)
           ORDER BY created_at DESC LIMIT 1`,
          [email],
        );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: Number(row.id),
      payload: row.payload ?? {},
      name: row.name,
      company: row.company,
    };
  } catch (err) {
    logger.warn('findLatestLeadByEmail failed', { error: err instanceof Error ? err.message : String(err), email });
    return null;
  }
}

export async function attachBookingToLead(
  email: string,
  booking: BookingDetails,
): Promise<{ leadId: number | null; duplicate: boolean }> {
  try {
    await ensureTable();
    const existing = await findLatestLeadByEmail(email, 'book_demo');
    const pool = getPlatformPool();

    const bookingPayload = {
      ...booking,
      recordedAt: new Date().toISOString(),
    };

    if (existing) {
      const history = Array.isArray((existing.payload as { bookingHistory?: unknown[] }).bookingHistory)
        ? ((existing.payload as { bookingHistory?: unknown[] }).bookingHistory as unknown[])
        : [];

      if (isDuplicateBooking(history, booking)) {
        logger.info('Duplicate Cal.com webhook ignored (already recorded)', {
          leadId: existing.id,
          email,
          eventType: booking.eventType,
          bookingUid: booking.bookingUid,
          bookingId: booking.bookingId,
        });
        return { leadId: existing.id, duplicate: true };
      }

      const nextPayload = {
        ...existing.payload,
        booking: bookingPayload,
        bookingHistory: [...history, bookingPayload].slice(-10),
      };
      await pool.query(
        `UPDATE marketing_leads SET payload = $1::jsonb WHERE id = $2`,
        [JSON.stringify(nextPayload), existing.id],
      );
      logger.info('Booking attached to existing lead', {
        leadId: existing.id,
        email,
        eventType: booking.eventType,
        bookingId: booking.bookingId,
      });
      return { leadId: existing.id, duplicate: false };
    }

    // No prior lead row — create one so the booking is not orphaned
    const insertResult = await pool.query<{ id: string }>(
      `INSERT INTO marketing_leads (source, name, email, company, payload)
       VALUES ('book_demo', $1, $2, NULL, $3::jsonb)
       RETURNING id`,
      [
        booking.attendeeName ?? null,
        email,
        JSON.stringify({ booking: bookingPayload, bookingHistory: [bookingPayload], origin: 'webhook_only' }),
      ],
    );
    const newId = Number(insertResult.rows[0]?.id ?? 0);
    logger.info('Booking created new lead row (no prior submission found)', { leadId: newId, email });
    if (newId) {
      await recordLeadEvent(newId, {
        eventType: 'created',
        newStatus: 'new',
        author: email,
        notes: 'Lead auto-created from Cal.com booking webhook',
      });
    }
    return { leadId: newId, duplicate: false };
  } catch (err) {
    logger.error('Failed to attach booking to lead', {
      error: err instanceof Error ? err.message : String(err),
      email,
    });
    return { leadId: null, duplicate: false };
  }
}

function formatLeadHtml(lead: LeadRecord, leadId: number, deepLink: string): string {
  const payload = lead.payload as Record<string, unknown>;
  const rows: Array<[string, string]> = [
    ['Source', lead.source],
    ['Lead ID', String(leadId)],
    ['Name', lead.name ?? '(not provided)'],
    ['Email', lead.email],
    ['Company', lead.company ?? '(not provided)'],
    ['Phone', lead.phone ?? '(not provided)'],
  ];
  if (typeof payload.teamSize === 'string') rows.push(['Team size', payload.teamSize]);
  if (typeof payload.preferredTime === 'string') rows.push(['Preferred time', payload.preferredTime]);
  if (typeof payload.useCase === 'string' && payload.useCase) rows.push(['Use case', payload.useCase]);
  if (typeof payload.message === 'string' && payload.message) rows.push(['Message', payload.message]);

  const tableRows = rows
    .map(
      ([k, v]) =>
        `<tr><td style="padding:6px 12px;font-weight:600;color:#475569;">${k}</td><td style="padding:6px 12px;color:#0f172a;">${escapeHtml(v)}</td></tr>`,
    )
    .join('');

  return `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;">
      <h2 style="color:#0f172a;margin:0 0 12px;">New ${lead.source.replace('_', ' ')} lead</h2>
      <p style="color:#475569;margin:0 0 16px;">A new prospect just submitted the ${lead.source === 'book_demo' ? 'Book a Demo' : lead.source === 'roi_calculator' ? 'ROI Calculator' : 'Contact'} form.</p>
      <table style="border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">${tableRows}</table>
      <p style="margin:16px 0 0;"><a href="${escapeHtml(deepLink)}" style="display:inline-block;background:#7c3aed;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;font-weight:600;">Open in Sales Inbox →</a></p>
    </div>
  `;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Resolve the email recipient list. Settings.emailRecipients (when populated by
 * an admin in the Sales Inbox UI) wins; otherwise we fall back to the legacy
 * env var so existing deployments keep working without touching the DB.
 */
function resolveEmailRecipients(settings: SalesAlertSettings): string[] {
  if (settings.emailRecipients.length > 0) return settings.emailRecipients;
  const fallback = (process.env.SALES_NOTIFICATION_EMAIL ?? process.env.SALES_EMAIL ?? '').trim();
  if (!fallback) return [];
  return fallback
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function resolveSlackUrl(settings: SalesAlertSettings): string | null {
  return settings.slackWebhookUrl || getOpsSlackWebhookUrl();
}

async function markLeadNotified(leadId: number): Promise<void> {
  try {
    const pool = getPlatformPool();
    await pool.query(`UPDATE marketing_leads SET notified = TRUE WHERE id = $1`, [leadId]);
  } catch (err) {
    logger.warn('Failed to mark lead as notified', {
      leadId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function isLeadAlreadyNotified(leadId: number): Promise<boolean> {
  try {
    const pool = getPlatformPool();
    const { rows } = await pool.query<{ notified: boolean }>(
      `SELECT notified FROM marketing_leads WHERE id = $1 LIMIT 1`,
      [leadId],
    );
    return Boolean(rows[0]?.notified);
  } catch {
    return false;
  }
}

interface DispatchResult {
  emailSent: boolean;
  slackSent: boolean;
  attempted: boolean;
}

export type AlertChannelStatus = 'sent' | 'skipped' | 'failed';

export interface AlertSendResult {
  email: AlertChannelStatus;
  slack: AlertChannelStatus;
  emailError?: string;
  slackError?: string;
}

export interface AlertMessageOptions {
  subject: string;
  slackText: string;
  html: string;
  plainText: string;
  replyTo?: string;
  leadId?: number | null;
}

/**
 * Core sales-alert delivery primitive. Reads enabled channels and recipient
 * config from `settings`, then attempts to send the supplied message and
 * reports per-channel status so callers can surface results in the UI (test
 * alerts) or in dispatch logs (real alerts).
 *
 *   - 'sent'    → channel attempted and at least one recipient/webhook accepted
 *   - 'skipped' → channel disabled OR no recipient/webhook configured
 *   - 'failed'  → channel attempted but every recipient/webhook rejected it
 */
export async function sendAlertMessage(
  settings: SalesAlertSettings,
  opts: AlertMessageOptions,
): Promise<AlertSendResult> {
  const result: AlertSendResult = { email: 'skipped', slack: 'skipped' };

  if (settings.channels.slack) {
    const slackUrl = resolveSlackUrl(settings);
    if (!slackUrl) {
      logger.debug('Sales-alert Slack skipped — no webhook configured', { leadId: opts.leadId });
    } else if (settings.slackWebhookUrl) {
      // Custom override URL — POST directly so admins can verify their own webhook.
      try {
        const res = await fetch(settings.slackWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: opts.slackText }),
        });
        if (res.ok) {
          result.slack = 'sent';
        } else {
          result.slack = 'failed';
          result.slackError = `Slack webhook returned HTTP ${res.status}`;
          logger.warn('Sales-alert Slack webhook returned non-2xx', {
            leadId: opts.leadId,
            status: res.status,
          });
        }
      } catch (err) {
        result.slack = 'failed';
        result.slackError = err instanceof Error ? err.message : String(err);
        logger.warn('Sales-alert Slack webhook request failed', {
          leadId: opts.leadId,
          error: result.slackError,
        });
      }
    } else {
      const r = await postToOpsSlackWebhook({ text: opts.slackText });
      if (r.success) {
        result.slack = 'sent';
      } else if (r.skipped) {
        // Env-driven webhook not configured — treat as skipped, not failure.
        result.slack = 'skipped';
      } else {
        result.slack = 'failed';
        result.slackError = r.error;
        logger.warn('Sales-alert Slack notification failed', {
          leadId: opts.leadId,
          error: r.error,
        });
      }
    }
  }

  if (settings.channels.email) {
    const recipients = resolveEmailRecipients(settings);
    if (recipients.length === 0) {
      logger.debug('Sales-alert email skipped — no recipients configured', { leadId: opts.leadId });
    } else {
      const errors: string[] = [];
      let anySent = false;
      // Send each recipient individually so a single bad address does not poison
      // the whole alert. Mark the alert "sent" if any recipient succeeds.
      for (const to of recipients) {
        const r = await sendEmail({
          to,
          subject: opts.subject,
          html: opts.html,
          text: opts.plainText,
          replyTo: opts.replyTo,
        });
        if (r.success) {
          anySent = true;
        } else {
          errors.push(`${to}: ${r.error ?? 'unknown error'}`);
          logger.warn('Sales-alert email failed for recipient', {
            leadId: opts.leadId,
            recipient: to,
            error: r.error,
          });
        }
      }
      if (anySent) {
        result.email = 'sent';
        if (errors.length) result.emailError = errors.join('; ');
      } else {
        result.email = 'failed';
        result.emailError = errors.join('; ') || 'No recipients accepted the message';
      }
    }
  }

  return result;
}

async function dispatchAlert(
  settings: SalesAlertSettings,
  opts: {
    subject: string;
    slackText: string;
    html: string;
    plainText: string;
    replyTo?: string;
    leadId: number | null;
  },
): Promise<DispatchResult> {
  const r = await sendAlertMessage(settings, opts);
  return {
    emailSent: r.email === 'sent',
    slackSent: r.slack === 'sent',
    attempted: r.email !== 'skipped' || r.slack !== 'skipped',
  };
}

async function notifyAdmins(lead: LeadRecord, leadId: number): Promise<void> {
  const settings = await getSalesAlertSettings();
  if (!settings.notifyOnNewLead) {
    logger.debug('New-lead alerts disabled by admin settings — skipping', { leadId });
    return;
  }

  // Idempotency: each lead row is alerted at most once. If the booking webhook
  // arrived first and already flagged it, we will not double-send here.
  const alreadyNotified = await isLeadAlreadyNotified(leadId);
  if (alreadyNotified) {
    logger.debug('Lead already marked notified — skipping new-lead alert', { leadId });
    return;
  }

  const headline = lead.source === 'book_demo'
    ? `New demo request from ${lead.company || lead.name || lead.email}`
    : lead.source === 'roi_calculator'
      ? `New ROI report request from ${lead.email}`
      : `New marketing lead from ${lead.email}`;

  const deepLink = getSalesInboxDeepLink(leadId);
  const payload = lead.payload as Record<string, unknown>;
  const detailLines = [
    `*${headline}*`,
    `• Email: ${lead.email}`,
    lead.name ? `• Name: ${lead.name}` : null,
    lead.company ? `• Company: ${lead.company}` : null,
    lead.phone ? `• Phone: ${lead.phone}` : null,
    typeof payload.teamSize === 'string' ? `• Team size: ${payload.teamSize}` : null,
    typeof payload.preferredTime === 'string' ? `• Preferred time: ${payload.preferredTime}` : null,
    typeof payload.useCase === 'string' && payload.useCase ? `• Use case: ${payload.useCase}` : null,
    typeof payload.message === 'string' && payload.message ? `• Message: ${payload.message}` : null,
    `• Source: ${lead.source}`,
    `• Lead ID: ${leadId}`,
    `• Open in Sales Inbox: ${deepLink}`,
  ].filter(Boolean) as string[];

  const dispatched = await dispatchAlert(settings, {
    subject: headline,
    slackText: detailLines.join('\n'),
    html: formatLeadHtml(lead, leadId, deepLink),
    plainText: detailLines.join('\n').replace(/\*/g, ''),
    replyTo: lead.email,
    leadId,
  });

  logger.info('Sales-alert dispatch result for new lead', {
    leadId,
    source: lead.source,
    email: lead.email,
    emailSent: dispatched.emailSent,
    slackSent: dispatched.slackSent,
    attempted: dispatched.attempted,
  });

  // Only mark the lead as notified after at least one channel succeeded so a
  // transient SMTP/Slack outage does not silently drop the alert forever.
  if (dispatched.emailSent || dispatched.slackSent) {
    await markLeadNotified(leadId);
  }
}

export async function notifyBookingConfirmed(
  email: string,
  booking: BookingDetails,
  leadInfo: { leadId: number | null; name: string | null; company: string | null },
): Promise<void> {
  const settings = await getSalesAlertSettings();
  const eventType = booking.eventType ?? 'created';

  // Per-event admin toggles. The "created" event is the high-intent moment we
  // want to alert on by default; reschedule/cancel events are status updates.
  const eventEnabled =
    eventType === 'cancelled'
      ? settings.notifyOnBookingCancelled
      : eventType === 'rescheduled'
        ? settings.notifyOnBookingRescheduled
        : settings.notifyOnBookingCreated;
  if (!eventEnabled) {
    logger.debug('Booking alert suppressed by admin settings', {
      leadId: leadInfo.leadId,
      eventType,
    });
    return;
  }

  // The `notified` column tracks "was this lead alerted at least once" — only
  // applied to the first-touch (booking created) signal. Reschedule/cancel
  // events still go through so sales sees the lifecycle update.
  if (eventType === 'created' && leadInfo.leadId) {
    const already = await isLeadAlreadyNotified(leadInfo.leadId);
    if (already) {
      logger.debug('Lead already marked notified — skipping booking-created alert', {
        leadId: leadInfo.leadId,
      });
      return;
    }
  }

  const eventLabel =
    eventType === 'cancelled'
      ? 'Demo cancelled'
      : eventType === 'rescheduled'
        ? 'Demo rescheduled'
        : 'Demo booked';

  const who = leadInfo.company || leadInfo.name || booking.attendeeName || email;
  const subject = `${eventLabel}: ${who}`;

  const startLabel = booking.startTime
    ? `${booking.startTime}${booking.timezone ? ` (${booking.timezone})` : ''}`
    : '(time not provided)';

  const deepLink = getSalesInboxDeepLink(leadInfo.leadId);

  const lines = [
    `*${subject}*`,
    `• Attendee: ${booking.attendeeName ?? leadInfo.name ?? '(unknown)'} <${email}>`,
    leadInfo.company ? `• Company: ${leadInfo.company}` : null,
    `• Source: book_demo`,
    `• When: ${startLabel}`,
    booking.endTime ? `• Until: ${booking.endTime}` : null,
    booking.meetingUrl ? `• Meeting link: ${booking.meetingUrl}` : null,
    booking.rescheduleUrl ? `• Reschedule: ${booking.rescheduleUrl}` : null,
    booking.cancelUrl ? `• Cancel: ${booking.cancelUrl}` : null,
    leadInfo.leadId ? `• Lead ID: ${leadInfo.leadId}` : null,
    `• Provider: ${booking.provider}`,
    `• Open in Sales Inbox: ${deepLink}`,
  ].filter(Boolean) as string[];

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;">
      <h2 style="color:#0f172a;margin:0 0 12px;">${escapeHtml(subject)}</h2>
      <p style="color:#475569;margin:0 0 16px;">A prospect just self-scheduled through the Book a Demo flow.</p>
      <table style="border-collapse:collapse;border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
        ${lines
          .slice(1)
          .filter((l) => !l.startsWith('• Open in Sales Inbox:'))
          .map(
            (l) =>
              `<tr><td style="padding:6px 12px;color:#0f172a;">${escapeHtml(l.replace(/^•\s*/, ''))}</td></tr>`,
          )
          .join('')}
      </table>
      <p style="margin:16px 0 0;"><a href="${escapeHtml(deepLink)}" style="display:inline-block;background:#7c3aed;color:#fff;padding:8px 16px;border-radius:6px;text-decoration:none;font-weight:600;">Open in Sales Inbox →</a></p>
    </div>
  `;

  const dispatched = await dispatchAlert(settings, {
    subject,
    slackText: lines.join('\n'),
    html,
    plainText: lines.join('\n').replace(/\*/g, ''),
    replyTo: email,
    leadId: leadInfo.leadId,
  });

  logger.info('Sales-alert dispatch result for booking', {
    leadId: leadInfo.leadId,
    email,
    eventType,
    startTime: booking.startTime,
    emailSent: dispatched.emailSent,
    slackSent: dispatched.slackSent,
    attempted: dispatched.attempted,
  });

  // Only flip `notified` for the booking-created event; reschedule/cancel are
  // status updates and shouldn't permanently lock out future booking-created
  // alerts (e.g. if the lead booked, cancelled, then booked again).
  if (
    eventType === 'created' &&
    leadInfo.leadId &&
    (dispatched.emailSent || dispatched.slackSent)
  ) {
    await markLeadNotified(leadInfo.leadId);
  }
}
