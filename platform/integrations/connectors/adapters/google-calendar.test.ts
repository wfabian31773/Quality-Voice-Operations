import { describe, test, expect, afterEach, vi } from 'vitest';
import { GoogleCalendarConnectorAdapter } from './google-calendar';
import type { ConnectorConfig, ConnectorPayload } from '../types';
import type { TenantId } from '../../../core/types';

vi.mock('../tokenRefresh', () => ({
  ensureFreshOAuthToken: async (cfg: ConnectorConfig) => cfg,
}));

const TENANT: TenantId = 'tenant-test' as TenantId;
const CONFIG: ConnectorConfig = {
  integrationId: 'int-gcal',
  tenantId: TENANT,
  connectorType: 'scheduling',
  provider: 'google-calendar',
  isEnabled: true,
  credentials: { access_token: 'tok-gcal', calendar_id: 'primary' },
};

describe('GoogleCalendarConnectorAdapter retry-with-backoff (BL-014 Task #505)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

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
          // Calendar API returns 429 with Retry-After when the per-user
          // quota trips. The retry helper must honor it and try again.
          return new Response(
            JSON.stringify({ error: { code: 429, message: 'Rate Limit Exceeded' } }),
            { status: 429, headers: { 'Retry-After': '1' } },
          );
        }
        return new Response(
          JSON.stringify({ id: 'evt-99', htmlLink: 'https://calendar.google.com/event?eid=evt-99' }),
          { status: 200 },
        );
      }));

      const adapter = new GoogleCalendarConnectorAdapter();
      const payload: ConnectorPayload = {
        type: 'appointment.booked',
        summary: 'Demo booked',
        appointmentDate: '2026-05-01',
        appointmentTime: '14:00',
        callerPhone: '+15551234567',
      };
      const result = await adapter.execute(TENANT, CONFIG, payload);

      expect(result.success).toBe(true);
      expect(result.externalId).toBe('evt-99');
      expect(result.meta).toMatchObject({ eventId: 'evt-99', provider: 'google-calendar' });
      // The 429 + the successful retry both target the same events endpoint.
      expect(calls).toHaveLength(2);
      expect(calls.every((c) => c.url.includes('/calendars/primary/events'))).toBe(true);
      expect(calls.every((c) => c.method === 'POST')).toBe(true);
    },
  );

  // BL-014 (Task #981): the 429 test above only proved Retry-After. The
  // remaining helper guarantees — recovery from transient 5xx, clean
  // exhaustion, and the 3-attempt cap that pins us inside the 60s
  // dispatch budget — were unverified for Google Calendar until now.
  test(
    'recovers from a transient 5xx (502 → 503 → 200) on the events POST and ultimately succeeds',
    { timeout: 15_000 },
    async () => {
      const calls: Array<{ url: string; method: string }> = [];
      let attempt = 0;
      vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        calls.push({ url, method });
        attempt += 1;
        // Two transient upstream failures must be retried by the helper
        // BEFORE the adapter even sees them; the third attempt returns the
        // created Calendar event as if the earlier failures never happened.
        if (attempt === 1) {
          return new Response(
            JSON.stringify({ error: { code: 502, message: 'bad gateway' } }),
            { status: 502 },
          );
        }
        if (attempt === 2) {
          return new Response(
            JSON.stringify({ error: { code: 503, message: 'service unavailable' } }),
            { status: 503 },
          );
        }
        return new Response(
          JSON.stringify({ id: 'evt-5xx', htmlLink: 'https://calendar.google.com/event?eid=evt-5xx' }),
          { status: 200 },
        );
      }));

      const adapter = new GoogleCalendarConnectorAdapter();
      const payload: ConnectorPayload = {
        type: 'appointment.booked',
        summary: 'Demo booked',
        appointmentDate: '2026-05-01',
        appointmentTime: '14:00',
        callerPhone: '+15551234567',
      };
      const result = await adapter.execute(TENANT, CONFIG, payload);

      expect(result.success).toBe(true);
      expect(result.externalId).toBe('evt-5xx');
      expect(result.meta).toMatchObject({ eventId: 'evt-5xx', provider: 'google-calendar' });
      // Two 5xx + one successful retry, all targeting the same events endpoint.
      expect(calls).toHaveLength(3);
      expect(calls.every((c) => c.url.includes('/calendars/primary/events'))).toBe(true);
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
        // Persistent 503 — the Calendar helper MUST cap at 3 attempts and
        // let the adapter convert the final failed Response into a clean
        // {success:false, error:'Google Calendar API error 503: ...'}
        // result rather than looping or hanging until the per-dispatch
        // deadline fires.
        return new Response(
          JSON.stringify({ error: { code: 503, message: 'service unavailable' } }),
          { status: 503 },
        );
      }));

      const startedAt = Date.now();
      const adapter = new GoogleCalendarConnectorAdapter();
      const payload: ConnectorPayload = {
        type: 'appointment.booked',
        summary: 'Demo booked',
        appointmentDate: '2026-05-01',
        appointmentTime: '14:00',
        callerPhone: '+15551234567',
      };
      const result = await adapter.execute(TENANT, CONFIG, payload);
      const elapsedMs = Date.now() - startedAt;

      expect(result.success).toBe(false);
      // The adapter wraps the helper's final response in its own status
      // string so callers get a stable, parseable failure instead of a raw
      // exception or a never-resolving promise.
      expect(result.error).toMatch(/Google Calendar API error 503/);
      expect(result.externalId).toBeUndefined();
      // Exactly three POSTs to the events endpoint: the helper does NOT
      // make a 4th attempt, which is what bounds the dispatch inside the
      // 60s budget (3 attempts × 15s per-attempt + 1s + 4s sleeps =
      // 50s worst case).
      expect(calls).toHaveLength(3);
      expect(calls.every((c) => c.url.includes('/calendars/primary/events'))).toBe(true);
      expect(calls.every((c) => c.method === 'POST')).toBe(true);
      // Total wall-clock comfortably inside the 60s budget — proving the
      // helper did not stretch past it on a hostile upstream.
      expect(elapsedMs).toBeLessThan(60_000);
    },
  );
});
