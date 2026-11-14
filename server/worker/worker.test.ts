import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { SchedulerWorker, awaitInFlightWork, type PoolStats } from './worker';
import type { SchedulerDefinition } from '../../platform/runtime/schedulers';
import { isPrivilegedScope } from '../../platform/db/tenantScope';

function fakeScheduler(name: string): SchedulerDefinition & { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> } {
  return { name, start: vi.fn(), stop: vi.fn() } as never;
}

function setup(stats: { current: PoolStats }) {
  const order: string[] = [];
  let hooks!: { onAcquire: () => void; onLose: () => void };
  const elector = {
    leader: false,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {
      order.push('release-lock');
    }),
    isLeader: () => false,
  };
  const s1 = fakeScheduler('campaigns');
  const s2 = fakeScheduler('gin');
  s1.stop.mockImplementation(() => order.push('stop:campaigns'));
  const closePool = vi.fn(async () => {
    order.push('close-pool');
  });
  const worker = new SchedulerWorker({
    schedulers: [s1, s2],
    ctx: { voiceGatewayBaseUrl: 'https://voice.example.com' },
    createElector: (h) => {
      hooks = h;
      return elector;
    },
    pool: () => stats.current,
    closePool,
    inFlightTimeoutMs: 100_000,
  });
  return { worker, elector, s1, s2, closePool, order, hooks: () => hooks };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('SchedulerWorker', () => {
  it('starts schedulers only when leadership is acquired, and stops them on loss', async () => {
    const t = setup({ current: { totalCount: 0, idleCount: 0, waitingCount: 0 } });
    await t.worker.start();
    expect(t.s1.start).not.toHaveBeenCalled();
    t.hooks().onAcquire();
    t.hooks().onAcquire();
    expect(t.s1.start).toHaveBeenCalledTimes(1);
    expect(t.s1.start).toHaveBeenCalledWith({ voiceGatewayBaseUrl: 'https://voice.example.com' });
    expect(t.worker.isRunningSchedulers()).toBe(true);
    t.hooks().onLose();
    expect(t.s1.stop).toHaveBeenCalledTimes(1);
    expect(t.s2.stop).toHaveBeenCalledTimes(1);
    expect(t.worker.isRunningSchedulers()).toBe(false);
  });

  it('starts schedulers in the privileged DB scope', async () => {
    const t = setup({ current: { totalCount: 0, idleCount: 0, waitingCount: 0 } });
    let privileged = false;
    t.s1.start.mockImplementation(() => { privileged = isPrivilegedScope(); });
    await t.worker.start();
    t.hooks().onAcquire();
    expect(privileged).toBe(true);
  });

  it('SIGTERM: stop ticks → wait for the in-flight tick → release lock → close pool', async () => {
    const stats = { current: { totalCount: 2, idleCount: 0, waitingCount: 0 } };
    const t = setup(stats);
    await t.worker.start();
    t.hooks().onAcquire();
    const p = t.worker.shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.elector.stop).not.toHaveBeenCalled(); // tick still in flight
    stats.current = { totalCount: 2, idleCount: 2, waitingCount: 0 };
    await vi.advanceTimersByTimeAsync(3_000);
    await p;
    expect(t.order).toEqual(['stop:campaigns', 'release-lock', 'close-pool']);
    t.hooks().onAcquire(); // a late acquire after shutdown never restarts schedulers
    expect(t.s1.start).toHaveBeenCalledTimes(1);
  });

  it('gives up waiting after 100 s', async () => {
    const t = setup({ current: { totalCount: 1, idleCount: 0, waitingCount: 0 } });
    await t.worker.start();
    t.hooks().onAcquire();
    const p = t.worker.shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(99_000);
    expect(t.elector.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    expect(t.elector.stop).toHaveBeenCalled();
    expect(t.closePool).toHaveBeenCalled();
  });

  it('waits for a scheduler reporting inFlight even when the pool is idle', async () => {
    const t = setup({ current: { totalCount: 1, idleCount: 1, waitingCount: 0 } });
    let ticking = true; // e.g. campaigns awaiting Twilio with no DB client held
    t.s1.inFlight = () => ticking;
    await t.worker.start();
    t.hooks().onAcquire();
    const p = t.worker.shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.elector.stop).not.toHaveBeenCalled();
    expect(t.closePool).not.toHaveBeenCalled();
    ticking = false;
    await vi.advanceTimersByTimeAsync(3_000);
    await p;
    expect(t.order).toEqual(['stop:campaigns', 'release-lock', 'close-pool']);
  });

  it('still gives up after 100 s when a scheduler never clears inFlight', async () => {
    const t = setup({ current: { totalCount: 0, idleCount: 0, waitingCount: 0 } });
    t.s2.inFlight = () => true;
    await t.worker.start();
    t.hooks().onAcquire();
    const p = t.worker.shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(99_000);
    expect(t.elector.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    expect(t.elector.stop).toHaveBeenCalled();
    expect(t.closePool).toHaveBeenCalled();
  });

  it('a standby (never leader) shuts down without waiting', async () => {
    const t = setup({ current: { totalCount: 5, idleCount: 0, waitingCount: 0 } });
    await t.worker.start();
    await t.worker.shutdown('SIGTERM');
    expect(t.elector.stop).toHaveBeenCalled();
    await t.worker.shutdown('SIGTERM');
    expect(t.elector.stop).toHaveBeenCalledTimes(1);
  });

  it('cancels deferred scheduler starts on leadership loss', async () => {
    const run = vi.fn();
    let deferred: ReturnType<typeof setTimeout> | null = null;
    const scheduler: SchedulerDefinition = {
      name: 'insights',
      start: () => {
        deferred = setTimeout(run, 60_000);
      },
      stop: () => {
        if (deferred) {
          clearTimeout(deferred);
          deferred = null;
        }
      },
    };
    let hooks!: { onAcquire: () => void; onLose: () => void };
    const worker = new SchedulerWorker({
      schedulers: [scheduler],
      ctx: { voiceGatewayBaseUrl: 'https://voice.example.com' },
      createElector: (h) => {
        hooks = h;
        return { start: async () => {}, stop: async () => {}, isLeader: () => false };
      },
      pool: () => ({ totalCount: 0, idleCount: 0, waitingCount: 0 }),
      closePool: async () => {},
    });
    await worker.start();
    hooks.onAcquire();
    hooks.onLose();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).not.toHaveBeenCalled();
  });

  it('cancels deferred scheduler starts on shutdown even after already losing leadership', async () => {
    const run = vi.fn();
    let deferred: ReturnType<typeof setTimeout> | null = null;
    const scheduler: SchedulerDefinition = {
      name: 'insights',
      start: () => {
        deferred = setTimeout(run, 60_000);
      },
      stop: () => {
        if (deferred) {
          clearTimeout(deferred);
          deferred = null;
        }
      },
    };
    let hooks!: { onAcquire: () => void; onLose: () => void };
    const electorStop = vi.fn(async () => {});
    const worker = new SchedulerWorker({
      schedulers: [scheduler],
      ctx: { voiceGatewayBaseUrl: 'https://voice.example.com' },
      createElector: (h) => {
        hooks = h;
        return { start: async () => {}, stop: electorStop, isLeader: () => false };
      },
      pool: () => ({ totalCount: 0, idleCount: 0, waitingCount: 0 }),
      closePool: async () => {},
    });
    await worker.start();
    hooks.onAcquire();
    hooks.onLose();
    await worker.shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).not.toHaveBeenCalled();
    expect(electorStop).toHaveBeenCalledTimes(1);
  });

  it('re-acquiring leadership starts schedulers exactly once per term', async () => {
    const t = setup({ current: { totalCount: 0, idleCount: 0, waitingCount: 0 } });
    await t.worker.start();
    t.hooks().onAcquire();
    t.hooks().onLose();
    t.hooks().onAcquire();
    t.hooks().onAcquire();
    expect(t.s1.start).toHaveBeenCalledTimes(2);
    expect(t.s1.stop).toHaveBeenCalledTimes(1);
    t.hooks().onLose();
    expect(t.s1.stop).toHaveBeenCalledTimes(2);
  });
});

describe('awaitInFlightWork', () => {
  it('needs two consecutive idle polls and counts waiting clients as busy', async () => {
    let stats: PoolStats = { totalCount: 1, idleCount: 1, waitingCount: 1 };
    let done = false;
    void awaitInFlightWork(() => stats, 10_000, 1_000).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(done).toBe(false);
    stats = { totalCount: 1, idleCount: 1, waitingCount: 0 };
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(true);
  });

  it('treats a missing pool as idle', async () => {
    const p = awaitInFlightWork(() => null, 1_000, 10);
    await vi.advanceTimersByTimeAsync(20);
    await expect(p).resolves.toBe(true);
  });
});
