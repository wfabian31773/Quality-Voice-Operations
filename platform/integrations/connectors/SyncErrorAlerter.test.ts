import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  queryMock,
  sendEmailMock,
  connectorSyncErrorEmailMock,
  connectorSyncRecoveryEmailMock,
  fanoutMock,
  filterRecipientsMock,
  filterUserIdsMock,
  isConnectorMutedMock,
  getConnectorAlertSettingsMock,
  getTenantAlertEmailRecipientsMock,
  getTenantAlertPhoneRecipientsMock,
} = vi.hoisted(() => ({
  queryMock: vi.fn(),
  sendEmailMock: vi.fn(),
  connectorSyncErrorEmailMock: vi.fn(() => ({
    subject: 'Sync error',
    html: '<p>html</p>',
    text: 'text',
  })),
  connectorSyncRecoveryEmailMock: vi.fn(() => ({
    subject: 'Recovered',
    html: '<p>html</p>',
    text: 'text',
  })),
  fanoutMock: vi.fn().mockResolvedValue(undefined),
  filterRecipientsMock: vi.fn(async (_t: string, e: string[]) => e),
  filterUserIdsMock: vi.fn(async (ids: string[]) => ids),
  isConnectorMutedMock: vi.fn().mockResolvedValue(false),
  getConnectorAlertSettingsMock: vi.fn(async () => ({
    digestMode: false,
    digestLastSentAt: null,
    updatedAt: null,
    updatedBy: null,
  })),
  getTenantAlertEmailRecipientsMock: vi.fn(async () => ({
    emails: [] as string[],
    userIds: [] as string[],
    recipients: [] as Array<{
      id: string;
      email: string;
      firstName: string | null;
      lastName: string | null;
    }>,
  })),
  getTenantAlertPhoneRecipientsMock: vi.fn(async () => [] as string[]),
}));

vi.mock('../../db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
}));

vi.mock('../../email', () => ({
  sendEmail: sendEmailMock,
  connectorSyncErrorEmail: connectorSyncErrorEmailMock,
  connectorSyncRecoveryEmail: connectorSyncRecoveryEmailMock,
}));

vi.mock('../../notifications/NotificationPreferences', () => ({
  fanoutInAppNotification: fanoutMock,
  filterEmailRecipientsByPreference: filterRecipientsMock,
  filterUserIdsByPreference: filterUserIdsMock,
}));

vi.mock('./ConnectorAlertPreferences', () => ({
  getConnectorAlertSettings: getConnectorAlertSettingsMock,
  isConnectorMuted: isConnectorMutedMock,
}));

vi.mock('./ConnectorAlertRecipients', () => ({
  getTenantAlertEmailRecipients: getTenantAlertEmailRecipientsMock,
  getTenantAlertPhoneRecipients: getTenantAlertPhoneRecipientsMock,
}));

import { notifyConnectorSyncError } from './SyncErrorAlerter';

beforeEach(() => {
  queryMock.mockReset();
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ success: true });
  fanoutMock.mockClear();
  filterRecipientsMock.mockClear();
  filterRecipientsMock.mockImplementation(async (_t: string, e: string[]) => e);
  filterUserIdsMock.mockClear();
  filterUserIdsMock.mockImplementation(async (ids: string[]) => ids);
  isConnectorMutedMock.mockClear();
  isConnectorMutedMock.mockResolvedValue(false);
  getConnectorAlertSettingsMock.mockClear();
  getConnectorAlertSettingsMock.mockResolvedValue({
    digestMode: false,
    digestLastSentAt: null,
    updatedAt: null,
    updatedBy: null,
  });
  getTenantAlertEmailRecipientsMock.mockClear();
  connectorSyncErrorEmailMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('notifyConnectorSyncError opt-out', () => {
  // Regression: locks in the per-event sync-error opt-out filter contract.
  // The same opt-out check that the connector auto-disable cycle uses
  // (`filterEmailRecipientsByPreference` with category 'integration') must
  // gate sync-error emails too. If a future refactor drops the filter, this
  // test fails.
  it('fans out in-app but skips sending email and skips throttle stamp when admins opted out', async () => {
    // Throttle SELECT (returns empty so we proceed past throttle check).
    queryMock.mockImplementationOnce(async () => ({ rows: [] }));
    // SELECT name FROM tenants.
    queryMock.mockImplementationOnce(async () => ({ rows: [{ name: 'Acme' }] }));

    getTenantAlertEmailRecipientsMock.mockResolvedValueOnce({
      emails: ['owner@acme.test', 'admin@acme.test'],
      userIds: ['u-1', 'u-2'],
      recipients: [
        { id: 'u-1', email: 'owner@acme.test', firstName: 'Owner', lastName: 'One' },
        { id: 'u-2', email: 'admin@acme.test', firstName: 'Admin', lastName: 'Two' },
      ],
    });
    filterRecipientsMock.mockResolvedValueOnce([]);

    await notifyConnectorSyncError({
      tenantId: 'tenant-optout',
      integrationId: 'integration-optout',
      connectorType: 'crm',
      provider: 'salesforce',
      errorMessage: 'invalid_grant',
      firstFailedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });

    // Filter must be invoked with the 'integration' category.
    expect(filterRecipientsMock).toHaveBeenCalledTimes(1);
    expect(filterRecipientsMock).toHaveBeenCalledWith(
      'tenant-optout',
      ['owner@acme.test', 'admin@acme.test'],
      'integration',
    );

    // Email side effects must NOT fire.
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(connectorSyncErrorEmailMock).not.toHaveBeenCalled();

    // Other side effects still happen: in-app fanout fires regardless of
    // email opt-out so per-user 'integration' in-app preferences are
    // honoured downstream.
    expect(fanoutMock).toHaveBeenCalledTimes(1);
    expect(fanoutMock.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-optout',
      type: 'integration',
      category: 'integration',
      metadata: expect.objectContaining({
        integrationId: 'integration-optout',
        provider: 'salesforce',
      }),
    });

    // The auth_alert_sent_at throttle stamp at the end of the function
    // must NOT fire when nobody received the email — leaving the slot
    // clear lets the next sync error retry for any not-opted-out admin.
    const stampCalls = queryMock.mock.calls.filter((c) =>
      typeof c[0] === 'string' && /UPDATE integrations[\s\S]*auth_alert_sent_at = NOW\(\)/.test(c[0]),
    );
    expect(stampCalls).toHaveLength(0);
  });
});
