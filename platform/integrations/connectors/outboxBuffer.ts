import { randomUUID } from 'crypto';
import { withPrivilegedClient } from '../../db';
import { createLogger } from '../../core/logger';
import type { ConnectorPayload } from './types';
import type { TenantId } from '../../core/types';

const logger = createLogger('CONNECTOR_OUTBOX_BUFFER');

/**
 * How long the inline dispatch is allowed to run before the drain worker is
 * eligible to claim the same row. The grace window prevents a same-second
 * race where the drain picks up a row that the inline path is still actively
 * dispatching. After inline failure we explicitly reset `next_attempt_at` to
 * NOW() so the drain picks the row up on its next cycle.
 */
const OUTBOX_INLINE_GRACE_MS = 60_000;

const IDEMPOTENCY_KEY_MAX_LEN = 200;

export interface OutboxBufferResult {
  rowId: string | null;
  alreadyDelivered: boolean;
}

/**
 * Build a stable idempotency key for an outbound integration event so that
 * repeated dispatches of the same business event collapse into a single
 * outbox row. We try several payload fields in order of specificity and fall
 * back to a fresh UUID when no stable identifier is present (in which case
 * the row is unique by construction and offers durability without dedup).
 */
export function deriveOutboxIdempotencyKey(
  eventType: string,
  payload: ConnectorPayload,
): string {
  const p = payload as Record<string, unknown>;
  const candidates: string[] = [];

  const pick = (value: unknown): string => {
    if (typeof value !== 'string') return '';
    return value.trim();
  };

  for (const key of [
    'eventId',
    'appointmentId',
    'callSessionId',
    'callSid',
    'ticketId',
    'messageId',
  ]) {
    const v = pick(p[key]);
    if (v) candidates.push(`${key}=${v}`);
  }

  const stableKey = candidates.length > 0 ? candidates.join('|') : `random=${randomUUID()}`;
  const raw = `evt:${eventType}:${stableKey}`;
  return raw.length > IDEMPOTENCY_KEY_MAX_LEN ? raw.slice(0, IDEMPOTENCY_KEY_MAX_LEN) : raw;
}

interface RawClient {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] } | undefined | void>;
}

/**
 * Insert a `pending` row into `outbox_events` for this event so the drain
 * worker can recover it if the inline dispatch fails or the process dies.
 * Honours the table's `(tenant_id, idempotency_key)` uniqueness so repeated
 * fires of the same event collapse onto the existing row instead of creating
 * duplicates.
 *
 * Best-effort: any DB error is logged and surfaced as `{ rowId: null }` so
 * the inline dispatch path proceeds in degraded mode rather than failing
 * outright.
 */
export async function bufferOutboxEvent(
  tenantId: TenantId,
  eventType: string,
  idempotencyKey: string,
  payload: ConnectorPayload,
): Promise<OutboxBufferResult> {
  try {
    const result = await withPrivilegedClient(async (client) => {
      const rawClient = client as unknown as RawClient;
      const insert = await rawClient.query(
        `INSERT INTO outbox_events
           (tenant_id, idempotency_key, event_type, payload, status, next_attempt_at, attempts)
         VALUES ($1, $2, $3, $4::jsonb, 'pending', NOW() + ($5 || ' milliseconds')::interval, 0)
         ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
         RETURNING id`,
        [tenantId, idempotencyKey, eventType, JSON.stringify(payload), String(OUTBOX_INLINE_GRACE_MS)],
      );

      const insertRows = (insert?.rows ?? []) as Array<{ id: string }>;
      if (insertRows.length > 0) {
        return { rowId: insertRows[0].id, alreadyDelivered: false } satisfies OutboxBufferResult;
      }

      const existing = await rawClient.query(
        `SELECT id, status::text AS status
           FROM outbox_events
          WHERE tenant_id = $1 AND idempotency_key = $2
          LIMIT 1`,
        [tenantId, idempotencyKey],
      );
      const existingRows = (existing?.rows ?? []) as Array<{ id: string; status: string }>;
      if (existingRows.length === 0) {
        return { rowId: null, alreadyDelivered: false } satisfies OutboxBufferResult;
      }
      return {
        rowId: existingRows[0].id,
        alreadyDelivered: existingRows[0].status === 'delivered',
      } satisfies OutboxBufferResult;
    });

    return result ?? { rowId: null, alreadyDelivered: false };
  } catch (err) {
    logger.warn('Failed to buffer connector outbox event', {
      tenantId,
      eventType,
      idempotencyKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return { rowId: null, alreadyDelivered: false };
  }
}

/**
 * Mark a buffered outbox row as `delivered` after the inline dispatch
 * succeeded across every configured connector. Only updates the row when it
 * is still in a non-terminal state so we never resurrect a `dead_letter`
 * row or stomp on a concurrent drain transition.
 */
export async function markOutboxRowDelivered(rowId: string): Promise<void> {
  try {
    await withPrivilegedClient(async (client) => {
      const rawClient = client as unknown as RawClient;
      await rawClient.query(
        `UPDATE outbox_events
            SET status = 'delivered',
                delivered_at = NOW(),
                last_error = NULL,
                attempts = attempts + 1,
                updated_at = NOW()
          WHERE id = $1
            AND status IN ('pending', 'processing', 'failed')`,
        [rowId],
      );
    });
  } catch (err) {
    logger.warn('Failed to mark outbox row delivered', {
      rowId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Mark a buffered outbox row as `pending` after the inline dispatch reported
 * at least one failed connector. Resets `next_attempt_at` to NOW() so the
 * drain worker picks it up on its next cycle (one cycle = one drain pass).
 *
 * The row's attempt counter is incremented so the drain's backoff progression
 * accounts for the inline attempt, and `last_error` records the most recent
 * inline failure for operator diagnostics.
 */
export async function markOutboxRowPendingAfterInlineFailure(
  rowId: string,
  errorMessage: string,
): Promise<void> {
  const truncated = errorMessage.length > 4000
    ? `${errorMessage.slice(0, 4000)}…`
    : errorMessage;
  try {
    await withPrivilegedClient(async (client) => {
      const rawClient = client as unknown as RawClient;
      await rawClient.query(
        `UPDATE outbox_events
            SET status = 'pending',
                last_error = $2,
                next_attempt_at = NOW(),
                attempts = attempts + 1,
                updated_at = NOW()
          WHERE id = $1
            AND status NOT IN ('delivered', 'dead_letter')`,
        [rowId, truncated],
      );
    });
  } catch (err) {
    logger.warn('Failed to mark outbox row pending after inline failure', {
      rowId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export const __test = {
  OUTBOX_INLINE_GRACE_MS,
};
