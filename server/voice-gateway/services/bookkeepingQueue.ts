/**
 * The per-call ordered queue for bookkeeping writes (RT-HOLD-LINE part 2).
 *
 * A tool call's bookkeeping (tool_invocations rows, call state moves, call
 * events, the observability error, the tool meter, the trial check) used to
 * be awaited before the tool output went back to the model: about nine DB
 * transactions, 2-3 s per tool on the Oct 18 calls. Now the output goes back
 * as soon as the action finishes, and the writes go through this queue:
 *
 * - one FIFO per call session, one write at a time, in enqueue order, so the
 *   rows are the same, in the same order, as when they were awaited inline;
 * - a write that fails is logged (its error code, never its message: SQL
 *   errors can echo values) and the queue moves on; nothing reaches the
 *   caller or the model;
 * - a write that hangs is cut off after BOOKKEEPING_WRITE_TIMEOUT_MS (logged),
 *   so one stuck statement can't stall the call's later writes;
 * - flush() waits for every write enqueued before it, bounded by
 *   BOOKKEEPING_FLUSH_TIMEOUT_MS (an error log on timeout). Readers of these
 *   rows flush first: the floor, teardown and call_completed;
 * - release() ends the queue at teardown, once no tool run is open and the
 *   writes have drained (bounded by BOOKKEEPING_RELEASE_MAX_WAIT_MS). After
 *   that nothing runs; a late write is dropped and logged.
 *
 * Nothing here is global: the queue lives in the call's session closures and
 * goes with them.
 */
import { createLogger } from '../../../platform/core/logger';

/** Longest a flush (floor, teardown, call_completed) waits for the queue. */
export const BOOKKEEPING_FLUSH_TIMEOUT_MS = 5_000;
/** Longest one write may hold the queue before the next write goes. */
export const BOOKKEEPING_WRITE_TIMEOUT_MS = 5_000;
/** Longest release() waits for open tool runs (an action can run 15 s per attempt) before ending the queue. */
export const BOOKKEEPING_RELEASE_MAX_WAIT_MS = 60_000;

export interface BookkeepingLogger {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

export interface BookkeepingQueueOptions {
  log?: BookkeepingLogger;
  flushTimeoutMs?: number;
  writeTimeoutMs?: number;
  releaseMaxWaitMs?: number;
}

export type FlushResult = 'drained' | 'timeout';

const defaultLogger = createLogger('BOOKKEEPING_QUEUE');

/** What a failed write may log: an error code or class, never the message. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code) return code;
  return err instanceof Error ? err.name : typeof err;
}

const WRITE_TIMED_OUT = Symbol('write timed out');

function bounded<T>(work: Promise<T>, ms: number): Promise<T | typeof WRITE_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof WRITE_TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(WRITE_TIMED_OUT), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export class BookkeepingQueue {
  /** The last write's settle: each new write chains behind it. */
  private tail: Promise<void> = Promise.resolve();
  /** Writes enqueued and not settled yet (queued + running). */
  private pending = 0;
  /** Tool runs whose writes are not all enqueued yet (release waits for them). */
  private openRuns = 0;
  private runClosedWaiters: Array<() => void> = [];
  private releasing: Promise<void> | null = null;
  private released = false;
  private readonly log: BookkeepingLogger;

  constructor(private readonly opts: BookkeepingQueueOptions = {}) {
    this.log = opts.log ?? defaultLogger;
  }

  /** Writes queued or running right now. */
  get depth(): number {
    return this.pending;
  }

  get isReleased(): boolean {
    return this.released;
  }

  /**
   * Queues one write behind every write enqueued before it. The returned
   * promise settles (never rejects) when this write is done, failed, timed
   * out or dropped. `label` names the write in logs (no caller data).
   */
  enqueue(label: string, write: () => Promise<unknown>): Promise<void> {
    if (this.released) {
      this.log.warn('Bookkeeping write dropped: the call\'s queue was released', { write: label });
      return Promise.resolve();
    }
    this.pending += 1;
    const run = this.tail.then(async () => {
      if (this.released) {
        this.log.warn('Bookkeeping write dropped: the call\'s queue was released', { write: label });
        return;
      }
      try {
        const outcome = await bounded(Promise.resolve().then(write), this.opts.writeTimeoutMs ?? BOOKKEEPING_WRITE_TIMEOUT_MS);
        if (outcome === WRITE_TIMED_OUT) {
          this.log.error('Bookkeeping write timed out; the queue moves on', { write: label, waitedMs: this.opts.writeTimeoutMs ?? BOOKKEEPING_WRITE_TIMEOUT_MS });
        }
      } catch (err) {
        this.log.warn('Bookkeeping write failed; the queue moves on', { write: label, error: errorCode(err) });
      }
    }).finally(() => {
      this.pending -= 1;
    });
    this.tail = run;
    return run;
  }

  /** Settles once every write enqueued so far has run (unbounded; readers use flush). */
  settled(): Promise<void> {
    return this.tail;
  }

  /**
   * What a tool call waits for, on its way to the model, for the writes it
   * just queued: nothing; they run in order behind it. Before this queue the
   * call awaited each write here, i.e. `return this.settled()`.
   */
  onCriticalPath(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Waits for every write enqueued before this call, at most `timeoutMs`.
   * Never rejects. On timeout it logs and returns 'timeout'; the writes keep
   * going in order behind it.
   */
  async flush(reason = 'flush', timeoutMs = this.opts.flushTimeoutMs ?? BOOKKEEPING_FLUSH_TIMEOUT_MS): Promise<FlushResult> {
    const depth = this.pending;
    if (depth === 0) return 'drained';
    const outcome = await bounded(this.tail, timeoutMs);
    if (outcome === WRITE_TIMED_OUT) {
      this.log.error('Bookkeeping flush timed out', { reason, waitedMs: timeoutMs, depthAtFlush: depth, depthNow: this.pending });
      return 'timeout';
    }
    return 'drained';
  }

  /** A tool run started; its writes may still come. Returns the close (idempotent). */
  openRun(): () => void {
    this.openRuns += 1;
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.openRuns -= 1;
      if (this.openRuns === 0) for (const wake of this.runClosedWaiters.splice(0)) wake();
    };
  }

  /**
   * Ends the queue at teardown: waits (bounded) for open tool runs to enqueue
   * their last writes and for the queue to drain, then nothing more runs.
   * Writes still queued past the bound are dropped and logged.
   */
  release(): Promise<void> {
    this.releasing ??= this.releaseOnce();
    return this.releasing;
  }

  private async releaseOnce(): Promise<void> {
    const maxWaitMs = this.opts.releaseMaxWaitMs ?? BOOKKEEPING_RELEASE_MAX_WAIT_MS;
    const startedAt = Date.now();
    if (this.openRuns > 0) {
      const runsClosed = new Promise<void>((resolve) => this.runClosedWaiters.push(resolve));
      if (await bounded(runsClosed, maxWaitMs) === WRITE_TIMED_OUT) {
        this.log.error('Bookkeeping release: tool runs still open', { openRuns: this.openRuns, waitedMs: maxWaitMs });
      }
    }
    const left = Math.max(0, maxWaitMs - (Date.now() - startedAt));
    await this.flush('release', Math.min(left, this.opts.flushTimeoutMs ?? BOOKKEEPING_FLUSH_TIMEOUT_MS));
    if (this.pending > 0) this.log.error('Bookkeeping release: writes still queued are dropped', { dropped: this.pending });
    this.released = true;
    this.runClosedWaiters = [];
  }
}
