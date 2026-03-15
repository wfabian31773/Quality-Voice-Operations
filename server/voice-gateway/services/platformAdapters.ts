import { getPlatformPool, withTenantContext } from '../../../platform/db';
import type { CallerMemoryStorage, CallHistoryRecord } from '../../../platform/infra/memory/CallerMemoryService';
import type { OutboxPersistenceAdapter, OutboxIntegrationAdapter } from '../../../platform/integrations/outbox/OutboxService';
import { connectorService } from '../../../platform/integrations/connectors';
import type { TenantId } from '../../../platform/core/types';
import { randomUUID } from 'crypto';
import { createLogger } from '../../../platform/core/logger';

const logger = createLogger('PLATFORM_ADAPTERS');

interface DbClient {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
}

async function withTenant<T>(tenantId: string, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const result = await fn(client as unknown as DbClient);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export function createCallerMemoryStorage(): CallerMemoryStorage {
  return {
    async getCallHistoryByPhone(
      tenantId: TenantId,
      phone: string,
      limit: number,
    ): Promise<CallHistoryRecord[]> {
      return withTenant(tenantId, async (client) => {
        const e164 = phone.startsWith('+') ? phone : `+1${phone}`;
        const digits10 = phone.replace(/\D/g, '').replace(/^1(\d{10})$/, '$1');
        const { rows } = await client.query(
          `SELECT
             created_at AS "createdAt",
             context->>'callReason' AS "callReason",
             context->>'agentOutcome' AS "agentOutcome",
             context->>'ticketNumber' AS "ticketNumber",
             agent_id AS "agentUsed",
             duration_seconds AS "durationSeconds",
             context->>'preferredContactMethod' AS "preferredContactMethod",
             context->>'patientName' AS "patientName",
             context->>'patientDob' AS "patientDob",
             context->>'lastProviderSeen' AS "lastProviderSeen",
             context->>'lastLocationSeen' AS "lastLocationSeen"
           FROM call_sessions
           WHERE tenant_id = $1
             AND (caller_number = $2 OR caller_number = $3 OR caller_number = $4)
           ORDER BY created_at DESC
           LIMIT $5`,
          [tenantId, phone, e164, digits10, limit],
        );
        return rows as unknown as CallHistoryRecord[];
      });
    },
  };
}

export function createOutboxAdapters(): {
  persistence: OutboxPersistenceAdapter;
  integration: OutboxIntegrationAdapter;
} {
  const persistence: OutboxPersistenceAdapter = {
    async insert(params) {
      return withTenant(params.tenantId, async (client) => {
        const id = randomUUID();
        await client.query(
          `INSERT INTO outbox_messages
             (id, tenant_id, idempotency_key, call_sid, call_log_id, payload, status, max_retries, next_retry_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
          [
            id,
            params.tenantId,
            params.idempotencyKey ?? null,
            params.callSid ?? null,
            params.callLogId ?? null,
            JSON.stringify(params.payload),
            params.status,
            params.maxRetries,
            params.nextRetryAt,
          ],
        );
        return { id };
      });
    },

    async findByIdempotencyKey(tenantId: TenantId, key: string) {
      return withTenant(tenantId, async (client) => {
        const { rows } = await client.query(
          `SELECT id, status, context->>'ticketNumber' AS "ticketNumber"
           FROM outbox_messages WHERE tenant_id = $1 AND idempotency_key = $2 LIMIT 1`,
          [tenantId, key],
        );
        if (!rows[0]) return null;
        return {
          id: rows[0].id as string,
          status: rows[0].status as string,
          ticketNumber: rows[0].ticketNumber as string | undefined,
        };
      });
    },

    async claimForSending(tenantId: TenantId, outboxId: string, leaseTimeoutMs: number) {
      return withTenant(tenantId, async (client) => {
        const leaseExpiry = new Date(Date.now() + leaseTimeoutMs);
        const { rows } = await client.query(
          `UPDATE outbox_messages
           SET status = 'sending', lease_expires_at = $3, updated_at = NOW()
           WHERE tenant_id = $1 AND id = $2 AND status IN ('pending', 'retry')
           RETURNING id, retry_count AS "retryCount", payload`,
          [tenantId, outboxId, leaseExpiry],
        );
        if (rows.length === 0) return null;
        const row = rows[0];
        return {
          id: row.id as string,
          retryCount: (row.retryCount as number) ?? 0,
          payload: typeof row.payload === 'string' ? JSON.parse(row.payload as string) : row.payload,
        };
      });
    },

    async claimRetries(tenantId: TenantId, leaseTimeoutMs: number, now: Date) {
      return withTenant(tenantId, async (client) => {
        const leaseExpiry = new Date(now.getTime() + leaseTimeoutMs);
        const { rows } = await client.query(
          `UPDATE outbox_messages
           SET status = 'sending', lease_expires_at = $3, updated_at = NOW()
           WHERE tenant_id = $1 AND status = 'retry' AND next_retry_at <= $2
           RETURNING id, retry_count AS "retryCount", payload`,
          [tenantId, now, leaseExpiry],
        );
        return rows.map((r: Record<string, unknown>) => ({
          id: r.id as string,
          retryCount: (r.retryCount as number) ?? 0,
          payload: typeof r.payload === 'string' ? JSON.parse(r.payload as string) : r.payload,
        }));
      });
    },

    async markSent(tenantId: TenantId, outboxId: string, ticketNumber: string, externalId?: string) {
      await withTenant(tenantId, async (client) => {
        await client.query(
          `UPDATE outbox_messages
           SET status = 'sent', context = jsonb_build_object('ticketNumber', $3::text, 'externalId', $4::text), updated_at = NOW()
           WHERE tenant_id = $1 AND id = $2`,
          [tenantId, outboxId, ticketNumber, externalId ?? null],
        );
      });
    },

    async markFailed(tenantId: TenantId, outboxId: string, retryCount: number, error: string, nextRetryAt: Date | null, isDead: boolean) {
      await withTenant(tenantId, async (client) => {
        const newStatus = isDead ? 'dead_letter' : 'retry';
        await client.query(
          `UPDATE outbox_messages
           SET status = $3, retry_count = $4, last_error = $5, next_retry_at = $6, updated_at = NOW()
           WHERE tenant_id = $1 AND id = $2`,
          [tenantId, outboxId, newStatus, retryCount, error, nextRetryAt],
        );
      });
    },

    async getStats(tenantId: TenantId) {
      return withTenant(tenantId, async (client) => {
        const { rows } = await client.query(
          `SELECT status, COUNT(*)::int AS count FROM outbox_messages WHERE tenant_id = $1 GROUP BY status`,
          [tenantId],
        );
        const stats: Record<string, number> = {};
        for (const r of rows) {
          stats[r.status as string] = r.count as number;
        }
        return {
          pending: stats.pending ?? 0,
          sending: stats.sending ?? 0,
          sent: stats.sent ?? 0,
          failed: (stats.failed ?? 0) + (stats.retry ?? 0),
          deadLetter: stats.dead_letter ?? 0,
        };
      });
    },
  };

  const integration: OutboxIntegrationAdapter = {
    async send(tenantId: TenantId, payload: unknown) {
      const connectorPayload = payload as { type?: string; [key: string]: unknown };

      if (!connectorPayload || typeof connectorPayload.type !== 'string') {
        logger.warn('Outbox payload missing type — cannot route to connector', { tenantId });
        return { success: false, error: 'Payload missing type field' };
      }

      try {
        const result = await connectorService.executeByPayload(tenantId, connectorPayload as { type: string });
        return {
          success: result.success,
          ticketNumber: result.ticketNumber,
          externalId: result.externalId,
          error: result.error,
        };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.error('Connector execution failed', { tenantId, payloadType: connectorPayload.type, error });
        return { success: false, error };
      }
    },
  };

  return { persistence, integration };
}
