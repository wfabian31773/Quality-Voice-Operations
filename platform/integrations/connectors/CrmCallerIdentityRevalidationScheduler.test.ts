import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  listDueMock,
  markValidatedMock,
  clearMock,
  listConfigsMock,
  validateHubSpotMock,
  validateSalesforceMock,
  validatePipedriveMock,
  validateZohoMock,
} = vi.hoisted(() => ({
  listDueMock: vi.fn(),
  markValidatedMock: vi.fn(),
  clearMock: vi.fn(),
  listConfigsMock: vi.fn(),
  validateHubSpotMock: vi.fn(),
  validateSalesforceMock: vi.fn(),
  validatePipedriveMock: vi.fn(),
  validateZohoMock: vi.fn(),
}));

vi.mock('./crmCallerIdentity', async () => {
  const actual = await vi.importActual<typeof import('./crmCallerIdentity')>(
    './crmCallerIdentity',
  );
  return {
    ...actual,
    listCrmCallerIdentitiesDueForRevalidation: listDueMock,
    markCrmCallerIdentityValidated: markValidatedMock,
    clearCrmCallerIdentity: clearMock,
  };
});

vi.mock('./db', () => ({
  listEnabledConnectorConfigs: listConfigsMock,
}));

vi.mock('./adapters/hubspot', () => ({
  validateHubSpotCachedIdentity: validateHubSpotMock,
}));
vi.mock('./adapters/salesforce', () => ({
  validateSalesforceCachedIdentity: validateSalesforceMock,
}));
vi.mock('./adapters/pipedrive', () => ({
  validatePipedriveCachedIdentity: validatePipedriveMock,
}));
vi.mock('./adapters/zoho', () => ({
  validateZohoCachedIdentity: validateZohoMock,
}));

import {
  runCrmCallerIdentityRevalidationCycle,
  startCrmCallerIdentityRevalidationScheduler,
  stopCrmCallerIdentityRevalidationScheduler,
} from './CrmCallerIdentityRevalidationScheduler';
import {
  getCrmRevalidationMetricsSnapshot,
  resetCrmRevalidationMetricsForTest,
} from './CrmCallerIdentityRevalidationMetrics';

function dueRow(overrides: Partial<{
  tenantId: string;
  provider: string;
  phone: string;
  identity: { contactId?: string; accountId?: string; opportunityId?: string; extras?: Record<string, string> };
}> = {}) {
  return {
    tenantId: 'tenant-a',
    provider: 'hubspot',
    phone: '5551234567',
    identity: { contactId: 'c1' },
    lastValidatedAt: null,
    ...overrides,
  };
}

const baseConfig = (provider: string) => ({
  integrationId: `${provider}-int`,
  tenantId: 'tenant-a',
  connectorType: 'crm' as const,
  provider,
  isEnabled: true,
  credentials: { access_token: 'tok' },
});

