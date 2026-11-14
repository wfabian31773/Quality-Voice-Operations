/**
 * Fake-timer proof that a leadership failover yields exactly one worker
 * running jobs inside the 10 s retry window, with no double run after loss.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { SchedulerWorker } from './worker';
import {
  LeaderElector,
  type LeaderLockClient,
} from '../../platform/runtime/leaderLock';
import type { SchedulerDefinition } from '../../platform/runtime/schedulers';

class FakeClient implements LeaderLockClient {
  static lockHolder: FakeClient | null = null;
  listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  queries: string[] = [];
  ended = false;
  async connect() {}
  async query(sql: string) {
    this.queries.push(sql);
    if (sql.includes('pg_try_advisory_lock')) {
      if (!FakeClient.lockHolder || FakeClient.lockHolder === this) {
        FakeClient.lockHolder = this;
        return { rows: [{ locked: true }] };
      }
      return { rows: [{ locked: false }] };
    }
    if (sql.includes('pg_advisory_unlock') && FakeClient.lockHolder === this) FakeClient.lockHolder = null;
    return { rows: [{}] };
  }
  async end() {
    this.ended = true;
    if (FakeClient.lockHolder === this) FakeClient.lockHolder = null;
    for (const l of this.listeners.end ?? []) l();
  }
  on(event: string, l: (...a: unknown[]) => void) {
    (this.listeners[event] ??= []).push(l);
    return this;
  }
}

const RETRY_MS = 10_000;
const JOB_INTERVAL_MS = 1_000;
const DEFERRED_MS = 60_000;

function makeJobScheduler(run: (owner: string, kind: 'deferred' | 'tick') => void, owner: string): SchedulerDefinition {
  let interval: ReturnType<typeof setInterval> | null = null;
  let deferred: ReturnType<typeof setTimeout> | null = null;
  return {
    name: 'leader-only',
    start: () => {
      deferred = setTimeout(() => run(owner, 'deferred'), DEFERRED_MS);
      interval = setInterval(() => run(owner, 'tick'), JOB_INTERVAL_MS);
    },
    stop: () => {
      if (deferred) {
        clearTimeout(deferred);
        deferred = null;
      }
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  };
}

function makeWorker(owner: string, run: (owner: string, kind: 'deferred' | 'tick') => void) {
  const clients: FakeClient[] = [];
  const worker = new SchedulerWorker({
    schedulers: [makeJobScheduler(run, owner)],
    ctx: { voiceGatewayBaseUrl: 'https://voice.example.com' },
    createElector: (hooks) =>
      new LeaderElector({
        connectionString: 'postgres://x@h:5432/db',
        retryIntervalMs: RETRY_MS,
        healthCheckIntervalMs: 1_000,
        onAcquire: hooks.onAcquire,
        onLose: hooks.onLose,
        clientFactory: () => {
          const c = new FakeClient();
          clients.push(c);
          return c;
        },
      }),
    pool: () => ({ totalCount: 0, idleCount: 0, waitingCount: 0 }),
    closePool: async () => {},
    inFlightTimeoutMs: 20,
    pollIntervalMs: 1,
  });
  return { worker, clients };
}

beforeEach(() => {
  FakeClient.lockHolder = null;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('worker leader failover', () => {
  it('after leadership loss the loser runs no further jobs; the standby is sole leader within 10 s', async () => {
    const runs: Array<{ owner: string; kind: 'deferred' | 'tick'; at: number }> = [];
    const run = (owner: string, kind: 'deferred' | 'tick') => {
      runs.push({ owner, kind, at: Date.now() });
    };
    const a = makeWorker('a', run);
    const b = makeWorker('b', run);

    await a.worker.start();
    await b.worker.start();
    expect(a.worker.isRunningSchedulers()).toBe(true);
    expect(b.worker.isRunningSchedulers()).toBe(false);

    await vi.advanceTimersByTimeAsync(3_000);
    const ticksWhileALed = runs.filter((r) => r.kind === 'tick');
    expect(ticksWhileALed.length).toBeGreaterThan(0);
    expect(ticksWhileALed.every((r) => r.owner === 'a')).toBe(true);
    expect(runs.some((r) => r.owner === 'b')).toBe(false);

    const lostAt = Date.now();
    for (const l of a.clients[0].listeners.error ?? []) l(new Error('reset'));
    await vi.advanceTimersByTimeAsync(0);
    expect(a.worker.isRunningSchedulers()).toBe(false);

    const afterLoss = runs.length;
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(b.worker.isRunningSchedulers()).toBe(true);
    expect(a.worker.isRunningSchedulers()).toBe(false);
    expect(Date.now() - lostAt).toBeLessThanOrEqual(RETRY_MS);

    await vi.advanceTimersByTimeAsync(3_000);
    const afterFailover = runs.slice(afterLoss);
    expect(afterFailover.length).toBeGreaterThan(0);
    expect(afterFailover.every((r) => r.owner === 'b')).toBe(true);
    expect(runs.filter((r) => r.kind === 'tick' && r.owner === 'a' && r.at > lostAt)).toHaveLength(0);

    const aDown = a.worker.shutdown('SIGTERM');
    const bDown = b.worker.shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(50);
    await aDown;
    await bDown;
  }, 15_000);

  it('deferred first-run is cancelled on loss and on shutdown; re-acquire runs it once', async () => {
    const runs: Array<{ owner: string; kind: 'deferred' | 'tick' }> = [];
    const run = (owner: string, kind: 'deferred' | 'tick') => {
      runs.push({ owner, kind });
    };
    const a = makeWorker('a', run);
    const b = makeWorker('b', run);

    await a.worker.start();
    await b.worker.start();

    for (const l of a.clients[0].listeners.error ?? []) l(new Error('reset'));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(DEFERRED_MS);
    expect(runs.filter((r) => r.kind === 'deferred' && r.owner === 'a')).toHaveLength(0);

    // B became leader at 10 s; its deferred first-run is 60 s later (t=70 s).
    await vi.advanceTimersByTimeAsync(RETRY_MS);
    expect(b.worker.isRunningSchedulers()).toBe(true);
    expect(runs.filter((r) => r.kind === 'deferred')).toEqual([{ owner: 'b', kind: 'deferred' }]);

    const aDown = a.worker.shutdown('SIGTERM');
    const bDown = b.worker.shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(50);
    await aDown;
    await bDown;
    const afterShutdown = runs.filter((r) => r.kind === 'deferred').length;
    await vi.advanceTimersByTimeAsync(DEFERRED_MS);
    expect(runs.filter((r) => r.kind === 'deferred')).toHaveLength(afterShutdown);
  }, 15_000);
});
