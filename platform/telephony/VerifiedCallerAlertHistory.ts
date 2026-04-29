import { getPlatformPool } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('VERIFIED_CALLER_ALERT_HISTORY');

/**
 * One delivery attempt for a single recipient inside one dispatch. The
 * Platform Admin history view renders these grouped by `dispatchId` so
 * support can see exactly who received (or didn't receive) each alert.
 */
export interface VerifiedCallerAlertRecipientRow {
  id: number;
  dispatchId: string;
  healthStatus: string;
  recipientEmail: string;
  recipientName: string | null;
  userId: string | null;
  deliveryStatus: 'sent' | 'bounced' | 'failed' | 'skipped';
  deliveryError: string | null;
  permanentFailure: boolean;
  source: 'scheduler' | 'admin_reissue';
  triggeredByUserId: string | null;
  triggeredByEmail: string | null;
  triggeredByName: string | null;
  dispatchedAt: string;
}

/**
 * Aggregate counts for the most recent dispatch on a given caller. The
 * listing endpoint embeds one of these per row so the panel can render a
 * "last alert: 3 sent, 1 bounced" badge inline without an extra fetch.
 *
 * `allBounced` is true when at least one delivery attempt was made and
 * every attempt landed in `bounced` (no `sent`, no transient `failed`).
 * Skipped rows are excluded from the deliverability check — they never
 * left the building, so they can't have bounced.
 */
export interface VerifiedCallerAlertSummary {
  dispatchId: string;
  dispatchedAt: string;
  healthStatus: string;
  source: 'scheduler' | 'admin_reissue';
  sentCount: number;
  bouncedCount: number;
  failedCount: number;
  skippedCount: number;
  totalCount: number;
  allBounced: boolean;
}

interface AlertSummaryRow {
  caller_id: string;
  dispatch_id: string;
  dispatched_at: Date;
  health_status: string;
  source: string;
  sent_count: string | number;
  bounced_count: string | number;
  failed_count: string | number;
  skipped_count: string | number;
  total_count: string | number;
}

