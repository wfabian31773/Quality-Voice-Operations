// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, setToken } from './api';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  setToken('test-session');
});

afterEach(() => {
  setToken(null);
  vi.unstubAllGlobals();
});

describe('API request headers', () => {
  it('passes POST headers to fetch alongside authorization, JSON content type and the abort signal', async () => {
    const signal = new AbortController().signal;
    await api.post('/test-reply', { body: 'Test reply' }, {
      signal,
      headers: { 'Idempotency-Key': 'test-reply-key' },
    });

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/test-reply', {
      method: 'POST',
      body: JSON.stringify({ body: 'Test reply' }),
      signal,
      headers: {
        'Idempotency-Key': 'test-reply-key',
        Authorization: 'Bearer test-session',
        'Content-Type': 'application/json',
      },
      credentials: 'include',
    });
  });

  it('keeps existing POST callers working without request options', async () => {
    await expect(api.post('/test-reply', { body: 'Test reply' })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledWith('/api/test-reply', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ body: 'Test reply' }),
      headers: { Authorization: 'Bearer test-session', 'Content-Type': 'application/json' },
    }));
  });
});
