import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({
  updateConnectorCredentials: vi.fn().mockResolvedValue(undefined),
  markConnectorReconnectNeeded: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../audit/AuditService', () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import { ensureFreshOAuthToken } from './tokenRefresh';
import { updateConnectorCredentials } from './db';
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
