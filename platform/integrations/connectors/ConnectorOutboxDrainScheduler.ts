import type { PoolClient } from 'pg';
import { getPlatformPool } from '../../db';
import { createLogger } from '../../core/logger';
import { connectorService } from './ConnectorService';
import type { TenantId } from '../../core/types';
import type { ConnectorPayload, StandardEventType } from './types';

const logger = createLogger('CONNECTOR_OUTBOX_DRAIN');

const DEFAULT_INTERVAL_MS = 30_000;
const INITIAL_DELAY_MS = 5_000;
const DEFAULT_BATCH_LIMIT = 50;

const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;

interface OutboxRow {
  id: string;
  tenant_id: string;
  event_type: string;
  payload: ConnectorPayload | null;
  attempts: number;
  max_attempts: number;
}

function nextBackoffMs(attempts: number): number {
  const exp = Math.max(0, attempts - 1);
  const candidate = BACKOFF_BASE_MS * 2 ** exp;
  if (!Number.isFinite(candidate)) return BACKOFF_MAX_MS;
  return Math.min(candidate, BACKOFF_MAX_MS);
}

async function claimBatch(client: PoolClient, limit: number): Promise<OutboxRow[]> {
  await client.query('BEGIN');
  try {
    const { rows } = await client.query<OutboxRow>(
      `WITH claimed AS (
         SELECT id
           FROM outbox_events
          WHERE status IN ('pending', 'failed')
            AND attempts < max_attempts
            AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
            AND archived_at IS NULL
          ORDER BY next_attempt_at NULLS FIRST, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE outbox_events o
          SET status = 'processing',
              attempts = o.attempts + 1,
              updated_at = NOW()
         FROM claimed c
        WHERE o.id = c.id
       RETURNING o.id,
                 o.tenant_id,
                 o.event_type,
                 o.payload,
                 o.attempts,
                 o.max_attempts`,
      [limit],
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
            updated_at = NOW()
      WHERE id = $1`,
    [id, truncated, String(backoffMs)],
  );
  return 'failed';
}

export interface DrainCycleResult {
  claimed: number;
  delivered: number;
  failed: number;
  deadLettered: number;
}

export async function runConnectorOutboxDrainCycle(
  options: { batchLimit?: number } = {},
): Promise<DrainCycleResult> {
  const limit = Math.max(1, options.batchLimit ?? DEFAULT_BATCH_LIMIT);
  const pool = getPlatformPool();
  const result: DrainCycleResult = {
    claimed: 0,
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
    claimed = await claimBatch(client, limit);
  } catch (err) {
    logger.error('Failed to claim outbox batch', { error: String(err) });
    client.release();
    return result;
  } finally {
    // claimBatch commits/rolls-back; release here is for the post-claim path.
  }
  client.release();

  result.claimed = claimed.length;
  if (claimed.length === 0) return result;

  for (const row of claimed) {
    const tenantId = row.tenant_id as TenantId;
    const eventType = row.event_type as StandardEventType;
    const payload = (row.payload ?? {}) as ConnectorPayload;
    try {
      const dispatch = await connectorService.dispatchEvent(tenantId, eventType, payload);
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

  logger.info('Connector outbox drain scheduler started', { intervalMs });
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

export const __test = {
  nextBackoffMs,
};
