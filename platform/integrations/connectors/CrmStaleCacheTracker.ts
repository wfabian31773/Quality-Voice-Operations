import { getPlatformPool } from '../../db';
import { createLogger } from '../../core/logger';
import { fanoutInAppNotification } from '../../notifications/NotificationPreferences';
import { normalizeCallerPhone, type StaleCrmIds } from './crmCallerIdentity';
import type { TenantId } from '../../core/types';

const logger = createLogger('CRM_STALE_CACHE_TRACKER');

/**
 * `tenant_notifications.type` for the customer-visible alert. Mapped to the
 * 'integration' preference category in `categoryForNotificationType` so it
 * honours the same per-user opt-out toggle as connector outage alerts.
 */
export const STALE_CACHE_NOTIFICATION_TYPE = 'crm_stale_cache_alert';

/** How far back to look when counting scrub events for a single caller. */
const WINDOW_HOURS = 24;

/**
 * How long to suppress repeat alerts for the same (tenant, provider, caller)
 * key. Without this, every scrub past the threshold would re-fire the alert
 * because the rolling 24h count stays elevated for a full day.
 */
const ALERT_THROTTLE_HOURS = 24;

/**
 * Default scrub count in a 24h window that triggers an alert. Set high enough
 * that one stale record (which auto-resolves on the next sync) is silent, but
 * low enough that genuine churn surfaces within a single working session.
 * Override with `CRM_STALE_CACHE_ALERT_THRESHOLD` for per-deployment tuning.
 */
const DEFAULT_THRESHOLD = 3;

