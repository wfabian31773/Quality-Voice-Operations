import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
  retryWithBackoff,
  retryFetch,
  parseRetryAfter,
  RetryFetchHttpError,
} from './retryWithBackoff';

function fakeSleep(): {
  sleep: (ms: number) => Promise<void>;
  delays: number[];
} {
  const delays: number[] = [];
  const sleep = async (ms: number) => {
    delays.push(ms);
  };
  return { sleep, delays };
}

const noJitter = (base: number) => base;

describe('retryWithBackoff', () => {
  test('returns the value on first success without sleeping', async () => {
    const { sleep, delays } = fakeSleep();
    const fn = vi.fn().mockResolvedValue('ok');

    const result = await retryWithBackoff(fn, { sleep, jitter: noJitter });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  test('retries up to maxAttempts then throws the last error', async () => {
    const { sleep, delays } = fakeSleep();
    const err = new Error('boom');
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      retryWithBackoff(fn, { sleep, jitter: noJitter }),
    ).rejects.toThrow('boom');

    expect(fn).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([1_000, 4_000]);
  });

  test('uses 1s/4s/16s default schedule across 4 attempts', async () => {
    const { sleep, delays } = fakeSleep();
    const fn = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(
      retryWithBackoff(fn, {
        maxAttempts: 4,
        sleep,
        jitter: noJitter,
      }),
    ).rejects.toThrow('boom');

    expect(fn).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([1_000, 4_000, 16_000]);
  });

  test('does not retry when shouldRetry returns false', async () => {
    const { sleep, delays } = fakeSleep();
    const err = new Error('fatal');
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      retryWithBackoff(fn, {
        sleep,
        jitter: noJitter,
        shouldRetry: () => false,
      }),
    ).rejects.toThrow('fatal');

    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  test('caps a single sleep at maxBackoffMs', async () => {
    const { sleep, delays } = fakeSleep();
    const fn = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(
      retryWithBackoff(fn, {
        sleep,
        jitter: () => 999_999,
        maxBackoffMs: 5_000,
      }),
    ).rejects.toThrow('boom');

    expect(delays.every((d) => d <= 5_000)).toBe(true);
  });

  test('total of default schedule stays well under 60s adapter budget', async () => {
    // 1s + 4s + 16s = 21s with no jitter; even with +20% jitter on every
    // step the upper bound is ~25s — comfortably below 60s.
    const { sleep, delays } = fakeSleep();
    const fn = vi.fn().mockRejectedValue(new Error('boom'));

    await expect(
      retryWithBackoff(fn, {
        maxAttempts: 4,
        sleep,
        jitter: (base) => base * 1.2,
      }),
    ).rejects.toThrow('boom');

    const total = delays.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(60_000);
  });
});

describe('parseRetryAfter', () => {
  test('parses delta-seconds', () => {
    expect(parseRetryAfter('5')).toBe(5_000);
    expect(parseRetryAfter('0')).toBe(0);
    expect(parseRetryAfter('120')).toBe(120_000);
  });

  test('parses HTTP-date relative to now', () => {
    const now = Date.parse('2026-04-25T10:00:00Z');
    const future = 'Sat, 25 Apr 2026 10:00:10 GMT';
    expect(parseRetryAfter(future, now)).toBe(10_000);
  });

  test('returns 0 for past HTTP-dates', () => {
    const now = Date.parse('2026-04-25T10:00:00Z');
    const past = 'Sat, 25 Apr 2026 09:59:00 GMT';
    expect(parseRetryAfter(past, now)).toBe(0);
  });

  test('returns null for missing or unparseable values', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter(undefined)).toBeNull();
    expect(parseRetryAfter('')).toBeNull();
    expect(parseRetryAfter('not-a-thing')).toBeNull();
    expect(parseRetryAfter('-5')).toBeNull();
  });
});

describe('retryFetch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  test('returns response immediately on 200', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const { sleep, delays } = fakeSleep();

    const res = await retryFetch('https://api.test/x', undefined, {
      fetcher,
      sleep,
      jitter: noJitter,
    });

    expect(res.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  test('does not retry on 400/401/403/404', async () => {
    for (const status of [400, 401, 403, 404]) {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(new Response('nope', { status }));
      const { sleep, delays } = fakeSleep();

      const res = await retryFetch('https://api.test/x', undefined, {
        fetcher,
        sleep,
        jitter: noJitter,
      });

      expect(res.status).toBe(status);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(delays).toEqual([]);
    }
  });

  test('retries 429 with Retry-After: 5 and resolves on second attempt', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('rate limited', {
          status: 429,
          headers: { 'Retry-After': '5' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const { sleep, delays } = fakeSleep();

    const res = await retryFetch('https://api.test/x', undefined, {
      fetcher,
      sleep,
      jitter: noJitter,
    });

    expect(res.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    // Retry-After: 5 → 5 000 ms wait, overriding the default 1s schedule.
    expect(delays).toEqual([5_000]);
  });

  test('caps Retry-After at maxBackoffMs to keep latency bounded', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('rate limited', {
          status: 429,
          headers: { 'Retry-After': '600' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const { sleep, delays } = fakeSleep();

    await retryFetch('https://api.test/x', undefined, {
      fetcher,
      sleep,
      jitter: noJitter,
      maxBackoffMs: 30_000,
    });

    expect(delays).toEqual([30_000]);
  });

  test('retries 503 / 502 / 504', async () => {
    for (const status of [502, 503, 504]) {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(new Response('boom', { status }))
        .mockResolvedValueOnce(new Response('ok', { status: 200 }));
      const { sleep } = fakeSleep();

      const res = await retryFetch('https://api.test/x', undefined, {
        fetcher,
        sleep,
        jitter: noJitter,
      });

      expect(res.status).toBe(200);
      expect(fetcher).toHaveBeenCalledTimes(2);
    }
  });

  test('exhausts attempts on persistent 503 and returns the last response', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response('boom', { status: 503 }));
    const { sleep, delays } = fakeSleep();

    const res = await retryFetch('https://api.test/x', undefined, {
      fetcher,
      sleep,
      jitter: noJitter,
    });

    expect(res.status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([1_000, 4_000]);
  });

  test('retries network errors and rethrows after exhausting attempts', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    const { sleep, delays } = fakeSleep();

    await expect(
      retryFetch('https://api.test/x', undefined, {
        fetcher,
        sleep,
        jitter: noJitter,
      }),
    ).rejects.toThrow('fetch failed');

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([1_000, 4_000]);
  });

  test('uses the provided custom fetcher (e.g. SSRF-guarded fetch)', async () => {
    const safe = vi
      .fn()
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));

    const res = await retryFetch('https://api.test/x', undefined, {
      fetcher: safe,
      sleep: async () => {},
      jitter: noJitter,
    });

    expect(res.status).toBe(200);
    expect(safe).toHaveBeenCalledTimes(1);
  });

  test('total backoff for 3 attempts of 503 stays under 60s budget', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response('boom', { status: 503 }));
    const { sleep, delays } = fakeSleep();

    await retryFetch('https://api.test/x', undefined, {
      fetcher,
      sleep,
      jitter: (base) => base * 1.2,
    });

    const total = delays.reduce((a, b) => a + b, 0);
    expect(total).toBeLessThan(60_000);
  });

  test('exposes RetryFetchHttpError type for predicate use', () => {
    const r = new Response('x', { status: 429 });
    const err = new RetryFetchHttpError(r, 5_000);
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(5_000);
  });
});