describe('CrmCallerIdentityRevalidationScheduler', () => {
  beforeEach(() => {
    listDueMock.mockReset();
    markValidatedMock.mockReset();
    clearMock.mockReset();
    listConfigsMock.mockReset();
    validateHubSpotMock.mockReset();
    validateSalesforceMock.mockReset();
    validatePipedriveMock.mockReset();
    validateZohoMock.mockReset();
    resetCrmRevalidationMetricsForTest();
  });

  afterEach(() => {
    stopCrmCallerIdentityRevalidationScheduler();
    vi.useRealTimers();
    resetCrmRevalidationMetricsForTest();
  });

  it('returns early with zero counters when no rows are due', async () => {
    listDueMock.mockResolvedValueOnce([]);

    const result = await runCrmCallerIdentityRevalidationCycle();

    expect(result).toEqual({
      scanned: 0, validated: 0, staleScrubbed: 0, skippedNoConfig: 0, failed: 0,
    });
    expect(listConfigsMock).not.toHaveBeenCalled();
    expect(markValidatedMock).not.toHaveBeenCalled();
  });

  it('marks valid rows as validated and does not scrub', async () => {
    listDueMock.mockResolvedValueOnce([dueRow()]);
    listConfigsMock.mockResolvedValueOnce([baseConfig('hubspot')]);
    validateHubSpotMock.mockResolvedValueOnce({ stale: {} });

    const result = await runCrmCallerIdentityRevalidationCycle();

    expect(result.scanned).toBe(1);
    expect(result.validated).toBe(1);
    expect(result.staleScrubbed).toBe(0);
    expect(clearMock).not.toHaveBeenCalled();
    expect(markValidatedMock).toHaveBeenCalledWith('tenant-a', 'hubspot', '5551234567');
  });

  it('scrubs stale IDs and still bumps validation timestamp on the surviving row', async () => {
    listDueMock.mockResolvedValueOnce([
      dueRow({ identity: { contactId: 'c1', extras: { companyId: 'co1' } } }),
    ]);
    listConfigsMock.mockResolvedValueOnce([baseConfig('hubspot')]);
    validateHubSpotMock.mockResolvedValueOnce({ stale: { contactId: 'c1' } });

    const result = await runCrmCallerIdentityRevalidationCycle();

    expect(result.staleScrubbed).toBe(1);
    expect(result.validated).toBe(1);
    expect(clearMock).toHaveBeenCalledWith(
      'tenant-a', 'hubspot', '5551234567', { contactId: 'c1' },
    );
    expect(markValidatedMock).toHaveBeenCalledWith('tenant-a', 'hubspot', '5551234567');
  });

  it('skips rows whose tenant has no enabled config but bumps timestamp to avoid churn', async () => {
    listDueMock.mockResolvedValueOnce([dueRow({ provider: 'salesforce' })]);
    listConfigsMock.mockResolvedValueOnce([]); // no CRM configs

    const result = await runCrmCallerIdentityRevalidationCycle();

    expect(result.skippedNoConfig).toBe(1);
    expect(result.validated).toBe(0);
    expect(validateSalesforceMock).not.toHaveBeenCalled();
    expect(markValidatedMock).toHaveBeenCalledWith('tenant-a', 'salesforce', '5551234567');
  });

  it('caches connector configs per tenant across rows in one cycle', async () => {
    listDueMock.mockResolvedValueOnce([
      dueRow(),
      dueRow({ phone: '5559999999', identity: { contactId: 'c2' } }),
      dueRow({ tenantId: 'tenant-b', identity: { contactId: 'c3' } }),
    ]);
    listConfigsMock.mockImplementation(async (tenantId: string) => [baseConfig(`hubspot`)]);
    validateHubSpotMock.mockResolvedValue({ stale: {} });

    await runCrmCallerIdentityRevalidationCycle();

    // Two distinct tenants -> two listEnabledConnectorConfigs calls only.
    expect(listConfigsMock).toHaveBeenCalledTimes(2);
    expect(listConfigsMock).toHaveBeenNthCalledWith(1, 'tenant-a', ['crm']);
    expect(listConfigsMock).toHaveBeenNthCalledWith(2, 'tenant-b', ['crm']);
  });

  it('routes each row to the right per-provider validator', async () => {
    listDueMock.mockResolvedValueOnce([
      dueRow({ provider: 'hubspot', identity: { contactId: 'h1' } }),
      dueRow({ provider: 'salesforce', identity: { contactId: '003abc' } }),
      dueRow({ provider: 'pipedrive', identity: { contactId: 'p1' } }),
      dueRow({ provider: 'zoho', identity: { contactId: 'z1' } }),
    ]);
    listConfigsMock.mockResolvedValue([
      baseConfig('hubspot'), baseConfig('salesforce'), baseConfig('pipedrive'), baseConfig('zoho'),
    ]);
    validateHubSpotMock.mockResolvedValue({ stale: {} });
    validateSalesforceMock.mockResolvedValue({ stale: {} });
    validatePipedriveMock.mockResolvedValue({ stale: {} });
    validateZohoMock.mockResolvedValue({ stale: {} });

    const result = await runCrmCallerIdentityRevalidationCycle();

    expect(result.validated).toBe(4);
    expect(validateHubSpotMock).toHaveBeenCalledTimes(1);
    expect(validateSalesforceMock).toHaveBeenCalledTimes(1);
    expect(validatePipedriveMock).toHaveBeenCalledTimes(1);
    expect(validateZohoMock).toHaveBeenCalledTimes(1);
  });

  it('counts validator throws as failed without aborting the cycle', async () => {
    listDueMock.mockResolvedValueOnce([
      dueRow({ identity: { contactId: 'c1' } }),
      dueRow({ phone: '5550000002', identity: { contactId: 'c2' } }),
    ]);
    listConfigsMock.mockResolvedValueOnce([baseConfig('hubspot')]);
    validateHubSpotMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ stale: {} });

    const result = await runCrmCallerIdentityRevalidationCycle();

    expect(result.failed).toBe(1);
    expect(result.validated).toBe(1);
  });

  it('counts config-load failures as failed and does not mark rows validated (so they retry next cycle)', async () => {
    listDueMock.mockResolvedValueOnce([
      dueRow(),
      dueRow({ phone: '5550000002', identity: { contactId: 'c2' } }),
    ]);
    listConfigsMock.mockRejectedValueOnce(new Error('decrypt timeout'));

    const result = await runCrmCallerIdentityRevalidationCycle();

    expect(result.failed).toBe(2);
    expect(result.skippedNoConfig).toBe(0);
    expect(result.validated).toBe(0);
    expect(markValidatedMock).not.toHaveBeenCalled();
    // Cache prevents a second config-load call within the same cycle.
    expect(listConfigsMock).toHaveBeenCalledTimes(1);
  });

  it('ignores unsupported providers without crashing', async () => {
    listDueMock.mockResolvedValueOnce([dueRow({ provider: 'mystery' })]);
    listConfigsMock.mockResolvedValueOnce([]);

    const result = await runCrmCallerIdentityRevalidationCycle();

    expect(result.scanned).toBe(1);
    expect(result.validated).toBe(0);
    expect(result.skippedNoConfig).toBe(0);
    expect(markValidatedMock).not.toHaveBeenCalled();
  });

  it('records cycle counters and per-tenant deltas in the metrics aggregator', async () => {
    listDueMock.mockResolvedValueOnce([
      dueRow({ tenantId: 'tenant-a' }),
      dueRow({ tenantId: 'tenant-b', phone: '5550000002', identity: { contactId: 'b1' } }),
    ]);
    listConfigsMock.mockResolvedValue([baseConfig('hubspot')]);
    validateHubSpotMock
      .mockResolvedValueOnce({ stale: { contactId: 'c1' } }) // tenant-a -> scrubbed
      .mockResolvedValueOnce({ stale: {} });                 // tenant-b -> validated only

    await runCrmCallerIdentityRevalidationCycle();

    const snap = getCrmRevalidationMetricsSnapshot();
    expect(snap.totals.cyclesRun).toBe(1);
    expect(snap.totals.scanned).toBe(2);
    expect(snap.totals.validated).toBe(2);
    expect(snap.totals.staleScrubbed).toBe(1);
    expect(snap.lastCycle?.scanned).toBe(2);

    const byTenant = new Map(snap.perTenant.map((t) => [t.tenantId, t]));
    expect(byTenant.get('tenant-a')?.staleScrubbed).toBe(1);
    expect(byTenant.get('tenant-a')?.validated).toBe(1);
    expect(byTenant.get('tenant-b')?.staleScrubbed).toBe(0);
    expect(byTenant.get('tenant-b')?.validated).toBe(1);
  });

  it('records per-tenant failures so admins can spot tenants with repeated issues', async () => {
    listDueMock.mockResolvedValueOnce([
      dueRow({ tenantId: 'tenant-x' }),
    ]);
    listConfigsMock.mockResolvedValueOnce([baseConfig('hubspot')]);
    validateHubSpotMock.mockRejectedValueOnce(new Error('upstream 500'));

    await runCrmCallerIdentityRevalidationCycle();

    const snap = getCrmRevalidationMetricsSnapshot();
    expect(snap.totals.failed).toBe(1);
    expect(snap.perTenant[0]?.tenantId).toBe('tenant-x');
    expect(snap.perTenant[0]?.failed).toBe(1);
  });

  it('records an empty cycle (no due rows) so admins see the sweep is alive', async () => {
    listDueMock.mockResolvedValueOnce([]);

    await runCrmCallerIdentityRevalidationCycle();

    const snap = getCrmRevalidationMetricsSnapshot();
    expect(snap.totals.cyclesRun).toBe(1);
    expect(snap.totals.scanned).toBe(0);
    expect(snap.lastCycle).not.toBeNull();
    expect(snap.lastCycle?.threw).toBe(false);
  });

  it('marks the cycle as threw when listing due rows fails', async () => {
    listDueMock.mockRejectedValueOnce(new Error('db down'));

    await expect(runCrmCallerIdentityRevalidationCycle()).rejects.toThrow('db down');

    const snap = getCrmRevalidationMetricsSnapshot();
    expect(snap.totals.cyclesRun).toBe(1);
    expect(snap.totals.cyclesThrew).toBe(1);
    expect(snap.lastCycle?.threw).toBe(true);
  });

  it('start/stop is idempotent and does not blow up when start is called twice', () => {
    vi.useFakeTimers();
    startCrmCallerIdentityRevalidationScheduler(60_000);
    startCrmCallerIdentityRevalidationScheduler(60_000);
    stopCrmCallerIdentityRevalidationScheduler();
    stopCrmCallerIdentityRevalidationScheduler();
  });
});