const PROVIDER_LABELS: Record<string, string> = {
  salesforce: 'Salesforce',
  hubspot: 'HubSpot',
  pipedrive: 'Pipedrive',
  zoho: 'Zoho',
};

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function describeStaleIds(staleIds: StaleCrmIds): string {
  const entries = Object.entries(staleIds ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  if (entries.length === 0) return 'unknown';
  return entries.map(([k, v]) => `${k}=${v}`).join(', ');
}

export interface RecordStaleCacheScrubParams {
  tenantId: TenantId;
  /** Lower-case adapter slug: salesforce | hubspot | pipedrive | zoho. */
  provider: string;
  /** Raw caller phone as passed in the dispatch payload; normalized internally. */
  callerPhone: string;
  /**
   * The {contactId, accountId, opportunityId, ...} payload that was scrubbed,
   * shaped exactly like the `StaleCrmIds` value the dispatch layer hands to
   * `clearCrmCallerIdentity` so the same payload can be forwarded verbatim.
   */
  staleIds: StaleCrmIds;
  /** Adapter-reported error code that surfaced the stale ID, if known. */
  errorCode?: string | null;
}

/**
 * Persist one stale-cache scrub event and, when a single (tenant, provider,
 * caller_phone) hits the configured threshold inside a 24h window, fan out an
 * in-app alert so the customer can investigate.
 *
 * Errors are caught and logged. The dispatch path that calls this should
 * never observe a thrown exception — the original CRM dispatch has already
 * succeeded/failed by the time we get here, and we don't want a DB hiccup
 * during alerting to mask it.
 */
export async function recordStaleCacheScrub(params: RecordStaleCacheScrubParams): Promise<void> {
  const { tenantId, provider, errorCode } = params;
  const normalizedPhone = normalizeCallerPhone(params.callerPhone);
  if (!normalizedPhone) {
    // Without a normalizable phone we can't dedupe per caller, so skip both
    // the insert and the threshold evaluation. Logged at debug because most
    // CRM dispatches do carry a caller phone — a missing one usually means
    // a misconfigured test event, not a real production case.
    logger.debug('Skipping stale-cache scrub record (no normalizable phone)', {
      tenantId,
      provider,
    });
    return;
  }

  const pool = getPlatformPool();
  const stalePayload = params.staleIds ?? {};

  try {
    await pool.query(
      `INSERT INTO crm_stale_cache_scrubs
         (tenant_id, provider, caller_phone, stale_ids, error_code)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [
        tenantId,
        provider.toLowerCase(),
        normalizedPhone,
        JSON.stringify(stalePayload),
        errorCode ?? null,
      ],
    );
  } catch (err) {
    // Insert failure means we lose this single data point but everything
    // downstream still works — bail rather than risk firing an alert that
    // can't be backed up by the underlying counter row.
    logger.warn('Failed to record CRM stale-cache scrub event', {
      tenantId,
      provider,
      error: String(err),
    });
    return;
  }

  const threshold = readPositiveIntEnv('CRM_STALE_CACHE_ALERT_THRESHOLD', DEFAULT_THRESHOLD);

  let recentCount = 0;
  try {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM crm_stale_cache_scrubs
        WHERE tenant_id = $1
          AND provider = $2
          AND caller_phone = $3
          AND occurred_at > NOW() - ($4 || ' hours')::interval`,
      [tenantId, provider.toLowerCase(), normalizedPhone, String(WINDOW_HOURS)],
    );
    recentCount = Number.parseInt(rows[0]?.count ?? '0', 10);
    if (!Number.isFinite(recentCount) || recentCount < 0) recentCount = 0;
  } catch (err) {
    logger.warn('Failed to count recent CRM stale-cache scrubs; skipping alert evaluation', {
      tenantId,
      provider,
      error: String(err),
    });
    return;
  }

  if (recentCount < threshold) return;

  // Per-(tenant, provider, caller_phone) throttle so the alert fires at most
  // once per 24h even though the rolling count stays above the threshold for
  // the full window. Match on metadata fields so we don't need yet another
  // dedicated table just for the throttle marker.
  try {
    const { rows: throttleRows } = await pool.query(
      `SELECT 1 FROM tenant_notifications
        WHERE tenant_id = $1
          AND type = $2
          AND metadata ->> 'provider' = $3
          AND metadata ->> 'callerPhone' = $4
          AND created_at > NOW() - ($5 || ' hours')::interval
        LIMIT 1`,
      [
        tenantId,
        STALE_CACHE_NOTIFICATION_TYPE,
        provider.toLowerCase(),
        normalizedPhone,
        String(ALERT_THROTTLE_HOURS),
      ],
    );
    if (throttleRows.length > 0) {
      logger.debug('CRM stale-cache alert suppressed by 24h throttle', {
        tenantId,
        provider,
        callerPhone: normalizedPhone,
      });
      return;
    }
  } catch (err) {
    logger.warn('Failed to check CRM stale-cache alert throttle (will still attempt fan-out)', {
      tenantId,
      provider,
      error: String(err),
    });
  }

  const providerLabel = PROVIDER_LABELS[provider.toLowerCase()] ?? provider;
  // Display the raw caller phone so it matches what the customer sees in the
  // call log; fall back to the normalized digits if no raw value came in.
  const displayPhone = (params.callerPhone ?? '').trim() || normalizedPhone;
  const staleIdSummary = describeStaleIds(stalePayload);

  const title = `${providerLabel} records keep disappearing for ${displayPhone}`;
  const message =
    `We've had to clear cached ${providerLabel} contact info for ${displayPhone} ` +
    `${recentCount} times in the last ${WINDOW_HOURS} hours. This usually means the upstream ` +
    `record is being deleted/recreated or someone on your team is removing what the AI just ` +
    `created. Latest stale IDs: ${staleIdSummary}. Open the record in ${providerLabel} to ` +
    `investigate.`;

  try {
    await fanoutInAppNotification({
      tenantId,
      type: STALE_CACHE_NOTIFICATION_TYPE,
      title,
      message,
      metadata: {
        provider: provider.toLowerCase(),
        providerLabel,
        callerPhone: normalizedPhone,
        callerPhoneDisplay: displayPhone,
        staleIds: stalePayload,
        errorCode: errorCode ?? null,
        scrubCount24h: recentCount,
        threshold,
        windowHours: WINDOW_HOURS,
        link: `/connectors?provider=${encodeURIComponent(provider.toLowerCase())}`,
      },
      category: 'integration',
    });
    logger.info('CRM stale-cache alert dispatched', {
      tenantId,
      provider,
      callerPhone: normalizedPhone,
      scrubCount24h: recentCount,
      threshold,
    });
  } catch (err) {
    // fanoutInAppNotification swallows its own DB errors, so a thrown
    // exception here is something more catastrophic (e.g. preference module
    // import failure). Log and move on — the underlying scrub row is still
    // persisted so the next event will retry the alert.
    logger.error('Failed to fan out CRM stale-cache alert', {
      tenantId,
      provider,
      error: String(err),
    });
  }
}
