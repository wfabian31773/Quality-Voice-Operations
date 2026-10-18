/**
 * Virtual clock for the audio harness. Installed over the global timer
 * functions and Date.now, so the runtime's own timers (silence watchdog,
 * playback fallback, budget interval) run on harness time: a 10-minute
 * ladder takes milliseconds and every run fires the same timers in the
 * same order. setImmediate / process.nextTick stay real: the harness uses
 * them to let the runtime's promise chains settle between steps.
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
}

/** Real setImmediate, captured before anything is installed. */
const realSetImmediate = globalThis.setImmediate;

/** Let pending promise chains and immediates run (real event-loop turns, no real time). */
export async function settle(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise<void>((resolve) => realSetImmediate(resolve));
}

export class VirtualClock {
  private current: number;
  private readonly timers = new Map<number, TimerEntry>();
  private nextId = 1;
  private seq = 0;
  private saved: Saved | null = null;

  constructor(readonly epochMs = Date.parse('2026-10-20T14:00:00.000Z')) {
    this.current = epochMs;
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
    };
    const g = globalThis as unknown as Record<string, unknown>;
    g.setTimeout = (fn: TimerFn, ms?: number, ...args: unknown[]) => this.setTimeout(fn, ms, ...args);
    g.clearTimeout = (handle: unknown) => this.clear(handle);
    g.setInterval = (fn: TimerFn, ms?: number, ...args: unknown[]) => this.setInterval(fn, ms, ...args);
    g.clearInterval = (handle: unknown) => this.clear(handle);
    Date.now = () => this.current;
  }

  uninstall(): void {
    if (!this.saved) return;
    const g = globalThis as unknown as Record<string, unknown>;
    g.setTimeout = this.saved.setTimeout;
    g.clearTimeout = this.saved.clearTimeout;
    g.setInterval = this.saved.setInterval;
    g.clearInterval = this.saved.clearInterval;
    Date.now = this.saved.dateNow;
    this.saved = null;
  }

  /** Drop every timer (between runs). */
  reset(): void {
    this.timers.clear();
    this.current = this.epochMs;
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
