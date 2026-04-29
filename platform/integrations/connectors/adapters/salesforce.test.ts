import { describe, test, expect, afterEach, vi } from 'vitest';
import { SalesforceConnectorAdapter } from './salesforce';
import type { ConnectorConfig, ConnectorPayload } from '../types';
import type { TenantId } from '../../../core/types';

vi.mock('../tokenRefresh', () => ({
  ensureFreshOAuthToken: async (cfg: ConnectorConfig) => cfg,
}));

const TENANT: TenantId = 'tenant-test' as TenantId;
const CONFIG: ConnectorConfig = {
  integrationId: 'int-1',
  tenantId: TENANT,
  connectorType: 'crm',
  provider: 'salesforce',
  isEnabled: true,
  credentials: {
    access_token: 'tok-xyz',
    instance_url: 'https://my-org.salesforce.com',
  },
};

describe('SalesforceConnectorAdapter retry-with-backoff (BL-014 Task #1111)', () => {
  // Real timers because retryFetch's backoff uses setTimeout — with fake
  // timers the retry sleep would stall forever and the test would time out.
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // BL-014 (Task #1111): the older Salesforce adapter routes every call
  // through the shared `salesforceFetchWithTimeout` -> `retryFetch` helper,
  // but until now there were no tests covering it (no salesforce.test.ts file
  // existed at all). Without these two tests a regression that swapped
  // `retryFetch` for a plain `fetch` (e.g. during a refactor) would silently
  // pass CI even though the dispatch would no longer recover from a transient
  // upstream wobble or stay inside the 60s budget on a hostile one. The
  // pattern mirrors the QuickBooks / Zoho / Google Calendar / Outlook
  // Calendar tests added in Task #981.
  test(
    'recovers from a transient 5xx (502 → 503 → 200) on the Task POST and ultimately succeeds',
    { timeout: 15_000 },
    async () => {
      const calls: Array<{ url: string; method: string }> = [];
      let attempt = 0;
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ url, method });
        attempt += 1;
        // Two transient gateway failures must be retried by the helper
        // BEFORE the adapter even sees them; the third attempt returns the
        // created Task as if nothing happened.
        if (attempt === 1) {
          return new Response(JSON.stringify([{ message: 'bad gateway' }]), { status: 502 });
        }
        if (attempt === 2) {
          return new Response(JSON.stringify([{ message: 'service unavailable' }]), { status: 503 });
        }
        return new Response(JSON.stringify({ id: 'task-5xx' }), { status: 200 });
      }));

      const adapter = new SalesforceConnectorAdapter();
      // No callerPhone (skips findOrCreateLeadOrContact), explicit
      // opportunityId (resolveWhatId returns it directly without lookup),
      // no summary (skips attachSummaryNote). That keeps the dispatch to a
      // single endpoint — POST /sobjects/Task — so we can count attempts
      // cleanly.
      const payload: ConnectorPayload = {
        type: 'call.completed',
        opportunityId: '006xx0000004C92AAE',
        durationSeconds: 30,
      };
      const result = await adapter.execute(TENANT, CONFIG, payload);

      expect(result.success).toBe(true);
      expect(result.externalId).toBe('task-5xx');
      expect(result.meta).toMatchObject({
        taskId: 'task-5xx',
        whatId: '006xx0000004C92AAE',
        provider: 'salesforce',
      });
      // Two 5xx + one successful retry, all targeting the same Task
      // sobjects endpoint.
      expect(calls).toHaveLength(3);
      expect(calls.every((c) => c.url.endsWith('/sobjects/Task'))).toBe(true);
      expect(calls.every((c) => c.method === 'POST')).toBe(true);
    },
  );

  test(
    'exhausts at exactly 3 attempts on persistent 5xx, surfaces a clean error within the 60s budget',
    { timeout: 15_000 },
    async () => {
      const calls: Array<{ url: string; method: string }> = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ url, method });
        // Persistent 503 — Salesforce's helper MUST cap at 3 attempts and
        // let the adapter convert the final failed Response into a clean
        // {success:false, error:'Salesforce Task create failed 503: ...'}
        // result rather than looping or hanging until the per-dispatch
        // deadline fires. The body deliberately omits any `errorCode` so
        // it isn't misclassified as a stale-record signal.
        return new Response(JSON.stringify([{ message: 'service unavailable' }]), {
          status: 503,
        });
      }));

      const startedAt = Date.now();
      const adapter = new SalesforceConnectorAdapter();
      const payload: ConnectorPayload = {
        type: 'call.completed',
        opportunityId: '006xx0000004C92AAE',
        durationSeconds: 30,
      };
      const result = await adapter.execute(TENANT, CONFIG, payload);
      const elapsedMs = Date.now() - startedAt;

      expect(result.success).toBe(false);
      // The adapter wraps the helper's final response in its own status
      // string so callers get a stable, parseable failure instead of a raw
      // exception or a never-resolving promise.
      expect(result.error).toMatch(/Salesforce Task create failed 503/);
      expect(result.externalId).toBeUndefined();
      // Exactly three POSTs to the Task endpoint: the helper does NOT make
      // a 4th attempt, which is what bounds the dispatch inside the 60s
      // budget (3 attempts × 15s per-attempt + 1s + 4s sleeps = 50s
      // worst case).
      expect(calls).toHaveLength(3);
      expect(calls.every((c) => c.url.endsWith('/sobjects/Task'))).toBe(true);
      expect(calls.every((c) => c.method === 'POST')).toBe(true);
      // Total wall-clock comfortably inside the 60s budget — proving the
      // helper did not stretch past it on a hostile upstream.
      expect(elapsedMs).toBeLessThan(60_000);
    },
  );

  // BL-014 (Task #1111): the same retry contract MUST also cover transport-
  // layer failures (per-attempt timeouts surfaced as `AbortError`, undici's
  // `TypeError('fetch failed')` for ECONN/ETIMEDOUT/ENOTFOUND, etc.) since
  // the 60s budget guarantee is meaningless if the helper would only retry
  // on HTTP statuses. Pair the 5xx tests above with timeout-recovery and
  // timeout-exhaustion variants so a regression that narrowed the
  // `shouldRetry` predicate would be caught here.
  test(
    'recovers from a transient transport timeout (TypeError → TypeError → 200) on the Task POST',
    { timeout: 15_000 },
    async () => {
      const calls: Array<{ url: string; method: string }> = [];
      let attempt = 0;
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ url, method });
        attempt += 1;
        if (attempt <= 2) {
          throw new TypeError('fetch failed');
        }
        return new Response(JSON.stringify({ id: 'task-timeout' }), { status: 200 });
      }));

      const adapter = new SalesforceConnectorAdapter();
      const payload: ConnectorPayload = {
        type: 'call.completed',
        opportunityId: '006xx0000004C92AAE',
        durationSeconds: 30,
      };
      const result = await adapter.execute(TENANT, CONFIG, payload);

      expect(result.success).toBe(true);
      expect(result.externalId).toBe('task-timeout');
      expect(calls).toHaveLength(3);
      expect(calls.every((c) => c.url.endsWith('/sobjects/Task'))).toBe(true);
    },
  );

  test(
    'exhausts at exactly 3 attempts on persistent transport timeouts, surfaces a clean error within the 60s budget',
    { timeout: 15_000 },
    async () => {
      const calls: Array<{ url: string; method: string }> = [];
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ url, method });
        // Persistent transport failure — the helper MUST cap at 3 attempts
        // and let the adapter's outer try/catch turn the final thrown
        // error into a {success:false, error:'fetch failed'} result rather
        // than looping or hanging.
        throw new TypeError('fetch failed');
      }));

      const startedAt = Date.now();
      const adapter = new SalesforceConnectorAdapter();
      const payload: ConnectorPayload = {
        type: 'call.completed',
        opportunityId: '006xx0000004C92AAE',
        durationSeconds: 30,
      };
      const result = await adapter.execute(TENANT, CONFIG, payload);
      const elapsedMs = Date.now() - startedAt;

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/fetch failed/);
      expect(result.externalId).toBeUndefined();
      expect(calls).toHaveLength(3);
      expect(calls.every((c) => c.url.endsWith('/sobjects/Task'))).toBe(true);
      expect(elapsedMs).toBeLessThan(60_000);
    },
  );
});
