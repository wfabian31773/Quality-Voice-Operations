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

  test('does not retry on non-transient thrown errors (e.g. SsrfBlockedError)', async () => {
    class SsrfBlockedError extends Error {
      constructor() {
        super('blocked');
        this.name = 'SsrfBlockedError';
      }
    }
    const fetcher = vi.fn().mockRejectedValue(new SsrfBlockedError());
    const { sleep, delays } = fakeSleep();

    await expect(
      retryFetch('https://api.test/x', undefined, {
        fetcher,
        sleep,
        jitter: noJitter,
      }),
    ).rejects.toThrow('blocked');

    // No retries, no sleeps — domain errors are surfaced immediately.
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(delays).toEqual([]);
  });

  test('retries AbortError (per-attempt request timeout)', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(abort)
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const { sleep } = fakeSleep();

    const res = await retryFetch('https://api.test/x', undefined, {
      fetcher,
      sleep,
      jitter: noJitter,
    });

    expect(res.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('honours an explicit shouldRetry override for synthetic errors', async () => {
    class FakeTransient extends Error {
      constructor() { super('transient'); this.name = 'FakeTransient'; }
    }
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new FakeTransient())
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const { sleep } = fakeSleep();

    const res = await retryFetch('https://api.test/x', undefined, {
      fetcher,
      sleep,
      jitter: noJitter,
      shouldRetry: (err) => err instanceof FakeTransient,
    });

    expect(res.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('caps Retry-After at the remaining per-dispatch deadline (maxTotalMs)', async () => {
    // First 429 says Retry-After: 50. With a 5s budget we must NOT sleep
    // 50s — the wait must be clipped to the remaining budget.
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('rate limited', {
          status: 429,
          headers: { 'Retry-After': '50' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const { sleep, delays } = fakeSleep();

    await retryFetch('https://api.test/x', undefined, {
      fetcher,
      sleep,
      jitter: noJitter,
      maxTotalMs: 5_000,
      maxBackoffMs: 60_000, // intentionally larger than maxTotalMs
    });

    // Whatever we slept, it cannot exceed the 5s deadline.
    expect(delays.length).toBe(1);
    expect(delays[0]).toBeLessThanOrEqual(5_000);
  });

  test('a single hanging request is bounded by maxTotalMs (Promise.race against deadline)', async () => {
    // Fetcher that NEVER resolves. Without the deadline race, retryFetch
    // would hang forever (the per-attempt timeout lives inside the
    // adapter's own fetcher and is bypassed by a stub fetcher like this).
    // The internal deadline race must rescue us in <=maxTotalMs.
    const fetcher = vi.fn(() => new Promise<Response>(() => { /* never */ }));
    const startedAt = Date.now();
    await expect(
      retryFetch('https://api.test/x', undefined, {
        fetcher,
        sleep: async () => {},
        jitter: noJitter,
        maxTotalMs: 50, // very tight budget for a fast unit test
      }),
    ).rejects.toMatchObject({ name: 'RetryFetchDeadlineExceeded' });
    const elapsed = Date.now() - startedAt;
    // Generous upper bound to absorb CI scheduling jitter; the point is
    // we returned in <<one attempt timeout>> instead of hanging forever.
    expect(elapsed).toBeLessThan(2_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  test('budget exhausted by transient thrown errors does not invoke fetcher again', async () => {
    // First attempt throws a transient TypeError (network error). After
    // the retry sleep "burns" the entire remaining budget, attempt 2
    // must NOT call the fetcher — the attempt-boundary guard fires
    // synchronously and the call surfaces the original transient error.
    let virtualNow = 0;
    const startWall = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => startWall + virtualNow);

    try {
      const fetcher = vi.fn(async () => {
        virtualNow += 10;
        throw new TypeError('fetch failed');
      });
      const sleep = vi.fn(async (ms: number) => {
        virtualNow += ms;
      });

      // Once the budget is exhausted with no prior HTTP response, the
      // attempt-boundary guard short-circuits with a dedicated
      // RetryFetchDeadlineExceeded error so callers can distinguish a
      // budget overrun from a true network failure.
      await expect(
        retryFetch('https://api.test/x', undefined, {
          fetcher,
          sleep,
          jitter: noJitter,
          // Tight budget: attempt1 (10ms) + sleep ≥ 100ms eats all of it.
          maxTotalMs: 100,
          baseDelaysMs: [200], // first retry sleep > remaining budget
        }),
      ).rejects.toMatchObject({ name: 'RetryFetchDeadlineExceeded' });

      // Exactly one fetch invocation: the attempt-boundary guard caught
      // attempt 2 before it could call out again.
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      (Date.now as unknown as { mockRestore?: () => void }).mockRestore?.();
    }
  });

  test('hanging final attempt after prior 429 surfaces the prior response on deadline', async () => {
    // First attempt: 429 (no Retry-After → use default schedule).
    // Second attempt: hangs. Deadline trips → caller must receive the 429
    // response, not a deadline error.
    let call = 0;
    const fetcher = vi.fn(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(new Response('rate limited', { status: 429 }));
      }
      return new Promise<Response>(() => { /* never */ });
    });

    const res = await retryFetch('https://api.test/x', undefined, {
      fetcher,
      sleep: async () => {}, // burn no time on retry-sleep
      jitter: noJitter,
      maxTotalMs: 50,
    });
    expect(res.status).toBe(429);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  test('worst-case wall-clock stays under maxTotalMs even with repeated 429 + huge Retry-After', async () => {
    // Simulates a hostile upstream: every response is a 429 with
    // Retry-After: 50s. We *must* bound total elapsed at maxTotalMs (5s
    // here) regardless of how many attempts fit, by clipping every sleep
    // to remainingMs() AND short-circuiting any attempt whose start time
    // is past the deadline.
    let virtualNow = 0;
    const startWall = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => startWall + virtualNow);

    try {
      const fetcher = vi.fn(async () => {
        // Each fetch "takes" 100ms of wall time.
        virtualNow += 100;
        return new Response('rate limited', {
          status: 429,
          headers: { 'Retry-After': '50' },
        });
      });
      const sleep = vi.fn(async (ms: number) => {
        virtualNow += ms;
      });

      const res = await retryFetch('https://api.test/x', undefined, {
        fetcher,
        sleep,
        jitter: noJitter,
        maxTotalMs: 5_000,
        maxBackoffMs: 60_000,
      });

      // Even though Retry-After asked for 50s × 2, total wall time must
      // stay inside the 5s budget (give or take the cheap final fetch).
      expect(res.status).toBe(429);
      expect(virtualNow).toBeLessThanOrEqual(5_500);
      // We started at most 3 attempts, but the last one (if it ran) was
      // a no-op short-circuit because remainingMs() was already 0.
      // Total fetcher invocations therefore matches what fit in budget.
      expect(fetcher.mock.calls.length).toBeLessThanOrEqual(3);
    } finally {
      (Date.now as unknown as { mockRestore?: () => void }).mockRestore?.();
    }
  });

  test('refuses to retry once the per-dispatch deadline is exhausted', async () => {
    // A real (non-injected) sleep would burn the budget; here we use a
    // sleep stub that itself advances "wall time" so we can deterministically
    // exhaust maxTotalMs after a single retry.
    let virtualNow = 0;
    const realDateNow = Date.now;
    const startWall = realDateNow();
    vi.spyOn(Date, 'now').mockImplementation(() => startWall + virtualNow);

    try {
      const fetcher = vi
        .fn()
        .mockResolvedValue(new Response('boom', { status: 503 }));
      const sleep = vi.fn(async (ms: number) => {
        virtualNow += ms;
      });

      const res = await retryFetch('https://api.test/x', undefined, {
        fetcher,
        sleep,
        jitter: noJitter,
        maxTotalMs: 1_500, // only enough for one sleep at the 1s base delay
      });

      // Hit the cap quickly: attempt 1 fails, sleep 1s (within 1.5s), attempt 2
      // fails, sleep would be 4s but remaining is 500ms → effective 500ms,
      // total now 1.5s → shouldRetry on attempt 3 sees remaining=0 → stop.
      expect(res.status).toBe(503);
      expect(fetcher.mock.calls.length).toBeLessThanOrEqual(3);
      // Second sleep, if any, must have been clipped to remaining budget.
      const totalSlept = sleep.mock.calls.reduce<number>(
        (a, [ms]) => a + (ms as number),
        0,
      );
      expect(totalSlept).toBeLessThanOrEqual(1_500);
    } finally {
      (Date.now as unknown as { mockRestore?: () => void }).mockRestore?.();
    }
  });
});
