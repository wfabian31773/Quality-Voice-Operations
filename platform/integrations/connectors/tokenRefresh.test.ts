import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({
  updateConnectorCredentials: vi.fn().mockResolvedValue(undefined),
  markConnectorReconnectNeeded: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../audit/AuditService', () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import { ensureFreshOAuthToken } from './tokenRefresh';
import { updateConnectorCredentials, markConnectorReconnectNeeded } from './db';
import type { ConnectorConfig } from './types';

const ORIG_FETCH = global.fetch;

function makeConfig(overrides: Partial<ConnectorConfig['credentials']> = {}): ConnectorConfig {
  return {
    tenantId: 'tenant-zoho',
    integrationId: 'integration-zoho',
    type: 'crm',
    provider: 'zoho',
    enabled: true,
    config: {},
    credentials: {
      access_token: 'expired',
      refresh_token: 'refresh-abc',
      token_expires_at: String(Date.now() - 60_000), // already expired
      ...overrides,
    },
  } as unknown as ConnectorConfig;
}

describe('refreshZoho region routing', () => {
  beforeEach(() => {
    process.env.ZOHO_CLIENT_ID = 'test-client';
    process.env.ZOHO_CLIENT_SECRET = 'test-secret';
    delete process.env.ZOHO_ACCOUNTS_SERVER;
  });

  afterEach(() => {
    global.fetch = ORIG_FETCH;
    vi.clearAllMocks();
  });

  it('uses per-connector accounts_server (EU) instead of the global endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'new-eu-token',
          expires_in: 3600,
          api_domain: 'https://www.zohoapis.eu',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const cfg = makeConfig({ accounts_server: 'https://accounts.zoho.eu' });
    const refreshed = await ensureFreshOAuthToken(cfg);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe('https://accounts.zoho.eu/oauth/v2/token');
    expect(refreshed.credentials.access_token).toBe('new-eu-token');
    expect(updateConnectorCredentials).toHaveBeenCalledWith(
      'tenant-zoho',
      'integration-zoho',
      expect.objectContaining({ access_token: 'new-eu-token', api_domain: 'https://www.zohoapis.eu' }),
    );
  });

  it('falls back to ZOHO_ACCOUNTS_SERVER env when no per-connector value is set', async () => {
    process.env.ZOHO_ACCOUNTS_SERVER = 'https://accounts.zoho.in';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'new-in-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const cfg = makeConfig();
    await ensureFreshOAuthToken(cfg);

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe('https://accounts.zoho.in/oauth/v2/token');
  });

  it('refuses to POST credentials when stored accounts_server is not in the allowlist', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const cfg = makeConfig({ accounts_server: 'https://attacker.example.com' });
    await expect(ensureFreshOAuthToken(cfg)).rejects.toThrow(/not in the allowed Zoho hosts list/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to the global accounts.zoho.com endpoint as a last resort', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'new-global-token', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const cfg = makeConfig();
    await ensureFreshOAuthToken(cfg);

    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe('https://accounts.zoho.com/oauth/v2/token');
  });
});

function makeSalesforceConfig(
  overrides: Partial<ConnectorConfig['credentials']> = {},
): ConnectorConfig {
  return {
    tenantId: 'tenant-sf',
    integrationId: 'integration-sf',
    type: 'crm',
    provider: 'salesforce',
    enabled: true,
    config: {},
    credentials: {
      access_token: 'sf-old',
      refresh_token: 'sf-refresh',
      instance_url: 'https://acme.my.salesforce.com',
      token_expires_at: String(Date.now() - 60_000),
      ...overrides,
    },
  } as unknown as ConnectorConfig;
}

describe('refreshSalesforce', () => {
  beforeEach(() => {
    process.env.SALESFORCE_CLIENT_ID = 'sf-client';
    process.env.SALESFORCE_CLIENT_SECRET = 'sf-secret';
    delete process.env.SALESFORCE_LOGIN_URL;
  });

  afterEach(() => {
    global.fetch = ORIG_FETCH;
    vi.clearAllMocks();
  });

  it('refreshes against login.salesforce.com and persists rotated instance_url', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'sf-new',
          instance_url: 'https://acme-2.my.salesforce.com',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const cfg = makeSalesforceConfig();
    const refreshed = await ensureFreshOAuthToken(cfg);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe('https://login.salesforce.com/services/oauth2/token');
    expect(refreshed.credentials.access_token).toBe('sf-new');
    expect(refreshed.credentials.instance_url).toBe('https://acme-2.my.salesforce.com');
    // Salesforce omits expires_in on refresh — falls back to a 90-minute TTL.
    const expiresAt = Number(refreshed.credentials.token_expires_at);
    expect(expiresAt).toBeGreaterThan(Date.now() + 89 * 60 * 1000);
    expect(expiresAt).toBeLessThan(Date.now() + 91 * 60 * 1000);
    expect(updateConnectorCredentials).toHaveBeenCalledWith(
      'tenant-sf',
      'integration-sf',
      expect.objectContaining({
        access_token: 'sf-new',
        instance_url: 'https://acme-2.my.salesforce.com',
      }),
    );
  });

  it('honors SALESFORCE_LOGIN_URL for sandbox tenants', async () => {
    process.env.SALESFORCE_LOGIN_URL = 'https://test.salesforce.com';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'sf-new' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await ensureFreshOAuthToken(makeSalesforceConfig());

    expect(fetchMock.mock.calls[0][0]).toBe('https://test.salesforce.com/services/oauth2/token');
  });

  it('marks connector for reconnect on HTTP failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('invalid_grant', { status: 400 }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(ensureFreshOAuthToken(makeSalesforceConfig())).rejects.toThrow(/HTTP 400/);
    expect(markConnectorReconnectNeeded).toHaveBeenCalledWith(
      'tenant-sf',
      'integration-sf',
      expect.objectContaining({ provider: 'salesforce' }),
    );
  });

  it('throws when SALESFORCE_CLIENT_ID/SECRET env vars are missing', async () => {
    delete process.env.SALESFORCE_CLIENT_ID;
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(ensureFreshOAuthToken(makeSalesforceConfig())).rejects.toThrow(
      /Salesforce OAuth env vars missing/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(markConnectorReconnectNeeded).toHaveBeenCalledWith(
      'tenant-sf',
      'integration-sf',
      expect.objectContaining({ provider: 'salesforce' }),
    );
  });
});

