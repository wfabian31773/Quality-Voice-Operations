import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../platform/integrations/connectors/db', () => ({
  listRefreshableConnectorConfigs: vi.fn(),
}));

const mockRefreshableProviders = new Set<string>([
  'hubspot',
  'pipedrive',
  'quickbooks',
  'salesforce',
  'outlook-calendar',
  'google-calendar',
  'zoho',
]);

vi.mock('../../platform/integrations/connectors/tokenRefresh', () => ({
  ensureFreshOAuthToken: vi.fn(),
  isRefreshableProvider: (p: string) => mockRefreshableProviders.has(p),
  getRefreshableProviders: () => Array.from(mockRefreshableProviders),
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
    mockRefreshableProviders.clear();
    for (const p of [
      'hubspot',
      'pipedrive',
      'quickbooks',
      'salesforce',
      'outlook-calendar',
      'google-calendar',
      'zoho',
    ]) {
      mockRefreshableProviders.add(p);
    }
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

  it('derives the swept provider list from the registered refreshers', async () => {
    // Simulate someone wiring up a brand-new refresher in tokenRefresh.ts
    // without touching the scheduler. The cycle should pick it up
    // automatically — that's the whole point of this task.
    mockRefreshableProviders.add('made-up-new-provider');
    vi.mocked(listRefreshableConnectorConfigs).mockResolvedValue([]);

    await runOAuthTokenRefreshCycle(30 * 60 * 1000);

    expect(listRefreshableConnectorConfigs).toHaveBeenCalledTimes(1);
    const providers = vi.mocked(listRefreshableConnectorConfigs).mock.calls[0][0];
    expect(providers).toContain('made-up-new-provider');
  });

  it('refreshes a config for a newly registered provider without scheduler edits', async () => {
    // The scheduler should not have any hardcoded provider list — adding
    // a refresher anywhere downstream is enough for the sweep to fire.
    mockRefreshableProviders.add('made-up-new-provider');
    const newCfg = makeConfig({
      integrationId: 'integ-new',
      provider: 'made-up-new-provider',
    });
    vi.mocked(listRefreshableConnectorConfigs).mockResolvedValue([newCfg]);
    vi.mocked(ensureFreshOAuthToken).mockResolvedValue(newCfg);

    const result = await runOAuthTokenRefreshCycle(30 * 60 * 1000);

    expect(result.expiringSoon).toBe(1);
    expect(result.refreshed).toBe(1);
    expect(ensureFreshOAuthToken).toHaveBeenCalledWith(newCfg, { leadMs: 30 * 60 * 1000 });
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

  it('skips tokens within the 24h horizon if less than half their lifetime has elapsed', async () => {
    // 1h-TTL token, only 5 minutes old: still has ~92% of life remaining.
    // Even though it expires within the (default) 24h horizon, we should
    // not rotate it on every cycle.
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    const expiresInOneHour = fiveMinAgo + 60 * 60 * 1000;
    const cfg = makeConfig({
      credentials: {
        access_token: 'at',
        refresh_token: 'rt',
        token_issued_at: String(fiveMinAgo),
        token_expires_at: String(expiresInOneHour),
      },
    });
    vi.mocked(listRefreshableConnectorConfigs).mockResolvedValue([cfg]);

    const result = await runOAuthTokenRefreshCycle(24 * 60 * 60 * 1000);

    expect(result.scanned).toBe(1);
    expect(result.expiringSoon).toBe(0);
    expect(result.refreshed).toBe(0);
    expect(ensureFreshOAuthToken).not.toHaveBeenCalled();
  });

  it('refreshes tokens past the half-lifetime mark even when not yet expired', async () => {
    // 1h-TTL token issued 40 minutes ago — 67% consumed, 20 minutes left.
    // Within the 24h horizon and past the half-lifetime threshold, so the
    // sweep should refresh it before the access_token expires.
    const fortyMinAgo = Date.now() - 40 * 60 * 1000;
    const expiresInTwentyMin = fortyMinAgo + 60 * 60 * 1000;
    const cfg = makeConfig({
      credentials: {
        access_token: 'at',
        refresh_token: 'rt',
        token_issued_at: String(fortyMinAgo),
        token_expires_at: String(expiresInTwentyMin),
      },
    });
    vi.mocked(listRefreshableConnectorConfigs).mockResolvedValue([cfg]);
    vi.mocked(ensureFreshOAuthToken).mockResolvedValue(cfg);

    const result = await runOAuthTokenRefreshCycle(24 * 60 * 60 * 1000);

    expect(result.scanned).toBe(1);
    expect(result.expiringSoon).toBe(1);
    expect(result.refreshed).toBe(1);
    expect(ensureFreshOAuthToken).toHaveBeenCalledTimes(1);
  });

  it('always refreshes tokens within the floor window regardless of lifetime', async () => {
    // Long-lived token (24h TTL) issued recently, but only 2 minutes from
    // expiry. Less than half of lifetime consumed, but the 5-minute floor
    // forces a refresh anyway.
    const issuedAt = Date.now() - 23 * 60 * 60 * 1000 - 58 * 60 * 1000;
    const expiresAt = Date.now() + 2 * 60 * 1000;
    const cfg = makeConfig({
      credentials: {
        access_token: 'at',
        refresh_token: 'rt',
        token_issued_at: String(issuedAt),
        token_expires_at: String(expiresAt),
      },
    });
    vi.mocked(listRefreshableConnectorConfigs).mockResolvedValue([cfg]);
    vi.mocked(ensureFreshOAuthToken).mockResolvedValue(cfg);

    const result = await runOAuthTokenRefreshCycle(24 * 60 * 60 * 1000);

    expect(result.expiringSoon).toBe(1);
    expect(result.refreshed).toBe(1);
  });

  it('falls back to the horizon check when token_issued_at is missing', async () => {
    // Legacy token without persisted issued_at: keep existing behaviour
    // (refresh whenever we are inside the horizon). This protects
    // pre-existing connector_configs rows that haven't been refreshed
    // since this change rolled out.
    const cfg = makeConfig({
      credentials: {
        access_token: 'at',
        refresh_token: 'rt',
        token_expires_at: String(Date.now() + 5 * 60 * 1000),
      },
    });
    vi.mocked(listRefreshableConnectorConfigs).mockResolvedValue([cfg]);
    vi.mocked(ensureFreshOAuthToken).mockResolvedValue(cfg);

    const result = await runOAuthTokenRefreshCycle(24 * 60 * 60 * 1000);

    expect(result.expiringSoon).toBe(1);
    expect(result.refreshed).toBe(1);
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
