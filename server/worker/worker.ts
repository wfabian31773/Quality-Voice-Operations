/**
 * Scheduler worker core (PR-00, Render `qvo-worker`). Kept separate from
 * start.ts so the leader/shutdown flow is unit-testable.
 *
 *   - Runs the selected schedulers only while holding the Postgres advisory
 *     lock (single leader). Standbys retry every 10 s.
 *   - On SIGTERM: stop scheduling new ticks, wait for the in-flight tick
 *     (≤ 100 s, observed as "no checked-out DB clients"), release the lock,
 *     close the pool, exit.
 */
import { createLogger } from '../../platform/core/logger';
import type { SchedulerContext, SchedulerDefinition } from '../../platform/runtime/schedulers';

const logger = createLogger('WORKER');

export interface PoolStats {
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}

export interface Elector {
  start(): Promise<void>;
  stop(): Promise<void>;
  isLeader(): boolean;
}

export interface WorkerOptions {
  schedulers: readonly SchedulerDefinition[];
  ctx: SchedulerContext;
  createElector: (hooks: { onAcquire: () => void; onLose: () => void }) => Elector;
  /** Pool whose checked-out clients mark an in-flight tick. */
  pool: () => PoolStats | null;
  closePool: () => Promise<void>;
  inFlightTimeoutMs?: number;
  pollIntervalMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait until no DB client is checked out (and none is waiting) for two
 * consecutive polls, or until `timeoutMs`. Every scheduler tick goes through
 * the platform pool, so an idle pool means no tick is mid-flight.
 */
export async function awaitInFlightWork(
  stats: () => PoolStats | null,
  timeoutMs: number,
  pollIntervalMs = 1_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let quiet = 0;
  for (;;) {
    const s = stats();
    const busy = s ? s.totalCount - s.idleCount + s.waitingCount : 0;
    quiet = busy === 0 ? quiet + 1 : 0;
    if (quiet >= 2) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  }
}

export class SchedulerWorker {
  private running = false;
  private shuttingDown = false;
  private readonly elector: Elector;

  constructor(private readonly opts: WorkerOptions) {
    this.elector = opts.createElector({
      onAcquire: () => this.startSchedulers(),
      onLose: () => this.stopSchedulers('lost leadership'),
    });
  }

  isRunningSchedulers(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.opts.schedulers.length === 0) {
      logger.info('No schedulers enabled for this worker (shadow mode); idling');
    }
    await this.elector.start();
  }

  private startSchedulers(): void {
    if (this.running || this.shuttingDown) return;
    this.running = true;
    logger.info('Leader: starting schedulers', { schedulers: this.opts.schedulers.map((s) => s.name) });
    for (const s of this.opts.schedulers) s.start(this.opts.ctx);
  }

  private stopSchedulers(reason: string): void {
    if (!this.running) return;
    this.running = false;
    logger.info('Stopping schedulers', { reason });
    for (const s of this.opts.schedulers) {
      try {
        s.stop();
      } catch (err) {
        logger.warn('Scheduler stop failed', { scheduler: s.name, error: String(err) });
      }
    }
  }

  /** Graceful stop. Returns once the lock is released and the pool closed. */
  async shutdown(signal: string): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    logger.info(`Received ${signal}, stopping worker`);
    const wasRunning = this.running;
    this.stopSchedulers(signal);
    if (wasRunning) {
      const idle = await awaitInFlightWork(
        this.opts.pool,
        this.opts.inFlightTimeoutMs ?? 100_000,
        this.opts.pollIntervalMs ?? 1_000,
      );
      if (!idle) logger.warn('In-flight scheduler work still running after timeout; exiting anyway');
    }
    await this.elector.stop();
    await this.opts.closePool().catch((err) => {
      logger.warn('DB pool close failed', { error: String(err) });
    });
    logger.info('Worker shutdown complete');
  }
}
