import type { PoolClient } from 'pg';
import { getPlatformPool } from '../../db';
import { createLogger } from '../../core/logger';
import { writeAuditLog } from '../../audit/AuditService';
import { connectorService } from './ConnectorService';
import type { TenantId } from '../../core/types';
import type { ConnectorPayload, StandardEventType } from './types';

const logger = createLogger('CONNECTOR_OUTBOX_DRAIN');

const DEFAULT_INTERVAL_MS = 30_000;
const INITIAL_DELAY_MS = 5_000;
const DEFAULT_BATCH_LIMIT = 50;

// Cleanup of soft-archived outbox rows. Rows are archived (instead of
// deleted) when an admin clicks "Mark resolved" on a dead-letter row in the
// Stuck connector messages panel — that preserves the payload for forensics
// but means the table grows unbounded unless we age them out. The sweep
// hard-deletes any archived row older than the retention window.
const DEFAULT_ARCHIVE_RETENTION_DAYS = 90;
// Sweep daily by default. The work is one DELETE so it's cheap, but there's
// no value in running it more often than once a day.
const DEFAULT_ARCHIVE_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INITIAL_ARCHIVE_SWEEP_DELAY_MS = 60_000;

const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;

// How long a worker is allowed to hold a claim before the row is considered
// abandoned and eligible to be reclaimed by another drain cycle. Defaults to
// 5 minutes which is comfortably longer than any single connector dispatch
// (HTTP timeouts in the adapters are <60s) but short enough that a crashed
// worker doesn't strand a customer's CRM/Slack/Zapier event for long.
const DEFAULT_LEASE_DURATION_MS = 5 * 60 * 1000;

function leaseDurationMs(): number {
  const raw = process.env.CONNECTOR_OUTBOX_LEASE_MS;
  if (!raw) return DEFAULT_LEASE_DURATION_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LEASE_DURATION_MS;
  return Math.floor(parsed);
}

function archiveRetentionDays(): number {
  const raw = process.env.OUTBOX_ARCHIVE_RETENTION_DAYS;
  if (!raw) return DEFAULT_ARCHIVE_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_ARCHIVE_RETENTION_DAYS;
  return Math.floor(parsed);
}

interface OutboxRow {
  id: string;
  tenant_id: string;
  event_type: string;
  payload: ConnectorPayload | null;
  attempts: number;
  max_attempts: number;
  prior_status: string;
}

function nextBackoffMs(attempts: number): number {
  const exp = Math.max(0, attempts - 1);
  const candidate = BACKOFF_BASE_MS * 2 ** exp;
  if (!Number.isFinite(candidate)) return BACKOFF_MAX_MS;
  return Math.min(candidate, BACKOFF_MAX_MS);
}

async function claimBatch(
  client: PoolClient,
  limit: number,
  leaseMs: number,
): Promise<OutboxRow[]> {
  await client.query('BEGIN');
  try {
    // The CTE selects two kinds of rows:
    //   1. Fresh work: pending/failed rows whose backoff has elapsed.
    //   2. Abandoned work: 'processing' rows whose lease_expires_at has
    //      passed — these belong to a worker that crashed mid-flight.
    // We capture `prior_status` so the caller can count reclaims for
    // observability, then atomically transition every selected row to
    // 'processing' with a fresh lease.
    const { rows } = await client.query<OutboxRow>(
      `WITH claimed AS (
         SELECT id, status AS prior_status
           FROM outbox_events
          WHERE attempts < max_attempts
            AND archived_at IS NULL
            AND (
              (
                status IN ('pending', 'failed')
                AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
              )
              OR (
                status = 'processing'
                AND lease_expires_at IS NOT NULL
                AND lease_expires_at <= NOW()
              )
            )
          ORDER BY next_attempt_at NULLS FIRST, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE outbox_events o
          SET status = 'processing',
              attempts = o.attempts + 1,
              claimed_at = NOW(),
              lease_expires_at = NOW() + ($2 || ' milliseconds')::interval,
              updated_at = NOW()
         FROM claimed c
        WHERE o.id = c.id
       RETURNING o.id,
                 o.tenant_id,
                 o.event_type,
                 o.payload,
                 o.attempts,
                 o.max_attempts,
                 c.prior_status`,
      [limit, String(leaseMs)],
    );
    await client.query('COMMIT');
    return rows;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  }
}

