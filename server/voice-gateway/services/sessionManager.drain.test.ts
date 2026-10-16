import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }));
vi.mock('../../../platform/core/logger', () => ({
  createLogger: () => ({ info: h.info, warn: h.warn, error: h.error, debug: vi.fn() }),
}));

import {
  SessionManager,
  redactCallSidForLog,
  resolveDrainTimeoutMs,
  DEFAULT_DRAIN_TIMEOUT_MS,
  type ActiveSession,
} from './sessionManager';

function fakeSession(mgr: SessionManager, id: string, callSid: string, opts: { endAfterMs?: number } = {}) {
  const cleanup = vi.fn(async () => {
    mgr.unregister(id);
  });
  const session: ActiveSession = {
    callSessionId: id,
    tenantId: 't1',
    agentId: 'a1',
    callSid,
    startedAt: new Date(Date.now()),
    cleanup,
  };
  mgr.register(session);
  if (opts.endAfterMs !== undefined) {
    setTimeout(() => mgr.unregister(id), opts.endAfterMs);
  }
  return { session, cleanup };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-16T08:00:00Z'));
  h.warn.mockReset();
  h.info.mockReset();
  h.error.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionManager.drainGracefully', () => {
  it('does not clean up a call early: waits for it to end on its own (60 s)', async () => {
    const mgr = new SessionManager();
    const { cleanup } = fakeSession(mgr, 's1', 'CA1111111111', { endAfterMs: 60_000 });

    let done = false;
    const p = mgr.drainGracefully({ timeoutMs: 285_000 }).then((r) => {
      done = true;
      return r;
    });
    expect(mgr.isDraining()).toBe(true);

    await vi.advanceTimersByTimeAsync(59_000);
    expect(done).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
    expect(mgr.getActiveCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(2_000);
    const result = await p;
    expect(result.endedNaturally).toBe(true);
    expect(result.stragglers).toBe(0);
    expect(result.waitedMs).toBeGreaterThanOrEqual(60_000);
    expect(result.waitedMs).toBeLessThanOrEqual(61_000);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('polls every second', async () => {
    const mgr = new SessionManager();
    fakeSession(mgr, 's1', 'CA1', { endAfterMs: 2_500 });
    let settled = false;
    void mgr.drainGracefully({ timeoutMs: 10_000 }).then(() => (settled = true));
    // Session ends at 2.5 s; the next 1 s poll (t = 3 s) notices it.
    await vi.advanceTimersByTimeAsync(2_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
  });

  it('cleans up and logs (SID + age) only the calls still active at the timeout', async () => {
    const mgr = new SessionManager();
    const short = fakeSession(mgr, 's-short', 'CAshort000001', { endAfterMs: 10_000 });
    const long = fakeSession(mgr, 's-long', 'CAlong0000002');

    const p = mgr.drainGracefully({ timeoutMs: 285_000 });
    await vi.advanceTimersByTimeAsync(284_000);
    expect(long.cleanup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await p;

    expect(result).toMatchObject({ endedNaturally: false, stragglers: 1 });
    expect(short.cleanup).not.toHaveBeenCalled();
    expect(long.cleanup).toHaveBeenCalledTimes(1);
    expect(mgr.getActiveCount()).toBe(0);
    const straggler = h.warn.mock.calls.find((c) => String(c[0]).includes('cleaning up call still active'));
    expect(straggler?.[1]).toMatchObject({ callSid: 'CAlong0000002', callId: 's-long', ageSec: 285 });
  });

  it('redacts the call SID in the straggler log when DISABLE_PHI_LOGGING=true', async () => {
    const prev = process.env.DISABLE_PHI_LOGGING;
    process.env.DISABLE_PHI_LOGGING = 'true';
    try {
      const mgr = new SessionManager();
      fakeSession(mgr, 's1', 'CA0123456789abcdef');
      const p = mgr.drainGracefully({ timeoutMs: 1_000 });
      await vi.advanceTimersByTimeAsync(2_000);
      await p;
      const logged = h.warn.mock.calls.find((c) => String(c[0]).includes('cleaning up'))?.[1] as Record<string, unknown>;
      expect(logged.callSid).toBe('CA…cdef');
      expect(JSON.stringify(h.warn.mock.calls)).not.toContain('CA0123456789abcdef');
    } finally {
      if (prev === undefined) delete process.env.DISABLE_PHI_LOGGING;
      else process.env.DISABLE_PHI_LOGGING = prev;
    }
  });

  it('also waits for accepted streams that have not registered a session yet', async () => {
    const mgr = new SessionManager();
    const release = mgr.trackConnection();
    let done = false;
    const p = mgr.drainGracefully({ timeoutMs: 60_000 }).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(done).toBe(false);
    expect(mgr.getDrainStatus().openStreams).toBe(1);
    release();
    release(); // idempotent
    await vi.advanceTimersByTimeAsync(1_000);
    await p;
    expect(done).toBe(true);
    expect(mgr.getDrainStatus().openStreams).toBe(0);
  });

  it('bounds a hung straggler cleanup', async () => {
    const mgr = new SessionManager();
    mgr.register({
      callSessionId: 'hung',
      tenantId: 't',
      agentId: 'a',
      callSid: 'CAh',
      startedAt: new Date(),
      cleanup: () => new Promise(() => {}),
    });
    const p = mgr.drainGracefully({ timeoutMs: 1_000, stragglerCleanupTimeoutMs: 5_000 });
    await vi.advanceTimersByTimeAsync(7_000);
    await expect(p).resolves.toMatchObject({ stragglers: 1 });
    expect(h.error).toHaveBeenCalledWith('Session cleanup failed', expect.objectContaining({ callId: 'hung' }));
  });
});

describe('SessionManager.getDrainStatus', () => {
  it('reports draining, active sessions and the oldest session age', async () => {
    const mgr = new SessionManager();
    fakeSession(mgr, 'a', 'CAa');
    await vi.advanceTimersByTimeAsync(42_000);
    fakeSession(mgr, 'b', 'CAb');
    expect(mgr.getDrainStatus()).toEqual({ draining: false, activeSessions: 2, oldestSessionAgeSec: 42, openStreams: 0 });
    mgr.beginDrain();
    mgr.beginDrain();
    expect(mgr.getDrainStatus().draining).toBe(true);
  });

  it('reports 0 age with no sessions', () => {
    expect(new SessionManager().getDrainStatus()).toEqual({ draining: false, activeSessions: 0, oldestSessionAgeSec: 0, openStreams: 0 });
  });
});

describe('SessionManager.drainAll (uncaughtException fast path)', () => {
  it('cleans up every live call immediately', async () => {
    const mgr = new SessionManager();
    const a = fakeSession(mgr, 'a', 'CAa');
    const b = fakeSession(mgr, 'b', 'CAb');
    await mgr.drainAll(30_000);
    expect(a.cleanup).toHaveBeenCalled();
    expect(b.cleanup).toHaveBeenCalled();
    expect(mgr.getActiveCount()).toBe(0);
    expect(mgr.isDraining()).toBe(true);
  });
});

describe('helpers', () => {
  it('resolveDrainTimeoutMs defaults to 285000 and honors DRAIN_TIMEOUT_MS', () => {
    expect(resolveDrainTimeoutMs({})).toBe(DEFAULT_DRAIN_TIMEOUT_MS);
    expect(DEFAULT_DRAIN_TIMEOUT_MS).toBe(285_000);
    expect(resolveDrainTimeoutMs({ DRAIN_TIMEOUT_MS: '1000' })).toBe(1000);
    expect(resolveDrainTimeoutMs({ DRAIN_TIMEOUT_MS: 'nope' })).toBe(285_000);
    expect(resolveDrainTimeoutMs({ DRAIN_TIMEOUT_MS: '-5' })).toBe(285_000);
  });

  it('redactCallSidForLog keeps the SID unless DISABLE_PHI_LOGGING=true', () => {
    expect(redactCallSidForLog('CA0123456789', {})).toBe('CA0123456789');
    expect(redactCallSidForLog('CA0123456789', { DISABLE_PHI_LOGGING: 'true' })).toBe('CA…6789');
    expect(redactCallSidForLog('CA12', { DISABLE_PHI_LOGGING: 'true' })).toBe('***');
    expect(redactCallSidForLog('', { DISABLE_PHI_LOGGING: 'true' })).toBe('');
  });
});
