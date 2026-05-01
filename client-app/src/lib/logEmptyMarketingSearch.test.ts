// @vitest-environment happy-dom
/**
 * Unit tests for the marketing-page zero-hit search logger. The logger
 * is the only client-side consumer of the `/marketing/search/empty`
 * endpoint, so this is the regression net for:
 *   - latest-query-wins debounce (a typing sequence under one (source,
 *     locale) collapses to a single log of the *final* phrase)
 *   - dedup (the same final normalized phrase in the same locale isn't
 *     logged more than once per minute)
 *   - minimum length / locale validation
 *   - normalization (trim + collapse whitespace + lowercase)
 *   - silence on fetch failure
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetEmptyMarketingSearchState,
  logEmptyMarketingSearch,
} from './logEmptyMarketingSearch';

const fetchMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  __resetEmptyMarketingSearchState();
});

afterEach(() => {
  vi.useRealTimers();
});

function bodyAt(index: number): Record<string, unknown> {
  const calls = fetchMock.mock.calls;
  const idx = index < 0 ? calls.length + index : index;
  const call = calls[idx];
  if (!call) throw new Error(`expected fetch call at index ${index}`);
  const init = call[1] as RequestInit;
  return JSON.parse(init.body as string);
}

describe('logEmptyMarketingSearch', () => {
  it('collapses a typing sequence into a single log of the final phrase (latest-query-wins)', async () => {
    // Simulates the user typing "preci" → "precio" → "precios" inside one
    // search session. We must NOT spam the analytics table with each
    // intermediate prefix — only the stabilized final phrase should be
    // recorded.
    logEmptyMarketingSearch({ query: 'preci', locale: 'es', source: 'help_widget' });
    logEmptyMarketingSearch({ query: 'precio', locale: 'es', source: 'help_widget' });
    logEmptyMarketingSearch({ query: 'precios', locale: 'es', source: 'help_widget' });

    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(800);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(bodyAt(0).query).toBe('precios');
  });

  it('skips queries shorter than 2 characters', async () => {
    logEmptyMarketingSearch({ query: 'p', locale: 'es', source: 'help_widget' });
    logEmptyMarketingSearch({ query: ' ', locale: 'es', source: 'help_widget' });
    logEmptyMarketingSearch({ query: '', locale: 'es', source: 'help_widget' });

    await vi.advanceTimersByTimeAsync(2_000);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not log when locale is empty', async () => {
    logEmptyMarketingSearch({ query: 'precios', locale: '', source: 'help_widget' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('dedupes the same final phrase in the same locale within the cooldown window', async () => {
    logEmptyMarketingSearch({ query: 'precios', locale: 'es', source: 'help_widget' });
    await vi.advanceTimersByTimeAsync(800);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Same normalized query (case + whitespace folded) — should be dropped
    // because the dedup cooldown is keyed on (source|locale|normalized).
    logEmptyMarketingSearch({ query: '  PRECIOS  ', locale: 'es', source: 'help_widget' });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats different locales as independent debounce streams', async () => {
    logEmptyMarketingSearch({ query: 'precios', locale: 'es', source: 'help_widget' });
    logEmptyMarketingSearch({ query: 'precios', locale: 'pt-BR', source: 'help_widget' });

    await vi.advanceTimersByTimeAsync(800);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const locales = fetchMock.mock.calls.map(
      (c) => JSON.parse((c[1] as RequestInit).body as string).locale,
    );
    expect(locales.sort()).toEqual(['es', 'pt-BR']);
  });

  it('treats different sources as independent debounce streams', async () => {
    logEmptyMarketingSearch({ query: 'precios', locale: 'es', source: 'help_widget' });
    logEmptyMarketingSearch({ query: 'precios', locale: 'es', source: 'resources' });

    await vi.advanceTimersByTimeAsync(800);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('logs again after the cooldown elapses for the same final phrase', async () => {
    logEmptyMarketingSearch({ query: 'precios', locale: 'es', source: 'help_widget' });
    await vi.advanceTimersByTimeAsync(800);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Advance past the 60-second dedup window — the same phrase is now
    // eligible to be logged again (the user came back later and re-tried
    // a still-broken search).
    await vi.advanceTimersByTimeAsync(60_001);

    logEmptyMarketingSearch({ query: 'precios', locale: 'es', source: 'help_widget' });
    await vi.advanceTimersByTimeAsync(800);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('posts to /api/marketing/search/empty with JSON body and credentials omitted', async () => {
    logEmptyMarketingSearch({
      query: '  Precios  Mensuales ',
      locale: 'es',
      source: 'help_widget',
      pagePath: '/pricing',
    });
    await vi.advanceTimersByTimeAsync(800);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0];
    if (!firstCall) throw new Error('expected one fetch call');
    const [url, init] = firstCall;
    expect(url).toBe('/api/marketing/search/empty');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).credentials).toBe('omit');
    const body = bodyAt(-1);
    expect(body).toMatchObject({
      // The raw query is preserved (trimmed only) so admins can see what
      // the user actually typed.
      query: 'Precios  Mensuales',
      locale: 'es',
      source: 'help_widget',
      page_path: '/pricing',
    });
  });

  it('does not throw when fetch rejects', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    logEmptyMarketingSearch({ query: 'precios', locale: 'es', source: 'help_widget' });
    // Should not throw or unhandle a rejection.
    await vi.advanceTimersByTimeAsync(800);
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
