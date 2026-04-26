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
  /**
   * Per-provider native IDs stored verbatim under their adapter-facing field
   * names (e.g. HubSpot: `companyId`, `dealId`; Pipedrive: `personId`, `orgId`,
   * `dealId`). The dispatch layer reads these directly for non-Salesforce
   * providers so we never lose provider context to a name remap.
   */
  extras?: Record<string, string>;
}

/**
 * Field names recognized as provider-native IDs per provider. Keep this list
 * narrow on purpose: only the IDs the corresponding adapter consumes as
 * payload hints belong here, so the cache always round-trips to the same
 * shape the adapter expects.
 */
const PROVIDER_NATIVE_ID_FIELDS: Record<string, readonly string[]> = {
  hubspot: ['contactId', 'companyId', 'dealId'],
  pipedrive: ['personId', 'orgId', 'dealId'],
};

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
 * Heuristically extract `{ contactId, accountId, opportunityId, extras }` from a
 * connector adapter's `result.meta`.
 *
 * - The Salesforce-style canonical slots (`contactId`/`accountId`/`opportunityId`)
 *   are still populated for back-compat and so Salesforce dispatches keep working
 *   without consulting `extras`.
 * - When `provider` is supplied and is one of the known per-provider providers
 *   (HubSpot / Pipedrive), the recognized native field names are also copied
 *   verbatim into `extras` so the dispatch layer can re-inject them without any
 *   conceptual remap (e.g. HubSpot's `companyId` stays `companyId`, not `accountId`).
 */
export function extractIdentityFromMeta(
  meta: Record<string, unknown> | undefined,
  provider?: string,
): CrmCallerIdentity {
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

  // Per-provider native ID extras, stored verbatim under their adapter-facing
  // field names so we can round-trip them without conceptual remapping.
  if (provider && PROVIDER_NATIVE_ID_FIELDS[provider]) {
    const extras: Record<string, string> = {};
    for (const field of PROVIDER_NATIVE_ID_FIELDS[provider]) {
      const value = coerceId(meta[field]);
      if (value) extras[field] = value;
    }
    if (Object.keys(extras).length > 0) out.extras = extras;
  }

  return out;
}

function parseExtras(value: unknown): Record<string, string> | undefined {
  if (!value) return undefined;
  let raw: unknown = value;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const coerced = coerceId(v);
    if (coerced) out[k] = coerced;
  }
  return Object.keys(out).length > 0 ? out : undefined;
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
        `SELECT contact_id, account_id, opportunity_id, extras
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
      const extras = parseExtras(row.extras);
      if (extras) identity.extras = extras;
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
 * IDs that an adapter has confirmed are no longer accessible in the upstream
 * CRM (404 / entity deleted / merged / archived). The dispatch layer uses
 * these to scrub the matching slots from `crm_caller_identities` so the next
 * call falls back to phone/company lookup instead of re-injecting a zombie ID.
 *
 * Both Salesforce-style canonical names and provider-native names (HubSpot's
 * `companyId` / `dealId`, Pipedrive's `personId` / `orgId` / `dealId`) are
 * accepted; matching is performed by value across the canonical columns AND
 * the `extras` JSONB so an alias (e.g. HubSpot `companyId` cached under
 * `extras.companyId` and also mirrored to the canonical `account_id` slot)
 * gets cleared from both places in one call.
 */
export interface StaleCrmIds {
  contactId?: string;
  accountId?: string;
  opportunityId?: string;
  companyId?: string;
  dealId?: string;
  personId?: string;
  orgId?: string;
}

function collectStaleValues(stale: StaleCrmIds): Set<string> {
  const out = new Set<string>();
  for (const value of Object.values(stale)) {
    const coerced = coerceId(value);
    if (coerced) out.add(coerced);
  }
  return out;
}

/**
 * Invalidate stale CRM IDs cached for `(tenant, provider, phone)`.
 *
 * - When `stale` is omitted, the entire cache row is deleted.
 * - When `stale` is provided, any canonical column (`contact_id`, `account_id`,
 *   `opportunity_id`) whose current value matches one of the stale IDs is set
 *   to NULL, and any `extras` JSONB key whose value matches a stale ID is
 *   removed.
 * - If the resulting row has no canonical IDs left and an empty `extras`, the
 *   row is deleted entirely so subsequent lookups fall through to a fresh
 *   phone/company resolution.
 *
 * Matching is by value, so the caller can safely pass IDs without knowing
 * whether they came from the canonical columns or `extras`.
 */
export async function clearCrmCallerIdentity(
  tenantId: TenantId,
  provider: string,
  phone: string,
  stale?: StaleCrmIds,
): Promise<void> {
  const normalized = normalizeCallerPhone(phone);
  if (!normalized) return;

  try {
    await withTenant(tenantId, async (client) => {
      if (!stale) {
        await client.query(
          `DELETE FROM crm_caller_identities
           WHERE tenant_id = $1 AND provider = $2 AND phone_e164 = $3`,
          [tenantId, provider, normalized],
        );
        return;
      }

      const staleValues = collectStaleValues(stale);
      if (staleValues.size === 0) return;

      const { rows } = await client.query(
        `SELECT contact_id, account_id, opportunity_id, extras
         FROM crm_caller_identities
         WHERE tenant_id = $1 AND provider = $2 AND phone_e164 = $3
         FOR UPDATE`,
        [tenantId, provider, normalized],
      );
      if (rows.length === 0) return;

      const row = rows[0];
      const currentContact = row.contact_id ? String(row.contact_id) : null;
      const currentAccount = row.account_id ? String(row.account_id) : null;
      const currentOpportunity = row.opportunity_id ? String(row.opportunity_id) : null;
      const currentExtras = parseExtras(row.extras) ?? {};

      const nextContact = currentContact && staleValues.has(currentContact) ? null : currentContact;
      const nextAccount = currentAccount && staleValues.has(currentAccount) ? null : currentAccount;
      const nextOpportunity = currentOpportunity && staleValues.has(currentOpportunity) ? null : currentOpportunity;

      const nextExtras: Record<string, string> = {};
      for (const [k, v] of Object.entries(currentExtras)) {
        if (!staleValues.has(v)) nextExtras[k] = v;
      }

      const changedCanonical =
        nextContact !== currentContact
        || nextAccount !== currentAccount
        || nextOpportunity !== currentOpportunity;
      const changedExtras = Object.keys(nextExtras).length !== Object.keys(currentExtras).length;
      if (!changedCanonical && !changedExtras) return;

      const hasAnythingLeft =
        nextContact !== null
        || nextAccount !== null
        || nextOpportunity !== null
        || Object.keys(nextExtras).length > 0;

      if (!hasAnythingLeft) {
        await client.query(
          `DELETE FROM crm_caller_identities
           WHERE tenant_id = $1 AND provider = $2 AND phone_e164 = $3`,
          [tenantId, provider, normalized],
        );
      } else {
        await client.query(
          `UPDATE crm_caller_identities
           SET contact_id = $4,
               account_id = $5,
               opportunity_id = $6,
               extras = $7::jsonb,
               updated_at = NOW()
           WHERE tenant_id = $1 AND provider = $2 AND phone_e164 = $3`,
          [
            tenantId,
            provider,
            normalized,
            nextContact,
            nextAccount,
            nextOpportunity,
            JSON.stringify(nextExtras),
          ],
        );
      }

      logger.info('CRM caller identity invalidated', {
        tenantId,
        provider,
        phone: normalized,
        clearedContact: nextContact !== currentContact,
        clearedAccount: nextAccount !== currentAccount,
        clearedOpportunity: nextOpportunity !== currentOpportunity,
        rowDeleted: !hasAnythingLeft,
      });
    });
  } catch (err) {
    logger.warn('clearCrmCallerIdentity failed', {
      tenantId,
      provider,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Upsert per-tenant per-caller-phone CRM identifiers. Existing non-null IDs
 * are preserved when the new value is null so we never lose state across calls
 * (e.g. a later event without an opportunity must not blank out the cached one).
 * The `extras` JSONB column is merged at the key level so a subsequent event
 * that only supplies `dealId` does not erase a previously cached `companyId`.
 */
export async function upsertCrmCallerIdentity(
  tenantId: TenantId,
  provider: string,
  phone: string,
  identity: CrmCallerIdentity,
): Promise<void> {
  const normalized = normalizeCallerPhone(phone);
  if (!normalized) return;
  const hasExtras = identity.extras && Object.keys(identity.extras).length > 0;
  if (!identity.contactId && !identity.accountId && !identity.opportunityId && !hasExtras) return;

  try {
    await withTenant(tenantId, async (client) => {
      await client.query(
        `INSERT INTO crm_caller_identities
           (tenant_id, provider, phone_e164, contact_id, account_id, opportunity_id, extras, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, NOW(), NOW())
         ON CONFLICT (tenant_id, provider, phone_e164)
         DO UPDATE SET
           contact_id = COALESCE(EXCLUDED.contact_id, crm_caller_identities.contact_id),
           account_id = COALESCE(EXCLUDED.account_id, crm_caller_identities.account_id),
           opportunity_id = COALESCE(EXCLUDED.opportunity_id, crm_caller_identities.opportunity_id),
           extras = COALESCE(crm_caller_identities.extras, '{}'::jsonb) || EXCLUDED.extras,
           updated_at = NOW()`,
        [
          tenantId,
          provider,
          normalized,
          identity.contactId ?? null,
          identity.accountId ?? null,
          identity.opportunityId ?? null,
          JSON.stringify(identity.extras ?? {}),
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
      extrasKeys: identity.extras ? Object.keys(identity.extras) : [],
    });
  } catch (err) {
    logger.warn('upsertCrmCallerIdentity failed', {
      tenantId,
      provider,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
