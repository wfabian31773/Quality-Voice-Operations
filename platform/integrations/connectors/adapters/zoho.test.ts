import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { ZohoConnectorAdapter } from './zoho';
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
  provider: 'zoho',
  isEnabled: true,
  credentials: {
    access_token: 'tok-xyz',
    api_domain: 'https://www.zohoapis.com',
  },
};

function writeOk(id: string) {
  return { body: { data: [{ code: 'SUCCESS', status: 'success', details: { id } }] } };
}

describe('ZohoConnectorAdapter appointment.booked', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T10:00:00Z'));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test('creates account + contact + deal and returns IDs in meta', async () => {
    const { calls } = setupFetch([
      {
        match: (u, i) => u.includes('/crm/v2/Accounts/search') && (i?.method ?? 'GET') === 'GET',
        response: { status: 204, body: {} },
      },
      {
        match: (u, i) => u.endsWith('/crm/v2/Accounts') && i?.method === 'POST',
        response: writeOk('account-1'),
      },
      {
        match: (u, i) => u.includes('/crm/v2/Contacts/search?phone=') && (i?.method ?? 'GET') === 'GET',
        response: { status: 204, body: {} },
      },
      {
        match: (u, i) => u.endsWith('/crm/v2/Contacts') && i?.method === 'POST',
        response: writeOk('contact-1'),
      },
      {
        match: (u, i) => u.includes('/crm/v2/Contacts/contact-1/Deals') && (i?.method ?? 'GET') === 'GET',
        response: { status: 204, body: {} },
      },
      {
        match: (u, i) => u.endsWith('/crm/v2/Deals') && i?.method === 'POST',
        response: writeOk('deal-1'),
      },
      {
        match: (u, i) => u.endsWith('/crm/v2/Notes') && i?.method === 'POST',
        response: writeOk('note-1'),
      },
    ]);

    const adapter = new ZohoConnectorAdapter();
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
      accountId: 'account-1',
      dealId: 'deal-1',
      noteId: 'note-1',
      provider: 'zoho',
    });

    const dealCall = calls.find((c) => c.url.endsWith('/crm/v2/Deals') && c.method === 'POST');
    expect(dealCall).toBeDefined();
    const dealBody = dealCall!.body as { data: Array<Record<string, unknown>> };
    expect(dealBody.data[0].Deal_Name).toContain('Acme Inc');
    expect(dealBody.data[0].Contact_Name).toEqual({ id: 'contact-1' });
    expect(dealBody.data[0].Account_Name).toEqual({ id: 'account-1' });

    const noteCall = calls.find((c) => c.url.endsWith('/crm/v2/Notes') && c.method === 'POST');
    const noteBody = noteCall!.body as { data: Array<Record<string, unknown>> };
    expect(noteBody.data[0].Parent_Id).toEqual({ id: 'deal-1' });
    expect(noteBody.data[0].se_module).toBe('Deals');
  });

  test('moves an existing open deal into the configured appointment stage', async () => {
    const cfg: ConnectorConfig = {
      ...CONFIG,
      credentials: {
        ...CONFIG.credentials,
        appointment_pipeline_id: 'layout-A',
        appointment_stage_id: 'Appointment Booked',
      },
    };
    const { calls } = setupFetch([
      {
        match: (u, i) => u.includes('/crm/v2/Accounts/search') && (i?.method ?? 'GET') === 'GET',
        response: { body: { data: [{ id: 'account-9' }] } },
      },
      {
        match: (u, i) => u.includes('/crm/v2/Contacts/search?phone=') && (i?.method ?? 'GET') === 'GET',
        response: { body: { data: [{ id: 'contact-9' }] } },
      },
      {
        match: (u, i) => u.includes('/crm/v2/Contacts/contact-9/Deals') && (i?.method ?? 'GET') === 'GET',
        response: { body: { data: [{ id: 'deal-9', Stage: 'Qualification' }] } },
      },
      {
        match: (u, i) => u.endsWith('/crm/v2/Deals') && i?.method === 'PUT',
        response: writeOk('deal-9'),
      },
      {
        match: (u, i) => u.endsWith('/crm/v2/Notes') && i?.method === 'POST',
        response: writeOk('note-9'),
      },
    ]);

    const adapter = new ZohoConnectorAdapter();
    const payload: ConnectorPayload = {
      type: 'appointment.booked',
      callerPhone: '+15551234567',
      callerCompany: 'Acme Inc',
    };

    const result = await adapter.execute(TENANT, cfg, payload);

    expect(result.success).toBe(true);
    expect(result.meta).toMatchObject({
      contactId: 'contact-9',
      accountId: 'account-9',
      dealId: 'deal-9',
      pipelineId: 'layout-A',
      stageId: 'Appointment Booked',
      dealStageMoved: true,
    });

    const putCall = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/crm/v2/Deals'));
    expect(putCall).toBeDefined();
    const putBody = putCall!.body as { data: Array<Record<string, unknown>> };
    expect(putBody.data[0]).toMatchObject({
      id: 'deal-9',
      Stage: 'Appointment Booked',
      Account_Name: { id: 'account-9' },
      Layout: { id: 'layout-A' },
    });
  });

  test('accepts canonical opportunityId in payload and emits it in meta, skipping deal search/create', async () => {
    const { calls } = setupFetch([
      {
        match: (u, i) => u.endsWith('/crm/v2/Deals') && i?.method === 'PUT',
        response: writeOk('deal-canonical'),
      },
      {
        match: (u, i) => u.endsWith('/crm/v2/Notes') && i?.method === 'POST',
        response: writeOk('note-canonical'),
      },
    ]);

    const adapter = new ZohoConnectorAdapter();
    const payload: ConnectorPayload = {
      type: 'appointment.booked',
      contactId: 'contact-canonical',
      accountId: 'account-canonical',
      opportunityId: 'deal-canonical',
    };

    const result = await adapter.execute(TENANT, CONFIG, payload);

    expect(result.success).toBe(true);
    expect(result.meta).toMatchObject({
      contactId: 'contact-canonical',
      accountId: 'account-canonical',
      dealId: 'deal-canonical',
      opportunityId: 'deal-canonical',
      noteId: 'note-canonical',
      provider: 'zoho',
    });

    // No search calls and no create calls for contact/account/deal because
    // canonical IDs are already supplied via payload.
    expect(calls.find((c) => c.url.includes('/search'))).toBeUndefined();
    expect(calls.find((c) => c.url.includes('/Contacts/contact-canonical/Deals'))).toBeUndefined();
    expect(calls.find((c) => c.url.endsWith('/crm/v2/Contacts') && c.method === 'POST')).toBeUndefined();
    expect(calls.find((c) => c.url.endsWith('/crm/v2/Accounts') && c.method === 'POST')).toBeUndefined();
    expect(calls.find((c) => c.url.endsWith('/crm/v2/Deals') && c.method === 'POST')).toBeUndefined();

    const noteCall = calls.find((c) => c.url.endsWith('/crm/v2/Notes') && c.method === 'POST');
    const noteBody = noteCall!.body as { data: Array<Record<string, unknown>> };
    expect(noteBody.data[0].Parent_Id).toEqual({ id: 'deal-canonical' });
  });

  test('call.completed emits opportunityId alias alongside dealId in meta', async () => {
    const { calls } = setupFetch([
      {
        match: (u, i) => u.endsWith('/crm/v2/Calls') && i?.method === 'POST',
        response: writeOk('call-canonical'),
      },
    ]);

    const adapter = new ZohoConnectorAdapter();
    const payload: ConnectorPayload = {
      type: 'call.completed',
      contactId: 'contact-canonical',
      accountId: 'account-canonical',
      opportunityId: 'deal-canonical',
      summary: 'Quick check-in',
      durationSeconds: 42,
    };

    const result = await adapter.execute(TENANT, CONFIG, payload);

    expect(result.success).toBe(true);
    expect(result.meta).toMatchObject({
      contactId: 'contact-canonical',
      accountId: 'account-canonical',
      dealId: 'deal-canonical',
      opportunityId: 'deal-canonical',
      provider: 'zoho',
    });

    // No lookups should run when canonical IDs are supplied.
    expect(calls.find((c) => c.url.includes('/search'))).toBeUndefined();
  });

  test('honors hint IDs from payload to skip lookups', async () => {
    const { calls } = setupFetch([
      {
        match: (u, i) => u.endsWith('/crm/v2/Deals') && i?.method === 'PUT',
        response: writeOk('deal-hint'),
      },
      {
        match: (u, i) => u.endsWith('/crm/v2/Notes') && i?.method === 'POST',
        response: writeOk('note-hint'),
      },
    ]);

    const adapter = new ZohoConnectorAdapter();
    const payload: ConnectorPayload = {
      type: 'appointment.booked',
      contactId: 'contact-hint',
      accountId: 'account-hint',
      dealId: 'deal-hint',
    };

    const result = await adapter.execute(TENANT, CONFIG, payload);

    expect(result.success).toBe(true);
    expect(result.meta).toMatchObject({
      contactId: 'contact-hint',
      accountId: 'account-hint',
      dealId: 'deal-hint',
      noteId: 'note-hint',
      provider: 'zoho',
    });

    expect(calls.find((c) => c.url.includes('/search'))).toBeUndefined();
    expect(calls.find((c) => c.url.endsWith('/crm/v2/Contacts') && c.method === 'POST')).toBeUndefined();
    expect(calls.find((c) => c.url.endsWith('/crm/v2/Accounts') && c.method === 'POST')).toBeUndefined();
    expect(calls.find((c) => c.url.endsWith('/crm/v2/Deals') && c.method === 'POST')).toBeUndefined();

    // The adapter relinks the hinted account to the existing deal so the
    // appointment lands against the right Account in pipeline reports.
    const putCall = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/crm/v2/Deals'));
    expect(putCall).toBeDefined();
    const putBody = putCall!.body as { data: Array<Record<string, unknown>> };
    expect(putBody.data[0]).toMatchObject({
      id: 'deal-hint',
      Account_Name: { id: 'account-hint' },
    });

    const noteCall = calls.find((c) => c.url.endsWith('/crm/v2/Notes') && c.method === 'POST');
    const noteBody = noteCall!.body as { data: Array<Record<string, unknown>> };
    expect(noteBody.data[0].Parent_Id).toEqual({ id: 'deal-hint' });
  });
});

