/**
 * Daily background sweeper that prunes old rows from `crm_stale_cache_scrubs`
 * (migration 095). The table is append-only — `CrmStaleCacheTracker` adds a
 * row every time the CRM dispatch layer scrubs a stale cached record — and
 * the alerting logic only ever reads the trailing 24h window. Anything older
 * than that is dead weight that slowly bloats the table and slows the
 * per-(tenant, provider, caller_phone) count query that gates the alert.
 *
 * Wiring: this scheduler is started by `server/admin-api/start.ts` alongside
 * the other retention/cleanup schedulers. In a horizontally-scaled deployment
 * every admin instance will run its own cycle; the DELETE is idempotent and
 * cheap enough that we don't bother coordinating a leader lease.
 *
 * Retention horizon: defaults to 30 days, override with
 * `CRM_STALE_CACHE_RETENTION_DAYS`. The value is well past the 24h window
 * the alerting query reads, so historic data needed for any in-flight
 * threshold evaluation is always preserved with a wide safety margin.
 */

import { createLogger } from '../../core/logger';
import { getPlatformPool } from '../../db';

const logger = createLogger('CRM_STALE_CACHE_RETENTION');

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day
const INITIAL_DELAY_MS = 5 * 60 * 1000; // wait 5 min after boot

export interface CrmStaleCacheRetentionResult {
  deleted: number;
  retentionDays: number;
}

/**
 * Read the retention horizon from `CRM_STALE_CACHE_RETENTION_DAYS`, falling
 * back to {@link DEFAULT_RETENTION_DAYS} when unset, blank, or not a positive
 * integer. The minimum effective value is 1 day so a misconfigured env var
 * cannot accidentally widen the delete window to "everything".
 */
export function getCrmStaleCacheRetentionDays(): number {
  const raw = process.env.CRM_STALE_CACHE_RETENTION_DAYS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_RETENTION_DAYS;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RETENTION_DAYS;
  return n;
}

/**
 * Run a single retention cycle. Deletes every `crm_stale_cache_scrubs` row
 * whose `occurred_at` is older than `retentionDays` ago. Errors are logged
 * and counted as a zero-row cycle so the periodic loop keeps ticking on
 * transient failures (the next cycle will retry).
 */
export async function runCrmStaleCacheRetentionCycle(
  options: { retentionDays?: number } = {},
): Promise<CrmStaleCacheRetentionResult> {
  const retentionDays = Math.max(1, options.retentionDays ?? getCrmStaleCacheRetentionDays());

  let deleted = 0;
  try {
    const pool = getPlatformPool();
    const r = await pool.query(
      `DELETE FROM crm_stale_cache_scrubs
        WHERE occurred_at < NOW() - make_interval(days => $1::int)`,
      [retentionDays],
    );
    deleted = r.rowCount ?? 0;
  } catch (err) {
    logger.error('Failed to prune crm_stale_cache_scrubs rows', {
      error: err instanceof Error ? err.message : String(err),
      retentionDays,
    });
    return { deleted: 0, retentionDays };
  }

  if (deleted > 0) {
    logger.info('CRM stale-cache retention cycle removed old rows', {
      deleted,
      retentionDays,
    });
  } else {
    logger.debug('CRM stale-cache retention cycle found no old rows', {
      retentionDays,
    });
  }

  return { deleted, retentionDays };
}

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

export function startCrmStaleCacheRetentionScheduler(
  intervalMs: number = DEFAULT_INTERVAL_MS,
): void {
  if (timer) return;

  initialTimer = setTimeout(() => {
    runCrmStaleCacheRetentionCycle().catch((err) => {
      logger.error('Initial CRM stale-cache retention cycle failed', {
        error: String(err),
      });
    });
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    runCrmStaleCacheRetentionCycle().catch((err) => {
      logger.error('CRM stale-cache retention cycle failed', {
        error: String(err),
      });
    });
  }, intervalMs);

  logger.info('CRM stale-cache retention scheduler started', {
    intervalMs,
    retentionDays: getCrmStaleCacheRetentionDays(),
  });
}

export function stopCrmStaleCacheRetentionScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('CRM stale-cache retention scheduler stopped');
  }
}

export const CRM_STALE_CACHE_RETENTION_DEFAULTS = {
  intervalMs: DEFAULT_INTERVAL_MS,
  initialDelayMs: INITIAL_DELAY_MS,
  retentionDays: DEFAULT_RETENTION_DAYS,
} as const;