function parseCount(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function normalizeSource(s: string | null | undefined): 'scheduler' | 'admin_reissue' {
  return s === 'admin_reissue' ? 'admin_reissue' : 'scheduler';
}

function summaryFromRow(row: AlertSummaryRow): VerifiedCallerAlertSummary {
  const sentCount = parseCount(row.sent_count);
  const bouncedCount = parseCount(row.bounced_count);
  const failedCount = parseCount(row.failed_count);
  const skippedCount = parseCount(row.skipped_count);
  // "All bounced" is the badge condition: at least one permanent bounce
  // and zero successful or transient-failed attempts. A mixed
  // sent+bounced result still means *somebody* got it.
  const allBounced =
    bouncedCount > 0 && sentCount === 0 && failedCount === 0;
  return {
    dispatchId: row.dispatch_id,
    dispatchedAt: row.dispatched_at.toISOString(),
    healthStatus: row.health_status,
    source: normalizeSource(row.source),
    sentCount,
    bouncedCount,
    failedCount,
    skippedCount,
    totalCount: parseCount(row.total_count),
    allBounced,
  };
}

/**
 * Bulk-load the most recent dispatch summary for each given caller id.
 * Used by the verified-caller-health listing endpoint to embed the
 * `lastAlert` block inline. Returns a map keyed by caller_id; callers
 * without any audit rows are simply absent from the map (the panel
 * renders "no alerts on file" for those).
 *
 * Uses `DISTINCT ON` to pick the latest dispatch per caller in a single
 * indexed scan, then joins back to the recipient table to compute the
 * delivery counts in one round-trip. Cheaper than per-row N+1 fetches
 * once the panel has a few hundred unhealthy callers in view.
 */
export async function getLatestAlertSummariesByCaller(
  tenantCallerPairs: Array<{ tenantId: string; callerId: string }>,
): Promise<Map<string, VerifiedCallerAlertSummary>> {
  const out = new Map<string, VerifiedCallerAlertSummary>();
  if (tenantCallerPairs.length === 0) return out;
  // De-dupe caller ids — the listing query already groups by caller, but
  // be defensive in case a future caller passes pairs with duplicates.
  const callerIds = Array.from(new Set(tenantCallerPairs.map((p) => p.callerId)));
  try {
    const pool = getPlatformPool();
    // CTE picks the latest dispatch per (tenant, caller). The outer
    // SELECT joins back so the COUNT FILTER aggregates only over rows
    // that belong to that latest dispatch — earlier dispatches are
    // ignored. The DISTINCT ON tiebreaker on dispatch_id keeps results
    // deterministic when two rows share the exact same dispatched_at
    // (e.g. a forced admin reissue + scheduler racing in the same ms).
    const { rows } = await pool.query<AlertSummaryRow>(
      `WITH latest AS (
         SELECT DISTINCT ON (tenant_id, caller_id)
           tenant_id, caller_id, dispatch_id, dispatched_at,
           health_status, source
         FROM verified_caller_alert_recipients
         WHERE caller_id = ANY($1::varchar[])
         ORDER BY tenant_id, caller_id, dispatched_at DESC, dispatch_id DESC
       )
       SELECT
         l.caller_id,
         l.dispatch_id,
         l.dispatched_at,
         l.health_status,
         l.source,
         COUNT(*) FILTER (WHERE r.delivery_status = 'sent')    AS sent_count,
         COUNT(*) FILTER (WHERE r.delivery_status = 'bounced') AS bounced_count,
         COUNT(*) FILTER (WHERE r.delivery_status = 'failed')  AS failed_count,
         COUNT(*) FILTER (WHERE r.delivery_status = 'skipped') AS skipped_count,
         COUNT(*) AS total_count
       FROM latest l
       JOIN verified_caller_alert_recipients r
         ON r.tenant_id = l.tenant_id
        AND r.dispatch_id = l.dispatch_id
       GROUP BY l.caller_id, l.dispatch_id, l.dispatched_at, l.health_status, l.source`,
      [callerIds],
    );
    for (const row of rows) {
      out.set(row.caller_id, summaryFromRow(row));
    }
  } catch (err) {
    logger.warn('Failed to load verified-caller alert summaries', {
      callerCount: callerIds.length,
      error: String(err),
    });
  }
  return out;
}

interface RecipientRow {
  id: string | number;
  dispatch_id: string;
  health_status: string;
  recipient_email: string;
  recipient_name: string | null;
  user_id: string | null;
  delivery_status: string;
  delivery_error: string | null;
  permanent_failure: boolean;
  source: string;
  triggered_by_user_id: string | null;
  triggered_by_email: string | null;
  triggered_by_name: string | null;
  dispatched_at: Date;
}

function normalizeDeliveryStatus(
  s: string,
): 'sent' | 'bounced' | 'failed' | 'skipped' {
  if (s === 'sent' || s === 'bounced' || s === 'failed' || s === 'skipped') return s;
  // Unknown vocabulary slipped into the table (manual SQL, future
  // migration). Treat it as failed so the UI doesn't crash on an
  // exhaustive switch.
  return 'failed';
}

function rowToRecipient(row: RecipientRow): VerifiedCallerAlertRecipientRow {
  const idNum = typeof row.id === 'number' ? row.id : Number.parseInt(String(row.id), 10);
  return {
    id: Number.isFinite(idNum) ? idNum : 0,
    dispatchId: row.dispatch_id,
    healthStatus: row.health_status,
    recipientEmail: row.recipient_email,
    recipientName: row.recipient_name,
    userId: row.user_id,
    deliveryStatus: normalizeDeliveryStatus(row.delivery_status),
    deliveryError: row.delivery_error,
    permanentFailure: row.permanent_failure === true,
    source: normalizeSource(row.source),
    triggeredByUserId: row.triggered_by_user_id,
    triggeredByEmail: row.triggered_by_email,
    triggeredByName: row.triggered_by_name,
    dispatchedAt: row.dispatched_at.toISOString(),
  };
}

/**
 * Load the per-recipient history for a single (tenant, caller) pair.
 * Backs the lazy-loaded expand row on the Platform Admin verified-caller
 * panel. `limit` caps total recipient rows (not dispatches) to keep
 * payloads bounded for tenants with hundreds of admins. Sort is
 * newest-first by dispatch then alphabetical by recipient so each
 * dispatch group renders deterministically.
 */
export async function listVerifiedCallerAlertHistory(
  tenantId: string,
  callerId: string,
  limit: number,
): Promise<VerifiedCallerAlertRecipientRow[]> {
  try {
    const pool = getPlatformPool();
    const { rows } = await pool.query<RecipientRow>(
      `SELECT
         r.id,
         r.dispatch_id,
         r.health_status,
         r.recipient_email,
         r.recipient_name,
         r.user_id,
         r.delivery_status,
         r.delivery_error,
         r.permanent_failure,
         r.source,
         r.triggered_by_user_id,
         u.email AS triggered_by_email,
         NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS triggered_by_name,
         r.dispatched_at
       FROM verified_caller_alert_recipients r
       LEFT JOIN users u ON u.id = r.triggered_by_user_id
       WHERE r.tenant_id = $1 AND r.caller_id = $2
       ORDER BY r.dispatched_at DESC, r.dispatch_id DESC, r.recipient_email ASC
       LIMIT $3`,
      [tenantId, callerId, limit],
    );
    return rows.map(rowToRecipient);
  } catch (err) {
    logger.warn('Failed to load verified-caller alert history', {
      tenantId,
      callerId,
      error: String(err),
    });
    return [];
  }
}
