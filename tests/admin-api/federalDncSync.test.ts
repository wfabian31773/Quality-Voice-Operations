/**
 * Coverage for the FTC National DNC Registry sync producer
 * (`platform/campaigns/FederalDncService.syncFederalDncRegistry`).
 *
 * The federal snapshot is several gigabytes of newline-delimited phone
 * numbers, so the sync MUST stream the response body and flush in bounded
 * batches — buffering the whole body would OOM in production. These tests
 * lock that contract down by:
 *
 *   1. Asserting `response.text()` is never called when the response exposes
 *      a streamable `body` (the production path must use the reader).
 *   2. Asserting numbers are flushed in batches of at most `insertBatchSize`
 *      regardless of total count.
 *   3. Asserting a 1M-row synthetic snapshot loads successfully without
 *      the sync ever materializing the whole body or batch in memory.
 *   4. Asserting the post-load prune deletes stale-version rows and
 *      `federal_dnc_sync_state` records the new version + count.
 *   5. Asserting an empty/garbage snapshot is refused (no wipe) and
 *      recorded as `failed`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { queryMock, privilegedClientMock } = vi.hoisted(() => {
  const queryMock = vi.fn(async () => ({ rows: [] as Record<string, unknown>[], rowCount: 0 }));
  const privilegedClientMock = vi.fn(async (fn: (client: { query: typeof queryMock }) => Promise<unknown>) =>
    fn({ query: queryMock }),
  );
  return { queryMock, privilegedClientMock };
});

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
  withPrivilegedClient: privilegedClientMock,
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { syncFederalDncRegistry } from '../../platform/campaigns/FederalDncService';

/**
 * Build a fetch-style Response whose body is a real Web ReadableStream that
 * yields the configured chunks one at a time. Records when `text()` is called
 * so a test can assert it never is in the streaming path.
 */
function buildStreamingResponse(chunks: string[], opts: { lastModified?: string } = {}): Response & { textCalls: number } {
  let textCalls = 0;
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i]));
      i += 1;
    },
  });
  const headers = new Headers();
  if (opts.lastModified) headers.set('last-modified', opts.lastModified);
  const response = new Response(stream, { status: 200, headers }) as Response & { textCalls: number };
  // Wrap text() so the test can detect any non-streaming fallback usage.
  const origText = response.text.bind(response);
  Object.defineProperty(response, 'text', {
    value: async () => {
      textCalls += 1;
      return origText();
    },
  });
  Object.defineProperty(response, 'textCalls', {
    get: () => textCalls,
  });
  return response;
}

beforeEach(() => {
  queryMock.mockReset();
  privilegedClientMock.mockClear();
  queryMock.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
  process.env.FEDERAL_DNC_SOURCE_URL = 'https://fixture.example/dnc';
});

