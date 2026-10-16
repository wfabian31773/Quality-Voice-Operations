import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../core/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() }),
}));

import { closeWithTimeout, DEFAULT_CLOSE_TIMEOUT_MS } from './boundedClose';

beforeEach(() => {
  warn.mockClear();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('closeWithTimeout', () => {
  it('resolves true when close finishes in time', async () => {
    const close = vi.fn(async () => {});
    await expect(closeWithTimeout('DB pool', close)).resolves.toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up after the timeout (default 5 s) when close hangs', async () => {
    let result: boolean | undefined;
    void closeWithTimeout('DB pool', () => new Promise<void>(() => {})).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(DEFAULT_CLOSE_TIMEOUT_MS - 1);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe(false);
    expect(DEFAULT_CLOSE_TIMEOUT_MS).toBe(5_000);
    expect(warn).toHaveBeenCalledWith('DB pool close timed out; exiting anyway', { timeoutMs: 5_000 });
  });

  it('never throws when close rejects', async () => {
    await expect(closeWithTimeout('DB pool', async () => Promise.reject(new Error('boom')), 100)).resolves.toBe(false);
    expect(warn).toHaveBeenCalledWith('DB pool close failed', { error: 'boom' });
    expect(vi.getTimerCount()).toBe(0);
  });
});
