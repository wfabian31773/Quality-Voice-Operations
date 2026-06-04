import { describe, it, expect, vi, afterEach } from 'vitest';
import { withRetry } from './retry';
import { withTimeout } from './timeout';
import { CircuitBreaker, CircuitOpenError } from './circuitBreaker';
import { getCircuitBreaker, getCircuitBreakerMetrics } from './circuitBreakerRegistry';
import { withResiliency } from './index';
import { OPENAI_RETRY_CONFIG, TWILIO_RETRY_CONFIG } from './presets';
import type { RetryOptions } from './types';

const FAST: RetryOptions = { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2 };

afterEach(() => {
  vi.useRealTimers();
});

describe('withRetry', () => {
  it('returns the result on the first successful attempt', async () => {
    const res = await withRetry(async () => 'ok', FAST);
    expect(res).toMatchObject({ success: true, result: 'ok', attempts: 1 });
    expect(res.totalTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('retries a failing operation until it succeeds', async () => {
    let calls = 0;
    const res = await withRetry(async () => {
      calls += 1;
      if (calls < 3) throw new Error('transient');
      return 'recovered';
    }, FAST);
    expect(res.success).toBe(true);
    expect(res.attempts).toBe(3);
  });

  it('gives up after maxAttempts and returns the last error', async () => {
    const res = await withRetry(async () => { throw new Error('always'); }, FAST);
    expect(res.success).toBe(false);
    expect(res.attempts).toBe(3);
    expect((res.error as Error).message).toBe('always');
  });

  it('does not retry a non-retryable error', async () => {
    let calls = 0;
    const res = await withRetry(
      async () => { calls += 1; throw new Error('fatal'); },
      { ...FAST, retryableErrors: () => false },
    );
    expect(res.success).toBe(false);
    expect(res.attempts).toBe(1);
    expect(calls).toBe(1);
  });

  it('invokes the onRetry hook with attempt, error and delay', async () => {
    const onRetry = vi.fn();
    let calls = 0;
    await withRetry(async () => {
      calls += 1;
      if (calls < 2) throw new Error('boom');
      return 'ok';
    }, { ...FAST, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toBe(1);
    expect((onRetry.mock.calls[0][1] as Error).message).toBe('boom');
    expect(typeof onRetry.mock.calls[0][2]).toBe('number');
  });
});

describe('withTimeout', () => {
  it('resolves when the promise beats the deadline', async () => {
    await expect(withTimeout(Promise.resolve('done'), 1000)).resolves.toBe('done');
  });

  it('rejects with a descriptive error on timeout', async () => {
    await expect(
      withTimeout(new Promise<never>(() => {}), 10, 'Fetch'),
    ).rejects.toThrow('Fetch timed out after 10ms');
  });

  it('propagates the original rejection and clears the timer', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
  });
});

describe('CircuitBreaker', () => {
  async function trip(cb: CircuitBreaker, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      await cb.execute(async () => { throw new Error('fail'); }).catch(() => {});
    }
  }

  it('passes through while closed and exposes metrics', async () => {
    const cb = new CircuitBreaker('cb-1', { failureThreshold: 3, resetTimeoutMs: 1000 });
    expect(cb.getState()).toBe('closed');
    expect(await cb.execute(async () => 42)).toBe(42);
    expect(cb.getMetrics()).toMatchObject({ state: 'closed', failureCount: 0 });
  });

  it('opens after the failure threshold and fast-fails with CircuitOpenError', async () => {
    const cb = new CircuitBreaker('cb-2', { failureThreshold: 3, resetTimeoutMs: 1000 });
    await trip(cb, 3);
    expect(cb.getState()).toBe('open');
    await expect(cb.execute(async () => 'x')).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('resets the failure count on an intervening success', async () => {
    const cb = new CircuitBreaker('cb-3', { failureThreshold: 3, resetTimeoutMs: 1000 });
    await trip(cb, 2);
    await cb.execute(async () => 'ok');
    expect(cb.getMetrics().failureCount).toBe(0);
    await trip(cb, 2);
    expect(cb.getState()).toBe('closed'); // 2 < threshold again
  });

  it('half-opens after the reset timeout and closes on success', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const onStateChange = vi.fn();
    const cb = new CircuitBreaker('cb-4', { failureThreshold: 2, resetTimeoutMs: 1000, onStateChange });
    await trip(cb, 2);
    expect(cb.getState()).toBe('open');
    vi.setSystemTime(1000); // reset window elapsed
    expect(await cb.execute(async () => 'recovered')).toBe('recovered');
    expect(cb.getState()).toBe('closed');
    expect(onStateChange).toHaveBeenCalledWith('open', 'half-open');
    expect(onStateChange).toHaveBeenCalledWith('half-open', 'closed');
  });

  it('re-opens when the half-open probe fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const cb = new CircuitBreaker('cb-5', { failureThreshold: 2, resetTimeoutMs: 1000 });
    await trip(cb, 2);
    vi.setSystemTime(1000);
    await cb.execute(async () => { throw new Error('still down'); }).catch(() => {});
    expect(cb.getState()).toBe('open');
  });

  it('caps half-open probe attempts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const cb = new CircuitBreaker('cb-6', { failureThreshold: 1, resetTimeoutMs: 1000, halfOpenMaxAttempts: 1 });
    await trip(cb, 1);
    vi.setSystemTime(1000);
    // First half-open probe is allowed (and hangs the slot by throwing)…
    await cb.execute(async () => { throw new Error('x'); }).catch(() => {});
    // …now open again; before the next reset window a probe fast-fails.
    await expect(cb.execute(async () => 'y')).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('can be manually reset', async () => {
    const cb = new CircuitBreaker('cb-7', { failureThreshold: 1, resetTimeoutMs: 1000 });
    await trip(cb, 1);
    expect(cb.getState()).toBe('open');
    cb.reset();
    expect(cb.getState()).toBe('closed');
  });

  it('CircuitOpenError carries a retry-after hint', () => {
    const err = new CircuitOpenError('svc', 5000);
    expect(err.name).toBe('CircuitOpenError');
    expect(err.retryAfterMs).toBe(5000);
    expect(err.message).toContain('5s');
  });
});

describe('circuitBreakerRegistry', () => {
  it('returns the same instance for a given name', () => {
    expect(getCircuitBreaker('reg:test:a')).toBe(getCircuitBreaker('reg:test:a'));
  });

  it('applies provider-specific defaults inferred from the name', async () => {
    // Twilio default threshold is 3; openai is 5.
    const twilio = getCircuitBreaker('reg:twilio-default');
    for (let i = 0; i < 3; i++) {
      await twilio.execute(async () => { throw new Error('f'); }).catch(() => {});
    }
    expect(twilio.getState()).toBe('open');

    const openai = getCircuitBreaker('reg:openai-default');
    for (let i = 0; i < 3; i++) {
      await openai.execute(async () => { throw new Error('f'); }).catch(() => {});
    }
    expect(openai.getState()).toBe('closed'); // needs 5 to open
  });

  it('reports metrics for every registered breaker', () => {
    getCircuitBreaker('reg:metrics-probe');
    expect(getCircuitBreakerMetrics()['reg:metrics-probe']).toMatchObject({ state: 'closed' });
  });
});

describe('withResiliency', () => {
  it('retries a retryable failure through the breaker then succeeds', async () => {
    const cb = new CircuitBreaker('wr-1', { failureThreshold: 10, resetTimeoutMs: 1000 });
    let calls = 0;
    const res = await withResiliency(async () => {
      calls += 1;
      if (calls < 2) throw new Error('transient');
      return 'ok';
    }, cb, FAST);
    expect(res.success).toBe(true);
    expect(res.result).toBe('ok');
  });

  it('never retries a CircuitOpenError (fast-fail signal)', async () => {
    const cb = new CircuitBreaker('wr-2', { failureThreshold: 1, resetTimeoutMs: 60_000 });
    await cb.execute(async () => { throw new Error('down'); }).catch(() => {});
    expect(cb.getState()).toBe('open');
    const res = await withResiliency(async () => 'never-runs', cb, FAST);
    expect(res.success).toBe(false);
    expect(res.attempts).toBe(1);
    expect(res.error).toBeInstanceOf(CircuitOpenError);
  });
});

describe('retry presets retryableErrors', () => {
  it('OPENAI config retries timeouts and 5xx, not 4xx', () => {
    const r = OPENAI_RETRY_CONFIG.retryableErrors!;
    expect(r(new Error('Request timed out'))).toBe(true);
    expect(r(new Error('ECONNRESET'))).toBe(true);
    expect(r(new Error('HTTP 503'))).toBe(true);
    expect(r(new Error('HTTP 400 bad request'))).toBe(false);
    expect(r('not-an-error')).toBe(false);
  });

  it('TWILIO config retries rate limits and timeouts', () => {
    const r = TWILIO_RETRY_CONFIG.retryableErrors!;
    expect(r(new Error('429 rate limit'))).toBe(true);
    expect(r(new Error('connection timeout'))).toBe(true);
    expect(r(new Error('HTTP 502'))).toBe(true);
    expect(r(new Error('HTTP 404'))).toBe(false);
  });
});
