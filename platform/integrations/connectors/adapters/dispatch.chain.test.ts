import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ConnectorConfig } from '../types';
import type { TenantId } from '../../../core/types';

// --- Mocks for everything the dispatch layer touches besides the adapters ---

// Token refresh: passthrough so the adapters use the credentials as-is.
vi.mock('../tokenRefresh', () => ({
  ensureFreshOAuthToken: async (cfg: ConnectorConfig) => cfg,
}));

// In-memory CRM caller identity store. We keep `extractIdentityFromMeta` and
// `normalizeCallerPhone` real so the test exercises the actual meta-extraction
// logic, and only swap the DB persistence for an in-process Map. The mock
// round-trips the `extras` JSONB column the same way the real DB does:
// per-key merge so a later event can't blank out a previously cached native ID.
interface StoredIdentity {
  contactId?: string;
  accountId?: string;
  opportunityId?: string;
  extras?: Record<string, string>;
}
vi.mock('../crmCallerIdentity', async () => {
  const actual = await vi.importActual<typeof import('../crmCallerIdentity')>(
    '../crmCallerIdentity',
  );
  const store = new Map<string, StoredIdentity>();
  return {
    ...actual,
    __store: store,
    lookupCrmCallerIdentity: vi.fn(async (tenantId: string, provider: string, phone: string) => {
      const norm = actual.normalizeCallerPhone(phone);
      if (!norm) return null;
      return store.get(`${tenantId}:${provider}:${norm}`) ?? null;
    }),
    upsertCrmCallerIdentity: vi.fn(async (
      tenantId: string,
      provider: string,
      phone: string,
      identity: StoredIdentity,
    ) => {
      const norm = actual.normalizeCallerPhone(phone);
      if (!norm) return;
      const key = `${tenantId}:${provider}:${norm}`;
      const prior = store.get(key) ?? {};
      const mergedExtras = { ...(prior.extras ?? {}), ...(identity.extras ?? {}) };
      store.set(key, {
        contactId: identity.contactId ?? prior.contactId,
        accountId: identity.accountId ?? prior.accountId,
        opportunityId: identity.opportunityId ?? prior.opportunityId,
        extras: Object.keys(mergedExtras).length > 0 ? mergedExtras : undefined,
      });
    }),
  };
});

// DB layer for connectors — return our test config and no-op the rest.
vi.mock('../db', () => ({
  getConnectorConfig: vi.fn(),
  listEnabledConnectorConfigs: vi.fn(),
  updateConnectorSyncStatus: vi.fn(async () => []),
}));

// Privileged client used by recordConnectorDispatchEvent — no-op.
vi.mock('../../../db', () => ({
  withPrivilegedClient: vi.fn(async () => undefined),
}));

// Sync error alerter — no-op.
vi.mock('../SyncErrorAlerter', () => ({
  notifyConnectorSyncError: vi.fn(async () => undefined),
  notifySustainedConnectorFailure: vi.fn(async () => undefined),
  isRevenueCriticalProvider: () => false,
}));

// Trace logger — no-op.
vi.mock('../../../core/observability/traceLogger', () => ({
  recordIntegrationEvent: vi.fn(async () => null),
}));

// Import AFTER all mocks are registered so ConnectorService picks them up.
import { ConnectorService } from '../ConnectorService';
import * as connectorDb from '../db';
import * as identityModule from '../crmCallerIdentity';

const TENANT: TenantId = 'tenant-test' as TenantId;
const CALLER_PHONE = '+15551234567';

interface FetchExpectation {
  match: (url: string, init?: RequestInit) => boolean;
  response: { status?: number; body: unknown };
  // When set, the expectation is exhausted after this many matches.
  times?: number;
}

interface FetchScope {
  calls: Array<{ url: string; method: string; body?: unknown }>;
  reset(): void;
}

function setupFetch(expectations: FetchExpectation[]): FetchScope {
  const counts = new Map<FetchExpectation, number>();
  const scope: FetchScope = {
    calls: [],
    reset() {
      this.calls.length = 0;
      counts.clear();
    },
  };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    let parsedBody: unknown;
    try {
      parsedBody = init?.body ? JSON.parse(init.body as string) : undefined;
    } catch {
      parsedBody = init?.body;
    }
    scope.calls.push({ url, method, body: parsedBody });

    const found = expectations.find((e) => {
      if (!e.match(url, init)) return false;
      if (e.times === undefined) return true;
      return (counts.get(e) ?? 0) < e.times;
    });
    if (!found) {
      throw new Error(`Unexpected fetch in dispatch chain test: ${method} ${url}`);
    }
    counts.set(found, (counts.get(found) ?? 0) + 1);
    const status = found.response.status ?? 200;
    return new Response(JSON.stringify(found.response.body), { status });
  }));
  return scope;
}

