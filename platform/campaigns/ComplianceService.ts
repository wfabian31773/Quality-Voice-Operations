import { getPlatformPool, withTenantContext } from '../db';
import { decryptSensitiveField } from '../security/FieldEncryption';
import { redactPHI } from '../core/phi/redact';
import { createLogger } from '../core/logger';
import { extractAreaCode } from './AreaCodeTimezone';
import type { Campaign } from './types';

const logger = createLogger('CAMPAIGN_COMPLIANCE');

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
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface DncMatch {
  contactId: string;
  phoneRedacted: string;
  contactName: string | null;
}

export interface ComplianceCheck {
  ok: boolean;
  totalContacts: number;
  scannedContacts: number;
  dncMatches: DncMatch[];
  dncMatchCount: number;
  optedOutCount: number;
  unknownTimezoneCount: number;
  hasQuietHoursConfig: boolean;
  respectsContactTimezone: boolean;
  complianceScore: number;
  recommendations: string[];
  preflightTruncated: boolean;
}

/**
 * Hard ceiling on how many contacts we'll decrypt and scan in one pre-flight
 * pass. We chunk in batches so very large campaigns don't load all rows into
 * memory at once, but we'll never scan more than this many contacts in a
 * single call. If a campaign has more contacts than this, the launch is
 * refused (`ok=false`) — operators must split the campaign or scrub their
 * imports against the DNC list before launching. Override via env for tests
 * or unusually large workloads.
 */
const MAX_PREFLIGHT_CONTACTS = Number(process.env.CAMPAIGN_PREFLIGHT_MAX_CONTACTS ?? 100_000);
const PREFLIGHT_BATCH_SIZE = Number(process.env.CAMPAIGN_PREFLIGHT_BATCH_SIZE ?? 1_000);

/**
 * Decrypt a possibly-encrypted phone number stored in `campaign_contacts`.
 * Tolerant of plaintext rows (older data, tests with encryption disabled)
 * and never throws — returns the raw value if decryption fails so the
 * caller can still log/skip the row.
 */
async function safeDecryptPhone(tenantId: string, raw: string): Promise<string> {
  if (!raw) return raw;
  if (!raw.startsWith('env1:')) return raw;
  try {
    return await decryptSensitiveField(tenantId, raw);
  } catch (err) {
    logger.warn('Failed to decrypt contact phone for compliance check', {
      tenantId,
      error: String(err),
    });
    return raw;
  }
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Inspect every (or the first MAX_PREFLIGHT_CONTACTS) campaign contacts and
 * cross-reference with the tenant's DNC list, opt-outs, and timezone
 * coverage. Produces a compliance score (0–100) and an `ok` flag — campaigns
 * with `ok=false` are refused at launch by the admin API.
 */
export async function checkCampaignCompliance(
  tenantId: string,
  campaignId: string,
  campaign: Pick<Campaign, 'config'> | null,
): Promise<ComplianceCheck> {
  return withTenant(tenantId, async (client) => {
    const { rows: dncRows } = await client.query(
      `SELECT phone_number FROM dnc_list WHERE tenant_id = $1`,
      [tenantId],
    );
    const dncSet = new Set<string>(dncRows.map((r) => String(r.phone_number)));

    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'opted_out')::int AS opted_out
       FROM campaign_contacts WHERE campaign_id = $1 AND tenant_id = $2`,
      [campaignId, tenantId],
    );
    const totalContacts = (countRows[0]?.total as number) ?? 0;
    const optedOutCount = (countRows[0]?.opted_out as number) ?? 0;

    const dncMatches: DncMatch[] = [];
    let unknownTimezoneCount = 0;
    let scannedContacts = 0;
    let preflightTruncated = false;
    let lastCreatedAt: string | null = null;
    let lastId: string | null = null;

    // Paginate via keyset on (created_at, id) so we scan every contact
    // (not just the first batch) without loading them all at once.
    while (scannedContacts < MAX_PREFLIGHT_CONTACTS) {
      const params: unknown[] = [campaignId, tenantId];
      let cursorClause = '';
      if (lastCreatedAt && lastId) {
        params.push(lastCreatedAt, lastId);
        cursorClause = `AND (created_at, id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
      }
      params.push(PREFLIGHT_BATCH_SIZE);
      const { rows: batch } = await client.query(
        `SELECT id, phone_number, name, created_at FROM campaign_contacts
         WHERE campaign_id = $1 AND tenant_id = $2
           AND status NOT IN ('opted_out')
           ${cursorClause}
         ORDER BY created_at ASC, id ASC
         LIMIT $${params.length}`,
        params,
      );
      if (batch.length === 0) break;

      for (const row of batch) {
        const decrypted = await safeDecryptPhone(tenantId, String(row.phone_number));
        if (dncSet.has(decrypted)) {
          dncMatches.push({
            contactId: String(row.id),
            phoneRedacted: redactPHI(decrypted),
            contactName: (row.name as string | null) ?? null,
          });
        }
        if (!extractAreaCode(decrypted)) {
          unknownTimezoneCount++;
        }
        scannedContacts++;
      }

      const last = batch[batch.length - 1];
      lastCreatedAt = String(last.created_at);
      lastId = String(last.id);
      if (batch.length < PREFLIGHT_BATCH_SIZE) break;
    }

    if (scannedContacts >= MAX_PREFLIGHT_CONTACTS && totalContacts - optedOutCount > scannedContacts) {
      preflightTruncated = true;
    }

    const config = (campaign?.config ?? {}) as Record<string, unknown>;
    const respectsContactTimezone = config.respectContactTimezone !== false;
    const hasQuietHoursConfig = Boolean(
      config.callWindowStart || config.callWindowEnd
        || (Array.isArray(config.callWindows) && config.callWindows.length > 0),
    );

    let score = 100;
    const recommendations: string[] = [];

    if (dncMatches.length > 0) {
      score = Math.min(score, 30 - Math.min(30, dncMatches.length));
      recommendations.push(
        `${dncMatches.length} contact${dncMatches.length === 1 ? ' is' : 's are'} on the do-not-call list. Remove them before launching.`,
      );
    }
    if (totalContacts > 0 && optedOutCount > 0) {
      const ratio = optedOutCount / totalContacts;
      score -= Math.min(20, Math.round(ratio * 100));
    }
    if (!hasQuietHoursConfig) {
      score -= 10;
      recommendations.push('Configure call windows so the dialer can enforce quiet hours.');
    }
    if (!respectsContactTimezone) {
      score -= 10;
      recommendations.push('Enable "respect contact timezone" so quiet hours follow the called party\'s local time (TCPA compliant).');
    }
    if (totalContacts > 0 && unknownTimezoneCount === totalContacts && respectsContactTimezone) {
      recommendations.push('No contacts have a recognizable area code; quiet hours will fall back to the campaign timezone.');
    }
    if (totalContacts === 0) {
      score = 0;
      recommendations.push('Add contacts before launching the campaign.');
    }
    if (preflightTruncated) {
      score = Math.min(score, 50);
      recommendations.push(
        `Campaign exceeds the ${MAX_PREFLIGHT_CONTACTS.toLocaleString()}-contact pre-flight limit. Split the campaign or scrub contacts against the DNC list before launching.`,
      );
    }

    // Refuse to launch if (a) any DNC match was found, (b) the campaign is
    // empty, or (c) we couldn't fully verify the contact list. This is the
    // "fail closed" behavior required for TCPA compliance.
    const ok = dncMatches.length === 0 && totalContacts > 0 && !preflightTruncated;
    return {
      ok,
      totalContacts,
      scannedContacts,
      dncMatches: dncMatches.slice(0, 25),
      dncMatchCount: dncMatches.length,
      optedOutCount,
      unknownTimezoneCount,
      hasQuietHoursConfig,
      respectsContactTimezone,
      complianceScore: clampScore(score),
      recommendations,
      preflightTruncated,
    };
  });
}

