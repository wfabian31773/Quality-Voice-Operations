/**
 * Virtual clock for the audio harness. Installed over the global timer
 * functions, Date.now and `new Date()`, so the runtime's own timers (silence watchdog,
 * playback fallback, budget interval) run on harness time: a 10-minute
 * ladder takes milliseconds and every run fires the same timers in the
 * same order. setImmediate / process.nextTick stay real: the harness uses
 * them to let the runtime's promise chains settle between steps. They only
 * order work, they don't measure time, so a loaded box runs the same turns.
 * Anything that waits on real I/O must finish before the clock moves: the
 * `quiesce` hook (CallWorld.drainReal) runs before every advance.
 */

type TimerFn = (...args: unknown[]) => void;

interface TimerEntry {
  id: number;
  at: number;
  seq: number;
  fn: TimerFn;
  args: unknown[];
  every?: number;
}

/** What setTimeout returns: enough of Node's Timeout for callers that unref/ref/refresh. */
export class VirtualTimer {
  constructor(readonly id: number, private readonly clock: VirtualClock) {}
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  hasRef(): boolean {
    return true;
  }
  refresh(): this {
    this.clock.refresh(this.id);
    return this;
  }
  [Symbol.toPrimitive](): number {
    return this.id;
  }
}

interface Saved {
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  setInterval: typeof globalThis.setInterval;
  clearInterval: typeof globalThis.clearInterval;
  dateNow: typeof Date.now;
  Date: DateConstructor;
}

/**
 * `Date` whose no-argument form (`new Date()`, `Date()`) reads the virtual
 * clock; with arguments it is the real Date. Instances are real Dates (same
 * prototype), so `instanceof Date` and subclasses keep working.
 */
function virtualDate(RealDate: DateConstructor, now: () => number): DateConstructor {
  function VirtualDate(this: unknown, ...args: unknown[]): unknown {
    if (!new.target) return new RealDate(now()).toString();
    return Reflect.construct(RealDate, args.length === 0 ? [now()] : args, new.target);
  }
  Object.setPrototypeOf(VirtualDate, RealDate);
  VirtualDate.prototype = RealDate.prototype;
  (VirtualDate as unknown as { now: () => number }).now = now;
  return VirtualDate as unknown as DateConstructor;
}

/** Real setImmediate, captured before anything is installed. */
const realSetImmediate = globalThis.setImmediate;

/** Let pending promise chains and immediates run (real event-loop turns, no real time). */
export async function settle(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((resolve) => realSetImmediate(resolve));
}

/**
 * How far apart on the wall clock two runs start. Every synthetic call is its
 * own call: the runtime's per-tenant windows (the tool rate limit: 30 a
 * minute, 300 an hour, per tenant and tool, process-wide) must not carry
 * over from the previous runs of the same process, as they never would
 * between real calls minutes apart. Observations are relative to each run's
 * start, so they don't change.
 */
export const RUN_SPACING_MS = 2 * 60 * 60_000;

export class VirtualClock {
  private current: number;
  private readonly timers = new Map<number, TimerEntry>();
  private nextId = 1;
  private seq = 0;
  private saved: Saved | null = null;
  private runEpochMs: number;
  /** Runs started in this process, over every clock (a mutant run builds its own): the rate-limit windows are process-wide too. */
  private static runsInProcess = 0;
  /** Waits out real (non-virtual) work before time moves on; set per call by the harness. */
  quiesce: () => Promise<void> = async () => {};

  constructor(readonly baseEpochMs = Date.parse('2026-10-20T14:00:00.000Z')) {
    this.runEpochMs = baseEpochMs;
    this.current = baseEpochMs;
  }

  /** When the current run started (wall-clock ms). */
  get epochMs(): number {
    return this.runEpochMs;
  }