function clearIdentityStore() {
  const store = (identityModule as unknown as { __store: Map<string, unknown> }).__store;
  store.clear();
}

describe('ConnectorService dispatch chain — meta forwarding from call.completed → appointment.booked', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-25T10:00:00Z'));
    clearIdentityStore();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  test('HubSpot: appointment.booked reuses contactId, companyId, and dealId from call.completed (no duplicate creates)', async () => {
    const config: ConnectorConfig = {
      integrationId: 'int-hs-1',
      tenantId: TENANT,
      connectorType: 'crm',
      provider: 'hubspot',
      isEnabled: true,
      credentials: { access_token: 'tok-hs' },
    };
    vi.mocked(connectorDb.listEnabledConnectorConfigs).mockResolvedValue([config]);

    // ---- Event 1: call.completed expectations ----
    // contact search miss -> create; company search miss -> create; associate;
    // log call engagement.
    const eventOneFetch = setupFetch([
      {
        match: (u, i) => u.endsWith('/crm/v3/objects/contacts/search') && i?.method === 'POST',
        response: { body: { total: 0, results: [] } },
      },
      {
        match: (u, i) => u.endsWith('/crm/v3/objects/contacts') && i?.method === 'POST',
        response: { body: { id: 'hs-contact-1' } },
      },
      {
        match: (u, i) => u.endsWith('/crm/v3/objects/companies/search') && i?.method === 'POST',
        response: { body: { total: 0, results: [] } },
      },
      {
        match: (u, i) => u.endsWith('/crm/v3/objects/companies') && i?.method === 'POST',
        response: { body: { id: 'hs-company-1' } },
      },
      {
        match: (u) => u.includes('/crm/v4/objects/contacts/hs-contact-1/associations/companies/hs-company-1'),
        response: { body: { results: [] } },
      },
      {
        match: (u, i) => u.endsWith('/crm/v3/objects/calls') && i?.method === 'POST',
        response: { body: { id: 'hs-call-1' } },
      },
    ]);

    const service = new ConnectorService();
    const sharedPayload = {
      callerPhone: CALLER_PHONE,
      callerFirstName: 'Jane',
      callerLastName: 'Doe',
      callerCompany: 'Acme Inc',
    };

    const callResult = await service.dispatchEvent(TENANT, 'call.completed', {
      type: 'call.completed',
      ...sharedPayload,
      summary: 'AI voice call',
      durationSeconds: 120,
      callSid: 'CA-1',
    });

    expect(callResult.dispatched).toBe(1);
    expect(callResult.results[0]).toMatchObject({ provider: 'hubspot', success: true });

    // Sanity: event 1 actually created the contact and company.
    expect(eventOneFetch.calls.find((c) => c.method === 'POST' && c.url.endsWith('/crm/v3/objects/contacts'))).toBeDefined();
    expect(eventOneFetch.calls.find((c) => c.method === 'POST' && c.url.endsWith('/crm/v3/objects/companies'))).toBeDefined();

    // The dispatch layer should have persisted the IDs from meta. Provider-
    // native field names land verbatim under `extras` so HubSpot's
    // `companyId` is not silently remapped to the Salesforce `accountId`.
    expect(identityModule.upsertCrmCallerIdentity).toHaveBeenCalledWith(
      TENANT,
      'hubspot',
      CALLER_PHONE,
      expect.objectContaining({
        contactId: 'hs-contact-1',
        accountId: 'hs-company-1',
        extras: expect.objectContaining({
          contactId: 'hs-contact-1',
          companyId: 'hs-company-1',
        }),
      }),
    );

    // ---- Event 2: appointment.booked expectations ----
    // With contactId + companyId hints injected, NO contact/company search or
    // create should be attempted. The deal does not yet exist (call.completed
    // doesn't make one in HubSpot), so a single deal create is expected.
    vi.unstubAllGlobals();
    const eventTwoFetch = setupFetch([
      {
        match: (u, i) => u.endsWith('/crm/v3/objects/deals/search') && i?.method === 'POST',
        response: { body: { total: 0, results: [] } },
      },
      {
        match: (u, i) => u.endsWith('/crm/v3/objects/deals') && i?.method === 'POST',
        response: { body: { id: 'hs-deal-1' } },
      },
      {
        match: (u) => u.includes('/crm/v4/objects/deals/hs-deal-1/associations/companies/hs-company-1'),
        response: { body: { results: [] } },
      },
      {
        match: (u, i) => u.endsWith('/crm/v3/objects/notes') && i?.method === 'POST',
        response: { body: { id: 'hs-note-1' } },
      },
    ]);

    const apptResult = await service.dispatchEvent(TENANT, 'appointment.booked', {
      type: 'appointment.booked',
      ...sharedPayload,
      summary: 'Demo booked',
      appointmentDate: '2026-05-01',
      appointmentTime: '14:00',
    });

    expect(apptResult.dispatched).toBe(1);
    expect(apptResult.results[0]).toMatchObject({ provider: 'hubspot', success: true });

    // The dispatch layer must have looked up the cached identity for event 2.
    expect(identityModule.lookupCrmCallerIdentity).toHaveBeenCalledWith(
      TENANT,
      'hubspot',
      CALLER_PHONE,
    );

    // No contact lookup or create — contactId hint short-circuits.
    expect(eventTwoFetch.calls.find((c) => c.url.endsWith('/crm/v3/objects/contacts/search'))).toBeUndefined();
    expect(eventTwoFetch.calls.find((c) => c.method === 'POST' && c.url.endsWith('/crm/v3/objects/contacts'))).toBeUndefined();
    // No company lookup or create — companyId hint short-circuits.
    expect(eventTwoFetch.calls.find((c) => c.url.endsWith('/crm/v3/objects/companies/search'))).toBeUndefined();
    expect(eventTwoFetch.calls.find((c) => c.method === 'POST' && c.url.endsWith('/crm/v3/objects/companies'))).toBeUndefined();

    // The deal POST must reference the cached contactId + companyId via the
    // associations array (i.e. the IDs really did flow through).
    const dealCreate = eventTwoFetch.calls.find((c) => c.method === 'POST' && c.url.endsWith('/crm/v3/objects/deals'));
    expect(dealCreate).toBeDefined();
    const dealBody = dealCreate!.body as {
      associations: Array<{ to: { id: string } }>;
    };
    const associatedIds = dealBody.associations.map((a) => a.to.id);
    expect(associatedIds).toEqual(expect.arrayContaining(['hs-contact-1', 'hs-company-1']));

    // The note POST must also reference the reused contact/deal.
    const noteCreate = eventTwoFetch.calls.find((c) => c.method === 'POST' && c.url.endsWith('/crm/v3/objects/notes'));
    expect(noteCreate).toBeDefined();
    const noteBody = noteCreate!.body as {
      associations?: Array<{ to: { id: string } }>;
    };
    const noteIds = (noteBody.associations ?? []).map((a) => a.to.id);
    expect(noteIds).toEqual(expect.arrayContaining(['hs-contact-1', 'hs-deal-1']));
  });

  test('Pipedrive: appointment.booked reuses personId, orgId, and dealId from call.completed (no duplicate creates)', async () => {
    const config: ConnectorConfig = {
      integrationId: 'int-pd-1',
      tenantId: TENANT,
      connectorType: 'crm',
      provider: 'pipedrive',
      isEnabled: true,
      credentials: { access_token: 'tok-pd', company_domain: 'acmedomain' },
    };
    vi.mocked(connectorDb.listEnabledConnectorConfigs).mockResolvedValue([config]);

    // ---- Event 1: call.completed expectations ----
    // org search miss -> create; person search miss -> create; no open deal ->
    // create deal; create call activity.
    const eventOneFetch = setupFetch([
      {
        match: (u) => u.includes('/organizations/search'),
        response: { body: { success: true, data: { items: [] } } },
      },
      {
        match: (u, i) => /\/organizations(\?|$)/.test(u) && i?.method === 'POST',
        response: { body: { success: true, data: { id: 555 } } },
      },
      {
        match: (u) => u.includes('/persons/search'),
        response: { body: { success: true, data: { items: [] } } },
      },
      {
        match: (u, i) => /\/persons(\?|$)/.test(u) && i?.method === 'POST',
        response: { body: { success: true, data: { id: 111 } } },
      },
      {
        match: (u) => u.includes('/persons/111/deals'),
        response: { body: { success: true, data: null } },
      },
      {
        match: (u, i) => /\/deals(\?|$)/.test(u) && i?.method === 'POST',
        response: { body: { success: true, data: { id: 999 } } },
      },
      {
        match: (u, i) => /\/activities(\?|$)/.test(u) && i?.method === 'POST',
        response: { body: { success: true, data: { id: 777 } } },
      },
    ]);

    const service = new ConnectorService();
    const sharedPayload = {
      callerPhone: CALLER_PHONE,
      callerFirstName: 'Jane',
      callerLastName: 'Doe',
      callerCompany: 'Acme Inc',
    };

    const callResult = await service.dispatchEvent(TENANT, 'call.completed', {
      type: 'call.completed',
      ...sharedPayload,
      summary: 'AI voice call',
      durationSeconds: 90,
      callSid: 'CA-2',
    });

    expect(callResult.dispatched).toBe(1);
    expect(callResult.results[0]).toMatchObject({ provider: 'pipedrive', success: true });

    // Sanity: event 1 created person, org, and deal.
    expect(eventOneFetch.calls.find((c) => c.method === 'POST' && /\/persons(\?|$)/.test(c.url))).toBeDefined();
    expect(eventOneFetch.calls.find((c) => c.method === 'POST' && /\/organizations(\?|$)/.test(c.url))).toBeDefined();
    expect(eventOneFetch.calls.find((c) => c.method === 'POST' && /\/deals(\?|$)/.test(c.url))).toBeDefined();

    // The dispatch layer should have persisted the IDs from meta. Pipedrive's
    // numeric IDs are normalized to strings in the cache slots, and the raw
    // provider-native field names (personId/orgId/dealId) round-trip verbatim
    // through `extras` instead of being remapped to Salesforce slot names.
    expect(identityModule.upsertCrmCallerIdentity).toHaveBeenCalledWith(
      TENANT,
      'pipedrive',
      CALLER_PHONE,
      expect.objectContaining({
        contactId: '111',
        accountId: '555',
        opportunityId: '999',
        extras: expect.objectContaining({
          personId: '111',
          orgId: '555',
          dealId: '999',
        }),
      }),
    );

    // ---- Event 2: appointment.booked expectations ----
    // With personId + orgId + dealId hints injected, the only call should be
    // the activity create. No searches or new persons/orgs/deals.
    vi.unstubAllGlobals();
    const eventTwoFetch = setupFetch([
      // ensureDealOrg backfills org_id on the pre-existing deal when no
      // appointment stage is configured. It's a single PUT against the deal.
      {
        match: (u, i) => /\/deals\/999(\?|$)/.test(u) && i?.method === 'PUT',
        response: { body: { success: true } },
      },
      {
        match: (u, i) => /\/activities(\?|$)/.test(u) && i?.method === 'POST',
        response: { body: { success: true, data: { id: 778 } } },
      },
    ]);

    const apptResult = await service.dispatchEvent(TENANT, 'appointment.booked', {
      type: 'appointment.booked',
      ...sharedPayload,
      summary: 'Demo booked',
      appointmentDate: '2026-05-01',
      appointmentTime: '14:00',
    });

    expect(apptResult.dispatched).toBe(1);
    expect(apptResult.results[0]).toMatchObject({ provider: 'pipedrive', success: true });

    expect(identityModule.lookupCrmCallerIdentity).toHaveBeenCalledWith(
      TENANT,
      'pipedrive',
      CALLER_PHONE,
    );

    // No second person/org/deal created and no searches needed.
    expect(eventTwoFetch.calls.find((c) => c.url.includes('/persons/search'))).toBeUndefined();
    expect(eventTwoFetch.calls.find((c) => c.url.includes('/organizations/search'))).toBeUndefined();
    expect(eventTwoFetch.calls.find((c) => c.method === 'POST' && /\/persons(\?|$)/.test(c.url))).toBeUndefined();
    expect(eventTwoFetch.calls.find((c) => c.method === 'POST' && /\/organizations(\?|$)/.test(c.url))).toBeUndefined();
    expect(eventTwoFetch.calls.find((c) => c.method === 'POST' && /\/deals(\?|$)/.test(c.url))).toBeUndefined();
    expect(eventTwoFetch.calls.find((c) => c.url.includes('/persons/111/deals'))).toBeUndefined();

    // The activity POST must reference the reused person, org, and deal IDs
    // (numeric, since the Pipedrive adapter coerces hint strings via toNumericId).
    const activityCreate = eventTwoFetch.calls.find(
      (c) => c.method === 'POST' && /\/activities(\?|$)/.test(c.url),
    );
    expect(activityCreate).toBeDefined();
    expect(activityCreate!.body).toMatchObject({
      person_id: 111,
      org_id: 555,
      deal_id: 999,
    });
  });

  test('Salesforce: appointment.booked reuses contactId, accountId, and opportunityId from call.completed (no Lead lookup or conversion)', async () => {
    const INSTANCE_URL = 'https://acme.my.salesforce.com';
    const config: ConnectorConfig = {
      integrationId: 'int-sf-1',
      tenantId: TENANT,
      connectorType: 'crm',
      provider: 'salesforce',
      isEnabled: true,
      credentials: {
        access_token: 'tok-sf',
        instance_url: INSTANCE_URL,
        // Far in the future under the fake clock so ensureSalesforceAccessToken
        // skips the OAuth refresh round-trip.
        token_expires_at: String(Date.now() + 60 * 60 * 1000),
      },
    };
    vi.mocked(connectorDb.listEnabledConnectorConfigs).mockResolvedValue([config]);

    // ---- Event 1: call.completed (qualified=true) ----
    // Phone search misses on Contact and Lead -> createLead pre-creates the
    // Account (search miss + POST) then creates the Lead. qualified=true
    // triggers Lead -> Contact + Account + Opportunity conversion. The reused
    // Account search resolves to the just-created Account (no second POST).
    // The summary triggers a ContentNote + ContentDocumentLink pair.
    const eventOneFetch = setupFetch([
      {
        match: (u) => u.includes('/services/data/v60.0/query?q=') && u.includes('FROM%20Contact'),
        response: { body: { totalSize: 0, records: [] } },
      },
      {
        match: (u) => u.includes('/services/data/v60.0/query?q=') && u.includes('FROM%20Lead'),
        response: { body: { totalSize: 0, records: [] } },
      },
      // First Account search (createLead pre-create): empty.
      {
        match: (u) => u.includes('/services/data/v60.0/query?q=') && u.includes('FROM%20Account'),
        response: { body: { totalSize: 0, records: [] } },
        times: 1,
      },
      // Second Account search (reuseAccountId resolution): finds the Account
      // created moments earlier so we don't double-create it.
      {
        match: (u) => u.includes('/services/data/v60.0/query?q=') && u.includes('FROM%20Account'),
        response: { body: { totalSize: 1, records: [{ Id: '001ACC0000000001' }] } },
      },
      {
        match: (u, i) => u.endsWith('/sobjects/Account') && i?.method === 'POST',
        response: { body: { id: '001ACC0000000001' } },
      },
      {
        match: (u, i) => u.endsWith('/sobjects/Lead') && i?.method === 'POST',
        response: { body: { id: '00QLEAD000000001' } },
      },
      {
        match: (u, i) => u.endsWith('/sobjects/LeadConvert/') && i?.method === 'POST',
        response: {
          body: {
            success: true,
            leadId: '00QLEAD000000001',
            contactId: '003CONT000000001',
            accountId: '001ACC0000000001',
            opportunityId: '006OPP0000000001',
          },
        },
      },
      {
        match: (u, i) => u.endsWith('/sobjects/Task') && i?.method === 'POST',
        response: { body: { id: '00TTASK000000001' } },
      },
      {
        match: (u, i) => u.endsWith('/sobjects/ContentNote') && i?.method === 'POST',
        response: { body: { id: 'CN0000000000001' } },
      },
      {
        match: (u, i) => u.endsWith('/sobjects/ContentDocumentLink') && i?.method === 'POST',
        response: { body: { id: 'CDL000000000001' } },
      },
    ]);

    const service = new ConnectorService();
    const sharedPayload = {
      callerPhone: CALLER_PHONE,
      callerFirstName: 'Jane',
      callerLastName: 'Doe',
      callerCompany: 'Acme Inc',
    };

    const callResult = await service.dispatchEvent(TENANT, 'call.completed', {
      type: 'call.completed',
      ...sharedPayload,
      qualified: true,
      summary: 'AI voice call',
      durationSeconds: 120,
      callSid: 'CA-3',
    });

    expect(callResult.dispatched).toBe(1);
    expect(callResult.results[0]).toMatchObject({ provider: 'salesforce', success: true });

    // Sanity: event 1 actually created the Lead and ran the conversion.
    expect(eventOneFetch.calls.find((c) => c.method === 'POST' && c.url.endsWith('/sobjects/Lead'))).toBeDefined();
    expect(eventOneFetch.calls.find((c) => c.method === 'POST' && c.url.endsWith('/sobjects/LeadConvert/'))).toBeDefined();

    // The dispatch layer should have persisted all three IDs from meta into
    // the canonical Salesforce-style slots used by the cache.
    expect(identityModule.upsertCrmCallerIdentity).toHaveBeenCalledWith(
      TENANT,
      'salesforce',
      CALLER_PHONE,
      expect.objectContaining({
        contactId: '003CONT000000001',
        accountId: '001ACC0000000001',
        opportunityId: '006OPP0000000001',
      }),
    );

    // ---- Event 2: appointment.booked ----
    // With contactId + accountId + opportunityId hints injected by the
    // dispatch layer, the adapter must skip the phone lookup, the Lead /
    // Contact / Account creates, AND the Lead conversion code path entirely.
    // The only writes are the Task plus its ContentNote attachment.
    vi.unstubAllGlobals();
    const eventTwoFetch = setupFetch([
      {
        match: (u, i) => u.endsWith('/sobjects/Task') && i?.method === 'POST',
        response: { body: { id: '00TTASK000000002' } },
      },
      {
        match: (u, i) => u.endsWith('/sobjects/ContentNote') && i?.method === 'POST',
        response: { body: { id: 'CN0000000000002' } },
      },
      {
        match: (u, i) => u.endsWith('/sobjects/ContentDocumentLink') && i?.method === 'POST',
        response: { body: { id: 'CDL000000000002' } },
      },
    ]);

    const apptResult = await service.dispatchEvent(TENANT, 'appointment.booked', {
      type: 'appointment.booked',
      ...sharedPayload,
      summary: 'Demo booked',
      appointmentDate: '2026-05-01',
      appointmentTime: '14:00',
    });

    expect(apptResult.dispatched).toBe(1);
    expect(apptResult.results[0]).toMatchObject({ provider: 'salesforce', success: true });

    // The dispatch layer must have looked up the cached identity for event 2.
    expect(identityModule.lookupCrmCallerIdentity).toHaveBeenCalledWith(
      TENANT,
      'salesforce',
      CALLER_PHONE,
    );

    // No phone search on Contact or Lead - contactId hint short-circuits
    // findOrCreateLeadOrContact before it queries.
    expect(eventTwoFetch.calls.find((c) => c.url.includes('FROM%20Contact'))).toBeUndefined();
    expect(eventTwoFetch.calls.find((c) => c.url.includes('FROM%20Lead'))).toBeUndefined();
    // No Lead conversion - who.object is 'Contact' (from the hint), not 'Lead'.
    expect(eventTwoFetch.calls.find((c) => c.url.endsWith('/sobjects/LeadConvert/'))).toBeUndefined();
    // No new Lead, Contact, or Account writes.
    expect(eventTwoFetch.calls.find((c) => c.method === 'POST' && c.url.endsWith('/sobjects/Lead'))).toBeUndefined();
    expect(eventTwoFetch.calls.find((c) => c.method === 'POST' && c.url.endsWith('/sobjects/Contact'))).toBeUndefined();
    expect(eventTwoFetch.calls.find((c) => c.method === 'POST' && c.url.endsWith('/sobjects/Account'))).toBeUndefined();
    // No open-opportunity SOQL - opportunityId hint short-circuits resolveWhatId.
    expect(eventTwoFetch.calls.find((c) => c.url.includes('OpportunityContactRole'))).toBeUndefined();

    // The Task POST must reference the cached contact via WhoId and the
    // cached opportunity via WhatId - i.e. the IDs really did flow through.
    const taskCreate = eventTwoFetch.calls.find(
      (c) => c.method === 'POST' && c.url.endsWith('/sobjects/Task'),
    );
    expect(taskCreate).toBeDefined();
    expect(taskCreate!.body).toMatchObject({
      WhoId: '003CONT000000001',
      WhatId: '006OPP0000000001',
    });

    // The ContentDocumentLink for the appointment summary must attach to the
    // Task we just created (not to a stale/old one).
    const linkCreate = eventTwoFetch.calls.find(
      (c) => c.method === 'POST' && c.url.endsWith('/sobjects/ContentDocumentLink'),
    );
    expect(linkCreate).toBeDefined();
    expect(linkCreate!.body).toMatchObject({
      LinkedEntityId: '00TTASK000000002',
      ContentDocumentId: 'CN0000000000002',
    });
  });
});
