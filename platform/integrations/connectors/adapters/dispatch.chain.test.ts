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
    // In-memory mirror of the real DB scrub: value-match the supplied stale
    // IDs against the canonical columns AND every value inside `extras`,
    // null/strip the matches, and delete the row entirely if nothing
    // identifying remains. Mirrors the SQL-side semantics in the real impl.
    clearCrmCallerIdentity: vi.fn(async (
      tenantId: string,
      provider: string,
      phone: string,
      stale?: Record<string, string>,
    ) => {
      const norm = actual.normalizeCallerPhone(phone);
      if (!norm) return;
      const key = `${tenantId}:${provider}:${norm}`;
      if (stale === undefined) {
        store.delete(key);
        return;
      }
      const row = store.get(key);
      if (!row) return;
      const staleValues = new Set(Object.values(stale).filter((v) => typeof v === 'string' && v));
      if (staleValues.size === 0) return;
      const next: StoredIdentity = {
        contactId: row.contactId && staleValues.has(row.contactId) ? undefined : row.contactId,
        accountId: row.accountId && staleValues.has(row.accountId) ? undefined : row.accountId,
        opportunityId: row.opportunityId && staleValues.has(row.opportunityId) ? undefined : row.opportunityId,
      };
      if (row.extras) {
        const filteredExtras: Record<string, string> = {};
        for (const [k, v] of Object.entries(row.extras)) {
          if (!staleValues.has(v)) filteredExtras[k] = v;
        }
        if (Object.keys(filteredExtras).length > 0) next.extras = filteredExtras;
      }
      const empty = !next.contactId && !next.accountId && !next.opportunityId
        && (!next.extras || Object.keys(next.extras).length === 0);
      if (empty) store.delete(key);
      else store.set(key, next);
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

  test('Salesforce: stale cached contactId triggers cache invalidation, and the next event re-runs lookup', async () => {
    const INSTANCE_URL = 'https://acme.my.salesforce.com';
    const config: ConnectorConfig = {
      integrationId: 'int-sf-stale',
      tenantId: TENANT,
      connectorType: 'crm',
      provider: 'salesforce',
      isEnabled: true,
      credentials: {
        access_token: 'tok-sf',
        instance_url: INSTANCE_URL,
        token_expires_at: String(Date.now() + 60 * 60 * 1000),
      },
    };
    vi.mocked(connectorDb.listEnabledConnectorConfigs).mockResolvedValue([config]);

    // Pre-seed the in-memory cache directly so we don't have to run a full
    // Lead conversion just to populate it. This represents a contact that was
    // valid yesterday but has since been deleted in Salesforce.
    const store = (identityModule as unknown as { __store: Map<string, StoredIdentity> }).__store;
    const normPhone = identityModule.normalizeCallerPhone(CALLER_PHONE)!;
    store.set(`${TENANT}:salesforce:${normPhone}`, {
      contactId: '003ZOMBIE0000001',
      accountId: '001ACC0000000099',
      opportunityId: '006OPP0000000099',
    });

    // ---- Event: appointment.booked, with cache hit injecting all three IDs ----
    // No phone search runs (contactId hint short-circuits it). The Task POST
    // is rejected by Salesforce with ENTITY_IS_DELETED naming the stale
    // Contact. The adapter must surface this via meta.staleIds and the
    // dispatch layer must scrub the cached row.
    const fetchScope = setupFetch([
      {
        match: (u, i) => u.endsWith('/sobjects/Task') && i?.method === 'POST',
        response: {
          // Salesforce surfaces the offending field via `fields` so we can
          // narrow the cache scrub to just the stale Contact instead of
          // wiping the still-valid Account/Opportunity slots too.
          status: 400,
          body: [{
            errorCode: 'ENTITY_IS_DELETED',
            message: 'entity is deleted',
            fields: ['WhoId'],
          }],
        },
      },
    ]);

    const service = new ConnectorService();
    const apptResult = await service.dispatchEvent(TENANT, 'appointment.booked', {
      type: 'appointment.booked',
      callerPhone: CALLER_PHONE,
      callerFirstName: 'Jane',
      callerLastName: 'Doe',
      callerCompany: 'Acme Inc',
      summary: 'Demo booked',
      appointmentDate: '2026-05-01',
      appointmentTime: '14:00',
    });

    // The dispatch reports failure (not a silent success) so retries/alerts
    // can fire upstream. The aggregated `dispatchEvent` shape intentionally
    // doesn't expose `meta` — observability of staleIds happens through the
    // cache-clear spy below, plus the structured INFO log emitted inside
    // maybeInvalidateCrmIdentity.
    expect(apptResult.dispatched).toBe(1);
    const result = apptResult.results[0];
    expect(result).toMatchObject({ provider: 'salesforce', success: false });

    // The Task create really was attempted with the stale WhoId — proving
    // the hint flowed all the way through to the HTTP layer.
    const taskCreate = fetchScope.calls.find(
      (c) => c.method === 'POST' && c.url.endsWith('/sobjects/Task'),
    );
    expect(taskCreate).toBeDefined();
    expect(taskCreate!.body).toMatchObject({ WhoId: '003ZOMBIE0000001' });

    // The dispatch layer must have invoked the cache-clear path with the
    // exact stale IDs the adapter surfaced.
    expect(identityModule.clearCrmCallerIdentity).toHaveBeenCalledWith(
      TENANT,
      'salesforce',
      CALLER_PHONE,
      expect.objectContaining({ contactId: '003ZOMBIE0000001' }),
    );

    // The store row must have the stale contactId scrubbed but the still-
    // valid accountId and opportunityId preserved (so we don't lose more
    // cache than necessary).
    const after = store.get(`${TENANT}:salesforce:${normPhone}`);
    expect(after).toBeDefined();
    expect(after!.contactId).toBeUndefined();
    expect(after!.accountId).toBe('001ACC0000000099');
    expect(after!.opportunityId).toBe('006OPP0000000099');
  });

  test('Salesforce: stale cached opportunityId on WhatId triggers targeted invalidation and preserves contactId/accountId', async () => {
    const INSTANCE_URL = 'https://acme.my.salesforce.com';
    const config: ConnectorConfig = {
      integrationId: 'int-sf-stale-what',
      tenantId: TENANT,
      connectorType: 'crm',
      provider: 'salesforce',
      isEnabled: true,
      credentials: {
        access_token: 'tok-sf',
        instance_url: INSTANCE_URL,
        token_expires_at: String(Date.now() + 60 * 60 * 1000),
      },
    };
    vi.mocked(connectorDb.listEnabledConnectorConfigs).mockResolvedValue([config]);

    const store = (identityModule as unknown as { __store: Map<string, StoredIdentity> }).__store;
    const normPhone = identityModule.normalizeCallerPhone(CALLER_PHONE)!;
    store.set(`${TENANT}:salesforce:${normPhone}`, {
      contactId: '003LIVECONT00001',
      accountId: '001LIVEACC000001',
      opportunityId: '006ZOMBIEOPP0001',
    });

    // Salesforce reports the stale reference is the WhatId (the cached
    // opportunity). The Contact + Account slots must NOT be touched.
    const fetchScope = setupFetch([
      {
        match: (u, i) => u.endsWith('/sobjects/Task') && i?.method === 'POST',
        response: {
          status: 400,
          body: [{
            errorCode: 'INVALID_CROSS_REFERENCE_KEY',
            message: 'invalid cross reference id',
            fields: ['WhatId'],
          }],
        },
      },
    ]);

    const service = new ConnectorService();
    const apptResult = await service.dispatchEvent(TENANT, 'appointment.booked', {
      type: 'appointment.booked',
      callerPhone: CALLER_PHONE,
      callerFirstName: 'Jane',
      callerLastName: 'Doe',
      callerCompany: 'Acme Inc',
      summary: 'Demo booked',
      appointmentDate: '2026-05-01',
      appointmentTime: '14:00',
    });

    expect(apptResult.dispatched).toBe(1);
    expect(apptResult.results[0]).toMatchObject({ provider: 'salesforce', success: false });

    // Sanity: the Task POST really did try to use the stale WhatId.
    const taskCreate = fetchScope.calls.find(
      (c) => c.method === 'POST' && c.url.endsWith('/sobjects/Task'),
    );
    expect(taskCreate).toBeDefined();
    expect(taskCreate!.body).toMatchObject({ WhatId: '006ZOMBIEOPP0001' });

    // The dispatch layer scrubs only the opportunityId (not contactId or
    // accountId), because Salesforce told us WhatId was the bad field and
    // a 006-prefix ID classifies as Opportunity.
    expect(identityModule.clearCrmCallerIdentity).toHaveBeenCalledWith(
      TENANT,
      'salesforce',
      CALLER_PHONE,
      expect.objectContaining({ opportunityId: '006ZOMBIEOPP0001' }),
    );
    const lastCallArgs = vi.mocked(identityModule.clearCrmCallerIdentity).mock.calls.at(-1)!;
    const passedStale = lastCallArgs[3] as Record<string, string> | undefined;
    expect(passedStale?.contactId).toBeUndefined();
    expect(passedStale?.accountId).toBeUndefined();

    const after = store.get(`${TENANT}:salesforce:${normPhone}`);
    expect(after).toBeDefined();
    expect(after!.opportunityId).toBeUndefined();
    expect(after!.contactId).toBe('003LIVECONT00001');
    expect(after!.accountId).toBe('001LIVEACC000001');
  });

  test('Salesforce: a 404 with a non-stale errorCode (e.g. INVALID_TYPE / misroute) must NOT clear the CRM caller identity cache', async () => {
    const INSTANCE_URL = 'https://acme.my.salesforce.com';
    const config: ConnectorConfig = {
      integrationId: 'int-sf-misroute',
      tenantId: TENANT,
      connectorType: 'crm',
      provider: 'salesforce',
      isEnabled: true,
      credentials: {
        access_token: 'tok-sf',
        instance_url: INSTANCE_URL,
        token_expires_at: String(Date.now() + 60 * 60 * 1000),
      },
    };
    vi.mocked(connectorDb.listEnabledConnectorConfigs).mockResolvedValue([config]);

    // Pre-seed a still-valid identity cache row.
    const store = (identityModule as unknown as { __store: Map<string, StoredIdentity> }).__store;
    const normPhone = identityModule.normalizeCallerPhone(CALLER_PHONE)!;
    store.set(`${TENANT}:salesforce:${normPhone}`, {
      contactId: '003LIVE000000001',
      accountId: '001LIVE000000001',
      opportunityId: '006LIVE000000001',
    });

    // Simulate a 404 that is NOT a stale-record signal — e.g. a typo'd
    // sobject name returns 404 INVALID_TYPE, or a Salesforce config-level
    // routing error. This is the false-positive case the reviewer flagged:
    // we MUST NOT scrub the cache just because the HTTP status was 404.
    setupFetch([
      {
        match: (u, i) => u.endsWith('/sobjects/Task') && i?.method === 'POST',
        response: {
          status: 404,
          body: [{
            errorCode: 'INVALID_TYPE',
            message: "sObject type 'Task' is not supported.",
          }],
        },
      },
    ]);

    const service = new ConnectorService();
    const result = await service.dispatchEvent(TENANT, 'appointment.booked', {
      type: 'appointment.booked',
      callerPhone: CALLER_PHONE,
      callerFirstName: 'Jane',
      callerLastName: 'Doe',
      callerCompany: 'Acme Inc',
      summary: 'Demo booked',
      appointmentDate: '2026-05-01',
      appointmentTime: '14:00',
    });

    expect(result.dispatched).toBe(1);
    expect(result.results[0]).toMatchObject({ provider: 'salesforce', success: false });
    // Critical: a 404 with a non-stale errorCode must not look like a stale
    // record, so the cache scrub MUST NOT have run.
    expect(identityModule.clearCrmCallerIdentity).not.toHaveBeenCalled();
    const after = store.get(`${TENANT}:salesforce:${normPhone}`);
    expect(after).toMatchObject({
      contactId: '003LIVE000000001',
      accountId: '001LIVE000000001',
      opportunityId: '006LIVE000000001',
    });
  });

  test('HubSpot: a non-stale failure (e.g. rate limit) must NOT clear the CRM caller identity cache', async () => {
    const config: ConnectorConfig = {
      integrationId: 'int-hs-no-clear',
      tenantId: TENANT,
      connectorType: 'crm',
      provider: 'hubspot',
      isEnabled: true,
      credentials: { access_token: 'tok-hs' },
    };
    vi.mocked(connectorDb.listEnabledConnectorConfigs).mockResolvedValue([config]);

    // Pre-seed a HubSpot-shaped cached identity.
    const store = (identityModule as unknown as { __store: Map<string, StoredIdentity> }).__store;
    const normPhone = identityModule.normalizeCallerPhone(CALLER_PHONE)!;
    store.set(`${TENANT}:hubspot:${normPhone}`, {
      contactId: 'hs-contact-keep',
      accountId: 'hs-company-keep',
      extras: { contactId: 'hs-contact-keep', companyId: 'hs-company-keep' },
    });

    // Make the very first HubSpot call fail with a 429. No staleIds, so the
    // dispatch layer must NOT touch the cache.
    setupFetch([
      {
        match: () => true,
        response: { status: 429, body: { message: 'rate limited' } },
      },
    ]);

    const service = new ConnectorService();
    const result = await service.dispatchEvent(TENANT, 'appointment.booked', {
      type: 'appointment.booked',
      callerPhone: CALLER_PHONE,
      callerFirstName: 'Jane',
      callerLastName: 'Doe',
      callerCompany: 'Acme Inc',
      summary: 'Demo booked',
      appointmentDate: '2026-05-01',
      appointmentTime: '14:00',
    });

    expect(result.dispatched).toBe(1);
    expect(result.results[0]).toMatchObject({ provider: 'hubspot', success: false });
    // Crucial: the cache scrub must NOT have run.
    expect(identityModule.clearCrmCallerIdentity).not.toHaveBeenCalled();
    // And the cached row is still intact.
    const after = store.get(`${TENANT}:hubspot:${normPhone}`);
    expect(after).toMatchObject({
      contactId: 'hs-contact-keep',
      accountId: 'hs-company-keep',
    });
  });

  test('HubSpot: stale cached dealId triggers targeted cache invalidation while preserving valid contactId/companyId', async () => {
    const config: ConnectorConfig = {
      integrationId: 'int-hs-stale-deal',
      tenantId: TENANT,
      connectorType: 'crm',
      provider: 'hubspot',
      isEnabled: true,
      credentials: {
        access_token: 'tok-hs',
        // Configured appointment stage forces handleAppointmentBooked into
        // the moveDealStage path (PATCH /crm/v3/objects/deals/{dealId}),
        // which is what we want to fail with OBJECT_NOT_FOUND.
        appointment_stage_id: 'stage-appt',
        appointment_pipeline_id: 'pipeline-default',
      },
    };
    vi.mocked(connectorDb.listEnabledConnectorConfigs).mockResolvedValue([config]);

    // Pre-seed a HubSpot cache row with a deal that has since been deleted
    // upstream. The contact and company are still valid and must NOT be
    // scrubbed. We mirror the real DB shape: canonical Salesforce-style slot
    // names (contactId / accountId / opportunityId) plus the HubSpot-native
    // names (contactId / companyId / dealId) round-tripped via `extras`.
    const store = (identityModule as unknown as { __store: Map<string, StoredIdentity> }).__store;
    const normPhone = identityModule.normalizeCallerPhone(CALLER_PHONE)!;
    store.set(`${TENANT}:hubspot:${normPhone}`, {
      contactId: 'hs-contact-keep',
      accountId: 'hs-company-keep',
      opportunityId: 'hs-deal-zombie',
      extras: {
        contactId: 'hs-contact-keep',
        companyId: 'hs-company-keep',
        dealId: 'hs-deal-zombie',
      },
    });

    // The hint chain pre-populates contact/company/deal so the only HubSpot
    // call we need to mock for handleAppointmentBooked is the deal stage
    // PATCH (which 404s) and any subsequent association/note/engagement
    // calls if the adapter still attempts them after the throw.
    const fetchScope = setupFetch([
      {
        match: (u, i) => /\/crm\/v3\/objects\/deals\/hs-deal-zombie(\?|$)/.test(u) && i?.method === 'PATCH',
        response: {
          status: 404,
          body: {
            status: 'error',
            message: 'resource not found',
            category: 'OBJECT_NOT_FOUND',
          },
        },
      },
    ]);

    const service = new ConnectorService();
    const apptResult = await service.dispatchEvent(TENANT, 'appointment.booked', {
      type: 'appointment.booked',
      callerPhone: CALLER_PHONE,
      callerFirstName: 'Jane',
      callerLastName: 'Doe',
      callerCompany: 'Acme Inc',
      summary: 'Demo booked',
      appointmentDate: '2026-05-01',
      appointmentTime: '14:00',
    });

    expect(apptResult.dispatched).toBe(1);
    expect(apptResult.results[0]).toMatchObject({ provider: 'hubspot', success: false });

    // Sanity: the deal stage move really did target the stale dealId, proving
    // the cache hint flowed end-to-end into the HTTP layer.
    const dealPatch = fetchScope.calls.find(
      (c) => c.method === 'PATCH' && /\/crm\/v3\/objects\/deals\/hs-deal-zombie/.test(c.url),
    );
    expect(dealPatch).toBeDefined();

    // The dispatch layer scrubbed the cache using the HubSpot-native dealId
    // key the adapter surfaced (NOT the canonical opportunityId remap).
    expect(identityModule.clearCrmCallerIdentity).toHaveBeenCalledWith(
      TENANT,
      'hubspot',
      CALLER_PHONE,
      expect.objectContaining({ dealId: 'hs-deal-zombie' }),
    );
    const lastCall = vi.mocked(identityModule.clearCrmCallerIdentity).mock.calls.at(-1)!;
    const passedStale = lastCall[3] as Record<string, string> | undefined;
    expect(passedStale?.contactId).toBeUndefined();
    expect(passedStale?.companyId).toBeUndefined();

    // Targeted scrub: the canonical opportunityId column AND the
    // extras.dealId entry must both be cleared (value-match), while the
    // still-valid contact and company slots are preserved.
    const after = store.get(`${TENANT}:hubspot:${normPhone}`);
    expect(after).toBeDefined();
    expect(after!.opportunityId).toBeUndefined();
    expect(after!.contactId).toBe('hs-contact-keep');
    expect(after!.accountId).toBe('hs-company-keep');
    expect(after!.extras).toEqual({
      contactId: 'hs-contact-keep',
      companyId: 'hs-company-keep',
    });
  });

  test('Pipedrive: stale cached dealId triggers targeted cache invalidation while preserving valid personId', async () => {
    const config: ConnectorConfig = {
      integrationId: 'int-pd-stale-deal',
      tenantId: TENANT,
      connectorType: 'crm',
      provider: 'pipedrive',
      isEnabled: true,
      credentials: {
        access_token: 'tok-pd',
        company_domain: 'acmedomain',
        // Configured appointment stage forces handleAppointmentBooked into
        // the moveDealStage path (PUT /deals/{dealId}), which is what we
        // want to fail with a Pipedrive "deal not found" 404.
        appointment_stage_id: '42',
      },
    };
    vi.mocked(connectorDb.listEnabledConnectorConfigs).mockResolvedValue([config]);

    // Pre-seed a Pipedrive cache row with a deal that has since been deleted
    // upstream. The person is still valid. We deliberately omit the org so
    // that moveDealStage's PUT body has only `stage_id` (no `org_id`) — the
    // only Pipedrive call path that targets a single ID unambiguously, which
    // lets the adapter flag *only* `dealId` as stale (and therefore only
    // scrub `dealId`, leaving `personId` untouched).
    const store = (identityModule as unknown as { __store: Map<string, StoredIdentity> }).__store;
    const normPhone = identityModule.normalizeCallerPhone(CALLER_PHONE)!;
    store.set(`${TENANT}:pipedrive:${normPhone}`, {
      contactId: '111',
      opportunityId: '999',
      extras: {
        personId: '111',
        dealId: '999',
      },
    });

    // No callerCompany on the inbound payload → the adapter doesn't try to
    // resolve an organization, so moveDealStage is invoked with orgId=undefined.
    const fetchScope = setupFetch([
      {
        match: (u, i) => /\/deals\/999(\?|$)/.test(u) && i?.method === 'PUT',
        response: {
          status: 404,
          body: { success: false, error: 'Deal not found', error_info: 'Please check your input' },
        },
      },
    ]);

    const service = new ConnectorService();
    const apptResult = await service.dispatchEvent(TENANT, 'appointment.booked', {
      type: 'appointment.booked',
      callerPhone: CALLER_PHONE,
      callerFirstName: 'Jane',
      callerLastName: 'Doe',
      summary: 'Demo booked',
      appointmentDate: '2026-05-01',
      appointmentTime: '14:00',
    });

    expect(apptResult.dispatched).toBe(1);
    expect(apptResult.results[0]).toMatchObject({ provider: 'pipedrive', success: false });

    // Sanity: the deal stage move really did target the stale dealId.
    const dealPut = fetchScope.calls.find(
      (c) => c.method === 'PUT' && /\/deals\/999/.test(c.url),
    );
    expect(dealPut).toBeDefined();
    // And the body did NOT include org_id (proves our pure-dealId path).
    expect(dealPut!.body).not.toHaveProperty('org_id');

    // The dispatch layer scrubbed the cache using the Pipedrive-native dealId
    // key the adapter surfaced. Crucially, no other native key was passed —
    // so the value-match scrub can't accidentally clear personId/orgId.
    expect(identityModule.clearCrmCallerIdentity).toHaveBeenCalledWith(
      TENANT,
      'pipedrive',
      CALLER_PHONE,
      expect.objectContaining({ dealId: '999' }),
    );
    const lastCall = vi.mocked(identityModule.clearCrmCallerIdentity).mock.calls.at(-1)!;
    const passedStale = lastCall[3] as Record<string, string> | undefined;
    expect(passedStale?.personId).toBeUndefined();
    expect(passedStale?.orgId).toBeUndefined();

    // Targeted scrub: opportunityId column + extras.dealId cleared (value-match),
    // still-valid person preserved.
    const after = store.get(`${TENANT}:pipedrive:${normPhone}`);
    expect(after).toBeDefined();
    expect(after!.opportunityId).toBeUndefined();
    expect(after!.contactId).toBe('111');
    expect(after!.extras).toEqual({
      personId: '111',
    });
  });

  test('HubSpot: stale cached contactId triggers targeted cache invalidation while preserving valid companyId/dealId', async () => {
    const config: ConnectorConfig = {
      integrationId: 'int-hs-stale-contact',
      tenantId: TENANT,
      connectorType: 'crm',
      provider: 'hubspot',
      isEnabled: true,
      credentials: { access_token: 'tok-hs' },
    };
    vi.mocked(connectorDb.listEnabledConnectorConfigs).mockResolvedValue([config]);

    // Pre-seed cache: contactId is the stale one, company + deal are still
    // valid in HubSpot. We use call.completed because handleCallCompleted's
    // logCallEngagement POSTs the call engagement with ONLY contactId in its
    // associations array — that's the single path-targeted-by-contactId-only
    // signal in the HubSpot adapter, so a 404/OBJECT_NOT_FOUND there cleanly
    // identifies contactId (and only contactId) as the stale record.
    const store = (identityModule as unknown as { __store: Map<string, StoredIdentity> }).__store;
    const normPhone = identityModule.normalizeCallerPhone(CALLER_PHONE)!;
    store.set(`${TENANT}:hubspot:${normPhone}`, {
      contactId: 'hs-contact-zombie',
      accountId: 'hs-company-keep',
      opportunityId: 'hs-deal-keep',
      extras: {
        contactId: 'hs-contact-zombie',
        companyId: 'hs-company-keep',
        dealId: 'hs-deal-keep',
      },
    });

    // No callerCompany on the inbound payload → handleCallCompleted skips
    // findOrCreateCompany AND the contacts→companies association, so the
    // only HubSpot call is the call-engagement POST that fails.
    const fetchScope = setupFetch([
      {
        match: (u, i) => /\/crm\/v3\/objects\/calls(\?|$)/.test(u) && i?.method === 'POST',
        response: {
          status: 404,
          body: {
            status: 'error',
            message: 'resource not found',
            category: 'OBJECT_NOT_FOUND',
          },
        },
      },
    ]);

    const service = new ConnectorService();
    const callResult = await service.dispatchEvent(TENANT, 'call.completed', {
      type: 'call.completed',
      callerPhone: CALLER_PHONE,
      callerFirstName: 'Jane',
      callerLastName: 'Doe',
      summary: 'AI voice call',
      durationSeconds: 60,
      callSid: 'CA-stale-contact',
    });

    expect(callResult.dispatched).toBe(1);
    expect(callResult.results[0]).toMatchObject({ provider: 'hubspot', success: false });

    // Sanity: the engagement POST really did reference the stale contactId.
    const engagementPost = fetchScope.calls.find(
      (c) => c.method === 'POST' && /\/crm\/v3\/objects\/calls/.test(c.url),
    );
    expect(engagementPost).toBeDefined();
    const associations = (engagementPost!.body as { associations?: Array<{ to?: { id: string } }> }).associations;
    expect(associations?.[0]?.to?.id).toBe('hs-contact-zombie');

    // The dispatch layer scrubbed the cache using the HubSpot-native contactId
    // key the adapter surfaced — and only that key (no companyId or dealId).
    expect(identityModule.clearCrmCallerIdentity).toHaveBeenCalledWith(
      TENANT,
      'hubspot',
      CALLER_PHONE,
      expect.objectContaining({ contactId: 'hs-contact-zombie' }),
    );
    const lastCall = vi.mocked(identityModule.clearCrmCallerIdentity).mock.calls.at(-1)!;
    const passedStale = lastCall[3] as Record<string, string> | undefined;
    expect(passedStale?.companyId).toBeUndefined();
    expect(passedStale?.dealId).toBeUndefined();

    // Targeted scrub: contactId column + extras.contactId cleared (value-match),
    // still-valid company and deal slots preserved.
    const after = store.get(`${TENANT}:hubspot:${normPhone}`);
    expect(after).toBeDefined();
    expect(after!.contactId).toBeUndefined();
    expect(after!.accountId).toBe('hs-company-keep');
    expect(after!.opportunityId).toBe('hs-deal-keep');
    expect(after!.extras).toEqual({
      companyId: 'hs-company-keep',
      dealId: 'hs-deal-keep',
    });
  });

  test('Pipedrive: stale cached personId triggers targeted cache invalidation while preserving valid orgId', async () => {
    const config: ConnectorConfig = {
      integrationId: 'int-pd-stale-person',
      tenantId: TENANT,
      connectorType: 'crm',
      provider: 'pipedrive',
      isEnabled: true,
      credentials: { access_token: 'tok-pd', company_domain: 'acmedomain' },
    };
    vi.mocked(connectorDb.listEnabledConnectorConfigs).mockResolvedValue([config]);

    // Pre-seed cache: personId is stale, orgId is still valid. No dealId so
    // findOpenDealForPerson is invoked — that's the single path-targeted-by-
    // personId-only signal in the Pipedrive adapter. The 404 there cleanly
    // identifies personId (and only personId) as the stale record.
    const store = (identityModule as unknown as { __store: Map<string, StoredIdentity> }).__store;
    const normPhone = identityModule.normalizeCallerPhone(CALLER_PHONE)!;
    store.set(`${TENANT}:pipedrive:${normPhone}`, {
      contactId: '111',
      accountId: '555',
      extras: {
        personId: '111',
        orgId: '555',
      },
    });

    // call.completed flow: with personId + orgId hints injected, the adapter
    // skips findOrCreatePerson + findOrCreateOrganization, then attempts
    // findOpenDealForPerson(111) which returns a Pipedrive "person not found"
    // 404 envelope.
    const fetchScope = setupFetch([
      {
        match: (u) => /\/persons\/111\/deals/.test(u),
        response: {
          status: 404,
          body: { success: false, error: 'Person not found' },
        },
      },
    ]);

    const service = new ConnectorService();
    const callResult = await service.dispatchEvent(TENANT, 'call.completed', {
      type: 'call.completed',
      callerPhone: CALLER_PHONE,
      callerFirstName: 'Jane',
      callerLastName: 'Doe',
      summary: 'AI voice call',
      durationSeconds: 60,
      callSid: 'CA-stale-person',
    });

    expect(callResult.dispatched).toBe(1);
    expect(callResult.results[0]).toMatchObject({ provider: 'pipedrive', success: false });

    // Sanity: findOpenDealForPerson really did target the stale personId.
    const personDealsLookup = fetchScope.calls.find((c) => /\/persons\/111\/deals/.test(c.url));
    expect(personDealsLookup).toBeDefined();

    // The dispatch layer scrubbed the cache using the Pipedrive-native personId
    // key the adapter surfaced — and only that key (no orgId or dealId).
    expect(identityModule.clearCrmCallerIdentity).toHaveBeenCalledWith(
      TENANT,
      'pipedrive',
      CALLER_PHONE,
      expect.objectContaining({ personId: '111' }),
    );
    const lastCall = vi.mocked(identityModule.clearCrmCallerIdentity).mock.calls.at(-1)!;
    const passedStale = lastCall[3] as Record<string, string> | undefined;
    expect(passedStale?.orgId).toBeUndefined();
    expect(passedStale?.dealId).toBeUndefined();

    // Targeted scrub: contactId column + extras.personId cleared (value-match),
    // still-valid org slot preserved.
    const after = store.get(`${TENANT}:pipedrive:${normPhone}`);
    expect(after).toBeDefined();
    expect(after!.contactId).toBeUndefined();
    expect(after!.accountId).toBe('555');
    expect(after!.extras).toEqual({
      orgId: '555',
    });
  });

  test('Zoho: stale cached dealId triggers targeted cache invalidation while preserving valid contactId', async () => {
    const config: ConnectorConfig = {
      integrationId: 'int-zoho-stale-deal',
      tenantId: TENANT,
      connectorType: 'crm',
      provider: 'zoho',
      isEnabled: true,
      credentials: {
        access_token: 'tok-zoho',
        // Configured appointment stage forces handleAppointmentBooked into
        // the moveDealStage path (PUT /Deals with body referencing the
        // dealId), which is what we want to fail with Zoho's per-record
        // "id given seems to be invalid" envelope.
        appointment_stage_id: 'Qualification',
      },
    };
    vi.mocked(connectorDb.listEnabledConnectorConfigs).mockResolvedValue([config]);

    // Pre-seed a Zoho cache row with a deal that has since been deleted
    // upstream. The contact is still valid and must NOT be scrubbed. We
    // deliberately omit accountId so the moveDealStage PUT body contains
    // only `{ id, Stage }` (no Account_Name) — the only Zoho path that
    // unambiguously implicates the dealId, which lets the adapter flag
    // *only* `dealId` as stale (and therefore only scrub `dealId`,
    // leaving `contactId` untouched).
    //
    // Zoho's `contactId` field already matches the canonical Salesforce-
    // style slot name, so it lands directly in `contactId`. `dealId` is
    // stored under the canonical `opportunityId` slot per
    // `extractIdentityFromMeta`'s field aliasing.
    const store = (identityModule as unknown as { __store: Map<string, StoredIdentity> }).__store;
    const normPhone = identityModule.normalizeCallerPhone(CALLER_PHONE)!;
    store.set(`${TENANT}:zoho:${normPhone}`, {
      contactId: 'zoho-contact-keep',
      opportunityId: 'zoho-deal-zombie',
    });

    // No callerCompany on the inbound payload → handleAppointmentBooked
    // skips findOrCreateAccount. The pre-existing contactId + dealId hints
    // (via cache injection) skip findOrCreateContact, findOpenDealForContact,
    // and createDealForContact. moveDealStage is invoked with orgId=undefined.
    // Zoho's bulk write API returns 200 with a per-record error envelope
    // when one record fails — INVALID_DATA + "id given seems to be invalid"
    // is the canonical "the referenced record is gone" body shape.
    const fetchScope = setupFetch([
      {
        match: (u, i) => /\/crm\/v2\/Deals(\?|$)/.test(u) && i?.method === 'PUT',
        response: {
          status: 200,
          body: {
            data: [{
              code: 'INVALID_DATA',
              details: { id: 'zoho-deal-zombie' },
              message: 'the id given seems to be invalid',
              status: 'error',
            }],
          },
        },
      },
    ]);

    const service = new ConnectorService();
    const apptResult = await service.dispatchEvent(TENANT, 'appointment.booked', {
      type: 'appointment.booked',
      callerPhone: CALLER_PHONE,
      callerFirstName: 'Jane',
      callerLastName: 'Doe',
      summary: 'Demo booked',
      appointmentDate: '2026-05-01',
      appointmentTime: '14:00',
    });

    expect(apptResult.dispatched).toBe(1);
    expect(apptResult.results[0]).toMatchObject({ provider: 'zoho', success: false });

    // Sanity: the deal stage move really did target the stale dealId, proving
    // the cache hint flowed end-to-end into the HTTP layer.
    const dealPut = fetchScope.calls.find(
      (c) => c.method === 'PUT' && /\/crm\/v2\/Deals/.test(c.url),
    );
    expect(dealPut).toBeDefined();
    // And the body's only data entry references the dealId without any
    // Account_Name — proves our pure-dealId path so the stale signal is
    // unambiguously the dealId.
    const dealPutBody = dealPut!.body as {
      data: Array<{ id: string; Stage: string; Account_Name?: unknown }>;
    };
    expect(dealPutBody.data[0].id).toBe('zoho-deal-zombie');
    expect(dealPutBody.data[0]).not.toHaveProperty('Account_Name');

    // The dispatch layer scrubbed the cache using the Zoho-native dealId
    // key the adapter surfaced — and only that key (no contactId or
    // accountId), so the value-match scrub can't accidentally clear the
    // still-valid contact slot.
    expect(identityModule.clearCrmCallerIdentity).toHaveBeenCalledWith(
      TENANT,
      'zoho',
      CALLER_PHONE,
      expect.objectContaining({ dealId: 'zoho-deal-zombie' }),
    );
    const lastCall = vi.mocked(identityModule.clearCrmCallerIdentity).mock.calls.at(-1)!;
    const passedStale = lastCall[3] as Record<string, string> | undefined;
    expect(passedStale?.contactId).toBeUndefined();
    expect(passedStale?.accountId).toBeUndefined();

    // Targeted scrub: the canonical opportunityId column (where Zoho's
    // dealId lives) is cleared by value-match, while the still-valid
    // contactId slot is preserved verbatim.
    const after = store.get(`${TENANT}:zoho:${normPhone}`);
    expect(after).toBeDefined();
    expect(after!.opportunityId).toBeUndefined();
    expect(after!.contactId).toBe('zoho-contact-keep');
  });
});