/**
 * Scan every (or up to MAX_PREFLIGHT_CONTACTS) campaign contact and return
 * the IDs of those whose decrypted phone is on the tenant's DNC list. This
 * powers the "Scrub DNC matches" admin action — unlike `checkCampaignCompliance`
 * which slices the displayed match list to 25 for the UI, this returns the
 * full set so the caller can flip every match to `opted_out` in one shot.
 *
 * `truncated` is true when we hit the pre-flight ceiling and there are still
 * more contacts to scan beyond it. Callers should surface this so the operator
 * knows another scrub pass may be needed (or the campaign needs to be split).
 */
export async function findDncMatchingContactIds(
  tenantId: string,
  campaignId: string,
): Promise<{ contactIds: string[]; scannedContacts: number; truncated: boolean }> {
  return withTenant(tenantId, async (client) => {
    const { rows: dncRows } = await client.query(
      `SELECT phone_number FROM dnc_list WHERE tenant_id = $1`,
      [tenantId],
    );
    const dncSet = new Set<string>(dncRows.map((r) => String(r.phone_number)));

    const matches: string[] = [];
    let scanned = 0;
    let lastCreatedAt: string | null = null;
    let lastId: string | null = null;
    let truncated = false;

    while (scanned < MAX_PREFLIGHT_CONTACTS) {
      const params: unknown[] = [campaignId, tenantId];
      let cursorClause = '';
      if (lastCreatedAt && lastId) {
        params.push(lastCreatedAt, lastId);
        cursorClause = `AND (created_at, id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
      }
      params.push(PREFLIGHT_BATCH_SIZE);
      const { rows: batch } = await client.query(
        `SELECT id, phone_number, created_at FROM campaign_contacts
         WHERE campaign_id = $1 AND tenant_id = $2
           AND status NOT IN ('opted_out')
           ${cursorClause}
         ORDER BY created_at ASC, id ASC
         LIMIT $${params.length}`,
        params,
      );
      if (batch.length === 0) break;

      for (const row of batch) {
        const decrypted = await safeDecryptPhone(tenantId, String(row.phone_number));
        if (dncSet.has(decrypted)) {
          matches.push(String(row.id));
        }
        scanned++;
      }

      const last = batch[batch.length - 1];
      lastCreatedAt = String(last.created_at);
      lastId = String(last.id);
      if (batch.length < PREFLIGHT_BATCH_SIZE) break;
    }

    if (scanned >= MAX_PREFLIGHT_CONTACTS && lastCreatedAt && lastId) {
      const { rows: more } = await client.query(
        `SELECT 1 FROM campaign_contacts
         WHERE campaign_id = $1 AND tenant_id = $2
           AND status NOT IN ('opted_out')
           AND (created_at, id) > ($3::timestamptz, $4::uuid)
         LIMIT 1`,
        [campaignId, tenantId, lastCreatedAt, lastId],
      );
      if (more.length > 0) truncated = true;
    }

    return { contactIds: matches, scannedContacts: scanned, truncated };
  });
}

/**
 * Lightweight DNC membership check that handles encrypted contact phones.
 * Used by the scheduler at dial-time as a defense-in-depth fallback.
 */
export async function isContactOnDnc(
  tenantId: string,
  encryptedOrPlaintextPhone: string,
): Promise<boolean> {
  const decrypted = await safeDecryptPhone(tenantId, encryptedOrPlaintextPhone);
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT 1 FROM dnc_list WHERE tenant_id = $1 AND phone_number = $2 LIMIT 1`,
      [tenantId, decrypted],
    );
    return rows.length > 0;
  });
}
