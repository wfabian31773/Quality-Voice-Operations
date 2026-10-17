import { describe, expect, it } from 'vitest';
import { executeWithRetry, NonRetryableToolError } from './RetryOrchestrator';
import {
  TOOL_STOPPED_CODE,
  ToolStopGuard,
  isToolStoppedResult,
  toolStoppedResult,
} from './ToolStopGuard';

const fast = { baseDelayMs: 1, maxDelayMs: 2, timeoutMs: 1000, maxRetries: 2 };

function failing(counter: { calls: number }, err: () => Error = () => new Error('ToolExecutionFailed: db down')) {
  return async () => {
    counter.calls += 1;
    throw err();
  };
}

describe('ToolStopGuard', () => {
  it('stops a tool after 3 failures in one call, per call + tool, and clears on call end', () => {
    const guard = new ToolStopGuard();
    guard.recordFailure('call-1', 'create_booking');
    guard.recordFailure('call-1', 'create_booking');
    expect(guard.isStopped('call-1', 'create_booking')).toBe(false);
    guard.recordFailure('call-1', 'create_booking');
    expect(guard.isStopped('call-1', 'create_booking')).toBe(true);
    expect(guard.isStopped('call-1', 'lookup_customer')).toBe(false);
    expect(guard.isStopped('call-2', 'create_booking')).toBe(false);

    guard.clearCall('call-1');
    expect(guard.isStopped('call-1', 'create_booking')).toBe(false);
    expect(guard.trackedCallCount()).toBe(0);
  });

  it('builds a structured non-retryable result that tells the model to stop, with no time promise', () => {
    const result = toolStoppedResult('create_booking', 3);
    expect(result).toMatchObject({ ok: false, success: false, code: TOOL_STOPPED_CODE, retryable: false, tool: 'create_booking', failedAttempts: 3 });
    expect(result.message).toMatch(/do not call it again/i);
    expect(result.message).toMatch(/follow up/i);
    expect(result.message_for_caller_hint).toMatch(/shop follow up/i);
    expect(`${result.message} ${result.message_for_caller_hint}`).not.toMatch(/within the hour|minutes|today|shortly|asap/i);
    expect(isToolStoppedResult(result)).toBe(true);
    expect(isToolStoppedResult({ success: false })).toBe(false);
  });
});

describe('executeWithRetry with a stop guard', () => {
  it('counts RetryOrchestrator retries: one call of 3 attempts stops the tool, the next call does not execute', async () => {
    const guard = new ToolStopGuard();
    const counter = { calls: 0 };
    const ctx = { tenantId: 't', toolName: 'create_booking', callSessionId: 'call-retries', retryConfig: fast, stopGuard: guard };

    const first = await executeWithRetry(failing(counter), ctx);
    expect(counter.calls).toBe(3);
    expect(first).toMatchObject({ success: false, attempts: 3, stopped: true });

    const second = await executeWithRetry(failing(counter), ctx);
    expect(counter.calls).toBe(3); // no 4th attempt
    expect(second).toMatchObject({ success: false, attempts: 0, stopped: true });
    expect(second.error).toMatch(/TOOL_STOPPED/);
  });

  it('counts across calls for non-retryable failures (1 attempt each): the 4th call never runs', async () => {
    const guard = new ToolStopGuard();
    const counter = { calls: 0 };
    const ctx = { tenantId: 't', toolName: 'create_booking', callSessionId: 'call-fast-fail', retryConfig: fast, stopGuard: guard };
    const sqlError = () => new NonRetryableToolError('ToolExecutionFailed: inconsistent types deduced for parameter $1');

    const results = [];
    for (let i = 0; i < 4; i++) results.push(await executeWithRetry(failing(counter, sqlError), ctx));
    expect(counter.calls).toBe(3);
    expect(results.map((r) => r.attempts)).toEqual([1, 1, 1, 0]);
    expect(results.map((r) => Boolean(r.stopped))).toEqual([false, false, true, true]);
  });

  it('stops mid-retry once the threshold is reached (earlier failures in the call count)', async () => {
    const guard = new ToolStopGuard();
    guard.recordFailure('call-mid', 'send_sms');
    guard.recordFailure('call-mid', 'send_sms');
    const counter = { calls: 0 };
    const res = await executeWithRetry(failing(counter), { tenantId: 't', toolName: 'send_sms', callSessionId: 'call-mid', retryConfig: fast, stopGuard: guard });
    expect(counter.calls).toBe(1);
    expect(res).toMatchObject({ attempts: 1, stopped: true });
  });

  it('does not stop other tools, other calls, or a call after it ended', async () => {
    const guard = new ToolStopGuard();
    const counter = { calls: 0 };
    await executeWithRetry(failing(counter), { tenantId: 't', toolName: 'create_booking', callSessionId: 'call-a', retryConfig: fast, stopGuard: guard });
    expect(guard.isStopped('call-a', 'create_booking')).toBe(true);

    let okCalls = 0;
    const ok = async () => { okCalls += 1; return 'ok'; };
    expect((await executeWithRetry(ok, { tenantId: 't', toolName: 'lookup_customer', callSessionId: 'call-a', retryConfig: fast, stopGuard: guard })).success).toBe(true);
    expect((await executeWithRetry(ok, { tenantId: 't', toolName: 'create_booking', callSessionId: 'call-b', retryConfig: fast, stopGuard: guard })).success).toBe(true);
    guard.clearCall('call-a');
    expect((await executeWithRetry(ok, { tenantId: 't', toolName: 'create_booking', callSessionId: 'call-a', retryConfig: fast, stopGuard: guard })).success).toBe(true);
    expect(okCalls).toBe(3);
  });

  it('a success does not reset the count (3 failures in the call, not 3 in a row)', async () => {
    const guard = new ToolStopGuard();
    const ctx = { tenantId: 't', toolName: 'book', callSessionId: 'call-mixed', retryConfig: { ...fast, maxRetries: 0 }, stopGuard: guard };
    const counter = { calls: 0 };
    await executeWithRetry(failing(counter), ctx);
    await executeWithRetry(async () => 'ok', ctx);
    await executeWithRetry(failing(counter), ctx);
    expect(guard.isStopped('call-mixed', 'book')).toBe(false);
    await executeWithRetry(failing(counter), ctx);
    expect(guard.isStopped('call-mixed', 'book')).toBe(true);
  });

  it('without a guard, behavior is unchanged (no stop)', async () => {
    const counter = { calls: 0 };
    for (let i = 0; i < 3; i++) {
      const res = await executeWithRetry(failing(counter), { tenantId: 't', toolName: 'x', callSessionId: 'c', retryConfig: fast });
      expect(res.stopped).toBeUndefined();
    }
    expect(counter.calls).toBe(9);
  });
});
