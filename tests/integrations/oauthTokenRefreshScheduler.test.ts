import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../platform/integrations/connectors/db', () => ({
  listRefreshableConnectorConfigs: vi.fn(),
}));

vi.mock('../../platform/integrations/connectors/tokenRefresh', () => ({
  ensureFreshOAuthToken: vi.fn(),
  isRefreshableProvider: (p: string) =>
    [
      'hubspot',
      'pipedrive',
      'quickbooks',
      'salesforce',
      'outlook-calendar',
      'google-calendar',
      'zoho',
    ].includes(p),
}));

import { runOAuthTokenRefreshCycle } from '../../platform/integrations/connectors/OAuthTokenRefreshScheduler';
import { listRefreshableConnectorConfigs } from '../../platform/integrations/connectors/db';
import { ensureFreshOAuthToken } from '../../platform/integrations/connectors/tokenRefresh';
import type { ConnectorConfig } from '../../platform/integrations/connectors/types';
import type { TenantId } from '../../platform/core/types';

function makeConfig(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    integrationId: 'integ-1',
    tenantId: 'tenant-a' as TenantId,
    connectorType: 'crm',
    provider: 'hubspot',
    isEnabled: true,
    credentials: {
      access_token: 'at',
      refresh_token: 'rt',
      token_expires_at: String(Date.now() + 5 * 60 * 1000),
    },
    ...overrides,
  };
}

describe('runOAuthTokenRefreshCycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('refreshes tokens that expire within the horizon', async () => {
    const cfg = makeConfig();
    vi.mocked(listRefreshableConnectorConfigs).mockResolvedValue([cfg]);
    vi.mocked(ensureFreshOAuthToken).mockResolvedValue(cfg);

    const result = await runOAuthTokenRefreshCycle(30 * 60 * 1000);

    expect(result.scanned).toBe(1);
    expect(result.expiringSoon).toBe(1);
    expect(result.refreshed).toBe(1);
    expect(result.failed).toBe(0);
    expect(ensureFreshOAuthToken).toHaveBeenCalledTimes(1);
    expect(ensureFreshOAuthToken).toHaveBeenCalledWith(cfg, { leadMs: 30 * 60 * 1000 });
  });

  it('skips tokens that expire after the horizon', async () => {
    const cfg = makeConfig({
      credentials: {
        access_token: 'at',
        refresh_token: 'rt',
        token_expires_at: String(Date.now() + 60 * 60 * 1000), // 1h away
      },
    });
    vi.mocked(listRefreshableConnectorConfigs).mockResolvedValue([cfg]);

    const result = await runOAuthTokenRefreshCycle(30 * 60 * 1000);

    expect(result.scanned).toBe(1);
    expect(result.expiringSoon).toBe(0);
    expect(result.refreshed).toBe(0);
    expect(ensureFreshOAuthToken).not.toHaveBeenCalled();
  });

  it('skips configs with missing or invalid token_expires_at', async () => {
    const noExpiry = makeConfig({
      integrationId: 'integ-no-exp',
      credentials: { access_token: 'at', refresh_token: 'rt' },
    });
    const badExpiry = makeConfig({
      integrationId: 'integ-bad-exp',
      credentials: {
        access_token: 'at',
        refresh_token: 'rt',
        token_expires_at: 'not-a-number',
      },
    });
    vi.mocked(listRefreshableConnectorConfigs).mockResolvedValue([noExpiry, badExpiry]);

    const result = await runOAuthTokenRefreshCycle(30 * 60 * 1000);

    expect(result.scanned).toBe(2);
    expect(result.expiringSoon).toBe(0);
    expect(ensureFreshOAuthToken).not.toHaveBeenCalled();
  });

  it('counts failures without aborting the rest of the cycle', async () => {
    const a = makeConfig({ integrationId: 'a' });
    const b = makeConfig({ integrationId: 'b' });
    vi.mocked(listRefreshableConnectorConfigs).mockResolvedValue([a, b]);
    vi.mocked(ensureFreshOAuthToken)
      .mockRejectedValueOnce(new Error('refresh boom'))
      .mockResolvedValueOnce(b);

    const result = await runOAuthTokenRefreshCycle(30 * 60 * 1000);

    expect(result.scanned).toBe(2);
    expect(result.expiringSoon).toBe(2);
    expect(result.refreshed).toBe(1);
    expect(result.failed).toBe(1);
    expect(ensureFreshOAuthToken).toHaveBeenCalledTimes(2);
  });

  it('includes zoho in the providers swept each cycle', async () => {
    vi.mocked(listRefreshableConnectorConfigs).mockResolvedValue([]);

    await runOAuthTokenRefreshCycle(30 * 60 * 1000);

    expect(listRefreshableConnectorConfigs).toHaveBeenCalledTimes(1);
    const providers = vi.mocked(listRefreshableConnectorConfigs).mock.calls[0][0];
    expect(providers).toEqual(
      expect.arrayContaining([
        'hubspot',
        'pipedrive',
        'quickbooks',
        'salesforce',
        'outlook-calendar',
        'google-calendar',
        'zoho',
      ]),
    );
  });

  it('refreshes an expiring zoho token without a user interaction', async () => {
    const zohoCfg = makeConfig({
      integrationId: 'integ-zoho',
      provider: 'zoho',
      credentials: {
        access_token: 'zoho-at',
        refresh_token: 'zoho-rt',
        token_expires_at: String(Date.now() + 5 * 60 * 1000),
      },
    });
    vi.mocked(listRefreshableConnectorConfigs).mockResolvedValue([zohoCfg]);
    vi.mocked(ensureFreshOAuthToken).mockResolvedValue(zohoCfg);

    const result = await runOAuthTokenRefreshCycle(30 * 60 * 1000);

    expect(result.expiringSoon).toBe(1);
    expect(result.refreshed).toBe(1);
    expect(result.failed).toBe(0);
    expect(ensureFreshOAuthToken).toHaveBeenCalledWith(zohoCfg, { leadMs: 30 * 60 * 1000 });
  });

  it('flags configs missing a refresh_token', async () => {
    const cfg = makeConfig({
      credentials: {
        access_token: 'at',
        token_expires_at: String(Date.now() + 60 * 1000),
      },
    });
    vi.mocked(listRefreshableConnectorConfigs).mockResolvedValue([cfg]);
    vi.mocked(ensureFreshOAuthToken).mockRejectedValue(new Error('No refresh_token stored'));

    const result = await runOAuthTokenRefreshCycle(30 * 60 * 1000);

    expect(result.expiringSoon).toBe(1);
    expect(result.skippedNoRefreshToken).toBe(1);
    expect(result.failed).toBe(1);
  });
});
