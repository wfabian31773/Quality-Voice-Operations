import { getPlatformPool } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';

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
  `);
  tableEnsured = true;
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

async function notifyAdmins(lead: LeadRecord, leadId: number): Promise<void> {
  const subject = lead.source === 'book_demo'
    ? `New demo request from ${lead.company || lead.name || lead.email}`
    : lead.source === 'roi_calculator'
      ? `New ROI report request from ${lead.email}`
      : `New marketing lead from ${lead.email}`;

  logger.info('Admin notification dispatched', {
    leadId,
    subject,
    source: lead.source,
    email: lead.email,
    company: lead.company,
    name: lead.name,
    payload: lead.payload,
  });

  try {
    const pool = getPlatformPool();
    await pool.query(
      `UPDATE marketing_leads SET notified = TRUE WHERE id = $1`,
      [leadId],
    );
  } catch {
    /* best-effort */
  }
}
