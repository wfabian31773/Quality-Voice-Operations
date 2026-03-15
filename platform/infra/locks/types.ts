export interface LockResult {
  acquired: boolean;
  lockId?: string;
  holder?: string;
  expiresAt?: Date;
}

export interface DistributedLockOptions {
  /** Lock name — will be auto-prefixed with `tenant:<id>:` by the service. */
  lockName: string;
  /** Caller identifier, combined with instance ID for uniqueness. */
  holderId: string;
  /** TTL in seconds. Refreshed automatically at 50% of TTL. */
  ttlSeconds?: number;
}
