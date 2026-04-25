import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../platform/integrations/connectors/db', () => ({
  listRefreshableConnectorConfigs: vi.fn(),
}));

vi.mock('../../platform/integrations/connectors/tokenRefresh', () => ({
  ensureFreshOAuthToken: vi.fn(),
  isRefreshableProvider: (p: string) => ['hubspot', 'pipedrive', 'quickbooks'].includes(p),
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