describe('ZohoConnectorAdapter api_domain allowlist', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('refuses to dispatch and never fetches when api_domain is not allowlisted', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const cfg: ConnectorConfig = {
      ...CONFIG,
      credentials: {
        access_token: 'tok-xyz',
        api_domain: 'https://attacker.example.com',
      },
    };
    const payload: ConnectorPayload = {
      type: 'appointment.booked',
      tenantId: TENANT,
      timestamp: new Date().toISOString(),
      data: {
        callerName: 'Jane Doe',
        callerPhone: '+15555550100',
        appointmentTime: new Date('2026-04-30T15:00:00Z').toISOString(),
      },
    };

    const adapter = new ZohoConnectorAdapter();
    const result = await adapter.execute(TENANT, cfg, payload);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/api_domain.*not a recognized Zoho API host/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ZohoConnectorAdapter retry-with-backoff (BL-014 Task #505)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  // Real timers because retryFetch's backoff uses setTimeout.
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
          // Zoho rate-limits with 429 + Retry-After when the per-second
          // request quota trips. The retry helper must honor it and try
          // again before the call surfaces.
          return new Response(
            JSON.stringify({ code: 'TOO_MANY_REQUESTS', message: 'rate limited' }),
            { status: 429, headers: { 'Retry-After': '1' } },
          );
        }
        return new Response(
          JSON.stringify({
            data: [{ code: 'SUCCESS', status: 'success', details: { id: 'call-retry' } }],
          }),
          { status: 200 },
        );
      }));

      const adapter = new ZohoConnectorAdapter();
      const payload: ConnectorPayload = {
        type: 'call.completed',
        contactId: 'contact-canonical',
        accountId: 'account-canonical',
        opportunityId: 'deal-canonical',
        summary: 'Quick check-in',
        durationSeconds: 30,
      };
      const result = await adapter.execute(TENANT, CONFIG, payload);

      expect(result.success).toBe(true);
      expect(result.externalId).toBe('call-retry');
      expect(result.meta).toMatchObject({ provider: 'zoho', callId: 'call-retry' });
      expect(calls).toHaveLength(2);
      expect(calls.every((c) => c.url.endsWith('/crm/v2/Calls'))).toBe(true);
      expect(calls.every((c) => c.method === 'POST')).toBe(true);
    },
  );
});
