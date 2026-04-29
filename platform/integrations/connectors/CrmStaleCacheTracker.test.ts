import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, fanoutMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  fanoutMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
}));

vi.mock('../../notifications/NotificationPreferences', () => ({
  fanoutInAppNotification: fanoutMock,
}));

import { recordStaleCacheScrub, STALE_CACHE_NOTIFICATION_TYPE } from './CrmStaleCacheTracker';

const TENANT = 'tenant-stale';
const RAW_PHONE = '+1 (555) 123-4567';
const NORMALIZED_PHONE = '5551234567';

beforeEach(() => {
  queryMock.mockReset();
  fanoutMock.mockReset();
  fanoutMock.mockResolvedValue(undefined);
  delete process.env.CRM_STALE_CACHE_ALERT_THRESHOLD;
});

afterEach(() => {
  vi.clearAllMocks();
});

/**
 * Helper that wires the queryMock to respond, in order, to:
 *   1. the INSERT into crm_stale_cache_scrubs
 *   2. the SELECT COUNT(*) of recent scrubs
 *   3. (optionally) the SELECT of the throttle marker row
 */
function setupQueries(opts: { count: number; throttleHit?: boolean }) {
  queryMock.mockImplementationOnce(async () => ({ rows: [] })); // INSERT
  queryMock.mockImplementationOnce(async () => ({
    rows: [{ count: String(opts.count) }],
  })); // COUNT
  if (opts.throttleHit !== undefined) {
    queryMock.mockImplementationOnce(async () => ({
      rows: opts.throttleHit ? [{ ok: 1 }] : [],
    })); // throttle SELECT
  }
}

