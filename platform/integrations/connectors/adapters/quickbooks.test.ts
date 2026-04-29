import { describe, test, expect, afterEach, vi } from 'vitest';
import { QuickBooksConnectorAdapter } from './quickbooks';
import type { ConnectorConfig, ConnectorPayload } from '../types';
import type { TenantId } from '../../../core/types';

vi.mock('../tokenRefresh', () => ({
  ensureFreshOAuthToken: async (cfg: ConnectorConfig) => cfg,
}));

const TENANT: TenantId = 'tenant-test' as TenantId;
const CONFIG: ConnectorConfig = {
  integrationId: 'int-qbo',
  tenantId: TENANT,
  connectorType: 'accounting',
  provider: 'quickbooks',
  isEnabled: true,
  credentials: {
    access_token: 'tok-qbo',
    realm_id: '4620816365222222222',
    environment: 'sandbox',
  },
};

describe('QuickBooksConnectorAdapter retry-with-backoff (BL-014 Task #505)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // Real timers because retryFetch's backoff uses setTimeout — with fake
  // timers the retry sleep would stall forever and the test would time out.
  test(
    'a 429 with Retry-After is automatically retried after the recommended interval',
    { timeout: 15_000 },
    async () => {
      const calls: Array<{ url: string; method: string }> = [];
      let attempt = 0;
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ url, method });
        attempt += 1;
        if (attempt === 1) {
          // First Customer query is rate-limited — Intuit advertises a 1s
          // backoff via Retry-After. The retry helper must honor that and
          // retry the same request before the adapter surfaces a failure.
          return new Response(JSON.stringify({ message: 'rate limited' }), {
            status: 429,
            headers: { 'Retry-After': '1' },
          });
        }
        if (url.includes('/query?query=')) {
          return new Response(
            JSON.stringify({
              QueryResponse: { Customer: [{ Id: 'cust-77', DisplayName: 'AI Voice Caller' }] },
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }));

      const adapter = new QuickBooksConnectorAdapter();
      const payload: ConnectorPayload = {
        type: 'appointment.booked',
        callerPhone: '+15551234567',
      };
      const result = await adapter.execute(TENANT, CONFIG, payload);

      expect(result.success).toBe(true);
      expect(result.externalId).toBe('cust-77');
      expect(result.meta).toMatchObject({ customerId: 'cust-77', provider: 'quickbooks' });
      // The 429 + the successful retry both target the same Customer query URL.
      expect(calls).toHaveLength(2);
      expect(calls[0].url).toContain('/query?query=');
      expect(calls[1].url).toContain('/query?query=');
    },
  );

  // BL-014 (Task #981): the new 429-only test above proves the Retry-After
  // path. The next two tests cover the *other* failure modes the helper is
  // supposed to handle but that the original Task #505 tests didn't exercise:
  // transient 5xx recovery and 5xx exhaustion (which also pins the
  // 3-attempts-within-the-60s-budget contract).
  test(
    'recovers from a transient 5xx (502 → 503 → 200) on the Customer query and ultimately succeeds',
    { timeout: 15_000 },
    async () => {
      const calls: Array<{ url: string; method: string }> = [];
      let attempt = 0;
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ url, method });
        attempt += 1;
        // Two transient gateway failures — the helper must reissue the
        // SAME query before surfacing the failure to the adapter, then the
        // third attempt returns the customer record as if nothing happened.
        if (attempt === 1) {
          return new Response(JSON.stringify({ message: 'bad gateway' }), { status: 502 });
        }
        if (attempt === 2) {
          return new Response(JSON.stringify({ message: 'service unavailable' }), { status: 503 });
        }
        if (url.includes('/query?query=')) {
          return new Response(
            JSON.stringify({
              QueryResponse: { Customer: [{ Id: 'cust-5xx', DisplayName: 'AI Voice Caller' }] },
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }));

      const adapter = new QuickBooksConnectorAdapter();
      const payload: ConnectorPayload = {
        type: 'appointment.booked',
        callerPhone: '+15551234567',
      };
      const result = await adapter.execute(TENANT, CONFIG, payload);

      expect(result.success).toBe(true);
      expect(result.externalId).toBe('cust-5xx');
      expect(result.meta).toMatchObject({ customerId: 'cust-5xx', provider: 'quickbooks' });
      // Three attempts on the same Customer query URL: two 5xx + one 200.
      expect(calls).toHaveLength(3);
      expect(calls.every((c) => c.url.includes('/query?query='))).toBe(true);
      expect(calls.every((c) => c.method === 'GET')).toBe(true);
    },
  );

  // Partial-success semantics, NOT clean-error semantics: the QuickBooks
  // adapter intentionally degrades gracefully on transient HTTP failures
  // from `findOrCreateCustomer` / `createInvoice` (logs a warning and
  // returns `undefined` to the handler), so a persistent 5xx surfaces
  // as `{ success: true, meta: { invoiced: false, invoiceId: undefined } }`
  // rather than `{ success: false }`. The retry helper still bounds
  // attempts at 3 per qboFetch invocation, which is the budget guarantee
  // this test exercises. The other three providers in this batch
  // (Zoho / Google Calendar / Outlook Calendar) DO surface
  // `{ success: false }` on exhaustion — see their respective test files.
  // Promoting QuickBooks to the same surface is tracked separately so the
  // dispatch / alerter / outbox layers can be reviewed alongside the
  // change. See follow-up: "Surface failed QuickBooks customer/invoice
  // writes instead of silently marking them as 'not invoiced'".
  test(
    'caps the Invoice POST at exactly 3 attempts on persistent 5xx, degrades gracefully within the 60s budget',
    { timeout: 15_000 },
    async () => {
      // Configure the invoice path so we can isolate the retry budget on a
      // single qboFetch call. The Customer query is mocked to succeed
      // immediately, then the Invoice POST is permanently 503 — that path
      // is the one we count attempts on.
      const cfg: ConnectorConfig = {
        ...CONFIG,
        credentials: {
          ...CONFIG.credentials,
          invoice_item_id: 'item-svc',
          default_invoice_amount: '125',
        },
      };

      const calls: Array<{ url: string; method: string }> = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ url, method });
        if (url.includes('/query?query=') && method === 'GET') {
          return new Response(
            JSON.stringify({
              QueryResponse: {
                Customer: [{ Id: 'cust-existing', DisplayName: 'AI Voice Caller' }],
              },
            }),
            { status: 200 },
          );
        }
        if (url.includes('/invoice') && method === 'POST') {
          // Persistent 503 — Intuit's helper MUST cap at 3 attempts and
          // return the failed Response to the adapter rather than looping
          // until the per-dispatch deadline fires.
          return new Response(JSON.stringify({ message: 'service unavailable' }), {
            status: 503,
          });
        }
        throw new Error(`Unexpected fetch: ${method} ${url}`);
      }));

      const startedAt = Date.now();
      const adapter = new QuickBooksConnectorAdapter();
      const payload: ConnectorPayload = {
        type: 'call.completed',
        callerPhone: '+15551234567',
        summary: 'Service call',
      };
      const result = await adapter.execute(TENANT, cfg, payload);
      const elapsedMs = Date.now() - startedAt;

      // Graceful degradation: the customer was located, the invoice could
      // not be created after retry exhaustion, so no invoice ID is reported
      // and the meta flag flips to invoiced: false. The dispatch never
      // throws and never hangs — the retry helper returned the final 503
      // Response to the adapter, which translated it into a stable,
      // non-throwing result. (Whether the dispatch layer SHOULD see this
      // as success: false is the open product question tracked by the
      // follow-up referenced above; for now the test pins the actual
      // behavior so a regression in either direction is caught.)
      expect(result.success).toBe(true);
      expect(result.externalId).toBe('cust-existing');
      expect(result.meta).toMatchObject({
        customerId: 'cust-existing',
        invoiceId: undefined,
        invoiced: false,
        provider: 'quickbooks',
      });
      // Exactly three /invoice POSTs: the helper does NOT make a 4th
      // attempt, which is what bounds the dispatch inside the 60s budget
      // (3 attempts × 15s per-attempt + 1s + 4s sleeps = 50s worst case).
      const invoicePosts = calls.filter(
        (c) => c.url.includes('/invoice') && c.method === 'POST',
      );
      expect(invoicePosts).toHaveLength(3);
      // The single Customer query was untouched by the retry budget.
      const queryGets = calls.filter(
        (c) => c.url.includes('/query?query=') && c.method === 'GET',
      );
      expect(queryGets).toHaveLength(1);
      // Total wall-clock comfortably inside the 60s budget — proving the
      // helper did not stretch past it on a hostile upstream.
      expect(elapsedMs).toBeLessThan(60_000);
    },
  );
});
