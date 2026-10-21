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
 * - a write still running after BOOKKEEPING_WRITE_TIMEOUT_MS is logged, not
 *   cut off. JS can't cancel a DB statement: a write the queue stopped
 *   waiting for would still land later, after newer writes or after the
 *   final call state. So the next write starts only once it settles, and the
 *   writes land in enqueue order, always. What bounds the settle is a DB
 *   statement timeout: every queued DB write's transaction runs SET LOCAL
 *   statement_timeout = BOOKKEEPING_STATEMENT_TIMEOUT_MS
 *   (isBookkeepingWrite()), so Postgres cancels a stuck statement and the
 *   transaction rolls back. callPersistence sets it itself; the platform
 *   writers (ToolExecutionService's tool_invocations rows, UsageRecorder's
 *   meter, TrialGuard) get it through withBookkeepingStatementTimeout
 *   (bookkeepingStatementTimeout.ts). That timeout is per statement, not per
 *   transaction (a state + event + ticket transaction can take a few times
 *   it). The observability error is not awaited, so it never holds the
 *   queue. A stuck write holds only this call's later writes: flush, drain
 *   and release keep their own bounds, so the floor and teardown are never
 *   held by it;
 * - flush() waits for every write enqueued before it, bounded by
 *   BOOKKEEPING_FLUSH_TIMEOUT_MS (an error log on timeout). Readers of these
 *   rows flush first: the floor and teardown;
 * - drain() is what teardown waits on before finalize and the call_completed
 *   event: open tool runs, at most BOOKKEEPING_FINALIZE_DRAIN_MAX_MS, then a
 *   flush. It orders rows, not the state: a run that closes within the bound
 *   lands its rows and events (tool_invocations complete, tool_end, meter)
 *   before them. It does not end the queue;
 * - release() ends the queue at teardown, once no tool run is open and the
 *   writes have drained (bounded by BOOKKEEPING_RELEASE_MAX_WAIT_MS). After
 *   that nothing runs; a late write is dropped and logged.
 *
 * The final call state is not the queue's job. session_closed (CALL_COMPLETED)
 * is queued at the start of teardown, before the drain, so a run still open
 * at hangup moves the state after the row is final, inside the drain or
 * after it. callPersistence keeps a terminal state (KEEP_TERMINAL_STATE_SQL)
 * and still writes the move's other columns, events and rows.
 *
 * A logger that throws never breaks the chain. Nothing here is global: the
 * queue lives in the call's session closures and goes with them.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { createLogger } from '../../../platform/core/logger';

/** Longest a flush (floor, teardown) waits for the queue. */
export const BOOKKEEPING_FLUSH_TIMEOUT_MS = 5_000;
/** When a write still running is logged as timed out (the next write still waits for it). */
export const BOOKKEEPING_WRITE_TIMEOUT_MS = 5_000;
/** Longest release() waits for open tool runs (an action can run 15 s per attempt) before ending the queue. */
export const BOOKKEEPING_RELEASE_MAX_WAIT_MS = 60_000;
/**
 * Longest the hangup waits for a tool run still open to queue its last
 * writes before finalize and the call_completed event (a flush, bounded as
 * above, follows). It orders rows, not the state: the row is already
 * CALL_COMPLETED (session_closed) and the terminal guard keeps it. A run open
 * at hangup is an action already in flight (a booking write, an SMS send),
 * which mostly ends within a second or two; 3 s lets its tool_invocations
 * completion, tool_end event and meter land before call_completed. It is
 * short because every hangup with a run open waits on it before end_time is
 * written (live-call UI, call_completed). A slower run still queues its rows
 * until release(), after the final rows.
 */
export const BOOKKEEPING_FINALIZE_DRAIN_MAX_MS = 3_000;
/**
 * The Postgres statement_timeout for the DB transactions run from this queue:
 * under BOOKKEEPING_WRITE_TIMEOUT_MS, so the DB cancels a stuck statement
 * about when the queue logs it, and the write settles.
 */
export const BOOKKEEPING_STATEMENT_TIMEOUT_MS = 4_000;
/** Run right after BEGIN in each of those transactions (callPersistence, bookkeepingStatementTimeout). */
export const BOOKKEEPING_STATEMENT_TIMEOUT_SQL = `SET LOCAL statement_timeout = ${BOOKKEEPING_STATEMENT_TIMEOUT_MS}`;

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
  drainMaxWaitMs?: number;
}

