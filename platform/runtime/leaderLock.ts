/**
 * Single-leader election for the scheduler worker (PR-00, Render migration).
 *
 * Uses a session-level Postgres advisory lock (`pg_try_advisory_lock`) held
 * on a dedicated connection. Only the holder runs schedulers. If the holder
 * exits (gracefully or not), Postgres releases the lock when its session
 * ends and a standby takes over on its next retry (default every 10 s).
 *
 * The lock must live on a *session* connection: a direct Postgres URL or the
 * Supabase session pooler (port 5432). Supavisor's transaction pooler (port
 * 6543) hands a different server session to every statement, which would
 * make the lock meaningless, so `resolveLeaderLockUrl` refuses it.
 */
import { Client, type ClientConfig } from 'pg';
import { createLogger } from '../core/logger';

const logger = createLogger('LEADER_LOCK');

/** Default lock key: ASCII "QVOWRK" packed into an int8. Stable across deploys. */
export const DEFAULT_LEADER_LOCK_KEY = '89431140160075';

export interface LeaderLockClient {
  connect(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  end(): Promise<void>;
  on(event: 'error' | 'end', listener: (...args: unknown[]) => void): unknown;
}

export interface LeaderElectorOptions {
  connectionString: string;
  lockKey?: string;
  /** How often a standby retries the lock (spec: 10 s). */
  retryIntervalMs?: number;
  /** How often the leader verifies its lock connection is still alive. */
  healthCheckIntervalMs?: number;
  /** Called once each time leadership is acquired. */
  onAcquire: () => void | Promise<void>;
  /** Called when leadership is lost (connection died). Not called by stop(). */
  onLose: () => void | Promise<void>;
  /** Test seam. */
  clientFactory?: (config: ClientConfig) => LeaderLockClient;
  ssl?: ClientConfig['ssl'];
}

type Env = Record<string, string | undefined>;

/**
 * Pick the connection used for the leader lock. `WORKER_LEADER_DB_URL` wins;
 * development falls back to DATABASE_URL (Replit/local Postgres). Production
 * has no fallback: PLATFORM_DB_POOL_URL is the transaction pooler.
 */
export function resolveLeaderLockUrl(env: Env = process.env): string {
  const explicit = env.WORKER_LEADER_DB_URL?.trim();
  const appEnv = env.APP_ENV ?? 'development';
  const url = explicit || (appEnv === 'development' ? env.DATABASE_URL?.trim() : undefined);
  if (!url) {
    throw new Error(
      'WORKER_LEADER_DB_URL is not set. Point it at a session-mode Postgres connection ' +
        '(Supabase session pooler on port 5432, or a direct connection).',
    );
  }
  let port = '';
  try {
    port = new URL(url).port;
  } catch {
    throw new Error('WORKER_LEADER_DB_URL is not a valid postgres:// URL');
  }
  if (port === '6543') {
    throw new Error(
      'WORKER_LEADER_DB_URL points at port 6543 (Supavisor transaction pooler), which cannot hold ' +
        'session advisory locks. Use the session pooler (port 5432) or a direct connection.',
    );
  }
  return url;
}

export class LeaderElector {
  private client: LeaderLockClient | null = null;
  private leader = false;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private healthTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt: Promise<void> | null = null;
  private readonly lockKey: string;
  private readonly retryIntervalMs: number;
  private readonly healthCheckIntervalMs: number;

  constructor(private readonly opts: LeaderElectorOptions) {
    this.lockKey = opts.lockKey ?? DEFAULT_LEADER_LOCK_KEY;
    this.retryIntervalMs = opts.retryIntervalMs ?? 10_000;
    this.healthCheckIntervalMs = opts.healthCheckIntervalMs ?? 10_000;
  }

  isLeader(): boolean {
    return this.leader;
  }

  /** Begin trying to acquire leadership; resolves after the first attempt. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.tryAcquire();
  }

  private makeClient(): LeaderLockClient {
    const config: ClientConfig = {
      connectionString: this.opts.connectionString,
      application_name: 'qvo-worker-leader',
      keepAlive: true,
      ...(this.opts.ssl !== undefined ? { ssl: this.opts.ssl } : {}),
    };
    return this.opts.clientFactory ? this.opts.clientFactory(config) : (new Client(config) as unknown as LeaderLockClient);
  }

  private tryAcquire(): Promise<void> {
    if (!this.attempt) {
      this.attempt = this.doTryAcquire().finally(() => {
        this.attempt = null;
      });
    }
    return this.attempt;
  }

  private async doTryAcquire(): Promise<void> {
    if (this.stopped || this.leader) return;
    try {
      if (!this.client) {
        const client = this.makeClient();
        client.on('error', (err) => {
          logger.warn('Leader lock connection error', { error: String(err) });
          void this.handleConnectionLost(client);
        });
        client.on('end', () => {
          void this.handleConnectionLost(client);
        });
        this.client = client;
        await client.connect();
      }
      const { rows } = await this.client.query('SELECT pg_try_advisory_lock($1::bigint) AS locked', [this.lockKey]);
      if (rows[0]?.locked === true) {
        if (this.stopped) {
          await this.release();
          return;
        }
        this.leader = true;
        logger.info('Acquired worker leadership');
        this.scheduleHealthCheck();
        await this.opts.onAcquire();
        return;
      }
      logger.info('Another worker holds leadership; standing by', { retryInMs: this.retryIntervalMs });
    } catch (err) {
      logger.warn('Leader lock attempt failed', { error: String(err) });
      await this.dropClient();
    }
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.tryAcquire();
    }, this.retryIntervalMs);
  }

  private scheduleHealthCheck(): void {
    if (this.stopped || !this.leader) return;
    this.healthTimer = setTimeout(() => {
      this.healthTimer = null;
      const client = this.client;
      if (!client || !this.leader) return;
      client
        .query('SELECT 1')
        .then(() => this.scheduleHealthCheck())
        .catch((err) => {
          logger.warn('Leader lock health check failed', { error: String(err) });
          void this.handleConnectionLost(client);
        });
    }, this.healthCheckIntervalMs);
  }

  private async handleConnectionLost(client: LeaderLockClient): Promise<void> {
    if (client !== this.client) return;
    const wasLeader = this.leader;
    this.leader = false;
    this.client = null;
    if (this.healthTimer) {
      clearTimeout(this.healthTimer);
      this.healthTimer = null;
    }
    client.end().catch(() => {});
    if (this.stopped) return;
    if (wasLeader) {
      logger.error('Lost worker leadership (lock connection closed); stopping schedulers');
      try {
        await this.opts.onLose();
      } catch (err) {
        logger.error('onLose handler failed', { error: String(err) });
      }
    }
    this.scheduleRetry();
  }

  private async dropClient(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) await client.end().catch(() => {});
  }

  private async release(): Promise<void> {
    const client = this.client;
    this.client = null;
    const wasLeader = this.leader;
    this.leader = false;
    if (!client) return;
    if (wasLeader) {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [this.lockKey]);
        logger.info('Released worker leadership');
      } catch (err) {
        // The session ending below releases the lock anyway.
        logger.warn('Advisory unlock failed; closing the session releases it', { error: String(err) });
      }
    }
    await client.end().catch(() => {});
  }

  /** Stop retrying, release the lock if held and close the connection. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.healthTimer) {
      clearTimeout(this.healthTimer);
      this.healthTimer = null;
    }
    if (this.attempt) await this.attempt.catch(() => {});
    await this.release();
  }
}
