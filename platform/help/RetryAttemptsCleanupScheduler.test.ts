import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { poolQueryMock, getRetryCooldownSecondsMock, getSupportReplyRetryCooldownSecondsMock } =
  vi.hoisted(() => ({
    poolQueryMock: vi.fn(),
    getRetryCooldownSecondsMock: vi.fn(),
    getSupportReplyRetryCooldownSecondsMock: vi.fn(),
  }));

vi.mock('../db', () => ({
  getPlatformPool: () => ({ query: poolQueryMock }),
}));

vi.mock('./docsFeedbackRetryLimiter', () => ({
  getRetryCooldownSeconds: getRetryCooldownSecondsMock,
}));

vi.mock('./supportReplyRetryLimiter', () => ({
  getSupportReplyRetryCooldownSeconds: getSupportReplyRetryCooldownSecondsMock,
}));

import {
  computeRetryAttemptsCutoffSeconds,
  runRetryAttemptsCleanupCycle,
  startRetryAttemptsCleanupScheduler,
  stopRetryAttemptsCleanupScheduler,
  RETRY_ATTEMPTS_CLEANUP_DEFAULTS,
} from './RetryAttemptsCleanupScheduler';

describe('RetryAttemptsCleanupScheduler', () => {
  beforeEach(() => {
    poolQueryMock.mockReset();
    getRetryCooldownSecondsMock.mockReset().mockReturnValue(60);
    getSupportReplyRetryCooldownSecondsMock.mockReset().mockReturnValue(60);
  });

  afterEach(() => {
    stopRetryAttemptsCleanupScheduler();
    vi.useRealTimers();
  });

  it('uses the largest configured cooldown plus the safety margin', () => {
    getRetryCooldownSecondsMock.mockReturnValue(60);
    getSupportReplyRetryCooldownSecondsMock.mockReturnValue(300);

    const cutoff = computeRetryAttemptsCutoffSeconds();

    expect(cutoff).toBe(300 + RETRY_ATTEMPTS_CLEANUP_DEFAULTS.safetyMarginSeconds);
  });

  it('handles negative cooldown values by clamping to zero before adding the safety margin', () => {
    getRetryCooldownSecondsMock.mockReturnValue(-1);
    getSupportReplyRetryCooldownSecondsMock.mockReturnValue(-50);

    const cutoff = computeRetryAttemptsCutoffSeconds();

    expect(cutoff).toBe(RETRY_ATTEMPTS_CLEANUP_DEFAULTS.safetyMarginSeconds);
  });

  it('runs a DELETE against retry_attempts using the computed cutoff', async () => {
    getRetryCooldownSecondsMock.mockReturnValue(120);
    getSupportReplyRetryCooldownSecondsMock.mockReturnValue(60);
    poolQueryMock.mockResolvedValueOnce({ rowCount: 7, rows: [] });

    const result = await runRetryAttemptsCleanupCycle();

    expect(poolQueryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(String(sql)).toMatch(/DELETE FROM retry_attempts/);
    expect(String(sql)).toMatch(/last_attempt_at\s*<\s*NOW\(\)\s*-\s*make_interval/);
    const expectedCutoff = 120 + RETRY_ATTEMPTS_CLEANUP_DEFAULTS.safetyMarginSeconds;
    expect(params).toEqual([expectedCutoff]);
    expect(result).toEqual({ deleted: 7, cutoffSeconds: expectedCutoff });
  });

  it('honours an explicitly-supplied cutoffSeconds option', async () => {
    poolQueryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await runRetryAttemptsCleanupCycle({ cutoffSeconds: 999 });

    expect(poolQueryMock).toHaveBeenCalledWith(expect.any(String), [999]);
    expect(result).toEqual({ deleted: 0, cutoffSeconds: 999 });
    // Cooldown getters are not consulted when cutoff is explicit.
    expect(getRetryCooldownSecondsMock).not.toHaveBeenCalled();
    expect(getSupportReplyRetryCooldownSecondsMock).not.toHaveBeenCalled();
  });

  it('clamps an explicit cutoff of zero to a minimum of one second', async () => {
    poolQueryMock.mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await runRetryAttemptsCleanupCycle({ cutoffSeconds: 0 });

    expect(poolQueryMock).toHaveBeenCalledWith(expect.any(String), [1]);
    expect(result.cutoffSeconds).toBe(1);
  });

  it('returns a zero-deleted result and does not throw when the DELETE fails', async () => {
    poolQueryMock.mockRejectedValueOnce(new Error('db down'));

    const result = await runRetryAttemptsCleanupCycle({ cutoffSeconds: 100 });

    expect(result).toEqual({ deleted: 0, cutoffSeconds: 100 });
  });

  it('treats a missing rowCount as zero deleted rows', async () => {
    poolQueryMock.mockResolvedValueOnce({ rows: [] });

    const result = await runRetryAttemptsCleanupCycle({ cutoffSeconds: 100 });

    expect(result.deleted).toBe(0);
  });

  it('start is idempotent — a second start call does not register additional timers', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    startRetryAttemptsCleanupScheduler(60_000);
    const firstIntervalCalls = setIntervalSpy.mock.calls.length;
    const firstTimeoutCalls = setTimeoutSpy.mock.calls.length;
    startRetryAttemptsCleanupScheduler(60_000);
    expect(setIntervalSpy).toHaveBeenCalledTimes(firstIntervalCalls);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(firstTimeoutCalls);

    stopRetryAttemptsCleanupScheduler();
    stopRetryAttemptsCleanupScheduler(); // safe to call twice
  });

  it('stop clears both the initial-delay timer and the recurring interval', () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    startRetryAttemptsCleanupScheduler(60_000);
    stopRetryAttemptsCleanupScheduler();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });
});