describe('recordStaleCacheScrub', () => {
  it('persists the scrub row with normalized phone and lower-cased provider', async () => {
    setupQueries({ count: 1 });

    await recordStaleCacheScrub({
      tenantId: TENANT,
      provider: 'Salesforce',
      callerPhone: RAW_PHONE,
      staleIds: { contactId: '003ZOMBIE0000001' },
      errorCode: 'ENTITY_IS_DELETED',
    });

    const insertCall = queryMock.mock.calls[0];
    expect(insertCall[0]).toMatch(/INSERT INTO crm_stale_cache_scrubs/);
    expect(insertCall[1]).toEqual([
      TENANT,
      'salesforce',
      NORMALIZED_PHONE,
      JSON.stringify({ contactId: '003ZOMBIE0000001' }),
      'ENTITY_IS_DELETED',
    ]);

    // Below threshold (default 3) -> count query happened, alert did not.
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(fanoutMock).not.toHaveBeenCalled();
  });

  it('does not fire alert when the rolling count is under the threshold', async () => {
    setupQueries({ count: 2 });

    await recordStaleCacheScrub({
      tenantId: TENANT,
      provider: 'hubspot',
      callerPhone: RAW_PHONE,
      staleIds: { contactId: 'C1' },
    });

    expect(fanoutMock).not.toHaveBeenCalled();
  });

  it('fires an in-app alert once the threshold is hit (no prior throttle row)', async () => {
    setupQueries({ count: 3, throttleHit: false });

    await recordStaleCacheScrub({
      tenantId: TENANT,
      provider: 'pipedrive',
      callerPhone: RAW_PHONE,
      staleIds: { personId: '777', dealId: '888' },
      errorCode: '404',
    });

    expect(fanoutMock).toHaveBeenCalledTimes(1);
    const fanoutArgs = fanoutMock.mock.calls[0][0];
    expect(fanoutArgs).toMatchObject({
      tenantId: TENANT,
      type: STALE_CACHE_NOTIFICATION_TYPE,
      category: 'integration',
    });
    expect(fanoutArgs.title).toContain('Pipedrive');
    expect(fanoutArgs.title).toContain(RAW_PHONE);
    expect(fanoutArgs.message).toContain('3 times');
    expect(fanoutArgs.message).toContain('personId=777');
    expect(fanoutArgs.message).toContain('dealId=888');
    expect(fanoutArgs.metadata).toMatchObject({
      provider: 'pipedrive',
      providerLabel: 'Pipedrive',
      callerPhone: NORMALIZED_PHONE,
      callerPhoneDisplay: RAW_PHONE,
      staleIds: { personId: '777', dealId: '888' },
      errorCode: '404',
      scrubCount24h: 3,
      threshold: 3,
      windowHours: 24,
      link: '/connectors?provider=pipedrive',
    });
  });

  it('honours the 24h alert throttle when a recent notification already exists', async () => {
    setupQueries({ count: 5, throttleHit: true });

    await recordStaleCacheScrub({
      tenantId: TENANT,
      provider: 'salesforce',
      callerPhone: RAW_PHONE,
      staleIds: { contactId: 'CZ' },
    });

    expect(fanoutMock).not.toHaveBeenCalled();

    // Throttle SELECT must have been keyed on the same (tenant, type,
    // provider, normalized phone) tuple we use to fan out the alert, otherwise
    // the throttle could be bypassed by phone-formatting differences.
    const throttleCall = queryMock.mock.calls[2];
    expect(throttleCall[0]).toMatch(/FROM tenant_notifications/);
    expect(throttleCall[1]).toEqual([
      TENANT,
      STALE_CACHE_NOTIFICATION_TYPE,
      'salesforce',
      NORMALIZED_PHONE,
      '24',
    ]);
  });

  it('respects CRM_STALE_CACHE_ALERT_THRESHOLD env override', async () => {
    process.env.CRM_STALE_CACHE_ALERT_THRESHOLD = '10';
    // Below the override (3 < 10) — would have alerted with default of 3.
    setupQueries({ count: 3 });

    await recordStaleCacheScrub({
      tenantId: TENANT,
      provider: 'zoho',
      callerPhone: RAW_PHONE,
      staleIds: { contactId: 'C1' },
    });

    expect(fanoutMock).not.toHaveBeenCalled();
    // Only the INSERT and COUNT ran — no throttle check needed because we
    // never reached the alert path.
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('skips the insert and alert when caller phone is not normalizable', async () => {
    await recordStaleCacheScrub({
      tenantId: TENANT,
      provider: 'salesforce',
      callerPhone: '   ',
      staleIds: { contactId: 'C1' },
    });

    expect(queryMock).not.toHaveBeenCalled();
    expect(fanoutMock).not.toHaveBeenCalled();
  });

  it('bails when the INSERT fails (no count, no alert)', async () => {
    queryMock.mockImplementationOnce(async () => {
      throw new Error('db down');
    });

    await recordStaleCacheScrub({
      tenantId: TENANT,
      provider: 'salesforce',
      callerPhone: RAW_PHONE,
      staleIds: { contactId: 'C1' },
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(fanoutMock).not.toHaveBeenCalled();
  });

  it('skips alert when the rolling count query fails', async () => {
    queryMock.mockImplementationOnce(async () => ({ rows: [] })); // INSERT ok
    queryMock.mockImplementationOnce(async () => {
      throw new Error('count failed');
    });

    await recordStaleCacheScrub({
      tenantId: TENANT,
      provider: 'salesforce',
      callerPhone: RAW_PHONE,
      staleIds: { contactId: 'C1' },
    });

    expect(fanoutMock).not.toHaveBeenCalled();
  });

  it('fans out anyway when the throttle SELECT errors (fail-open)', async () => {
    queryMock.mockImplementationOnce(async () => ({ rows: [] })); // INSERT
    queryMock.mockImplementationOnce(async () => ({ rows: [{ count: '4' }] })); // COUNT
    queryMock.mockImplementationOnce(async () => {
      throw new Error('throttle check failed');
    });

    await recordStaleCacheScrub({
      tenantId: TENANT,
      provider: 'salesforce',
      callerPhone: RAW_PHONE,
      staleIds: { contactId: 'C1' },
    });

    expect(fanoutMock).toHaveBeenCalledTimes(1);
  });

  it('does not throw when the fan-out itself rejects', async () => {
    setupQueries({ count: 3, throttleHit: false });
    fanoutMock.mockRejectedValueOnce(new Error('fanout exploded'));

    await expect(
      recordStaleCacheScrub({
        tenantId: TENANT,
        provider: 'salesforce',
        callerPhone: RAW_PHONE,
        staleIds: { contactId: 'C1' },
      }),
    ).resolves.toBeUndefined();
  });
});
