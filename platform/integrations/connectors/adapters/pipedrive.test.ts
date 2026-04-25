import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { PipedriveConnectorAdapter } from './pipedrive';
import type { ConnectorConfig, ConnectorPayload } from '../types';
import type { TenantId } from '../../../core/types';

vi.mock('../tokenRefresh', () => ({
  ensureFreshOAuthToken: async (cfg: ConnectorConfig) => cfg,
}));

interface FetchExpectation {
  match: (url: string, init?: RequestInit) => boolean;
  response: { status?: number; body: unknown };
}

function setupFetch(expectations: FetchExpectation[]): {
  calls: Array<{ url: string; method: string; body?: unknown }>;
} {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    let parsedBody: unknown;
    try {
      parsedBody = init?.body ? JSON.parse(init.body as string) : undefined;
    } catch {
      parsedBody = init?.body;
    }
    calls.push({ url, method, body: parsedBody });

    const found = expectations.find((e) => e.match(url, init));
    if (!found) {
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    }
    const status = found.response.status ?? 200;
    return new Response(JSON.stringify(found.response.body), { status });
  }));
  return { calls };
}

const TENANT: TenantId = 'tenant-test' as TenantId;
const CONFIG: ConnectorConfig = {
  integrationId: 'int-1',
  tenantId: TENANT,
  connectorType: 'crm',
  provider: 'pipedrive',
  isEnabled: true,
  credentials: { access_token: 'tok', company_domain: 'acmedomain' },
};

describe('PipedriveConnectorAdapter appointment.booked', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T10:00:00Z'));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('creates org + person + deal and returns IDs in meta', async () => {
    const { calls } = setupFetch([
      {
        match: (u, i) => u.includes('/organizations/search') && (!i?.method || i.method === 'GET'),
        response: { body: { success: true, data: { items: [] } } },
      },
      {
        match: (u, i) => u.includes('/organizations') && i?.method === 'POST',
        response: { body: { success: true, data: { id: 555 } } },
      },
      {
        match: (u, i) => u.includes('/persons/search') && (!i?.method || i.method === 'GET'),
        response: { body: { success: true, data: { items: [] } } },
      },
      {
        match: (u, i) => u.endsWith('/persons') || (u.includes('/persons?') && i?.method === 'POST'),
        response: { body: { success: true, data: { id: 111 } } },
      },
      {
        match: (u, i) => u.includes('/persons/111/deals') && (!i?.method || i.method === 'GET'),
        response: { body: { success: true, data: null } },
      },
      {
        match: (u, i) => (u.endsWith('/deals') || u.includes('/deals?')) && i?.method === 'POST',
        response: { body: { success: true, data: { id: 999 } } },
      },
      {
        match: (u, i) => (u.endsWith('/activities') || u.includes('/activities?')) && i?.method === 'POST',
        response: { body: { success: true, data: { id: 777 } } },
      },
    ]);

    const adapter = new PipedriveConnectorAdapter();
    const payload: ConnectorPayload = {
      type: 'appointment.booked',
      callerPhone: '+15551234567',
      callerFirstName: 'Jane',
      callerLastName: 'Doe',
      callerCompany: 'Acme Inc',
      summary: 'Demo booked',
      appointmentDate: '2026-05-01',
      appointmentTime: '14:00',
    };

    const result = await adapter.execute(TENANT, CONFIG, payload);

    expect(result.success).toBe(true);
    expect(result.externalId).toBe('777');
    expect(result.meta).toMatchObject({
      personId: 111,
      orgId: 555,
      dealId: 999,
      activityId: '777',
      provider: 'pipedrive',
    });

    // Person create body should include org_id linking it to the org.
    const personCreate = calls.find((c) => c.method === 'POST' && /\/persons(\?|$)/.test(c.url));
    expect(personCreate).toBeDefined();
    expect(personCreate!.body).toMatchObject({ org_id: 555 });

    // Deal create body should include person_id and org_id.
    const dealCreate = calls.find((c) => c.method === 'POST' && /\/deals(\?|$)/.test(c.url));
    expect(dealCreate).toBeDefined();
    expect(dealCreate!.body).toMatchObject({ person_id: 111, org_id: 555, status: 'open' });
  });

  test('moves an existing open deal into the configured stage on appointment.booked', async () => {
    const cfg: ConnectorConfig = {
      ...CONFIG,
      credentials: { ...CONFIG.credentials, appointment_stage_id: '42' },
    };
    const { calls } = setupFetch([
      {
        match: (u) => u.includes('/organizations/search'),
        response: { body: { success: true, data: { items: [{ item: { id: 33 } }] } } },
      },
      {
        match: (u) => u.includes('/persons/search'),
        response: { body: { success: true, data: { items: [{ item: { id: 22 } }] } } },
      },
      {
        match: (u) => u.includes('/persons/22/deals'),
        response: { body: { success: true, data: [{ id: 88, status: 'open', title: 'existing' }] } },
      },
      {
        match: (u, i) => u.includes('/deals/88') && i?.method === 'PUT',
        response: { body: { success: true } },
      },
      {
        match: (u, i) => (u.endsWith('/activities') || u.includes('/activities?')) && i?.method === 'POST',
        response: { body: { success: true, data: { id: 7 } } },
      },
    ]);

    const adapter = new PipedriveConnectorAdapter();
    const payload: ConnectorPayload = {
      type: 'appointment.booked',
      callerPhone: '+15551234567',
      callerCompany: 'Acme Inc',
    };

    const result = await adapter.execute(TENANT, cfg, payload);
    expect(result.success).toBe(true);
    expect(result.meta).toMatchObject({
      personId: 22,
      orgId: 33,
      dealId: 88,
      activityId: '7',
      stageId: 42,
      dealStageMoved: true,
    });

    const putDeal = calls.find((c) => c.method === 'PUT' && c.url.includes('/deals/88'));
    expect(putDeal).toBeDefined();
    expect(putDeal!.body).toMatchObject({ stage_id: 42, org_id: 33 });
  });

  test('honors hint IDs from payload to skip lookups', async () => {
    const { calls } = setupFetch([
      {
        match: (u, i) => u.includes('/deals/3') && i?.method === 'PUT',
        response: { body: { success: true } },
      },
      {
        match: (u, i) => (u.endsWith('/activities') || u.includes('/activities?')) && i?.method === 'POST',
        response: { body: { success: true, data: { id: 5 } } },
      },
    ]);

    const adapter = new PipedriveConnectorAdapter();
    const payload: ConnectorPayload = {
      type: 'appointment.booked',
      personId: 1,
      orgId: 2,
      dealId: 3,
    };

    const result = await adapter.execute(TENANT, CONFIG, payload);
    expect(result.success).toBe(true);
    expect(result.meta).toMatchObject({ personId: 1, orgId: 2, dealId: 3, activityId: '5' });

    expect(calls.find((c) => c.url.includes('/persons/search'))).toBeUndefined();
    expect(calls.find((c) => c.url.includes('/organizations/search'))).toBeUndefined();
    expect(calls.find((c) => c.url.includes('/deals') && c.method === 'POST')).toBeUndefined();
  });
});
