import { createLogger } from '../../core/logger';
import type {
  OutboxWriteParams,
  OutboxWriteResult,
  OutboxSendResult,
  OutboxStats,
} from './types';
import type { TenantId } from '../../core/types';

const logger = createLogger('OUTBOX');

const MAX_RETRIES = 5;
const RETRY_BACKOFF_BASE_MS = 30_000;
const SENDING_LEASE_TIMEOUT_MS = 120_000;
const WORKER_INTERVAL_MS = 60_000;

export interface OutboxPersistenceAdapter {
  insert(params: OutboxWriteParams & { status: string; maxRetries: number; nextRetryAt: Date }): Promise<{ id: string } | null>;
  findByIdempotencyKey(tenantId: TenantId, key: string): Promise<{ id: string; status: string; ticketNumber?: string } | null>;
  claimForSending(tenantId: TenantId, outboxId: string, leaseTimeoutMs: number): Promise<{ id: string; retryCount: number; payload: unknown } | null>;
  claimRetries(tenantId: TenantId, leaseTimeoutMs: number, now: Date): Promise<Array<{ id: string; retryCount: number; payload: unknown }>>;
  markSent(tenantId: TenantId, outboxId: string, ticketNumber: string, externalId?: string): Promise<void>;
  markFailed(tenantId: TenantId, outboxId: string, retryCount: number, error: string, nextRetryAt: Date | null, isDead: boolean): Promise<void>;
  getStats(tenantId: TenantId): Promise<OutboxStats>;
}

export interface OutboxIntegrationAdapter {
  send(tenantId: TenantId, payload: unknown): Promise<{ success: boolean; ticketNumber?: string; externalId?: string; error?: string }>;
}

/**
 * Durable at-least-once delivery outbox for external integrations.
 *
 * Multi-tenant: every row is scoped to a tenantId. The integration target
 * (ticketing, CRM, etc.) is resolved from the tenant's config via the
 * OutboxIntegrationAdapter, not hardcoded.
 *
 * Pattern: transactional outbox with idempotency keys, exponential backoff,
 * sending lease, and dead-letter after MAX_RETRIES.
 */
export class OutboxService {
  private static workerTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: OutboxPersistenceAdapter,
    private readonly integration: OutboxIntegrationAdapter,
  ) {}

  async writeToOutbox(params: OutboxWriteParams): Promise<OutboxWriteResult> {
    const namespacedKey = params.idempotencyKey
      ? `tenant:${params.tenantId}:${params.idempotencyKey}`
      : undefined;

    if (namespacedKey) {
      const existing = await this.db.findByIdempotencyKey(params.tenantId, namespacedKey);
      if (existing) {
        logger.info(`Idempotent hit: ${namespacedKey} → ${existing.id}`, {
          tenantId: params.tenantId,
          event: 'outbox_idempotent',
        });
        return { outboxId: existing.id, idempotencyKey: namespacedKey, alreadyExists: true };
      }
    }

    const entry = await this.db.insert({
      ...params,
      idempotencyKey: namespacedKey,
      status: 'pending',
      maxRetries: MAX_RETRIES,
      nextRetryAt: new Date(),
    });

    if (!entry) {
      const fallback = namespacedKey
        ? await this.db.findByIdempotencyKey(params.tenantId, namespacedKey)
        : null;
      if (fallback) {
        return { outboxId: fallback.id, idempotencyKey: namespacedKey, alreadyExists: true };
      }
      throw new Error(`Failed to write outbox entry for tenant ${params.tenantId}`);
    }

    logger.info(`Outbox entry persisted: ${entry.id}`, {
      tenantId: params.tenantId,
      callSid: params.callSid,
      event: 'outbox_written',
    });

    return { outboxId: entry.id, idempotencyKey: namespacedKey, alreadyExists: false };
  }

  async attemptSend(tenantId: TenantId, outboxId: string): Promise<OutboxSendResult> {
    const claimed = await this.db.claimForSending(tenantId, outboxId, SENDING_LEASE_TIMEOUT_MS);

    if (!claimed) {
      return { success: false, error: 'Already being processed or not found', outboxId };
    }

    try {
      const result = await this.integration.send(tenantId, claimed.payload);

      if (result.success) {
        const deliveryRef = result.ticketNumber ?? result.externalId ?? outboxId;
        await this.db.markSent(tenantId, outboxId, deliveryRef, result.externalId);
        if (result.ticketNumber) {
          logger.ticketCreated({ tenantId, ticketId: result.ticketNumber, callId: outboxId });
        } else {
          logger.info(`Outbox delivery confirmed: ${outboxId}`, {
            tenantId,
            externalId: result.externalId,
            event: 'outbox_sent',
          });
        }
        return { success: true, ticketNumber: deliveryRef, outboxId };
      }

      return await this.markFailed(tenantId, outboxId, claimed.retryCount, result.error ?? 'Connector returned success=false');
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error(`Outbox send failed: ${outboxId}`, { tenantId, error });
      return await this.markFailed(tenantId, outboxId, claimed.retryCount, error);
    }
  }

  private async markFailed(
    tenantId: TenantId,
    outboxId: string,
    currentRetryCount: number,
    error: string,
  ): Promise<OutboxSendResult> {
    const newRetryCount = currentRetryCount + 1;
    const isDead = newRetryCount >= MAX_RETRIES;
    const nextRetryAt = isDead
      ? null
      : new Date(Date.now() + RETRY_BACKOFF_BASE_MS * Math.pow(2, newRetryCount - 1));

    await this.db.markFailed(tenantId, outboxId, newRetryCount, error, nextRetryAt, isDead);

    if (isDead) {
      logger.error(`Dead letter after ${MAX_RETRIES} retries: ${outboxId}`, {
        tenantId,
        error,
        event: 'outbox_dead_letter',
      });
    }

    return { success: false, error, outboxId };
  }

  async processRetries(tenantId: TenantId): Promise<number> {
    const claimed = await this.db.claimRetries(tenantId, SENDING_LEASE_TIMEOUT_MS, new Date());
    if (claimed.length === 0) return 0;

    logger.info(`Processing ${claimed.length} outbox retries`, { tenantId });

    let successCount = 0;
    for (const entry of claimed) {
      const result = await this.attemptSend(tenantId, entry.id);
      if (result.success) successCount++;
    }

    return successCount;
  }

  async getStats(tenantId: TenantId) {
    return this.db.getStats(tenantId);
  }

  startWorker(tenantIds: () => TenantId[]): void {
    if (OutboxService.workerTimer) return;
    OutboxService.workerTimer = setInterval(async () => {
      for (const tenantId of tenantIds()) {
        try {
          await this.processRetries(tenantId);
        } catch (err) {
          logger.error('Outbox worker error', { tenantId, error: String(err) });
        }
      }
    }, WORKER_INTERVAL_MS);
    logger.info(`Outbox retry worker started (${WORKER_INTERVAL_MS / 1000}s interval)`);
  }

  stopWorker(): void {
    if (OutboxService.workerTimer) {
      clearInterval(OutboxService.workerTimer);
      OutboxService.workerTimer = null;
    }
  }
}
