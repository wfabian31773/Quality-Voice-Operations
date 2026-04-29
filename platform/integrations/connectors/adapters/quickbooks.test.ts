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
});