describe('syncFederalDncRegistry streaming load', () => {
  it('streams the body via getReader() and never calls response.text() when body is streamable', async () => {
    const phones = ['5550000001', '5550000002', '5550000003'];
    const response = buildStreamingResponse([phones.join('\n') + '\n']);

    const result = await syncFederalDncRegistry({
      sourceUrl: 'https://fixture.example/dnc',
      versionOverride: 'v-test-1',
      fetchImpl: async () => response,
      insertBatchSize: 1000,
    });

    expect(result.status).toBe('completed');
    expect(result.recordCount).toBe(3);
    expect(response.textCalls).toBe(0);

    const insertCalls = queryMock.mock.calls.filter((c) => /INSERT INTO federal_dnc_numbers/.test(String(c[0])));
    expect(insertCalls).toHaveLength(1);
    const params = insertCalls[0][1] as unknown[];
    expect(params).toEqual([
      '+15550000001', 'v-test-1',
      '+15550000002', 'v-test-1',
      '+15550000003', 'v-test-1',
    ]);
  });

  it('flushes in batches of at most insertBatchSize regardless of total count', async () => {
    const total = 12_345;
    const batchSize = 1_000;
    // Emit the snapshot in many small chunks (intentionally splitting lines
    // mid-number) so we exercise the partial-line buffer.
    const allLines = Array.from({ length: total }, (_, i) =>
      String(2_000_000_000 + i).padStart(10, '0'),
    ).join('\n') + '\n';
    const chunks: string[] = [];
    for (let j = 0; j < allLines.length; j += 333) {
      chunks.push(allLines.slice(j, j + 333));
    }
    const response = buildStreamingResponse(chunks);

    const result = await syncFederalDncRegistry({
      sourceUrl: 'https://fixture.example/dnc',
      versionOverride: 'v-test-batch',
      fetchImpl: async () => response,
      insertBatchSize: batchSize,
    });

    expect(result.status).toBe('completed');
    expect(result.recordCount).toBe(total);
    expect(response.textCalls).toBe(0);

    const insertCalls = queryMock.mock.calls.filter((c) => /INSERT INTO federal_dnc_numbers/.test(String(c[0])));
    // 12_345 / 1_000 -> 13 batches (12 full + 1 partial of 345).
    expect(insertCalls).toHaveLength(13);
    for (const call of insertCalls) {
      const params = call[1] as unknown[];
      const rowCount = params.length / 2;
      expect(rowCount).toBeLessThanOrEqual(batchSize);
      expect(rowCount).toBeGreaterThan(0);
    }
    const lastBatchSize = (insertCalls[insertCalls.length - 1][1] as unknown[]).length / 2;
    expect(lastBatchSize).toBe(345);
  });

  it('handles a 1M-row synthetic snapshot end-to-end without buffering the whole body', async () => {
    const total = 1_000_000;
    const batchSize = 5_000;
    // Stream the snapshot one row at a time so the test producer itself
    // never materializes more than one row in memory either — proving the
    // sync's bounded-memory property end-to-end.
    let produced = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= total) {
          controller.close();
          return;
        }
        // Push 1k rows per pull so we don't pay 1M JS-task overhead.
        const enc = new TextEncoder();
        const lines: string[] = [];
        const upTo = Math.min(produced + 1_000, total);
        for (let n = produced; n < upTo; n++) {
          lines.push(String(3_000_000_000 + n).padStart(10, '0'));
        }
        controller.enqueue(enc.encode(lines.join('\n') + '\n'));
        produced = upTo;
      },
    });
    const response = new Response(stream, { status: 200 });
    const textSpy = vi.spyOn(response, 'text');

    const result = await syncFederalDncRegistry({
      sourceUrl: 'https://fixture.example/dnc',
      versionOverride: 'v-1M',
      fetchImpl: async () => response,
      insertBatchSize: batchSize,
    });

    expect(result.status).toBe('completed');
    expect(result.recordCount).toBe(total);
    expect(textSpy).not.toHaveBeenCalled();

    const insertCalls = queryMock.mock.calls.filter((c) => /INSERT INTO federal_dnc_numbers/.test(String(c[0])));
    expect(insertCalls).toHaveLength(total / batchSize);
    for (const call of insertCalls) {
      const params = call[1] as unknown[];
      expect(params.length / 2).toBe(batchSize);
    }
  }, 60_000);

  it('prunes stale-version rows and records sync state with the new version', async () => {
    const response = buildStreamingResponse(['5550000099\n'], { lastModified: 'Mon, 27 Apr 2026 00:00:00 GMT' });

    const result = await syncFederalDncRegistry({
      sourceUrl: 'https://fixture.example/dnc',
      fetchImpl: async () => response,
      insertBatchSize: 100,
    });

    expect(result.status).toBe('completed');
    expect(result.registryVersion).toBe('lm:Mon, 27 Apr 2026 00:00:00 GMT');

    const deleteCalls = queryMock.mock.calls.filter((c) => /DELETE FROM federal_dnc_numbers/.test(String(c[0])));
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0][1]).toEqual(['lm:Mon, 27 Apr 2026 00:00:00 GMT']);

    const stateUpdates = queryMock.mock.calls.filter((c) => /UPDATE federal_dnc_sync_state/.test(String(c[0])));
    const completed = stateUpdates.find((c) => Array.isArray(c[1]) && (c[1] as unknown[])[0] === 'completed');
    expect(completed).toBeDefined();
    expect(completed?.[1]).toEqual(['completed', null, 'lm:Mon, 27 Apr 2026 00:00:00 GMT', 1]);
  });

  it('refuses to wipe the table when the snapshot is empty / unparseable', async () => {
    const response = buildStreamingResponse(['\n\n  \nnot-a-number\n']);

    const result = await syncFederalDncRegistry({
      sourceUrl: 'https://fixture.example/dnc',
      versionOverride: 'v-empty',
      fetchImpl: async () => response,
      insertBatchSize: 100,
    });

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/zero parseable numbers/i);

    const deleteCalls = queryMock.mock.calls.filter((c) => /DELETE FROM federal_dnc_numbers/.test(String(c[0])));
    expect(deleteCalls).toHaveLength(0);

    const stateUpdates = queryMock.mock.calls.filter((c) => /UPDATE federal_dnc_sync_state/.test(String(c[0])));
    const failed = stateUpdates.find((c) => Array.isArray(c[1]) && (c[1] as unknown[])[0] === 'failed');
    expect(failed).toBeDefined();
  });
});
