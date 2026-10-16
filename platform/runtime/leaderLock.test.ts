import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { LeaderElector, resolveLeaderLockUrl, DEFAULT_LEADER_LOCK_KEY, type LeaderLockClient } from './leaderLock';

class FakeClient implements LeaderLockClient {
  static lockHolder: FakeClient | null = null;
  listeners: Record<string, Array<(...a: unknown[]) => void>> = {};
  queries: string[] = [];
  failNext = false;
  ended = false;
  async connect() {}
  async query(sql: string) {
    this.queries.push(sql);
    if (this.failNext) {
      this.failNext = false;
      throw new Error('connection lost');
    }
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

function elector(overrides: Partial<ConstructorParameters<typeof LeaderElector>[0]> = {}) {
  const clients: FakeClient[] = [];
  const onAcquire = vi.fn();
  const onLose = vi.fn();
  const e = new LeaderElector({
    connectionString: 'postgres://x@h:5432/db',
    onAcquire,
    onLose,
    clientFactory: () => {
      const c = new FakeClient();
      clients.push(c);
      return c;
    },
    ...overrides,
  });
  return { e, clients, onAcquire, onLose };
}

beforeEach(() => {
  FakeClient.lockHolder = null;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('LeaderElector', () => {
  it('acquires, uses the default key, and releases on stop', async () => {
    const { e, clients, onAcquire } = elector();
    await e.start();
    expect(e.isLeader()).toBe(true);
    expect(onAcquire).toHaveBeenCalledTimes(1);
    await e.stop();
    expect(e.isLeader()).toBe(false);
    expect(clients[0].queries.some((q) => q.includes('pg_advisory_unlock'))).toBe(true);
    expect(clients[0].ended).toBe(true);
    expect(FakeClient.lockHolder).toBeNull();
    expect(DEFAULT_LEADER_LOCK_KEY).toBe('89431140160075');
  });

  it('a standby retries every 10 s and takes over after the leader stops', async () => {
    const a = elector();
    const b = elector();
    await a.e.start();
    await b.e.start();
    expect(b.e.isLeader()).toBe(false);
    await a.e.stop();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(b.e.isLeader()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(b.e.isLeader()).toBe(true);
    expect(b.onAcquire).toHaveBeenCalledTimes(1);
    await b.e.stop();
  });

  it('steps down (onLose) when the health check fails, then retries', async () => {
    const { e, clients, onLose, onAcquire } = elector({ healthCheckIntervalMs: 1_000 });
    await e.start();
    clients[0].failNext = true;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(e.isLeader()).toBe(false);
    expect(onLose).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(e.isLeader()).toBe(true);
    expect(onAcquire).toHaveBeenCalledTimes(2);
    await e.stop();
  });

  it('steps down when the lock connection emits error', async () => {
    const { e, clients, onLose } = elector();
    await e.start();
    for (const l of clients[0].listeners.error ?? []) l(new Error('reset'));
    await vi.advanceTimersByTimeAsync(0);
    expect(onLose).toHaveBeenCalledTimes(1);
    await e.stop();
  });

  it('retries after a failed connection attempt', async () => {
    let fail = true;
    const { e } = elector({
      clientFactory: () => {
        const c = new FakeClient();
        if (fail) {
          c.connect = async () => {
            fail = false;
            throw new Error('ECONNREFUSED');
          };
        }
        return c;
      },
    });
    await e.start();
    expect(e.isLeader()).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(e.isLeader()).toBe(true);
    await e.stop();
  });

  it('stop() during standby cancels retries', async () => {
    const a = elector();
    const b = elector();
    await a.e.start();
    await b.e.start();
    await b.e.stop();
    await a.e.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(b.e.isLeader()).toBe(false);
  });
});

describe('resolveLeaderLockUrl', () => {
  it('prefers WORKER_LEADER_DB_URL', () => {
    expect(resolveLeaderLockUrl({ WORKER_LEADER_DB_URL: 'postgres://u@h:5432/d', APP_ENV: 'production' })).toBe('postgres://u@h:5432/d');
  });
  it('falls back to DATABASE_URL in development only', () => {
    expect(resolveLeaderLockUrl({ DATABASE_URL: 'postgres://u@h/d' })).toBe('postgres://u@h/d');
    expect(() => resolveLeaderLockUrl({ DATABASE_URL: 'postgres://u@h/d', APP_ENV: 'production', PLATFORM_DB_POOL_URL: 'x' })).toThrow(/WORKER_LEADER_DB_URL is not set/);
  });
  it('refuses the transaction pooler port and never echoes the URL', () => {
    const url = 'postgres://user:hunter2@pooler:6543/db';
    expect(() => resolveLeaderLockUrl({ WORKER_LEADER_DB_URL: url })).toThrow(/6543/);
    try {
      resolveLeaderLockUrl({ WORKER_LEADER_DB_URL: url });
    } catch (err) {
      expect(String(err)).not.toContain('hunter2');
    }
    expect(() => resolveLeaderLockUrl({ WORKER_LEADER_DB_URL: 'not a url' })).toThrow(/not a valid/);
  });
});
