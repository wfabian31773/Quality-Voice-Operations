import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createVoiceShutdown } from './shutdown';
import { SessionManager } from './services/sessionManager';

function setup(env: Record<string, string> = {}) {
  const sessions = new SessionManager();
  const server = { close: vi.fn((cb?: () => void) => cb?.()), closeAllConnections: vi.fn() };
  const closePool = vi.fn(async () => {});
  const stopCanary = vi.fn();
  const exit = vi.fn();
  const shutdown = createVoiceShutdown({ server, sessions, closePool, stopCanary, exit, env });
  return { sessions, server, closePool, stopCanary, exit, shutdown };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('voice SIGTERM drain', () => {
  it('keeps serving until the live call ends on its own, then closes the pool and exits 0', async () => {
    const { sessions, server, closePool, exit, shutdown } = setup();
    const cleanup = vi.fn(async () => {});
    sessions.register({ callSessionId: 's1', tenantId: 't', agentId: 'a', callSid: 'CA1', startedAt: new Date(), cleanup });
    setTimeout(() => sessions.unregister('s1'), 60_000);

    const p = shutdown.drainAndExit('SIGTERM');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sessions.isDraining()).toBe(true);
    expect(server.close).not.toHaveBeenCalled(); // still serving /healthz + redirect TwiML
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(31_000);
    await p;
    expect(cleanup).not.toHaveBeenCalled();
    expect(server.close).toHaveBeenCalled();
    expect(closePool).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('cleans up stragglers at DRAIN_TIMEOUT_MS and still exits 0', async () => {
    const { sessions, exit, shutdown } = setup({ DRAIN_TIMEOUT_MS: '5000' });
    const cleanup = vi.fn(async () => {});
    sessions.register({ callSessionId: 's1', tenantId: 't', agentId: 'a', callSid: 'CA1', startedAt: new Date(), cleanup });
    const p = shutdown.drainAndExit('SIGTERM');
    await vi.advanceTimersByTimeAsync(6_000);
    await p;
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('ignores a second signal while draining', async () => {
    const { exit, shutdown, stopCanary } = setup();
    const a = shutdown.drainAndExit('SIGTERM');
    const b = shutdown.drainAndExit('SIGINT');
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([a, b]);
    expect(stopCanary).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('exits 0 even if closing the pool fails', async () => {
    const { closePool, exit, shutdown } = setup();
    closePool.mockRejectedValueOnce(new Error('boom'));
    await shutdown.drainAndExit('SIGTERM');
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe('uncaughtException fast path', () => {
  it('cleans up live calls immediately (no natural-end wait)', async () => {
    const { sessions, exit, shutdown } = setup();
    const cleanup = vi.fn(async () => {});
    sessions.register({ callSessionId: 's1', tenantId: 't', agentId: 'a', callSid: 'CA1', startedAt: new Date(), cleanup });
    await shutdown.fastShutdown('uncaughtException');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    await shutdown.fastShutdown('again');
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
