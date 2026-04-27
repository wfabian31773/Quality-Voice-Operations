/**
 * Read-only Platform Admin endpoint that surfaces the state of the
 * `call_events` partition retention worker (CallEventsRetentionScheduler,
 * BL-044). The endpoint joins three signals so an on-call engineer can
 * confirm at a glance that:
 *
 *   1. The daily worker actually ran recently (no silent failure).
 *   2. Next month's partition is pre-created so the month-boundary INSERT
 *      from the voice gateway will not 23514 / "no partition of relation".
 *   3. No partitions were silently dropped today that we did not expect.
 *
 * Source data:
 *   - `call_events_retention_runs` (migration 081) — append-only history
 *     written by the scheduler at the end of every cycle.
 *   - `pg_inherits` / `pg_class` — current partition list with the bounds
 *     parsed back into ISO timestamps for the UI table.
 *   - `CALL_EVENTS_RETENTION_DEFAULTS` — same constants the scheduler uses
 *     so the "stale alert" threshold (interval + grace) stays in sync.
 *
 * No mutations are exposed: the worker is fully autonomous; if an admin
 * needs to force a cycle they can restart the API process.
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';
import { getPlatformPool } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';
import { CALL_EVENTS_RETENTION_DEFAULTS } from '../../../platform/billing/CallEventsRetentionScheduler';

const router = Router();
const logger = createLogger('PLATFORM_CALL_EVENTS_RETENTION');

interface RetentionRunRow {
  id: string;
  started_at: string;
  finished_at: string | null;
  status: 'success' | 'failure';
  retention_days: number;
  ensured_partitions: string[];
  dropped_partitions: string[];
  error_message: string | null;
}

interface PartitionRow {
  name: string;
  lower_bound: string | null;
  upper_bound: string | null;
}

interface CallEventsRetentionResponse {
  retentionDays: number;
  intervalMs: number;
  staleAfterMs: number;
  expected: {
    currentMonthPartition: string;
    nextMonthPartition: string;
  };
  partitions: PartitionRow[];
  partitionsExist: {
    currentMonth: boolean;
    nextMonth: boolean;
  };
  lastRun: RetentionRunRow | null;
  lastSuccessfulRun: RetentionRunRow | null;
  recentRuns: RetentionRunRow[];
  status: {
    healthy: boolean;
    stale: boolean;
    missingNextMonth: boolean;
    lastRunFailed: boolean;
    neverRan: boolean;
    reasons: string[];
  };
}

// We give the daily worker a 2-hour grace window beyond its scheduled
// interval before flagging the cycle as "stale" — the task spec calls out
// 26h as the threshold (24h interval + 2h grace), and that's what we use
// here so the alert lines up with the operational expectation in the
// runbook.
const STALE_GRACE_MS = 2 * 60 * 60 * 1000;

function expectedPartitionName(monthOffset: number): string {
  const target = new Date();
  target.setUTCDate(1);
  target.setUTCHours(0, 0, 0, 0);
  target.setUTCMonth(target.getUTCMonth() + monthOffset);
  const yyyy = target.getUTCFullYear();
  const mm = String(target.getUTCMonth() + 1).padStart(2, '0');
  return `call_events_${yyyy}_${mm}`;
}

// pg_get_expr returns the partition bound expression. The most common
// form is the bare-literal one Postgres emits when the bound was created
// with a date string:
//   FOR VALUES FROM ('2025-07-01') TO ('2025-08-01')
// but depending on the server version and the column type it may add
// explicit casts and surrounding parens, e.g.
//   FOR VALUES FROM (('2025-07-01'::date)) TO (('2025-08-01'::date))
//   FOR VALUES FROM ('2025-07-01 00:00:00+00'::timestamp with time zone)
//                 TO ('2025-08-01 00:00:00+00'::timestamp with time zone)
// We tolerate any combination of the optional outer paren, the quoted
// literal, and the optional `::type` cast so the UI keeps showing real
// timestamps instead of falling back to "—" the next time Postgres
// changes its formatter.
const PARTITION_BOUND_LITERAL = /\(+\s*'([^']+)'(?:\s*::[\w ]+)?\s*\)+/g;

function parsePartitionBounds(expr: string | null): { lower: string | null; upper: string | null } {
  if (!expr) return { lower: null, upper: null };
  const fromIdx = expr.indexOf('FROM');
  const toIdx = expr.indexOf('TO', fromIdx >= 0 ? fromIdx : 0);
  if (fromIdx < 0 || toIdx < 0) return { lower: null, upper: null };

  const fromSegment = expr.slice(fromIdx, toIdx);
  const toSegment = expr.slice(toIdx);

  // Reset the global regex's lastIndex between segment matches.
  PARTITION_BOUND_LITERAL.lastIndex = 0;
  const fromMatch = PARTITION_BOUND_LITERAL.exec(fromSegment);
  PARTITION_BOUND_LITERAL.lastIndex = 0;
  const toMatch = PARTITION_BOUND_LITERAL.exec(toSegment);

  return {
    lower: fromMatch ? fromMatch[1] : null,
    upper: toMatch ? toMatch[1] : null,
  };
}

router.get(
  '/platform/call-events-retention',
  requireAuth,
  requirePlatformAdmin,
  async (_req, res) => {
    try {
      const pool = getPlatformPool();

      const partitionsResult = await pool.query<{ name: string; bounds: string | null }>(
        `SELECT child.relname AS name,
                pg_get_expr(child.relpartbound, child.oid) AS bounds
           FROM pg_inherits i
           JOIN pg_class child  ON child.oid  = i.inhrelid
           JOIN pg_class parent ON parent.oid = i.inhparent
          WHERE parent.relname = 'call_events'
          ORDER BY child.relname`,
      );

      const partitions: PartitionRow[] = partitionsResult.rows.map((row) => {
        const { lower, upper } = parsePartitionBounds(row.bounds);
        return { name: row.name, lower_bound: lower, upper_bound: upper };
      });

      const recentRunsResult = await pool.query<RetentionRunRow>(
        `SELECT id::text         AS id,
                started_at,
                finished_at,
                status,
                retention_days,
                ensured_partitions,
                dropped_partitions,
                error_message
           FROM call_events_retention_runs
          ORDER BY started_at DESC
          LIMIT 10`,
      );

      const recentRuns = recentRunsResult.rows;
      const lastRun = recentRuns[0] ?? null;
      const lastSuccessfulRun = recentRuns.find((r) => r.status === 'success') ?? null;

      const currentMonthName = expectedPartitionName(0);
      const nextMonthName = expectedPartitionName(1);
      const partitionNames = new Set(partitions.map((p) => p.name));
      const currentMonthExists = partitionNames.has(currentMonthName);
      const nextMonthExists = partitionNames.has(nextMonthName);

      const staleAfterMs = CALL_EVENTS_RETENTION_DEFAULTS.intervalMs + STALE_GRACE_MS;
      const lastSuccessAt = lastSuccessfulRun
        ? new Date(lastSuccessfulRun.finished_at ?? lastSuccessfulRun.started_at).getTime()
        : null;
      const stale =
        lastSuccessAt === null || Date.now() - lastSuccessAt > staleAfterMs;
      const lastRunFailed = lastRun?.status === 'failure';
      const neverRan = lastRun === null;
      const missingNextMonth = !nextMonthExists;

      const reasons: string[] = [];
      if (neverRan) reasons.push('No retention cycle has been recorded yet');
      else if (stale) reasons.push('Last successful cycle is older than 26 hours');
      if (lastRunFailed) reasons.push('Most recent cycle failed');
      if (missingNextMonth) reasons.push(`Next month's partition (${nextMonthName}) is missing`);

      const response: CallEventsRetentionResponse = {
        retentionDays: CALL_EVENTS_RETENTION_DEFAULTS.retainDays,
        intervalMs: CALL_EVENTS_RETENTION_DEFAULTS.intervalMs,
        staleAfterMs,
        expected: {
          currentMonthPartition: currentMonthName,
          nextMonthPartition: nextMonthName,
        },
        partitions,
        partitionsExist: {
          currentMonth: currentMonthExists,
          nextMonth: nextMonthExists,
        },
        lastRun,
        lastSuccessfulRun,
        recentRuns,
        status: {
          healthy: reasons.length === 0,
          stale,
          missingNextMonth,
          lastRunFailed,
          neverRan,
          reasons,
        },
      };

      return res.json(response);
    } catch (err) {
      logger.error('Failed to load call_events retention status', {
        error: String(err),
      });
      return res
        .status(500)
        .json({ error: 'Failed to load call_events retention status' });
    }
  },
);

export default router;