async function markDelivered(id: string): Promise<void> {
  const pool = getPlatformPool();
  await pool.query(
    `UPDATE outbox_events
        SET status = 'delivered',
            delivered_at = NOW(),
            last_error = NULL,
            claimed_at = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [id],
  );
}

async function markFailure(
  id: string,
  attempts: number,
  maxAttempts: number,
  errorMessage: string,
): Promise<'failed' | 'dead_letter'> {
  const pool = getPlatformPool();
  const truncated = errorMessage.length > 4000 ? `${errorMessage.slice(0, 4000)}…` : errorMessage;
  const isDead = attempts >= maxAttempts;
  if (isDead) {
    await pool.query(
      `UPDATE outbox_events
          SET status = 'dead_letter',
              last_error = $2,
              claimed_at = NULL,
              lease_expires_at = NULL,
              updated_at = NOW()
        WHERE id = $1`,
      [id, truncated],
    );
    return 'dead_letter';
  }
  const backoffMs = nextBackoffMs(attempts);
  await pool.query(
    `UPDATE outbox_events
        SET status = 'failed',
            last_error = $2,
            next_attempt_at = NOW() + ($3 || ' milliseconds')::interval,
            claimed_at = NULL,
            lease_expires_at = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [id, truncated, String(backoffMs)],
  );
  return 'failed';
}

export interface DrainCycleResult {
  claimed: number;
  reclaimed: number;
  delivered: number;
  failed: number;
  deadLettered: number;
}

export async function runConnectorOutboxDrainCycle(
  options: { batchLimit?: number; leaseDurationMs?: number } = {},
): Promise<DrainCycleResult> {
  const limit = Math.max(1, options.batchLimit ?? DEFAULT_BATCH_LIMIT);
  const leaseMs = Math.max(1_000, options.leaseDurationMs ?? leaseDurationMs());
  const pool = getPlatformPool();
  const result: DrainCycleResult = {
    claimed: 0,
    reclaimed: 0,
    delivered: 0,
    failed: 0,
    deadLettered: 0,
  };

  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (err) {
    logger.error('Failed to acquire pg client for outbox drain', { error: String(err) });
    return result;
  }

  let claimed: OutboxRow[];
  try {
    claimed = await claimBatch(client, limit, leaseMs);
  } catch (err) {
    logger.error('Failed to claim outbox batch', { error: String(err) });
    client.release();
    return result;
  } finally {
    // claimBatch commits/rolls-back; release here is for the post-claim path.
  }
  client.release();

  result.claimed = claimed.length;
  result.reclaimed = claimed.filter((r) => r.prior_status === 'processing').length;
  if (result.reclaimed > 0) {
    logger.warn('Reclaimed outbox rows from crashed/stalled worker', {
      reclaimed: result.reclaimed,
      leaseMs,
      ids: claimed.filter((r) => r.prior_status === 'processing').map((r) => r.id),
    });
  }
  if (claimed.length === 0) return result;

  for (const row of claimed) {
    const tenantId = row.tenant_id as TenantId;
    const eventType = row.event_type as StandardEventType;
    const payload = (row.payload ?? {}) as ConnectorPayload;
    try {
      // bufferToOutbox: false — the row already exists (this drain owns it),
      // so we must not insert a fresh outbox row for the same event. The row
      // is updated in-place by markDelivered / markFailure below.
      const dispatch = await connectorService.dispatchEvent(tenantId, eventType, payload, {
        bufferToOutbox: false,
      });
      const allOk = dispatch.results.every((r) => r.success);
      if (dispatch.dispatched === 0 || allOk) {
        await markDelivered(row.id);
        result.delivered += 1;
        continue;
      }
      const firstError = dispatch.results.find((r) => !r.success)?.error
        ?? 'Connector dispatch reported failure with no error message';
      const status = await markFailure(row.id, row.attempts, row.max_attempts, firstError);
      if (status === 'dead_letter') result.deadLettered += 1;
      else result.failed += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        const status = await markFailure(row.id, row.attempts, row.max_attempts, message);
        if (status === 'dead_letter') result.deadLettered += 1;
        else result.failed += 1;
      } catch (writeErr) {
        logger.error('Failed to record outbox dispatch failure', {
          outboxId: row.id,
          tenantId: row.tenant_id,
          error: String(writeErr),
          dispatchError: message,
        });
      }
    }
  }

  logger.info('Outbox drain cycle complete', {
    claimed: result.claimed,
    reclaimed: result.reclaimed,
    delivered: result.delivered,
    failed: result.failed,
    deadLettered: result.deadLettered,
  });
  return result;
}

let timer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;

export function startConnectorOutboxDrainScheduler(intervalMs: number = DEFAULT_INTERVAL_MS): void {
  if (timer) return;

  initialTimer = setTimeout(() => {
    runConnectorOutboxDrainCycle().catch((err) => {
      logger.error('Initial connector outbox drain cycle failed', { error: String(err) });
    });
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    runConnectorOutboxDrainCycle().catch((err) => {
      logger.error('Connector outbox drain cycle failed', { error: String(err) });
    });
  }, intervalMs);

  logger.info('Connector outbox drain scheduler started', {
    intervalMs,
    leaseMs: leaseDurationMs(),
  });
}

export function stopConnectorOutboxDrainScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Connector outbox drain scheduler stopped');
  }
}

export interface OutboxArchiveSweepResult {
  deleted: number;
  retentionDays: number;
  perTenant: Array<{ tenantId: string; deleted: number }>;
}

/**
 * Hard-deletes `outbox_events` rows that were soft-archived more than the
 * configured retention window ago. Rows whose `archived_at` is NULL (i.e.
 * still part of the active set the drain worker / Stuck panel cares about)
 * are never touched. Counts are emitted as a structured log line and as
 * per-tenant audit log entries so the cleanup is auditable end-to-end.
 */
export async function runOutboxArchiveSweepCycle(
  options: { retentionDays?: number } = {},
): Promise<OutboxArchiveSweepResult> {
  const retentionDays = Math.max(1, options.retentionDays ?? archiveRetentionDays());
  const pool = getPlatformPool();
  const result: OutboxArchiveSweepResult = {
    deleted: 0,
    retentionDays,
    perTenant: [],
  };

  let rows: Array<{ tenant_id: string }>;
  try {
    const res = await pool.query<{ tenant_id: string }>(
      // Predicate is intentionally explicit: archived_at IS NOT NULL guards
      // active rows, and the interval comparison guards rows that were
      // archived more recently than the retention window. Both conditions
      // must hold — non-archived rows are never deleted by this sweep.
      `DELETE FROM outbox_events
        WHERE archived_at IS NOT NULL
          AND archived_at < NOW() - ($1 || ' days')::interval
       RETURNING tenant_id`,
      [String(retentionDays)],
    );
    rows = res.rows ?? [];
  } catch (err) {
    logger.error('Outbox archive sweep failed', {
      error: String(err),
      retentionDays,
    });
    return result;
  }

  result.deleted = rows.length;
  const perTenant = new Map<string, number>();
  for (const r of rows) {
    perTenant.set(r.tenant_id, (perTenant.get(r.tenant_id) ?? 0) + 1);
  }
  result.perTenant = Array.from(perTenant.entries()).map(([tenantId, deleted]) => ({
    tenantId,
    deleted,
  }));

  if (result.deleted === 0) {
    logger.info('Outbox archive sweep: nothing to delete', { retentionDays });
    return result;
  }

  logger.info('Outbox archive sweep complete', {
    deleted: result.deleted,
    retentionDays,
    tenants: result.perTenant.length,
  });

  // One audit entry per tenant so the cleanup shows up in each tenant's
  // audit feed alongside the original "Mark resolved" entries that produced
  // the archived rows.
  for (const { tenantId, deleted } of result.perTenant) {
    try {
      await writeAuditLog({
        tenantId,
        actorUserId: null,
        actorRole: 'system',
        action: 'connector.outbox_archive_swept',
        resourceType: 'outbox_event',
        severity: 'info',
        changes: { deleted, retentionDays },
      });
    } catch (err) {
      logger.warn('Failed to write outbox archive sweep audit entry', {
        tenantId,
        deleted,
        error: String(err),
      });
    }
  }

  return result;
}

let sweepTimer: NodeJS.Timeout | null = null;
let initialSweepTimer: NodeJS.Timeout | null = null;

export function startOutboxArchiveSweepScheduler(
  intervalMs: number = DEFAULT_ARCHIVE_SWEEP_INTERVAL_MS,
): void {
  if (sweepTimer) return;

  initialSweepTimer = setTimeout(() => {
    runOutboxArchiveSweepCycle().catch((err) => {
      logger.error('Initial outbox archive sweep failed', { error: String(err) });
    });
  }, INITIAL_ARCHIVE_SWEEP_DELAY_MS);

  sweepTimer = setInterval(() => {
    runOutboxArchiveSweepCycle().catch((err) => {
      logger.error('Outbox archive sweep failed', { error: String(err) });
    });
  }, intervalMs);

  logger.info('Outbox archive sweep scheduler started', {
    intervalMs,
    retentionDays: archiveRetentionDays(),
  });
}

export function stopOutboxArchiveSweepScheduler(): void {
  if (initialSweepTimer) {
    clearTimeout(initialSweepTimer);
    initialSweepTimer = null;
  }
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
    logger.info('Outbox archive sweep scheduler stopped');
  }
}

export const __test = {
  nextBackoffMs,
  leaseDurationMs,
  archiveRetentionDays,
  DEFAULT_LEASE_DURATION_MS,
  DEFAULT_ARCHIVE_RETENTION_DAYS,
  DEFAULT_ARCHIVE_SWEEP_INTERVAL_MS,
};
