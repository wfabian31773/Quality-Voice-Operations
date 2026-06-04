import { describe, it, expect, vi, afterEach } from 'vitest';
import { sessionManager, type ActiveSession } from './sessionManager';

let counter = 0;
function makeSession(overrides: Partial<ActiveSession> = {}): ActiveSession {
  counter += 1;
  return {
    callSessionId: `cs-${counter}`,
    tenantId: 'tenant-1',
    agentId: 'agent-1',
    callSid: `CA${counter}`,
    startedAt: new Date(),
    cleanup: vi.fn(async () => {}),
    ...overrides,
  };
}

// The sessionManager is a module singleton; clean up registrations between
// tests. (drainAll is exercised last because `draining` cannot be reset.)
afterEach(() => {
  for (const id of [...Array(counter).keys()].map((i) => `cs-${i + 1}`)) {
    sessionManager.unregister(id);
  }
});

describe('sessionManager registration', () => {
  it('registers, looks up by session id and call sid, and counts', () => {
    const s = makeSession();
    sessionManager.register(s);
    expect(sessionManager.getActiveCount()).toBe(1);
    expect(sessionManager.get(s.callSessionId)).toBe(s);
    expect(sessionManager.getByCallSid(s.callSid)).toBe(s);
    expect(sessionManager.getByCallSid('CA-missing')).toBeUndefined();
  });

  it('unregisters a session', () => {
    const s = makeSession();
    sessionManager.register(s);
    sessionManager.unregister(s.callSessionId);
    expect(sessionManager.getActiveCount()).toBe(0);
    expect(sessionManager.get(s.callSessionId)).toBeUndefined();
  });

  it('reports metrics broken down by tenant', () => {
    sessionManager.register(makeSession({ tenantId: 'a' }));
    sessionManager.register(makeSession({ tenantId: 'a' }));
    sessionManager.register(makeSession({ tenantId: 'b' }));
    const metrics = sessionManager.getMetrics();
    expect(metrics.activeSessions).toBe(3);
    expect(metrics.sessionsByTenant).toEqual({ a: 2, b: 1 });
  });

  it('is not draining under normal operation', () => {
    expect(sessionManager.isDraining()).toBe(false);
  });
});

describe('sessionManager.drainAll', () => {
  it('cleans up every session, tolerates failures, and clears the registry', async () => {
    const ok = makeSession();
    const failing = makeSession({ cleanup: vi.fn(async () => { throw new Error('boom'); }) });
    sessionManager.register(ok);
    sessionManager.register(failing);

    await sessionManager.drainAll();

    expect(ok.cleanup).toHaveBeenCalledTimes(1);
    expect(failing.cleanup).toHaveBeenCalledTimes(1);
    expect(sessionManager.getActiveCount()).toBe(0);
    expect(sessionManager.isDraining()).toBe(true);
  });

  it('enforces the cleanup timeout for a hung session', async () => {
    vi.useFakeTimers();
    try {
      const hung = makeSession({ cleanup: vi.fn(() => new Promise<void>(() => {})) });
      sessionManager.register(hung);
      const drain = sessionManager.drainAll(1000);
      await vi.advanceTimersByTimeAsync(1000);
      await drain;
      expect(sessionManager.getActiveCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
