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

  it('a failure recorded after clearCall (hangup mid-tool) does not recreate the call entry', () => {
    const guard = new ToolStopGuard();
    guard.recordFailure('call-late', 'create_booking');
    guard.clearCall('call-late');
    expect(guard.recordFailure('call-late', 'create_booking')).toBe(0);
    expect(guard.failureCount('call-late', 'create_booking')).toBe(0);
    expect(guard.trackedCallCount()).toBe(0);

    // A call id that starts again is tracked again.
    guard.openCall('call-late');
    expect(guard.recordFailure('call-late', 'create_booking')).toBe(1);
  });

  it('remembers a bounded number of cleared calls', () => {
    const guard = new ToolStopGuard(3, 2);
    for (const id of ['c1', 'c2', 'c3']) guard.clearCall(id);
    // c1 fell out of the bounded set; c2 and c3 are still closed.
    expect(guard.recordFailure('c1', 't')).toBe(1);
    expect(guard.recordFailure('c2', 't')).toBe(0);
    expect(guard.recordFailure('c3', 't')).toBe(0);
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
  it('retries inside one call count once: 3 failed calls stop the tool, the 4th does not execute', async () => {
    const guard = new ToolStopGuard();
    const counter = { calls: 0 };
    const ctx = { tenantId: 't', toolName: 'create_booking', callSessionId: 'call-retries', retryConfig: fast, stopGuard: guard };

    const first = await executeWithRetry(failing(counter), ctx);
    expect(counter.calls).toBe(3);
    expect(first).toMatchObject({ success: false, attempts: 3 });
    expect(first.stopped).toBeUndefined();
    expect(guard.failureCount('call-retries', 'create_booking')).toBe(1);

    const second = await executeWithRetry(failing(counter), ctx);
    expect(second.stopped).toBeUndefined();
    const third = await executeWithRetry(failing(counter), ctx);
    expect(counter.calls).toBe(9);
    expect(third).toMatchObject({ success: false, attempts: 3, stopped: true });

    const fourth = await executeWithRetry(failing(counter), ctx);
    expect(counter.calls).toBe(9); // the 4th call never runs
    expect(fourth).toMatchObject({ success: false, attempts: 0, stopped: true });
    expect(fourth.error).toMatch(/TOOL_STOPPED/);
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

  it('a call that recovers on a retry records no failure', async () => {
    const guard = new ToolStopGuard();
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls < 3) throw new Error('ToolExecutionFailed: timeout');
      return 'ok';
    };
    const res = await executeWithRetry(flaky, { tenantId: 't', toolName: 'send_sms', callSessionId: 'call-flaky', retryConfig: fast, stopGuard: guard });
    expect(res).toMatchObject({ success: true, attempts: 3 });
    expect(guard.failureCount('call-flaky', 'send_sms')).toBe(0);
  });

  it('a failed call after two earlier failed calls stops the tool (earlier failures in the call count)', async () => {
    const guard = new ToolStopGuard();
    guard.recordFailure('call-mid', 'send_sms');
    guard.recordFailure('call-mid', 'send_sms');
    const counter = { calls: 0 };
    const res = await executeWithRetry(failing(counter), { tenantId: 't', toolName: 'send_sms', callSessionId: 'call-mid', retryConfig: fast, stopGuard: guard });
    expect(counter.calls).toBe(3);
    expect(res).toMatchObject({ attempts: 3, stopped: true });
    expect(guard.failureCount('call-mid', 'send_sms')).toBe(3);
  });

  it('does not stop other tools, other calls, or a call after it ended', async () => {
    const guard = new ToolStopGuard();
    const counter = { calls: 0 };
    for (let i = 0; i < 3; i++) {
      await executeWithRetry(failing(counter), { tenantId: 't', toolName: 'create_booking', callSessionId: 'call-a', retryConfig: fast, stopGuard: guard });
    }
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
    for (let i = 0; i < 4; i++) {
      const res = await executeWithRetry(failing(counter), { tenantId: 't', toolName: 'x', callSessionId: 'c', retryConfig: fast });
      expect(res.stopped).toBeUndefined();
    }
    expect(counter.calls).toBe(12);
  });
});
