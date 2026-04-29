/**
 * Periodic background sweeper that garbage-collects stale rows from the
 * shared `retry_attempts` table (migration 071).
 *
 * The `retry_attempts` table backs the per-key cooldowns used by the
 * docs-feedback and support-reply "Retry send" buttons (see
 * `platform/help/retryAttemptStore.ts`). Rows are written on every retry
 * click and only ever overwritten by a *subsequent reservation for the
 * exact same key*. Once an admin stops clicking Retry on a particular
 * feedback id / reply id the row is left behind forever, even though the
 * cooldown comparison can never re-block again.
 *
 * Wiring: this scheduler is started by `server/admin-api/start.ts`, the
 * same way the other help-area schedulers are. In a horizontally-scaled
 * deployment that means every admin instance runs its own cleanup cycle.
 * That is intentionally simple — the DELETE is idempotent (deleting an
 * already-deleted row is a no-op) and uses the
 * `retry_attempts_last_attempt_at_idx` index, so the cost of N instances
 * occasionally racing on the same expired rows is trivial compared with
 * coordinating a leader lease. If row volume ever justifies it, this
 * could be promoted to a single-leader / dedicated worker without
 * changing the DELETE itself.
 *
 * Safety margin: a freshly-deleted row is functionally identical to "no
 * row exists" — the next reservation just inserts a brand-new row. So in
 * principle we could delete anything older than the cooldown window. We
 * pad with `SAFETY_MARGIN_SECONDS` (24 h) anyway so:
 *   - admins who bump the cooldown env var don't immediately lose
 *     in-flight cooldowns the first time the cleaner runs (the bump
 *     only takes effect on a process restart, see the per-process
 *     caching in the limiter modules — the safety margin gives ops a
 *     full day's grace period to roll restarts),
 *   - clock skew between the cleaner host and the limiter host can never
 *     wipe a row that is technically still inside the cooldown window,
 *   - the table size stays bounded by (active retry keys per ~24h) which
 *     is small for the docs-feedback / support-reply use case.
 */

import { createLogger } from '../core/logger';
import { getPlatformPool } from '../db';
import { getRetryCooldownSeconds } from './docsFeedbackRetryLimiter';
import { getSupportReplyRetryCooldownSeconds } from './supportReplyRetryLimiter';

const logger = createLogger('RETRY_ATTEMPTS_CLEANUP');

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1h
const INITIAL_DELAY_MS = 5 * 60 * 1000;     // wait 5 min after boot
const SAFETY_MARGIN_SECONDS = 24 * 60 * 60; // 24h beyond the largest cooldown

export interface RetryAttemptsCleanupResult {
  deleted: number;
  cutoffSeconds: number;
}

/**
 * Compute the cutoff age (in seconds) past which a `retry_attempts` row is
 * safe to delete: the largest cooldown reported by the two limiter modules,
 * plus the fixed safety margin. Each limiter caches its env-var value at
 * module load (a process restart is required to pick up an env-var change),
 * so this returns a stable value within a process lifetime — the safety
 * margin is what protects in-flight cooldowns across cooldown bumps.
 */
export function computeRetryAttemptsCutoffSeconds(): number {
  const docsCooldown = Math.max(0, getRetryCooldownSeconds());
  const supportCooldown = Math.max(0, getSupportReplyRetryCooldownSeconds());
  const largest = Math.max(docsCooldown, supportCooldown);
  return largest + SAFETY_MARGIN_SECONDS;
}

/**
 * Run a single cleanup cycle. Deletes every `retry_attempts` row whose
 * `last_attempt_at` is older than `cutoffSeconds` ago. Returns the number
 * of rows removed and the cutoff used. Errors are logged and counted as a
 * zero-row cycle so the periodic loop keeps ticking on transient failures.
 */
export async function runRetryAttemptsCleanupCycle(
  options: { cutoffSeconds?: number } = {},
): Promise<RetryAttemptsCleanupResult> {
  const cutoffSeconds = Math.max(1, options.cutoffSeconds ?? computeRetryAttemptsCutoffSeconds());

  let deleted = 0;
  try {
    const pool = getPlatformPool();
    // The `retry_attempts_last_attempt_at_idx` index added by
    // migration 071 makes this DELETE cheap — Postgres can use the index
    // to find expired rows without scanning the whole table.
    const r = await pool.query(
      `DELETE FROM retry_attempts
        WHERE last_attempt_at < NOW() - make_interval(secs => $1::int)`,
      [cutoffSeconds],
    );
    deleted = r.rowCount ?? 0;
  } catch (err) {
    logger.error('Failed to garbage-collect retry_attempts rows', {
      error: err instanceof Error ? err.message : String(err),
      cutoffSeconds,
    });
    return { deleted: 0, cutoffSeconds };
  }

  if (deleted > 0) {
    logger.info('Retry attempts cleanup cycle removed stale rows', {
      deleted,
      cutoffSeconds,
    });
  } else {
    logger.debug('Retry attempts cleanup cycle found no stale rows', {
      cutoffSeconds,
    });
  }

  return { deleted, cutoffSeconds };
}

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

export function startRetryAttemptsCleanupScheduler(
  intervalMs: number = DEFAULT_INTERVAL_MS,
): void {
  if (timer) return;

  initialTimer = setTimeout(() => {
    runRetryAttemptsCleanupCycle().catch((err) => {
      logger.error('Initial retry attempts cleanup cycle failed', {
        error: String(err),
      });
    });
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    runRetryAttemptsCleanupCycle().catch((err) => {
      logger.error('Retry attempts cleanup cycle failed', {
        error: String(err),
      });
    });
  }, intervalMs);

  logger.info('Retry attempts cleanup scheduler started', {
    intervalMs,
    safetyMarginSeconds: SAFETY_MARGIN_SECONDS,
  });
}

export function stopRetryAttemptsCleanupScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Retry attempts cleanup scheduler stopped');
  }
}

export const RETRY_ATTEMPTS_CLEANUP_DEFAULTS = {
  intervalMs: DEFAULT_INTERVAL_MS,
  initialDelayMs: INITIAL_DELAY_MS,
  safetyMarginSeconds: SAFETY_MARGIN_SECONDS,
} as const;
