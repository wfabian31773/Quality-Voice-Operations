/**
 * RT-HOLD-LINE part 2: the per-call bookkeeping queue. Writes run one at a
 * time in enqueue order, none is lost when one fails or throws, a hanging
 * write is bounded, flush waits for every earlier write, and nothing runs
 * after release.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BOOKKEEPING_FINALIZE_DRAIN_MAX_MS,
  BOOKKEEPING_FLUSH_TIMEOUT_MS,
  BOOKKEEPING_RELEASE_MAX_WAIT_MS,
  BOOKKEEPING_WRITE_TIMEOUT_MS,
  BookkeepingQueue,
  isBookkeepingWrite,
} from './bookkeepingQueue';

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A deterministic pseudo-random sequence (no Math.random in a stress test). */
function lcg(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

/** A promise and the function that settles it. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

describe('BookkeepingQueue: order', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('writes enqueued from overlapping tool calls run one at a time in exactly enqueue order', async () => {
    // The test, not real timers, decides when each tool call moves on: the
    // enqueue order is fixed, so only the queue can change the run order.
    vi.useFakeTimers();
    const queue = new BookkeepingQueue({ log: logger() });
    const enqueued: string[] = [];
    const ran: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const enqueue = (label: string, ms: number) => {
      enqueued.push(label);
      void queue.enqueue(label, async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await sleep(ms);
        ran.push(label);
        running -= 1;
      });
    };
    // Two tool calls whose bookkeeping interleaves: A begins, B begins, A finishes, B finishes.
    // The writes take different times, so a queue that is not FIFO would reorder them.
    const bBegins = gate();
    const aFinishes = gate();
    const bFinishes = gate();
    const callA = async () => {
      enqueue('a.create', 5);
      enqueue('a.start', 1);
      await aFinishes.opened;
      enqueue('a.complete', 3);
      enqueue('a.end', 1);
    };
    const callB = async () => {
      await bBegins.opened;
      enqueue('b.create', 1);
      enqueue('b.start', 4);
      await bFinishes.opened;
      enqueue('b.complete', 1);
    };
    const calls = Promise.all([callA(), callB()]);

    // Each step lands 1 ms later, while a.create (5 ms) still holds the queue.
    expect(enqueued).toEqual(['a.create', 'a.start']);
    bBegins.open();
    await vi.advanceTimersByTimeAsync(1);
    expect(enqueued).toEqual(['a.create', 'a.start', 'b.create', 'b.start']);
    aFinishes.open();
    await vi.advanceTimersByTimeAsync(1);
    expect(enqueued).toEqual(['a.create', 'a.start', 'b.create', 'b.start', 'a.complete', 'a.end']);
    bFinishes.open();
    await vi.advanceTimersByTimeAsync(1);
    await calls;
    expect(ran).toEqual([]);

    const flushed = queue.flush();
    await vi.advanceTimersByTimeAsync(5 + 1 + 1 + 4 + 3 + 1 + 1);
    expect(await flushed).toBe('drained');
    expect(ran).toEqual(enqueued);
    expect(ran).toEqual(['a.create', 'a.start', 'b.create', 'b.start', 'a.complete', 'a.end', 'b.complete']);
    expect(maxRunning).toBe(1);
  });

  it('stress: 400 writes with random latencies from 8 concurrent producers keep their enqueue order and all run', async () => {
    const queue = new BookkeepingQueue({ log: logger() });
    const random = lcg(20261018);
    const enqueued: number[] = [];
    const ran: number[] = [];
    let seq = 0;
    let running = 0;
    let overlap = false;
    const producer = async () => {
      for (let i = 0; i < 50; i += 1) {
        const n = seq++;
        enqueued.push(n);
        const latency = Math.floor(random() * 3);
        const fails = random() < 0.1;
        void queue.enqueue(`w${n}`, async () => {
          running += 1;
          if (running > 1) overlap = true;
          if (latency > 0) await sleep(latency);
          ran.push(n);
          running -= 1;
          if (fails) throw new Error('write failed');
        });
        if (random() < 0.3) await sleep(Math.floor(random() * 2));
      }
    };
    await Promise.all(Array.from({ length: 8 }, producer));
    expect(await queue.flush('stress', 30_000)).toBe('drained');
    expect(ran).toHaveLength(400);
    expect(ran).toEqual(enqueued);
    expect(overlap).toBe(false);
    expect(queue.depth).toBe(0);
  }, 30_000);
});

describe('BookkeepingQueue: failures', () => {
  it('a write that rejects or throws synchronously is logged by code only, and every later write still runs', async () => {
    const log = logger();
    const queue = new BookkeepingQueue({ log });
    const ran: string[] = [];
    void queue.enqueue('first', async () => { ran.push('first'); });
    void queue.enqueue('rejects', async () => {
      throw Object.assign(new Error('duplicate key value (id)=(caller 555-0142)'), { code: '23505' });
    });
    void queue.enqueue('throws', () => { throw new TypeError('boom +15550100142'); });
    void queue.enqueue('last', async () => { ran.push('last'); });
    expect(await queue.flush()).toBe('drained');
    expect(ran).toEqual(['first', 'last']);
    expect(log.warn.mock.calls.map((c) => c[1])).toEqual([
      { write: 'rejects', error: '23505' },
      { write: 'throws', error: 'TypeError' },
    ]);
    // No message text (it can echo caller data) reaches the log.
    expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/555|caller|boom/);
  });

  it('enqueue never rejects, whatever the write does', async () => {
    const queue = new BookkeepingQueue({ log: logger() });
    await expect(queue.enqueue('x', async () => { throw new Error('no'); })).resolves.toBeUndefined();
  });
});

describe('BookkeepingQueue: bounds (fake timers)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a hanging write is logged at the write timeout; flush is bounded by the flush timeout; the next write waits for it to settle', async () => {
    const log = logger();
    const queue = new BookkeepingQueue({ log });
    const ran: string[] = [];
    const stuck = gate();
    void queue.enqueue('hangs', () => stuck.opened);
    void queue.enqueue('after', async () => { ran.push('after'); });

    let flushed: string | undefined;
    void queue.flush('teardown').then((r) => { flushed = r; });
    await vi.advanceTimersByTimeAsync(BOOKKEEPING_FLUSH_TIMEOUT_MS - 1);
    expect(flushed).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(flushed).toBe('timeout');
    expect(log.error).toHaveBeenCalledWith('Bookkeeping flush timed out', expect.objectContaining({ reason: 'teardown', waitedMs: BOOKKEEPING_FLUSH_TIMEOUT_MS, depthAtFlush: 2 }));
    expect(log.error).toHaveBeenCalledWith('Bookkeeping write timed out; later writes wait for it to settle', { write: 'hangs', waitedMs: BOOKKEEPING_WRITE_TIMEOUT_MS });

    // Not cut off: the next write starts only once the hung one settles.
    await vi.advanceTimersByTimeAsync(BOOKKEEPING_WRITE_TIMEOUT_MS * 10);
    expect(ran).toEqual([]);
    expect(queue.depth).toBe(2);
    stuck.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(ran).toEqual(['after']);
    expect(queue.depth).toBe(0);
  });

  it('P2: a write that times out and lands late never lands after a later write; the later state is the one left', async () => {
    // A row the writes overwrite, like call_sessions.lifecycle_state.
    let state = 'ACTIVE_CONVERSATION';
    const landed: string[] = [];
    const log = logger();
    const queue = new BookkeepingQueue({ log });
    // The DB takes 7 s for this statement: past the write timeout, it still commits.
    void queue.enqueue('call_state.tool_start', async () => {
      await sleep(BOOKKEEPING_WRITE_TIMEOUT_MS + 2_000);
      state = 'TOOL_EXECUTION';
      landed.push('tool_start');
    });
    void queue.enqueue('call_state.tool_end', async () => {
      await sleep(10);
      state = 'ACTIVE_CONVERSATION';
      landed.push('tool_end');
    });
    await vi.advanceTimersByTimeAsync(BOOKKEEPING_WRITE_TIMEOUT_MS + 100);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(10);
    // The later write did not start behind the stuck one's back, so it is the state left.
    expect(landed).toEqual(['tool_start', 'tool_end']);
    expect(state).toBe('ACTIVE_CONVERSATION');
    expect(log.error).toHaveBeenCalledWith('Bookkeeping write timed out; later writes wait for it to settle', expect.objectContaining({ write: 'call_state.tool_start' }));
  });

  it('flush resolves only after every write enqueued before it, not before the last one', async () => {
    const queue = new BookkeepingQueue({ log: logger() });
    const done: string[] = [];
    for (const [label, ms] of [['a', 300], ['b', 10], ['c', 900]] as const) {
      void queue.enqueue(label, async () => { await sleep(ms); done.push(label); });
    }
    let flushedAfter: string[] | undefined;
    void queue.flush().then(() => { flushedAfter = [...done]; });
    void queue.enqueue('later', async () => { await sleep(5_000); done.push('later'); });
    await vi.advanceTimersByTimeAsync(1_209);
    expect(flushedAfter).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    // Every earlier write, and not the one enqueued after the flush.
    expect(flushedAfter).toEqual(['a', 'b', 'c']);
  });

  it('flush on an empty queue resolves at once', async () => {
    const queue = new BookkeepingQueue({ log: logger() });
    expect(await queue.flush()).toBe('drained');
  });
});

describe('BookkeepingQueue: release', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('waits for open tool runs and the queued writes, then nothing more runs', async () => {
    const log = logger();
    const queue = new BookkeepingQueue({ log });
    const ran: string[] = [];
    const closeRun = queue.openRun();
    void queue.enqueue('begin', async () => { await sleep(100); ran.push('begin'); });

    let released = false;
    void queue.release().then(() => { released = true; });
    await vi.advanceTimersByTimeAsync(1_000);
    // A tool still running at teardown: its last writes still land.
    expect(released).toBe(false);
    void queue.enqueue('finish', async () => { await sleep(50); ran.push('finish'); });
    closeRun();
    await vi.advanceTimersByTimeAsync(100);
    expect(released).toBe(true);
    expect(queue.isReleased).toBe(true);
    expect(ran).toEqual(['begin', 'finish']);

    const late = vi.fn(async () => {});
    await queue.enqueue('late', late);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(late).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith('Bookkeeping write dropped: the call\'s queue was released', { write: 'late' });
  });

  it('a run that never closes holds release at most BOOKKEEPING_RELEASE_MAX_WAIT_MS; writes still queued then are dropped', async () => {
    const log = logger();
    const queue = new BookkeepingQueue({ log, writeTimeoutMs: 120_000 });
    queue.openRun();
    void queue.enqueue('hangs', () => new Promise(() => {}));
    const after = vi.fn(async () => {});
    void queue.enqueue('after', after);
    let released = false;
    void queue.release().then(() => { released = true; });
    await vi.advanceTimersByTimeAsync(BOOKKEEPING_RELEASE_MAX_WAIT_MS - 1);
    expect(released).toBe(false);
    // At the bound (plus the 0 ms flush it leaves itself, one timer turn later).
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(released).toBe(true);
    expect(log.error).toHaveBeenCalledWith('Bookkeeping release: tool runs still open', expect.objectContaining({ openRuns: 1 }));
    expect(log.error).toHaveBeenCalledWith('Bookkeeping release: writes still queued are dropped', { dropped: 2 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(after).not.toHaveBeenCalled();
  });

  it('release is idempotent', async () => {
    const queue = new BookkeepingQueue({ log: logger() });
    const first = queue.release();
    expect(queue.release()).toBe(first);
    await first;
    expect(queue.isReleased).toBe(true);
  });
});

describe('BookkeepingQueue: drain (before the final call state)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('waits for an open tool run to queue its last writes and for them to land, without releasing', async () => {
    const queue = new BookkeepingQueue({ log: logger() });
    const ran: string[] = [];
    const closeRun = queue.openRun();
    let drained: string | undefined;
    void queue.drain('call_completed').then((r) => { drained = r; });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(drained).toBeUndefined();
    void queue.enqueue('call_state.tool_end', async () => { await sleep(50); ran.push('tool_end'); });
    closeRun();
    await vi.advanceTimersByTimeAsync(49);
    expect(drained).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(drained).toBe('drained');
    expect(ran).toEqual(['tool_end']);
    expect(queue.isReleased).toBe(false);
    await queue.enqueue('after_drain', async () => { ran.push('after_drain'); });
    expect(ran).toEqual(['tool_end', 'after_drain']);
  });

  it('a run that never closes holds drain at most BOOKKEEPING_FINALIZE_DRAIN_MAX_MS (logged)', async () => {
    const log = logger();
    const queue = new BookkeepingQueue({ log });
    queue.openRun();
    let drained: string | undefined;
    void queue.drain('call_completed').then((r) => { drained = r; });
    await vi.advanceTimersByTimeAsync(BOOKKEEPING_FINALIZE_DRAIN_MAX_MS - 1);
    expect(drained).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(drained).toBe('drained');
    expect(log.error).toHaveBeenCalledWith('Bookkeeping drain: tool runs still open', { reason: 'call_completed', openRuns: 1, waitedMs: BOOKKEEPING_FINALIZE_DRAIN_MAX_MS });
  });

  it('with no open run and an empty queue it resolves at once', async () => {
    const queue = new BookkeepingQueue({ log: logger() });
    expect(await queue.drain()).toBe('drained');
  });
});

describe('BookkeepingQueue: a logger that throws', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('never rejects the chain or stalls later writes; they still run, in order', async () => {
    const boom = () => { throw new Error('logger down'); };
    const queue = new BookkeepingQueue({ log: { info: boom, warn: boom, error: boom }, writeTimeoutMs: 100 });
    const ran: string[] = [];
    const results: Array<Promise<void>> = [];
    results.push(queue.enqueue('fails', async () => { throw Object.assign(new Error('x'), { code: '23505' }); }));
    results.push(queue.enqueue('slow', async () => { await sleep(150); ran.push('slow'); }));
    results.push(queue.enqueue('next', async () => { ran.push('next'); }));
    await vi.advanceTimersByTimeAsync(150);
    await expect(Promise.all(results)).resolves.toBeDefined();
    expect(ran).toEqual(['slow', 'next']);

    // flush timeout, drain timeout, release and a dropped write log too.
    void queue.enqueue('stuck', () => new Promise(() => {}));
    const flushed = queue.flush('teardown', 10);
    await vi.advanceTimersByTimeAsync(10);
    await expect(flushed).resolves.toBe('timeout');
    queue.openRun();
    const drained = queue.drain('call_completed', 10);
    await vi.advanceTimersByTimeAsync(BOOKKEEPING_FLUSH_TIMEOUT_MS + 10);
    await expect(drained).resolves.toBe('timeout');
    const released = queue.release();
    await vi.advanceTimersByTimeAsync(BOOKKEEPING_RELEASE_MAX_WAIT_MS + 1);
    await expect(released).resolves.toBeUndefined();
    await expect(queue.enqueue('late', async () => {})).resolves.toBeUndefined();
  });
});

describe('BookkeepingQueue: the DB statement timeout scope', () => {
  it('isBookkeepingWrite() is true inside a queued write (across its awaits) and false outside', async () => {
    const queue = new BookkeepingQueue({ log: logger() });
    const seen: boolean[] = [];
    expect(isBookkeepingWrite()).toBe(false);
    await queue.enqueue('w', async () => {
      seen.push(isBookkeepingWrite());
      await sleep(1);
      seen.push(isBookkeepingWrite());
    });
    expect(seen).toEqual([true, true]);
    expect(isBookkeepingWrite()).toBe(false);
  });
});

describe('BookkeepingQueue: the critical path waits for nothing', () => {
  it('onCriticalPath resolves while the writes just queued are still pending', async () => {
    const queue = new BookkeepingQueue({ log: logger() });
    let written = false;
    void queue.enqueue('slow', async () => { await sleep(20); written = true; });
    await queue.onCriticalPath();
    expect(written).toBe(false);
    expect(queue.depth).toBe(1);
    await queue.settled();
    expect(written).toBe(true);
  });
});