export type FlushResult = 'drained' | 'timeout';

const defaultLogger = createLogger('BOOKKEEPING_QUEUE');

const bookkeepingWriteScope = new AsyncLocalStorage<true>();

/** True inside a write a BookkeepingQueue runs (callPersistence sets its statement timeout then). */
export function isBookkeepingWrite(): boolean {
  return bookkeepingWriteScope.getStore() === true;
}

/** What a failed write may log: an error code or class, never the message. */
function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && code) return code;
  return err instanceof Error ? err.name : typeof err;
}

const TIMED_OUT = Symbol('timed out');

function bounded<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export class BookkeepingQueue {
  /** The last write's settle: each new write chains behind it. */
  private tail: Promise<void> = Promise.resolve();
  /** Writes enqueued and not settled yet (queued + running). */
  private pending = 0;
  /** Tool runs whose writes are not all enqueued yet (drain and release wait for them). */
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
   * promise settles (never rejects) when this write is done, failed or
   * dropped. `label` names the write in logs (no caller data).
   */
  enqueue(label: string, write: () => Promise<unknown>): Promise<void> {
    if (this.released) {
      this.logSafely('warn', 'Bookkeeping write dropped: the call\'s queue was released', { write: label });
      return Promise.resolve();
    }
    this.pending += 1;
    const run = this.tail.then(async () => {
      if (this.released) {
        this.logSafely('warn', 'Bookkeeping write dropped: the call\'s queue was released', { write: label });
        return;
      }
      const timeoutMs = this.opts.writeTimeoutMs ?? BOOKKEEPING_WRITE_TIMEOUT_MS;
      // Logged at the bound; the next write still waits for this one to settle (see the header).
      const timer = setTimeout(() => {
        this.logSafely('error', 'Bookkeeping write timed out; later writes wait for it to settle', { write: label, waitedMs: timeoutMs });
      }, timeoutMs);
      try {
        await bookkeepingWriteScope.run(true, () => Promise.resolve().then(write));
      } catch (err) {
        this.logSafely('warn', 'Bookkeeping write failed; the queue moves on', { write: label, error: errorCode(err) });
      } finally {
        clearTimeout(timer);
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
    if (outcome === TIMED_OUT) {
      this.logSafely('error', 'Bookkeeping flush timed out', { reason, waitedMs: timeoutMs, depthAtFlush: depth, depthNow: this.pending });
      return 'timeout';
    }
    return 'drained';
  }

  /**
   * What teardown waits on before finalize and call_completed (row order, not
   * the state): open tool runs, at most `maxWaitMs`, then a flush (its own
   * bound). Does not end the queue;
   * release() does. Never rejects; logs when a run is still open.
   */
  async drain(reason = 'drain', maxWaitMs = this.opts.drainMaxWaitMs ?? BOOKKEEPING_FINALIZE_DRAIN_MAX_MS): Promise<FlushResult> {
    if (this.openRuns > 0 && await bounded(this.runsClosed(), maxWaitMs) === TIMED_OUT) {
      this.logSafely('error', 'Bookkeeping drain: tool runs still open', { reason, openRuns: this.openRuns, waitedMs: maxWaitMs });
    }
    return this.flush(reason);
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
    if (this.openRuns > 0 && await bounded(this.runsClosed(), maxWaitMs) === TIMED_OUT) {
      this.logSafely('error', 'Bookkeeping release: tool runs still open', { openRuns: this.openRuns, waitedMs: maxWaitMs });
    }
    const left = Math.max(0, maxWaitMs - (Date.now() - startedAt));
    await this.flush('release', Math.min(left, this.opts.flushTimeoutMs ?? BOOKKEEPING_FLUSH_TIMEOUT_MS));
    if (this.pending > 0) this.logSafely('error', 'Bookkeeping release: writes still queued are dropped', { dropped: this.pending });
    this.released = true;
    this.runClosedWaiters = [];
  }

  private runsClosed(): Promise<void> {
    return new Promise<void>((resolve) => this.runClosedWaiters.push(resolve));
  }

  /** A logger that throws must not reject the chain or stall later writes. */
  private logSafely(level: 'warn' | 'error', message: string, extra: Record<string, unknown>): void {
    try {
      this.log[level](message, extra);
    } catch {
      // The write's outcome stands without its log line.
    }
  }
}
