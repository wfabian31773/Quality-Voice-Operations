import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ConnectorConfig } from '../types';
import type { TenantId } from '../../../core/types';

vi.mock('../tokenRefresh', () => ({
  ensureFreshOAuthToken: async (cfg: ConnectorConfig) => cfg,
}));

import { validateHubSpotCachedIdentity } from './hubspot';
import { validateSalesforceCachedIdentity } from './salesforce';
import { validatePipedriveCachedIdentity } from './pipedrive';
import { validateZohoCachedIdentity } from './zoho';

interface FetchExpectation {
  match: (url: string, init?: RequestInit) => boolean;
  response: { status?: number; body?: unknown; text?: string };
}

function setupFetch(expectations: FetchExpectation[]): { calls: Array<{ url: string; method: string }> } {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method });
    const found = expectations.find((e) => e.match(url, init));
    if (!found) throw new Error(`Unexpected fetch: ${method} ${url}`);
    const status = found.response.status ?? 200;
    const body = found.response.text ?? JSON.stringify(found.response.body ?? {});
    return new Response(body, { status });
  }));
  return { calls };
}

const TENANT: TenantId = 'tenant-test' as TenantId;

describe('validateHubSpotCachedIdentity', () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(new Date('2026-04-29T12:00:00Z')));
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  const config: ConnectorConfig = {
    integrationId: 'int', tenantId: TENANT, connectorType: 'crm',
    provider: 'hubspot', isEnabled: true,
    credentials: { access_token: 'tok' },
  };

  test('returns empty stale when all probes succeed', async () => {
    setupFetch([
      { match: (u) => u.includes('/objects/contacts/c1'), response: { body: { id: 'c1' } } },
      { match: (u) => u.includes('/objects/companies/co1'), response: { body: { id: 'co1' } } },
      { match: (u) => u.includes('/objects/deals/d1'), response: { body: { id: 'd1' } } },
    ]);

    const out = await validateHubSpotCachedIdentity(TENANT, config, {
      contactId: 'c1', accountId: 'co1', opportunityId: 'd1',
    });
    expect(out.stale).toEqual({});
  });

  test('flags 404 records as stale under their HubSpot-native field names', async () => {
    setupFetch([
      {
        match: (u) => u.includes('/objects/contacts/c1'),
        response: { status: 404, body: { status: 'error', category: 'OBJECT_NOT_FOUND' } },
      },
      {
        match: (u) => u.includes('/objects/companies/co1'),
        response: { body: { id: 'co1' } },
      },
    ]);

    const out = await validateHubSpotCachedIdentity(TENANT, config, {
      contactId: 'c1', accountId: 'co1',
    });
    expect(out.stale).toEqual({ contactId: 'c1' });
  });

  test('does not flag non-stale 4xx (e.g. validation error)', async () => {
    setupFetch([
      {
        match: (u) => u.includes('/objects/contacts/c1'),
        response: { status: 400, body: { status: 'error', category: 'VALIDATION_ERROR' } },
      },
    ]);

    const out = await validateHubSpotCachedIdentity(TENANT, config, { contactId: 'c1' });
    expect(out.stale).toEqual({});
  });

  test('skips entirely when no IDs are cached', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const out = await validateHubSpotCachedIdentity(TENANT, config, {});
    expect(out.stale).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('prefers extras over canonical slots when both are present', async () => {
    setupFetch([
      {
        match: (u) => u.includes('/objects/contacts/native-c'),
        response: { status: 404, body: { status: 'error', category: 'OBJECT_NOT_FOUND' } },
      },
    ]);

    const out = await validateHubSpotCachedIdentity(TENANT, config, {
      contactId: 'canonical-c',
      extras: { contactId: 'native-c' },
    });
    expect(out.stale).toEqual({ contactId: 'native-c' });
  });
});