function makeOutlookConfig(
  overrides: Partial<ConnectorConfig['credentials']> = {},
): ConnectorConfig {
  return {
    tenantId: 'tenant-ms',
    integrationId: 'integration-ms',
    type: 'scheduling',
    provider: 'outlook-calendar',
    enabled: true,
    config: {},
    credentials: {
      access_token: 'ms-old',
      refresh_token: 'ms-refresh',
      client_id: 'ms-client-from-creds',
      client_secret: 'ms-secret-from-creds',
      token_expires_at: String(Date.now() - 60_000),
      ...overrides,
    },
  } as unknown as ConnectorConfig;
}

describe('refreshOutlookCalendar', () => {
  beforeEach(() => {
    delete process.env.MICROSOFT_CLIENT_ID;
    delete process.env.MICROSOFT_CLIENT_SECRET;
    delete process.env.MICROSOFT_TENANT_ID;
  });

  afterEach(() => {
    global.fetch = ORIG_FETCH;
    vi.clearAllMocks();
  });

  it('refreshes against the common Microsoft endpoint and persists new tokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'ms-new',
          refresh_token: 'ms-refresh-rotated',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const refreshed = await ensureFreshOAuthToken(makeOutlookConfig());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    );
    const body = (fetchMock.mock.calls[0][1] as { body: string }).body;
    // Should have used per-connector client_id/secret instead of env vars.
    expect(body).toContain('client_id=ms-client-from-creds');
    expect(body).toContain('client_secret=ms-secret-from-creds');
    expect(body).toContain('grant_type=refresh_token');
    expect(refreshed.credentials.access_token).toBe('ms-new');
    expect(refreshed.credentials.refresh_token).toBe('ms-refresh-rotated');
    expect(updateConnectorCredentials).toHaveBeenCalledWith(
      'tenant-ms',
      'integration-ms',
      expect.objectContaining({
        access_token: 'ms-new',
        refresh_token: 'ms-refresh-rotated',
      }),
    );
  });

  it('honors MICROSOFT_TENANT_ID env var for single-tenant Azure apps', async () => {
    process.env.MICROSOFT_TENANT_ID = 'contoso.onmicrosoft.com';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'ms-new', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await ensureFreshOAuthToken(makeOutlookConfig());

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/token',
    );
  });

  it('falls back to MICROSOFT_CLIENT_ID/SECRET env vars when not stored on connector', async () => {
    process.env.MICROSOFT_CLIENT_ID = 'env-client';
    process.env.MICROSOFT_CLIENT_SECRET = 'env-secret';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'ms-new', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const cfg = makeOutlookConfig({ client_id: undefined, client_secret: undefined });
    await ensureFreshOAuthToken(cfg);

    const body = (fetchMock.mock.calls[0][1] as { body: string }).body;
    expect(body).toContain('client_id=env-client');
    expect(body).toContain('client_secret=env-secret');
  });

  it('marks connector for reconnect when credentials are missing entirely', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const cfg = makeOutlookConfig({ client_id: undefined, client_secret: undefined });
    await expect(ensureFreshOAuthToken(cfg)).rejects.toThrow(/Outlook OAuth credentials missing/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(markConnectorReconnectNeeded).toHaveBeenCalledWith(
      'tenant-ms',
      'integration-ms',
      expect.objectContaining({ provider: 'outlook-calendar' }),
    );
  });
});