  /** A new run: no timers, and a wall-clock start RUN_SPACING_MS after the last run's. */
  startRun(): void {
    this.reset();
    this.runEpochMs = this.baseEpochMs + VirtualClock.runsInProcess * RUN_SPACING_MS;
    VirtualClock.runsInProcess += 1;
    this.current = this.runEpochMs;
  }

  /** Wall-clock milliseconds (epoch-based, like Date.now()). */
  get now(): number {
    return this.current;
  }

  /** Milliseconds since the clock started. */
  get elapsed(): number {
    return this.current - this.epochMs;
  }

  get pending(): number {
    return this.timers.size;
  }

  setTimeout(fn: TimerFn, ms?: number, ...args: unknown[]): VirtualTimer {
    return this.add(fn, ms, args);
  }

  setInterval(fn: TimerFn, ms?: number, ...args: unknown[]): VirtualTimer {
    return this.add(fn, ms, args, true);
  }

  clear(handle: unknown): void {
    if (handle === undefined || handle === null) return;
    const id = handle instanceof VirtualTimer ? handle.id : Number(handle);
    this.timers.delete(id);
  }

  refresh(id: number): void {
    const entry = this.timers.get(id);
    if (!entry) return;
    entry.at = this.current + (entry.every ?? Math.max(1, entry.at - this.current));
    entry.seq = this.seq++;
  }

  /** Advance to `elapsed + ms`, firing due timers in time order, settling after each. */
  async advance(ms: number, settleTurns = 4): Promise<void> {
    const target = this.current + ms;
    await this.quiesce();
    for (;;) {
      const next = this.nextDue(target);
      if (!next) break;
      this.current = Math.max(this.current, next.at);
      if (next.every !== undefined) {
        next.at = this.current + next.every;
        next.seq = this.seq++;
      } else {
        this.timers.delete(next.id);
      }
      next.fn(...next.args);
      await settle(settleTurns);
      await this.quiesce();
    }
    this.current = target;
  }

  install(): void {
    if (this.saved) return;
    this.saved = {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
      dateNow: Date.now,
      Date: globalThis.Date,
    };
    const g = globalThis as unknown as Record<string, unknown>;
    g.setTimeout = (fn: TimerFn, ms?: number, ...args: unknown[]) => this.setTimeout(fn, ms, ...args);
    g.clearTimeout = (handle: unknown) => this.clear(handle);
    g.setInterval = (fn: TimerFn, ms?: number, ...args: unknown[]) => this.setInterval(fn, ms, ...args);
    g.clearInterval = (handle: unknown) => this.clear(handle);
    // Date.now on the real Date too, for code that kept a reference to it.
    this.saved.Date.now = () => this.current;
    g.Date = virtualDate(this.saved.Date, () => this.current);
  }

  uninstall(): void {
    if (!this.saved) return;
    const g = globalThis as unknown as Record<string, unknown>;
    g.setTimeout = this.saved.setTimeout;
    g.clearTimeout = this.saved.clearTimeout;
    g.setInterval = this.saved.setInterval;
    g.clearInterval = this.saved.clearInterval;
    g.Date = this.saved.Date;
    this.saved.Date.now = this.saved.dateNow;
    this.saved = null;
  }

  /** Drop every timer (between runs). */
  reset(): void {
    this.timers.clear();
    this.current = this.epochMs;
    this.quiesce = async () => {};
  }

  private add(fn: TimerFn, ms: number | undefined, args: unknown[], repeat = false): VirtualTimer {
    const delay = Math.max(1, Number.isFinite(ms) ? Number(ms) : 0);
    const id = this.nextId++;
    this.timers.set(id, { id, at: this.current + delay, seq: this.seq++, fn, args, every: repeat ? delay : undefined });
    return new VirtualTimer(id, this);
  }

  private nextDue(target: number): TimerEntry | undefined {
    let best: TimerEntry | undefined;
    for (const entry of this.timers.values()) {
      if (entry.at > target) continue;
      if (!best || entry.at < best.at || (entry.at === best.at && entry.seq < best.seq)) best = entry;
    }
    return best;
  }
}