describe('validateSalesforceCachedIdentity', () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(new Date('2026-04-29T12:00:00Z')));
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  const config: ConnectorConfig = {
    integrationId: 'int', tenantId: TENANT, connectorType: 'crm',
    provider: 'salesforce', isEnabled: true,
    credentials: { access_token: 'tok', instance_url: 'https://example.my.salesforce.com' },
  };

  test('flags ENTITY_IS_DELETED records as stale and leaves the rest', async () => {
    setupFetch([
      {
        match: (u) => u.includes('/sobjects/Contact/003ABCDEFGHIJKLM'),
        response: { status: 404, body: [{ errorCode: 'ENTITY_IS_DELETED', message: 'gone' }] },
      },
      {
        match: (u) => u.includes('/sobjects/Account/001ABCDEFGHIJKLM'),
        response: { body: { Id: '001ABCDEFGHIJKLM' } },
      },
    ]);

    const out = await validateSalesforceCachedIdentity(TENANT, config, {
      contactId: '003ABCDEFGHIJKLM',
      accountId: '001ABCDEFGHIJKLM',
    });
    expect(out.stale).toEqual({ contactId: '003ABCDEFGHIJKLM' });
  });

  test('skips IDs whose Salesforce key prefix does not match the cached slot', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    // 00Q is a Lead prefix, not a Contact — must be ignored, not probed.
    const out = await validateSalesforceCachedIdentity(TENANT, config, {
      contactId: '00QABCDEFGHIJKLM',
    });
    expect(out.stale).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('does not flag stale on a non-stale 4xx body (e.g. INVALID_FIELD)', async () => {
    setupFetch([
      {
        match: (u) => u.includes('/sobjects/Contact/003ABCDEFGHIJKLM'),
        response: { status: 400, body: [{ errorCode: 'INVALID_FIELD', message: 'oops' }] },
      },
    ]);

    const out = await validateSalesforceCachedIdentity(TENANT, config, {
      contactId: '003ABCDEFGHIJKLM',
    });
    expect(out.stale).toEqual({});
  });
});

describe('validatePipedriveCachedIdentity', () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(new Date('2026-04-29T12:00:00Z')));
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  const config: ConnectorConfig = {
    integrationId: 'int', tenantId: TENANT, connectorType: 'crm',
    provider: 'pipedrive', isEnabled: true,
    credentials: { access_token: 'tok' },
  };

  test('flags 404 / GONE records as stale under Pipedrive-native field names', async () => {
    setupFetch([
      { match: (u) => u.includes('/persons/p1'), response: { status: 404, text: 'not found' } },
      { match: (u) => u.includes('/organizations/o1'), response: { body: { success: true, data: { id: 1 } } } },
      { match: (u) => u.includes('/deals/d1'), response: { status: 410, text: 'gone' } },
    ]);

    const out = await validatePipedriveCachedIdentity(TENANT, config, {
      contactId: 'p1', accountId: 'o1', opportunityId: 'd1',
    });
    expect(out.stale).toEqual({ personId: 'p1', dealId: 'd1' });
  });

  test('returns empty stale when no IDs are cached', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const out = await validatePipedriveCachedIdentity(TENANT, config, {});
    expect(out.stale).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('validateZohoCachedIdentity', () => {
  beforeEach(() => vi.useFakeTimers().setSystemTime(new Date('2026-04-29T12:00:00Z')));
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

  const config: ConnectorConfig = {
    integrationId: 'int', tenantId: TENANT, connectorType: 'crm',
    provider: 'zoho', isEnabled: true,
    credentials: { access_token: 'tok', api_domain: 'https://www.zohoapis.com' },
  };

  test('flags RESOURCE_NOT_FOUND records as stale and leaves the rest', async () => {
    setupFetch([
      {
        match: (u) => u.includes('/Contacts/c1'),
        response: { status: 404, text: '{"code":"RESOURCE_NOT_FOUND","message":"the record is gone"}' },
      },
      {
        match: (u) => u.includes('/Accounts/a1'),
        response: { body: { data: [{ id: 'a1' }] } },
      },
      {
        match: (u) => u.includes('/Deals/d1'),
        response: { status: 404, text: 'plain 404' },
      },
    ]);

    const out = await validateZohoCachedIdentity(TENANT, config, {
      contactId: 'c1', accountId: 'a1', opportunityId: 'd1',
    });
    expect(out.stale).toEqual({ contactId: 'c1', dealId: 'd1' });
  });

  test('does not flag stale when Zoho returns a non-stale code (e.g. OAUTH_SCOPE_MISMATCH)', async () => {
    setupFetch([
      {
        match: (u) => u.includes('/Contacts/c1'),
        response: { status: 401, text: '{"code":"OAUTH_SCOPE_MISMATCH","message":"bad scope"}' },
      },
    ]);

    const out = await validateZohoCachedIdentity(TENANT, config, { contactId: 'c1' });
    expect(out.stale).toEqual({});
  });
});
