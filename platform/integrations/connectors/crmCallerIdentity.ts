import { getPlatformPool, withTenantContext } from '../../db';
import type { TenantId } from '../../core/types';
import { createLogger } from '../../core/logger';

const logger = createLogger('CRM_CALLER_IDENTITY');

interface DbClient {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
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

export interface CrmCallerIdentity {
  contactId?: string;
  accountId?: string;
  opportunityId?: string;
}

/**
 * Normalize a caller phone number to a digits-only key so lookups are
 * deterministic regardless of formatting. US numbers are canonicalized to
 * 10 digits (the leading `1` country code is stripped when total length is
 * 11) so `+1 (555) 123-4567` and `5551234567` resolve to the same key.
 * Returns null when the input has no digits.
 */
export function normalizeCallerPhone(phone: string | undefined | null): string | null {
  if (!phone || typeof phone !== 'string') return null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 0) return null;
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

function coerceId(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/**
 * Heuristically extract `{ contactId, accountId, opportunityId }` from a
 * connector adapter's `result.meta`. Adapters return different field names for
 * the same conceptual entities (Salesforce: contactId/accountId/opportunityId;
 * HubSpot: contactId/companyId/dealId; Pipedrive: personId/orgId/dealId), so
 * we map them all into the canonical Salesforce-style slots used by the cache.
 * Salesforce ID-prefix detection on `whoId`/`whatId` remains as a fallback.
 */
export function extractIdentityFromMeta(meta: Record<string, unknown> | undefined): CrmCallerIdentity {
  if (!meta) return {};
  const out: CrmCallerIdentity = {};

  // Direct Salesforce-style names (also used by HubSpot for contactId).
  const contactId = coerceId(meta.contactId) ?? coerceId(meta.personId);
  if (contactId) out.contactId = contactId;

  const accountId = coerceId(meta.accountId) ?? coerceId(meta.companyId) ?? coerceId(meta.orgId);
  if (accountId) out.accountId = accountId;

  const opportunityId = coerceId(meta.opportunityId) ?? coerceId(meta.dealId);
  if (opportunityId) out.opportunityId = opportunityId;

  // Salesforce-specific fallback: derive from whoId/whatId using the standard
  // 3-character object key prefix (003 = Contact, 001 = Account, 006 = Opportunity).
  const whoObject = typeof meta.whoObject === 'string' ? meta.whoObject : undefined;
  const whoId = typeof meta.whoId === 'string' ? meta.whoId : undefined;
  if (!out.contactId && whoObject === 'Contact' && whoId) {
    out.contactId = whoId;
  }

  const whatId = typeof meta.whatId === 'string' ? meta.whatId : undefined;
  if (whatId && whatId.length >= 3) {
    const prefix = whatId.slice(0, 3);
    if (prefix === '006' && !out.opportunityId) out.opportunityId = whatId;
    else if (prefix === '001' && !out.accountId) out.accountId = whatId;
  }

  return out;
}

export async function lookupCrmCallerIdentity(
  tenantId: TenantId,
  provider: string,
  phone: string,
): Promise<CrmCallerIdentity | null> {
  const normalized = normalizeCallerPhone(phone);
  if (!normalized) return null;
  try {
    return await withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT contact_id, account_id, opportunity_id
         FROM crm_caller_identities
         WHERE tenant_id = $1 AND provider = $2 AND phone_e164 = $3
         LIMIT 1`,
        [tenantId, provider, normalized],
      );
      if (rows.length === 0) return null;
      const row = rows[0];
      const identity: CrmCallerIdentity = {};
      if (row.contact_id) identity.contactId = row.contact_id as string;
      if (row.account_id) identity.accountId = row.account_id as string;
      if (row.opportunity_id) identity.opportunityId = row.opportunity_id as string;
      return identity;
    });
  } catch (err) {
    logger.warn('lookupCrmCallerIdentity failed', {
      tenantId,
      provider,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Upsert per-tenant per-caller-phone CRM identifiers. Existing non-null IDs
 * are preserved when the new value is null so we never lose state across calls
 * (e.g. a later event without an opportunity must not blank out the cached one).
 */
export async function upsertCrmCallerIdentity(
  tenantId: TenantId,
  provider: string,
  phone: string,
  identity: CrmCallerIdentity,
): Promise<void> {
  const normalized = normalizeCallerPhone(phone);
  if (!normalized) return;
  if (!identity.contactId && !identity.accountId && !identity.opportunityId) return;

  try {
    await withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO crm_caller_identities
           (tenant_id, provider, phone_e164, contact_id, account_id, opportunity_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
         ON CONFLICT (tenant_id, provider, phone_e164)
         DO UPDATE SET
           contact_id = COALESCE(EXCLUDED.contact_id, crm_caller_identities.contact_id),
           account_id = COALESCE(EXCLUDED.account_id, crm_caller_identities.account_id),
           opportunity_id = COALESCE(EXCLUDED.opportunity_id, crm_caller_identities.opportunity_id),
           updated_at = NOW()`,
        [
          tenantId,
          provider,
          normalized,
          identity.contactId ?? null,
          identity.accountId ?? null,
          identity.opportunityId ?? null,
        ],
      );
    });
    logger.info('CRM caller identity cached', {
      tenantId,
      provider,
      phone: normalized,
      hasContact: Boolean(identity.contactId),
      hasAccount: Boolean(identity.accountId),
      hasOpportunity: Boolean(identity.opportunityId),
    });
  } catch (err) {
    logger.warn('upsertCrmCallerIdentity failed', {
      tenantId,
      provider,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
