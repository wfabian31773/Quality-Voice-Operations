import { randomUUID } from 'crypto';
import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import { redactPHI } from '../core/phi/redact';

const logger = createLogger('DNC_SERVICE');

interface DbClient {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

async function withTenant<T>(tenantId: string, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const result = await fn(client as unknown as DbClient);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export interface DncEntry {
  id: string;
  tenantId: string;
  phoneNumber: string;
  reason: string | null;
  source: string;
  createdAt: Date;
}

export async function addToDnc(
  tenantId: string,
  phoneNumber: string,
  source: 'sms' | 'voice' | 'manual',
  reason?: string,
): Promise<boolean> {
  return withTenant(tenantId, async (client) => {
    const { rowCount } = await client.query(
      `INSERT INTO dnc_list (id, tenant_id, phone_number, reason, source)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, phone_number) DO NOTHING`,
      [randomUUID(), tenantId, phoneNumber, reason ?? null, source],
    );
    const added = (rowCount ?? 0) > 0;
    if (added) {
      logger.info('Number added to DNC list', {
        tenantId,
        phone: redactPHI(phoneNumber),
        source,
        reason: reason ?? 'none',
      });
    }
    return added;
  });
}

export async function isOnDnc(tenantId: string, phoneNumber: string): Promise<boolean> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT 1 FROM dnc_list WHERE tenant_id = $1 AND phone_number = $2 LIMIT 1`,
      [tenantId, phoneNumber],
    );
    return rows.length > 0;
  });
}

export async function listDnc(
  tenantId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ entries: DncEntry[]; total: number }> {
  const { limit = 50, offset = 0 } = opts;
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM dnc_list WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [tenantId, limit, offset],
    );
    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS total FROM dnc_list WHERE tenant_id = $1`,
      [tenantId],
    );
    return {
      entries: rows.map((r) => ({
        id: r.id as string,
        tenantId: r.tenant_id as string,
        phoneNumber: r.phone_number as string,
        reason: r.reason as string | null,
        source: r.source as string,
        createdAt: new Date(r.created_at as string),
      })),
      total: (countRows[0]?.total as number) ?? 0,
    };
  });
}

export async function removeFromDnc(tenantId: string, phoneNumber: string): Promise<boolean> {
  return withTenant(tenantId, async (client) => {
    const { rowCount } = await client.query(
      `DELETE FROM dnc_list WHERE tenant_id = $1 AND phone_number = $2`,
      [tenantId, phoneNumber],
    );
    return (rowCount ?? 0) > 0;
  });
}

const OPT_OUT_PHRASES = [
  'remove me',
  'take me off',
  "don't call me",
  'dont call me',
  'stop calling',
  'do not call',
  'opt out',
  'opt-out',
  'unsubscribe',
  'take my number off',
  'remove my number',
];

export function detectOptOutInTranscript(transcript: string): boolean {
  const lower = transcript.toLowerCase();
  const tail = lower.slice(-300);
  return OPT_OUT_PHRASES.some((phrase) => tail.includes(phrase));
}

const SMS_OPT_OUT_KEYWORDS = ['stop', 'unsubscribe', 'cancel', 'quit', 'remove', 'opt out', 'opt-out', 'end'];

export function isSmsOptOut(body: string): boolean {
  const trimmed = body.trim().toLowerCase();
  return SMS_OPT_OUT_KEYWORDS.includes(trimmed);
}
