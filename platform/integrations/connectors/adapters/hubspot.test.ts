import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { HubSpotConnectorAdapter } from './hubspot';
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
  provider: 'hubspot',
  isEnabled: true,
  credentials: { access_token: 'tok-xyz' },
};

describe('HubSpotConnectorAdapter appointment.booked', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T10:00:00Z'));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('creates contact + company + deal and returns IDs in meta', async () => {
    const { calls } = setupFetch([
      {
        match: (u, i) => u.endsWith('/contacts/search') && i?.method === 'POST',
        response: { body: { total: 0, results: [] } },
      },
      {
        match: (u, i) => u.endsWith('/objects/contacts') && i?.method === 'POST',
        response: { body: { id: 'contact-1' } },
      },
      {
        match: (u, i) => u.endsWith('/companies/search') && i?.method === 'POST',
        response: { body: { total: 0, results: [] } },
      },
      {
        match: (u, i) => u.endsWith('/objects/companies') && i?.method === 'POST',
        response: { body: { id: 'company-1' } },
      },
      {
        match: (u) => u.includes('/crm/v4/objects/contacts/contact-1/associations/companies/company-1'),
        response: { body: { results: [] } },
      },
      {
        match: (u, i) => u.endsWith('/deals/search') && i?.method === 'POST',
        response: { body: { total: 0, results: [] } },
      },
      {
        match: (u, i) => u.endsWith('/objects/deals') && i?.method === 'POST',
        response: { body: { id: 'deal-1' } },
      },
      {
        match: (u) => u.includes('/crm/v4/objects/deals/deal-1/associations/companies/company-1'),
        response: { body: { results: [] } },
      },
      {
        match: (u, i) => u.endsWith('/objects/notes') && i?.method === 'POST',
        response: { body: { id: 'note-1' } },
      },
    ]);

    const adapter = new HubSpotConnectorAdapter();
    const payload: ConnectorPayload = {
      type: 'appointment.booked',
      callerPhone: '+15551234567',
      callerFirstName: 'Jane',
      callerLastName: 'Doe',
      callerCompany: 'Acme Inc',
      summary: 'Booked product demo',
      appointmentDate: '2026-05-01',
      appointmentTime: '14:00',
    };

    const result = await adapter.execute(TENANT, CONFIG, payload);

    expect(result.success).toBe(true);
    expect(result.externalId).toBe('note-1');
    expect(result.meta).toMatchObject({
      contactId: 'contact-1',
      companyId: 'company-1',
      dealId: 'deal-1',
      engagementId: 'note-1',
      provider: 'hubspot',
    });

    const dealCall = calls.find((c) => c.url.endsWith('/objects/deals') && c.method === 'POST');
    expect(dealCall).toBeDefined();
    const dealBody = dealCall!.body as {
      properties: Record<string, string>;
      associations: Array<{ to: { id: string }; types: Array<{ associationTypeId: number }> }>;
    };
    expect(dealBody.properties.dealname).toContain('Acme Inc');
    expect(dealBody.associations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ to: { id: 'contact-1' }, types: [expect.objectContaining({ associationTypeId: 3 })] }),
        expect.objectContaining({ to: { id: 'company-1' }, types: [expect.objectContaining({ associationTypeId: 5 })] }),
      ]),
    );
  });

  test('moves an existing open deal into the configured appointment stage', async () => {
    const cfg: ConnectorConfig = {
      ...CONFIG,
      credentials: {
        ...CONFIG.credentials,
        appointment_pipeline_id: 'pipe-A',
        appointment_stage_id: 'stage-appointment',
      },
    };
    const { calls } = setupFetch([
      {
        match: (u, i) => u.endsWith('/contacts/search') && i?.method === 'POST',
        response: { body: { total: 1, results: [{ id: 'contact-9' }] } },
      },
      {
        match: (u, i) => u.endsWith('/companies/search') && i?.method === 'POST',
        response: { body: { total: 1, results: [{ id: 'company-9' }] } },
      },
      {
        match: (u) => u.includes('/crm/v4/objects/contacts/contact-9/associations/companies/company-9'),
        response: { body: { results: [] } },
      },
      {
        match: (u, i) => u.endsWith('/deals/search') && i?.method === 'POST',
        response: { body: { total: 1, results: [{ id: 'deal-9' }] } },
      },
      {
        match: (u, i) => u.endsWith('/crm/v3/objects/deals/deal-9') && i?.method === 'PATCH',
        response: { body: { id: 'deal-9' } },
      },
      {
        match: (u) => u.includes('/crm/v4/objects/deals/deal-9/associations/companies/company-9'),
        response: { body: { results: [] } },
      },
      {
        match: (u, i) => u.endsWith('/objects/notes') && i?.method === 'POST',
        response: { body: { id: 'note-9' } },
      },
    ]);

    const adapter = new HubSpotConnectorAdapter();
    const payload: ConnectorPayload = {
      type: 'appointment.booked',
      callerPhone: '+15551234567',
      callerCompany: 'Acme Inc',
    };

    const result = await adapter.execute(TENANT, cfg, payload);

    expect(result.success).toBe(true);
    expect(result.meta).toMatchObject({
      contactId: 'contact-9',
      companyId: 'company-9',
      dealId: 'deal-9',
      pipelineId: 'pipe-A',
      stageId: 'stage-appointment',
      dealStageMoved: true,
    });

    const patchCall = calls.find((c) => c.method === 'PATCH' && c.url.endsWith('/objects/deals/deal-9'));
    expect(patchCall).toBeDefined();
    expect(patchCall!.body).toMatchObject({
      properties: { dealstage: 'stage-appointment', pipeline: 'pipe-A' },
    });
  });

  test('honors hint IDs from payload to skip lookups', async () => {
    const { calls } = setupFetch([
      {
        match: (u, i) => u.endsWith('/objects/notes') && i?.method === 'POST',
        response: { body: { id: 'note-hint' } },
      },
      {
        match: (u) => u.includes('/crm/v4/objects/deals/deal-hint/associations/companies/company-hint'),
        response: { body: { results: [] } },
      },
    ]);

    const adapter = new HubSpotConnectorAdapter();
    const payload: ConnectorPayload = {
      type: 'appointment.booked',
      contactId: 'contact-hint',
      companyId: 'company-hint',
      dealId: 'deal-hint',
    };

    const result = await adapter.execute(TENANT, CONFIG, payload);
    expect(result.success).toBe(true);
    expect(result.meta).toMatchObject({
      contactId: 'contact-hint',
      companyId: 'company-hint',
      dealId: 'deal-hint',
    });
    // No search/create calls happened; only the deal->company association and the note creation.
    expect(calls.find((c) => c.url.includes('/search'))).toBeUndefined();
    expect(calls.find((c) => c.url.endsWith('/objects/contacts') && c.method === 'POST')).toBeUndefined();
    expect(calls.find((c) => c.url.endsWith('/objects/companies') && c.method === 'POST')).toBeUndefined();
    expect(calls.find((c) => c.url.endsWith('/objects/deals') && c.method === 'POST')).toBeUndefined();
  });
});
