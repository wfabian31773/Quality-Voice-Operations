import { describe, it, expect, vi, afterEach } from 'vitest';
import { resilientFetch } from './resilientFetch';

function fakeResponse(init: { ok: boolean; status?: number; statusText?: string }): Response {
  return {
    ok: init.ok,
    status: init.status ?? (init.ok ? 200 : 500),
    statusText: init.statusText ?? '',
    clone: () => fakeResponse(init),
    text: async () => '',
  } as unknown as Response;
}

// Keep retries cheap and bounded for the failure paths.
const fastRetry = { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 2 };
let n = 0;
const circuit = () => `rf-test-${++n}`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resilientFetch', () => {
  it('returns the response on a successful fetch', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fakeResponse({ ok: true, status: 200 }));
    const res = await resilientFetch('https://api.test/x', { method: 'GET' }, { circuitName: circuit() });
    expect(res.status).toBe(200);
  });

  it('treats a 5xx as a retryable failure and ultimately throws', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(fakeResponse({ ok: false, status: 503, statusText: 'Service Unavailable' }));
    await expect(
      resilientFetch('https://api.test/x', { method: 'POST' }, { circuitName: circuit(), retryOptions: fastRetry }),
    ).rejects.toThrow('HTTP 503');
    expect(spy).toHaveBeenCalledTimes(2); // initial + one retry
  });

  it('does not retry a non-5xx non-ok response (e.g. 404)', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(fakeResponse({ ok: false, status: 404, statusText: 'Not Found' }));
    // 404 is not >= 500, so the operation returns the response without throwing.
    const res = await resilientFetch(
      'https://api.test/x',
      { method: 'GET' },
      { circuitName: circuit(), retryOptions: fastRetry },
    );
    expect(res.status).toBe(404);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('enforces a per-attempt timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockReturnValue(new Promise(() => {}) as Promise<Response>);
    await expect(
      resilientFetch(
        'https://api.test/slow',
        { method: 'GET' },
        { circuitName: circuit(), timeoutMs: 5, retryOptions: fastRetry, context: 'TestFetch' },
      ),
    ).rejects.toThrow('timed out');
  });
});
