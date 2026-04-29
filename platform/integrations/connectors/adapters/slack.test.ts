import { describe, test, expect, afterEach, vi } from 'vitest';
import { SlackConnectorAdapter } from './slack';
import type { ConnectorConfig, ConnectorPayload } from '../types';
import type { TenantId } from '../../../core/types';

const TENANT: TenantId = 'tenant-test' as TenantId;
const CONFIG: ConnectorConfig = {
  integrationId: 'int-1',
  tenantId: TENANT,
  connectorType: 'webhook',
  provider: 'slack',
  isEnabled: true,
  credentials: {
    bot_token: 'xoxb-test-token',
    channel_id: 'C0123456789',
  },
};

describe('SlackConnectorAdapter retry-with-backoff (BL-014 Task #1111)', () => {
  // Real timers because retryFetch's backoff uses setTimeout — with fake
  // timers the retry sleep would stall forever and the test would time out.
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // BL-014 (Task #1111): the older Slack adapter wraps the chat.postMessage
  // call in retryFetch directly (no helper), but until now there were no
  // tests covering it (no slack.test.ts file existed at all). Without these
  // two tests a regression that swapped `retryFetch` for a plain `fetch`
  // (e.g. during a refactor) would silently pass CI even though the dispatch
  // would no longer recover from a transient upstream wobble or stay inside
  // the 60s budget on a hostile one. The pattern mirrors the QuickBooks /
  // Zoho / Google Calendar / Outlook Calendar tests added in Task #981.
  test(
    'recovers from a transient 5xx (502 → 503 → 200) on chat.postMessage and ultimately succeeds',
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
        // posted message as if nothing happened.
        if (attempt === 1) {
          return new Response('bad gateway', { status: 502 });
        }
        if (attempt === 2) {
          return new Response('service unavailable', { status: 503 });
        }
        return new Response(
          JSON.stringify({ ok: true, ts: '1700000000.000100' }),
          { status: 200 },
        );
      }));

      const adapter = new SlackConnectorAdapter();
      const payload: ConnectorPayload = {
        type: 'call.completed',
        callerPhone: '+15551234567',
        durationSeconds: 30,
        summary: 'Caller asked about pricing',
        agentName: 'Aria',
        resolution: 'completed',
      };
      const result = await adapter.execute(TENANT, CONFIG, payload);

      expect(result.success).toBe(true);
      expect(result.externalId).toBe('1700000000.000100');
      expect(result.meta).toMatchObject({
        messageTs: '1700000000.000100',
        channel: 'C0123456789',
        provider: 'slack',
      });
      // Two 5xx + one successful retry, all targeting chat.postMessage.
      expect(calls).toHaveLength(3);
      expect(calls.every((c) => c.url.endsWith('/chat.postMessage'))).toBe(true);
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
        // Persistent 503 — Slack's retryFetch wrapper MUST cap at 3 attempts
        // and let the adapter convert the final failed Response into a
        // clean {success:false, error:'Slack API error 503: ...'} result
        // rather than looping or hanging until the per-dispatch deadline
        // fires.
        return new Response('service unavailable', { status: 503 });
      }));

      const startedAt = Date.now();
      const adapter = new SlackConnectorAdapter();
      const payload: ConnectorPayload = {
        type: 'call.completed',
        callerPhone: '+15551234567',
        durationSeconds: 30,
        summary: 'Caller asked about pricing',
        agentName: 'Aria',
        resolution: 'completed',
      };
      const result = await adapter.execute(TENANT, CONFIG, payload);
      const elapsedMs = Date.now() - startedAt;

      expect(result.success).toBe(false);
      // The adapter wraps the helper's final response in its own status
      // string so callers get a stable, parseable failure instead of a raw
      // exception or a never-resolving promise.
      expect(result.error).toMatch(/Slack API error 503/);
      expect(result.externalId).toBeUndefined();
      // Exactly three POSTs to chat.postMessage: the helper does NOT make
      // a 4th attempt, which is what bounds the dispatch inside the 60s
      // budget (3 attempts × 15s per-attempt + 1s + 4s sleeps = 50s
      // worst case).
      expect(calls).toHaveLength(3);
      expect(calls.every((c) => c.url.endsWith('/chat.postMessage'))).toBe(true);
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
    'recovers from a transient transport timeout (TypeError → TypeError → 200) on chat.postMessage',
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
        return new Response(
          JSON.stringify({ ok: true, ts: '1700000000.000200' }),
          { status: 200 },
        );
      }));

      const adapter = new SlackConnectorAdapter();
      const payload: ConnectorPayload = {
        type: 'call.completed',
        callerPhone: '+15551234567',
        durationSeconds: 30,
        summary: 'Caller asked about pricing',
        agentName: 'Aria',
        resolution: 'completed',
      };
      const result = await adapter.execute(TENANT, CONFIG, payload);

      expect(result.success).toBe(true);
      expect(result.externalId).toBe('1700000000.000200');
      expect(calls).toHaveLength(3);
      expect(calls.every((c) => c.url.endsWith('/chat.postMessage'))).toBe(true);
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
        // Persistent transport failure — postMessage's outer try/catch
        // turns the final thrown error from retryFetch into a clean
        // {success:false, error:'fetch failed'} result rather than
        // looping or hanging.
        throw new TypeError('fetch failed');
      }));

      const startedAt = Date.now();
      const adapter = new SlackConnectorAdapter();
      const payload: ConnectorPayload = {
        type: 'call.completed',
        callerPhone: '+15551234567',
        durationSeconds: 30,
        summary: 'Caller asked about pricing',
        agentName: 'Aria',
        resolution: 'completed',
      };
      const result = await adapter.execute(TENANT, CONFIG, payload);
      const elapsedMs = Date.now() - startedAt;

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/fetch failed/);
      expect(result.externalId).toBeUndefined();
      expect(calls).toHaveLength(3);
      expect(calls.every((c) => c.url.endsWith('/chat.postMessage'))).toBe(true);
      expect(elapsedMs).toBeLessThan(60_000);
    },
  );
});
