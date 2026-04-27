/**
 * Daily background worker that maintains the monthly partitions on
 * `call_events` (created in migrations/078_call_events_partition_and_usage_metrics_index.sql)
 * so the table never grows unbounded.
 *
 * On every cycle the worker:
 *   1. Calls ensure_call_events_partition() for the current and next month so
 *      there is always a partition ready to receive INSERTs from the voice
 *      gateway as the clock crosses a month boundary.
 *   2. Calls prune_call_events_older_than(retainDays) to DROP every monthly
 *      partition whose entire range is older than the retention window
 *      (default 90 days, per BL-044 / docs/audit/05-integration-and-performance.md
 *      finding I-24).
 *   3. Records a row in `call_events_retention_runs` (migration 081) so the
 *      Platform Admin console can show "the prune ran today" / "next month's
 *      partition is ready" without anyone having to shell into the database.
 *
 * Both DB helpers are idempotent so concurrent workers cannot corrupt the
 * partition layout — at worst they DROP the same already-removed partition
 * (handled with IF EXISTS inside the function) or attempt to CREATE one that
 * a peer just made (the existence check inside the helper is a no-op in that
 * case).
 */

import { createLogger } from '../core/logger';
import { getPlatformPool } from '../db';

const logger = createLogger('CALL_EVENTS_RETENTION');

const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day
const INITIAL_DELAY_MS = 60 * 1000; // wait 1 min after boot to avoid colliding with migrations

export interface CallEventsRetentionResult {
  ensured: string[];
  dropped: string[];
}

export async function runCallEventsRetentionCycle(
  retainDays: number = DEFAULT_RETENTION_DAYS,
): Promise<CallEventsRetentionResult> {
  const pool = getPlatformPool();
  const ensured: string[] = [];
  const startedAt = new Date();

  try {
    // Ensure both this month and next month have a partition. We always create
    // both so the boundary crossing at month-end never fails an INSERT.
    for (const offsetMonths of [0, 1]) {
      const target = new Date();
      target.setUTCDate(1);
      target.setUTCHours(0, 0, 0, 0);
      target.setUTCMonth(target.getUTCMonth() + offsetMonths);

      const { rows } = await pool.query<{ ensure_call_events_partition: string }>(
        'SELECT ensure_call_events_partition($1::timestamptz) AS ensure_call_events_partition',
        [target.toISOString()],
      );
      if (rows[0]?.ensure_call_events_partition) {
        ensured.push(rows[0].ensure_call_events_partition);
      }
    }

    const { rows: pruneRows } = await pool.query<{ prune_call_events_older_than: string[] }>(
      'SELECT prune_call_events_older_than($1::int) AS prune_call_events_older_than',
      [retainDays],
    );
    const dropped = pruneRows[0]?.prune_call_events_older_than ?? [];

    if (dropped.length > 0) {
      logger.info('Pruned call_events partitions older than retention window', {
        retainDays,
        dropped,
      });
    }

    logger.debug('call_events retention cycle complete', {
      retainDays,
      ensured,
      droppedCount: dropped.length,
    });

    await recordRetentionRun({
      startedAt,
      status: 'success',
      retentionDays: retainDays,
      ensured,
      dropped,
    });

    return { ensured, dropped };
  } catch (err) {
    // Best-effort bookkeeping: never let the audit insert mask the original
    // failure. If the bookkeeping write itself fails (e.g. migration 081 has
    // not run yet on a fresh deploy) we log and rethrow the original error
    // so the scheduler still surfaces the real problem.
    await recordRetentionRun({
      startedAt,
      status: 'failure',
      retentionDays: retainDays,
      ensured,
      dropped: [],
      errorMessage: err instanceof Error ? err.message : String(err),
    }).catch((bookErr) => {
      logger.error('Failed to record call_events retention failure', {
        error: String(bookErr),
      });
    });
    throw err;
  }
}

interface RecordRetentionRunInput {
  startedAt: Date;
  status: 'success' | 'failure';
  retentionDays: number;
  ensured: string[];
  dropped: string[];
  errorMessage?: string;
}

async function recordRetentionRun(input: RecordRetentionRunInput): Promise<void> {
  const pool = getPlatformPool();
  try {
    await pool.query(
      `INSERT INTO call_events_retention_runs
         (started_at, finished_at, status, retention_days,
          ensured_partitions, dropped_partitions, error_message)
       VALUES ($1, NOW(), $2, $3, $4::text[], $5::text[], $6)`,
      [
        input.startedAt.toISOString(),
        input.status,
        input.retentionDays,
        input.ensured,
        input.dropped,
        input.errorMessage ?? null,
      ],
    );
  } catch (err) {
    // Don't take down the cycle just because we couldn't write to the audit
    // table — a failure-to-record is logged and surfaced via the staleness
    // alert in the admin console (the Last Run timestamp simply won't refresh).
    logger.error('Failed to record call_events retention run', {
      status: input.status,
      error: String(err),
    });
    if (input.status === 'failure') {
      // Re-raise on failure path so the caller's catch can swallow/log it
      // alongside the original error chain.
      throw err;
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

export function startCallEventsRetentionScheduler(
  intervalMs: number = DEFAULT_INTERVAL_MS,
  retainDays: number = DEFAULT_RETENTION_DAYS,
): void {
  if (timer) return;

  initialTimer = setTimeout(() => {
    runCallEventsRetentionCycle(retainDays).catch((err) => {
      logger.error('Initial call_events retention cycle failed', { error: String(err) });
    });
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    runCallEventsRetentionCycle(retainDays).catch((err) => {
      logger.error('call_events retention cycle failed', { error: String(err) });
    });
  }, intervalMs);

  logger.info('call_events retention scheduler started', { intervalMs, retainDays });
}

export function stopCallEventsRetentionScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('call_events retention scheduler stopped');
  }
}

export const CALL_EVENTS_RETENTION_DEFAULTS = {
  intervalMs: DEFAULT_INTERVAL_MS,
  retainDays: DEFAULT_RETENTION_DAYS,
} as const;
