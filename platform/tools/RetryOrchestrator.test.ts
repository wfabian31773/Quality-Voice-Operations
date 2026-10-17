import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  executeWithRetry,
  onToolFailure,
  removeToolFailureListener,
  setToolRetryConfig,
  getToolRetryConfig,
  clearToolRetryConfig,
  DEFAULT_RETRY_CONFIG,
  isRetryableSqlState,
  isRetryableToolError,
  NonRetryableToolError,
  type ToolFailureEvent,
} from './RetryOrchestrator';

// Tiny delays / generous timeout so the retry loop runs fast under real timers.
const fast = { baseDelayMs: 1, maxDelayMs: 2, timeoutMs: 1000, maxRetries: 2 };
const ctx = (over = {}) => ({
  tenantId: 'tenant-1',
  toolName: 'createServiceTicket',
  callSessionId: 'cs-1',
  retryConfig: fast,
  ...over,
});

const listeners: Array<(e: ToolFailureEvent) => void> = [];
function capture(): ToolFailureEvent[] {
  const events: ToolFailureEvent[] = [];
  const fn = (e: ToolFailureEvent) => events.push(e);
  onToolFailure(fn);
  listeners.push(fn);
  return events;
}

afterEach(() => {
  for (const fn of listeners.splice(0)) removeToolFailureListener(fn);
});

describe('executeWithRetry', () => {
  it('returns the result on the first successful attempt', async () => {
    const res = await executeWithRetry(async () => 'ok', ctx());
    expect(res).toMatchObject({ success: true, result: 'ok', attempts: 1, usedFallback: false });
  });

  it('retries and succeeds on a later attempt', async () => {
    let n = 0;
    const res = await executeWithRetry(async () => {
      n += 1;
      if (n < 2) throw new Error('transient');
      return 'recovered';
    }, ctx());
    expect(res.success).toBe(true);
    expect(res.attempts).toBe(2);
  });

  it('exhausts retries and reports failure (no fallback)', async () => {
    const res = await executeWithRetry(async () => { throw new Error('always'); }, ctx());
    expect(res.success).toBe(false);
    expect(res.attempts).toBe(3); // maxRetries(2) + 1
    expect(res.usedFallback).toBe(false);
    expect(res.error).toContain('always');
  });

  it('falls back when retries are exhausted and the fallback succeeds', async () => {
    const res = await executeWithRetry(async () => { throw new Error('down'); }, ctx({
      fallbackExecutor: async () => 'from-fallback',
    }));
    expect(res.success).toBe(true);
    expect(res.result).toBe('from-fallback');
    expect(res.usedFallback).toBe(true);
  });

  it('reports failure when the fallback also fails', async () => {
    const res = await executeWithRetry(async () => { throw new Error('down'); }, ctx({
      fallbackExecutor: async () => { throw new Error('fallback-down'); },
    }));
    expect(res.success).toBe(false);
    expect(res.usedFallback).toBe(true);
    expect(res.error).toContain('fallback-down');
  });

  it('enforces a per-attempt timeout', async () => {
    const res = await executeWithRetry(
      () => new Promise<string>(() => {}), // never resolves
      ctx({ retryConfig: { ...fast, timeoutMs: 5, maxRetries: 0 } }),
    );
    expect(res.success).toBe(false);
    expect(res.error).toContain('timed out');
  });

  it('emits tool-failure events, with finalFailure on the last', async () => {
    const events = capture();
    await executeWithRetry(async () => { throw new Error('boom'); }, ctx());
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.finalFailure === false)).toBe(true); // retry events
    const final = events[events.length - 1];
    expect(final.finalFailure).toBe(true);
    expect(final.toolName).toBe('createServiceTicket');
  });

  it('emits a fallback-success event', async () => {
    const events = capture();
    await executeWithRetry(async () => { throw new Error('down'); }, ctx({
      fallbackExecutor: async () => 'ok',
    }));
    expect(events.some((e) => e.fallbackAttempted && e.fallbackSuccess)).toBe(true);
  });
});

describe('non-retryable failures', () => {
  const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

  it.each([
    ['42P18', 'inconsistent types deduced for parameter $1'],
    ['42804', 'column "tenant_id" is of type uuid but expression is of type text'],
    ['23505', 'duplicate key value violates unique constraint'],
    ['23P01', 'conflicting key value violates exclusion constraint'],
    ['22P02', 'invalid input syntax for type uuid'],
  ])('fails fast after one attempt on SQLSTATE %s', async (code, message) => {
    const events = capture();
    let calls = 0;
    const res = await executeWithRetry(async () => { calls += 1; throw pgError(code, message); }, ctx());
    expect(calls).toBe(1);
    expect(res).toMatchObject({ success: false, attempts: 1 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ finalFailure: true, retryCount: 1 });
  });

  it.each(['40001', '40P01', '53300', '57P01', '08006'])('keeps retrying transient SQLSTATE %s', async (code) => {
    let calls = 0;
    const res = await executeWithRetry(async () => { calls += 1; throw pgError(code, 'transient'); }, ctx());
    expect(calls).toBe(3);
    expect(res.attempts).toBe(3);
  });

  it('keeps retrying connection resets and timeouts', async () => {
    let calls = 0;
    await executeWithRetry(async () => { calls += 1; throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }); }, ctx());
    expect(calls).toBe(3);
    const timedOut = await executeWithRetry(
      () => new Promise<string>(() => {}),
      ctx({ retryConfig: { ...fast, timeoutMs: 5, maxRetries: 1 } }),
    );
    expect(timedOut.attempts).toBe(2);
  });

  it('honors an explicit retryable flag and NonRetryableToolError', async () => {
    let calls = 0;
    await executeWithRetry(async () => { calls += 1; throw new NonRetryableToolError('ToolExecutionFailed: title is required'); }, ctx());
    expect(calls).toBe(1);
    calls = 0;
    await executeWithRetry(async () => { calls += 1; throw Object.assign(new Error('x'), { code: '42P18', retryable: true }); }, ctx());
    expect(calls).toBe(3);
  });

  it('classifies tool results the same way', () => {
    expect(isRetryableToolError({ success: false, retryable: false, message: 'startTime must be a valid ISO-8601 timestamp.' })).toBe(false);
    expect(isRetryableToolError({ success: false, code: '23505' })).toBe(false);
    expect(isRetryableToolError({ success: false, message: 'Failed to store the booking request.' })).toBe(true);
    expect(isRetryableSqlState('VALIDATION_FAILED')).toBeUndefined();
  });
});

describe('per-tool retry config', () => {
  afterEach(() => clearToolRetryConfig('toolX'));

  it('returns defaults when nothing is set', () => {
    expect(getToolRetryConfig('toolX')).toEqual(DEFAULT_RETRY_CONFIG);
  });

  it('merges an override over the defaults and clears it', () => {
    setToolRetryConfig('toolX', { maxRetries: 7 });
    expect(getToolRetryConfig('toolX')).toMatchObject({ maxRetries: 7, baseDelayMs: DEFAULT_RETRY_CONFIG.baseDelayMs });
    clearToolRetryConfig('toolX');
    expect(getToolRetryConfig('toolX').maxRetries).toBe(DEFAULT_RETRY_CONFIG.maxRetries);
  });
});
