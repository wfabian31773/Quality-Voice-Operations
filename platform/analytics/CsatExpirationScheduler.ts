/**
 * Periodic background sweeper that flips `pending` CSAT survey rows whose
 * `expires_at` has passed to `status = 'expired'`.
 *
 * `expireStaleCsatRequests()` already exists in `CsatSurveyService` to do
 * the actual UPDATE — this module is the missing scheduler that runs it
 * on an interval. Without a periodic call the `call_csat_responses` table
 * accumulates "pending forever" rows for calls the customer never replied
 * to, which skews operational dashboards and keeps the partial unique
 * index occupied indefinitely.
 *
 * Wiring: this scheduler is started by `server/admin-api/start.ts`
 * alongside the other analytics-area schedulers (GIN, milestones, etc.).
 * In a horizontally-scaled deployment every admin instance runs its own
 * cycle — that is intentionally simple, because the UPDATE is idempotent
 * (a row already flipped to `expired` is no longer matched by the WHERE
 * clause) and the cost of N instances occasionally racing on the same
 * batch is trivial compared with coordinating a leader lease.
 */
import { createLogger } from '../core/logger';
import { expireStaleCsatRequests } from './CsatSurveyService';

const logger = createLogger('CSAT_EXPIRATION');

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1h
const INITIAL_DELAY_MS = 5 * 60 * 1000;     // wait 5 min after boot

export interface CsatExpirationCycleResult {
  expired: number;
}

/**
 * Run a single expiration cycle. Returns the number of rows flipped to
 * `expired`. Errors are logged and counted as a zero-row cycle so the
 * periodic loop keeps ticking on transient failures.
 */
export async function runCsatExpirationCycle(): Promise<CsatExpirationCycleResult> {
  let expired = 0;
  try {
    expired = await expireStaleCsatRequests();
  } catch (err) {
    logger.error('Failed to expire stale CSAT requests', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { expired: 0 };
  }

  if (expired > 0) {
    logger.info('CSAT expiration cycle flipped stale pending rows', { expired });
  } else {
    logger.debug('CSAT expiration cycle found no stale rows', { expired });
  }

  return { expired };
}

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

export function startCsatExpirationScheduler(
  intervalMs: number = DEFAULT_INTERVAL_MS,
): void {
  if (timer) return;

  initialTimer = setTimeout(() => {
    runCsatExpirationCycle().catch((err) => {
      logger.error('Initial CSAT expiration cycle failed', {
        error: String(err),
      });
    });
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    runCsatExpirationCycle().catch((err) => {
      logger.error('CSAT expiration cycle failed', {
        error: String(err),
      });
    });
  }, intervalMs);

  logger.info('CSAT expiration scheduler started', { intervalMs });
}

export function stopCsatExpirationScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('CSAT expiration scheduler stopped');
  }
}

export const CSAT_EXPIRATION_DEFAULTS = {
  intervalMs: DEFAULT_INTERVAL_MS,
  initialDelayMs: INITIAL_DELAY_MS,
} as const;
