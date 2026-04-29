import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { ZapierWebhookConnectorAdapter } from './zapier';
import type { ConnectorConfig, ConnectorPayload } from '../types';
import type { TenantId } from '../../../core/types';
import type { SafeFetchResponse } from '../ssrfGuard';

// BL-014 (Task #248) regression at the adapter layer:
// `safeFetch` returns a custom `SafeFetchResponse` shape (plain headers
// record, no `.clone()`); `retryFetch` expects the standard `Response`
// contract. The Zapier adapter bridges the two by reading the body once and
// constructing a real `Response`. If a future change drops that bridge,
// retry-on-429 (Retry-After parsing via `Headers.get`) and body draining
// (via `.clone().text()`) would silently break — these tests catch that.

const { safeFetchMock } = vi.hoisted(() => ({
  safeFetchMock: vi.fn(),
}));

vi.mock('../ssrfGuard', async () => {
  const actual = await vi.importActual<typeof import('../ssrfGuard')>(
    '../ssrfGuard',
  );
  return {
    ...actual,
    safeFetch: safeFetchMock,
  };
});

const TENANT: TenantId = 'tenant-test' as TenantId;
const CONFIG: ConnectorConfig = {
  integrationId: 'int-zapier-1',
  tenantId: TENANT,
  connectorType: 'webhook',
  provider: 'zapier',
  isEnabled: true,
  credentials: {
    webhook_url: 'https://hooks.zapier.com/hooks/catch/123/abc',
  },
};

const PAYLOAD: ConnectorPayload = {
  type: 'call.completed',
  callSid: 'CA-test-1234',
  durationSeconds: 42,
};

function safeRes(opts: {
  status: number;
  body?: string;
  headers?: Record<string, string>;
  statusText?: string;
}): SafeFetchResponse {
  const body = opts.body ?? '';
  return {
    ok: opts.status >= 200 && opts.status < 300,
    status: opts.status,
    statusText: opts.statusText ?? '',
    headers: opts.headers ?? {},
    text: async () => body,
    json: async () => (body ? (JSON.parse(body) as unknown) : {}),
  };
}

describe('ZapierWebhookConnectorAdapter retry behavior (BL-014 / Task #248)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-29T10:00:00Z'));
    safeFetchMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('retries once on 429 → 200 and returns success with the response id', async () => {
    safeFetchMock
      .mockResolvedValueOnce(
        safeRes({
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'retry-after': '2', 'content-type': 'text/plain' },
          body: 'rate limited',
        }),
      )
      .mockResolvedValueOnce(
        safeRes({
          status: 200,
          statusText: 'OK',
          headers: { 'content-type': 'application/json' },
          body: '{"id":"req-xyz"}',
        }),
      );

    const adapter = new ZapierWebhookConnectorAdapter();
    const promise = adapter.execute(TENANT, CONFIG, PAYLOAD);
    // Retry-After: 2 → ~2s sleep between attempts. Advance enough to fire
    // the sleep timer; the per-attempt 15s AbortController + 60s
    // per-dispatch deadline timers are cleared via finally blocks before
    // we ever advance that far.
    await vi.advanceTimersByTimeAsync(3_000);
    const result = await promise;

    expect(result.success).toBe(true);
    expect(result.externalId).toBe('req-xyz');
    expect(result.meta?.provider).toBe('zapier');
    expect(safeFetchMock).toHaveBeenCalledTimes(2);

    // Both attempts target the same configured webhook URL with a JSON body
    // wrapping the standardized event payload.
    const [firstUrl, firstInit] = safeFetchMock.mock.calls[0]!;
    expect(firstUrl).toBe('https://hooks.zapier.com/hooks/catch/123/abc');
    expect(firstInit?.method).toBe('POST');
    const sentBody = JSON.parse(firstInit?.body as string) as {
      event: string;
      tenantId: string;
      data: Record<string, unknown>;
    };
    expect(sentBody.event).toBe('call.completed');
    expect(sentBody.tenantId).toBe('tenant-test');
    expect(sentBody.data.callSid).toBe('CA-test-1234');

    const [secondUrl] = safeFetchMock.mock.calls[1]!;
    expect(secondUrl).toBe('https://hooks.zapier.com/hooks/catch/123/abc');
  });

  test('returns clean { success: false } after 5xx exhaustion (3 attempts)', async () => {
    safeFetchMock.mockResolvedValue(
      safeRes({
        status: 503,
        statusText: 'Service Unavailable',
        headers: {},
        body: 'upstream down',
      }),
    );

    const adapter = new ZapierWebhookConnectorAdapter();
    const promise = adapter.execute(TENANT, CONFIG, PAYLOAD);
    // Default schedule between three attempts: 1s + 4s of sleep (no
    // Retry-After header to override). Advance past both.
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await promise;

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/^Webhook error 503/);
    expect(result.externalId).toBeUndefined();
    expect(safeFetchMock).toHaveBeenCalledTimes(3);
  });
});
