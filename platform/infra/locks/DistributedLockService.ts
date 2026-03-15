import { EventEmitter } from 'events';
import { createLogger } from '../../core/logger';
import type { LockResult, DistributedLockOptions } from './types';

const logger = createLogger('DISTRIBUTED_LOCK');

const DEFAULT_TTL_SECONDS = 300;
const INSTANCE_ID = `${process.env.HOSTNAME ?? 'local'}-${process.pid}-${Date.now()}`;

/**
 * PostgreSQL-backed distributed lock with auto-refresh and EventEmitter notifications.
 *
 * Multi-tenant: lock names are namespaced as `tenant:<tenantId>:<lockName>` so tenants
 * cannot contend on each other's locks.
 *
 * The `db` dependency is injected to keep this module database-adapter-agnostic.
 * Pass the result of `import { db } from '<your db module>'`.
 */
export class DistributedLockService extends EventEmitter {
  private heldLocks = new Map<string, { lockId: string; refreshInterval: ReturnType<typeof setInterval> }>();

  constructor(
    private readonly db: {
      execute: (query: unknown) => Promise<{ rows: unknown[] }>;
    },
    private readonly sql: (strings: TemplateStringsArray, ...values: unknown[]) => unknown,
  ) {
    super();
  }

  private qualifyName(tenantId: string, lockName: string): string {
    return `tenant:${tenantId}:${lockName}`;
  }

  async acquireLock(tenantId: string, options: DistributedLockOptions): Promise<LockResult> {
    const { lockName: rawName, holderId, ttlSeconds = DEFAULT_TTL_SECONDS } = options;
    const lockName = this.qualifyName(tenantId, rawName);
    const fullHolderId = `${holderId}:${INSTANCE_ID}`;

    try {
      const now = new Date();
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

      const result = await this.db.execute(this.sql`
        INSERT INTO distributed_locks (lock_name, holder_id, acquired_at, expires_at)
        VALUES (${lockName}, ${fullHolderId}, ${now}, ${expiresAt})
        ON CONFLICT (lock_name) DO UPDATE SET
          holder_id = CASE
            WHEN distributed_locks.expires_at < ${now} THEN ${fullHolderId}
            ELSE distributed_locks.holder_id
          END,
          acquired_at = CASE
            WHEN distributed_locks.expires_at < ${now} THEN ${now}
            ELSE distributed_locks.acquired_at
          END,
          expires_at = CASE
            WHEN distributed_locks.expires_at < ${now} THEN ${expiresAt}
            ELSE distributed_locks.expires_at
          END
        RETURNING holder_id, expires_at
      `);

      const row = (result.rows as Record<string, unknown>[])[0];
      const acquired = row?.holder_id === fullHolderId;

      if (acquired) {
        logger.info(`Lock acquired: ${lockName}`, { lockName, expiresAt: expiresAt.toISOString() });

        const refreshInterval = setInterval(async () => {
          await this.refreshLock(lockName, fullHolderId, ttlSeconds);
        }, (ttlSeconds * 1000) / 2);

        this.heldLocks.set(lockName, { lockId: fullHolderId, refreshInterval });
        return { acquired: true, lockId: fullHolderId, expiresAt };
      }

      return {
        acquired: false,
        holder: row?.holder_id as string | undefined,
        expiresAt: row?.expires_at ? new Date(row.expires_at as string) : undefined,
      };
    } catch (error) {
      logger.error(`Failed to acquire lock: ${lockName}`, { lockName, error: String(error) });
      return { acquired: false };
    }
  }

  private async refreshLock(lockName: string, holderId: string, ttlSeconds: number): Promise<void> {
    try {
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
      const result = await this.db.execute(this.sql`
        UPDATE distributed_locks
        SET expires_at = ${expiresAt}
        WHERE lock_name = ${lockName} AND holder_id = ${holderId}
        RETURNING lock_name
      `);
      if ((result.rows as unknown[]).length === 0) {
        logger.warn(`Lock refresh failed — lock lost: ${lockName}`, { lockName, holderId });
        this.handleLockLost(lockName);
      }
    } catch (error) {
      logger.error(`Lock refresh error: ${lockName}`, { lockName, error: String(error) });
      this.handleLockLost(lockName);
    }
  }

  private handleLockLost(lockName: string): void {
    const held = this.heldLocks.get(lockName);
    if (held) {
      clearInterval(held.refreshInterval);
      this.heldLocks.delete(lockName);
    }
    this.emit('lock-lost', { lockName });
  }

  onLockLost(cb: (data: { lockName: string }) => void): void {
    this.on('lock-lost', cb);
  }

  async releaseLock(tenantId: string, rawName: string, holderId?: string): Promise<boolean> {
    const lockName = this.qualifyName(tenantId, rawName);
    const held = this.heldLocks.get(lockName);
    const fullHolderId = holderId ? `${holderId}:${INSTANCE_ID}` : held?.lockId;

    if (held) {
      clearInterval(held.refreshInterval);
      this.heldLocks.delete(lockName);
    }

    if (!fullHolderId) return false;

    try {
      const result = await this.db.execute(this.sql`
        DELETE FROM distributed_locks
        WHERE lock_name = ${lockName} AND holder_id = ${fullHolderId}
        RETURNING lock_name
      `);
      return (result.rows as unknown[]).length > 0;
    } catch (error) {
      logger.error(`Failed to release lock: ${lockName}`, { lockName, error: String(error) });
      return false;
    }
  }

  async isLockHeld(tenantId: string, rawName: string): Promise<LockResult> {
    const lockName = this.qualifyName(tenantId, rawName);
    try {
      const now = new Date();
      const result = await this.db.execute(this.sql`
        SELECT holder_id, expires_at FROM distributed_locks
        WHERE lock_name = ${lockName} AND expires_at > ${now}
      `);
      const row = (result.rows as Record<string, unknown>[])[0];
      if (row) {
        return {
          acquired: true,
          holder: row.holder_id as string,
          expiresAt: new Date(row.expires_at as string),
        };
      }
      return { acquired: false };
    } catch {
      return { acquired: false };
    }
  }

  async cleanupExpiredLocks(): Promise<number> {
    try {
      const result = await this.db.execute(this.sql`
        DELETE FROM distributed_locks WHERE expires_at < ${new Date()}
        RETURNING lock_name
      `);
      return (result.rows as unknown[]).length;
    } catch {
      return 0;
    }
  }

  releaseAllLocalLocks(): void {
    for (const [lockName, { refreshInterval }] of this.heldLocks) {
      clearInterval(refreshInterval);
      this.heldLocks.delete(lockName);
    }
  }
}
