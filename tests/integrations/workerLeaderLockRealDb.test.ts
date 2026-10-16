// @vitest-environment node
//
// PR-00: worker leader election against a real Postgres. Two worker
// instances → exactly one runs schedulers; when the leader exits (graceful
// stop or SIGKILL) the standby takes over within 15 s using the production
// 10 s retry interval.
//
// Like the other real-DB suites, this skips cleanly when DATABASE_URL is
// unset or unreachable (CI has no Postgres). Run locally with a disposable
// Postgres, e.g. DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres.
import { describe, it, expect, afterEach } from 'vitest';
import { Client } from 'pg';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { LeaderElector } from '../../platform/runtime/leaderLock';

const URL_RAW = process.env.DATABASE_URL ?? '';

async function probeReachable(): Promise<boolean> {
  if (!URL_RAW) return false;
  const probe = new Client({ connectionString: URL_RAW, connectionTimeoutMillis: 2_000 });
  try {
    await probe.connect();
    await probe.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => {});
  }
}
const dbReachable = await probeReachable();
const skipReason = !URL_RAW
  ? 'DATABASE_URL not set — skipping worker leader-lock real-DB test'
  : !dbReachable
    ? 'Postgres server unreachable — skipping worker leader-lock real-DB test'
    : null;

const RETRY_MS = 10_000; // production default
const TAKEOVER_BUDGET_MS = 15_000;

function makeWorker(lockKey: string) {
  const state = { running: false, acquiredAt: 0 };
  const elector = new LeaderElector({
    connectionString: URL_RAW,
    lockKey,
    retryIntervalMs: RETRY_MS,
    healthCheckIntervalMs: 1_000,
    onAcquire: () => {
      state.running = true;
      state.acquiredAt = Date.now();
    },
    onLose: () => {
      state.running = false;
    },
  });
  return { elector, state };
}

async function waitFor(cond: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`condition not met within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe.skipIf(skipReason !== null)('worker leader lock (real Postgres)', () => {
  it('two workers → exactly one leader; the standby takes over within 15 s after a graceful exit', async () => {
    const key = String(randomInt(1, 2 ** 47));
    const a = makeWorker(key);
    const b = makeWorker(key);
    cleanups.push(() => a.elector.stop(), () => b.elector.stop());

    await a.elector.start();
    await b.elector.start();
    expect([a.state.running, b.state.running].filter(Boolean)).toHaveLength(1);
    expect(a.elector.isLeader()).toBe(true);
    expect(b.elector.isLeader()).toBe(false);

    const stoppedAt = Date.now();
    await a.elector.stop();
    await waitFor(() => b.state.running, TAKEOVER_BUDGET_MS);
    expect(b.state.acquiredAt - stoppedAt).toBeLessThanOrEqual(TAKEOVER_BUDGET_MS);
    expect(b.elector.isLeader()).toBe(true);
    expect(a.elector.isLeader()).toBe(false);
  }, 30_000);

  it('the standby takes over within 15 s after the leader process is killed', async () => {
    const key = String(randomInt(1, 2 ** 47));
    // One OS process (no tsx launcher wrapper), so SIGKILL really kills the
    // session holding the lock, like Render killing the container.
    const child: ChildProcess = spawn(process.execPath, ['--import', 'tsx', path.join(__dirname, 'fixtures/leaderLockChild.ts')], {
      env: { ...process.env, LEADER_TEST_URL: URL_RAW, LEADER_TEST_KEY: key },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    cleanups.push(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });
    let out = '';
    child.stdout!.on('data', (d) => (out += String(d)));
    await waitFor(() => out.includes('LEADER'), 20_000);

    const b = makeWorker(key);
    cleanups.push(() => b.elector.stop());
    await b.elector.start();
    expect(b.state.running).toBe(false);

    const killedAt = Date.now();
    child.kill('SIGKILL');
    await waitFor(() => b.state.running, TAKEOVER_BUDGET_MS);
    expect(Date.now() - killedAt).toBeLessThanOrEqual(TAKEOVER_BUDGET_MS);
  }, 45_000);

  it('the leader steps down when its lock session is terminated', async () => {
    const key = String(randomInt(1, 2 ** 47));
    const a = makeWorker(key);
    cleanups.push(() => a.elector.stop());
    await a.elector.start();
    expect(a.state.running).toBe(true);

    const admin = new Client({ connectionString: URL_RAW });
    await admin.connect();
    cleanups.push(() => admin.end());
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'qvo-worker-leader' AND pid IN (
         SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted
           AND ((classid::bigint << 32) | objid::bigint) = $1::bigint)`,
      [key],
    );
    await waitFor(() => !a.state.running, 5_000);
  }, 30_000);
});
