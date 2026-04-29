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
  connectorType: 'calendar',
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
});
