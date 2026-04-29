import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { expireStaleCsatRequestsMock, loggerInfoMock, loggerErrorMock, loggerDebugMock } =
  vi.hoisted(() => ({
    expireStaleCsatRequestsMock: vi.fn(),
    loggerInfoMock: vi.fn(),
    loggerErrorMock: vi.fn(),
    loggerDebugMock: vi.fn(),
  }));

vi.mock('./CsatSurveyService', () => ({
  expireStaleCsatRequests: expireStaleCsatRequestsMock,
}));

vi.mock('../core/logger', () => ({
  createLogger: () => ({
    info: loggerInfoMock,
    error: loggerErrorMock,
    debug: loggerDebugMock,
    warn: vi.fn(),
  }),
}));

import {
  runCsatExpirationCycle,
  startCsatExpirationScheduler,
  stopCsatExpirationScheduler,
  CSAT_EXPIRATION_DEFAULTS,
} from './CsatExpirationScheduler';

describe('CsatExpirationScheduler', () => {
  beforeEach(() => {
    expireStaleCsatRequestsMock.mockReset();
    loggerInfoMock.mockReset();
    loggerErrorMock.mockReset();
    loggerDebugMock.mockReset();
  });

  afterEach(() => {
    stopCsatExpirationScheduler();
    vi.useRealTimers();
  });

  it('invokes expireStaleCsatRequests and returns the count', async () => {
    expireStaleCsatRequestsMock.mockResolvedValueOnce(7);

    const result = await runCsatExpirationCycle();

    expect(expireStaleCsatRequestsMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ expired: 7 });
  });

  it('logs the expired row count when work was done', async () => {
    expireStaleCsatRequestsMock.mockResolvedValueOnce(3);

    await runCsatExpirationCycle();

    expect(loggerInfoMock).toHaveBeenCalledWith(
      expect.stringContaining('CSAT expiration cycle flipped stale pending rows'),
      { expired: 3 },
    );
  });

  it('logs at debug level and reports zero when there is nothing to expire', async () => {
    expireStaleCsatRequestsMock.mockResolvedValueOnce(0);

    const result = await runCsatExpirationCycle();

    expect(result).toEqual({ expired: 0 });
    expect(loggerInfoMock).not.toHaveBeenCalled();
    expect(loggerDebugMock).toHaveBeenCalledWith(
      expect.stringContaining('CSAT expiration cycle found no stale rows'),
      { expired: 0 },
    );
  });

  it('returns zero and does not throw when the underlying service fails', async () => {
    expireStaleCsatRequestsMock.mockRejectedValueOnce(new Error('db down'));

    const result = await runCsatExpirationCycle();

    expect(result).toEqual({ expired: 0 });
    expect(loggerErrorMock).toHaveBeenCalledWith(
      expect.stringContaining('Failed to expire stale CSAT requests'),
      expect.objectContaining({ error: 'db down' }),
    );
  });

  it('runs at least once per hour by default', () => {
    expect(CSAT_EXPIRATION_DEFAULTS.intervalMs).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it('start is idempotent — a second start call does not register additional timers', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    startCsatExpirationScheduler(60_000);
    const firstIntervalCalls = setIntervalSpy.mock.calls.length;
    const firstTimeoutCalls = setTimeoutSpy.mock.calls.length;
    startCsatExpirationScheduler(60_000);
    expect(setIntervalSpy).toHaveBeenCalledTimes(firstIntervalCalls);
    expect(setTimeoutSpy).toHaveBeenCalledTimes(firstTimeoutCalls);

    stopCsatExpirationScheduler();
    stopCsatExpirationScheduler(); // safe to call twice
  });

  it('stop clears both the initial-delay timer and the recurring interval', () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    startCsatExpirationScheduler(60_000);
    stopCsatExpirationScheduler();

    expect(clearTimeoutSpy).toHaveBeenCalled();
    expect(clearIntervalSpy).toHaveBeenCalled();
  });

  it('the scheduler invokes the expiration cycle on its interval', async () => {
    vi.useFakeTimers();
    expireStaleCsatRequestsMock.mockResolvedValue(0);

    // Use an interval longer than the initial delay so the two timers
    // fire predictably and we can count calls one cycle at a time.
    const intervalMs = CSAT_EXPIRATION_DEFAULTS.initialDelayMs * 2;
    startCsatExpirationScheduler(intervalMs);

    // Initial-delay timer fires first
    await vi.advanceTimersByTimeAsync(CSAT_EXPIRATION_DEFAULTS.initialDelayMs);
    expect(expireStaleCsatRequestsMock).toHaveBeenCalledTimes(1);

    // Then the recurring interval ticks
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(expireStaleCsatRequestsMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(expireStaleCsatRequestsMock).toHaveBeenCalledTimes(3);
  });
});
