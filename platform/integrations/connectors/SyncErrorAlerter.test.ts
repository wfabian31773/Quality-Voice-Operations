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
  getTenantAlertPhoneRecipientsMock: vi.fn(async () => [] as Array<{
    id: string;
    phone_number: string | null;
    first_name: string | null;
    last_name: string | null;
    email: string | null;
  }>),
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

import {
  notifyConnectorRecovery,
  notifyConnectorSyncError,
  notifySustainedConnectorFailure,
} from './SyncErrorAlerter';

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
  getTenantAlertPhoneRecipientsMock.mockClear();
  getTenantAlertPhoneRecipientsMock.mockResolvedValue([]);
  connectorSyncErrorEmailMock.mockClear();
  connectorSyncRecoveryEmailMock.mockClear();
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

describe('notifyConnectorRecovery opt-out', () => {
  // Regression: locks in the recovery email opt-out filter contract.
  // `filterEmailRecipientsByPreference` must gate the "back online" email
  // with category 'integration_recovery' so admins who muted recovery
  // emails don't get spammed every time a connector flaps. If a future
  // refactor drops the filter, this test fails.
  it('fans out in-app and stamps throttle but skips sending email when admins opted out of recovery', async () => {
    // 1) Throttle SELECT on integrations (no prior recovery alert -> proceed).
    queryMock.mockImplementationOnce(async () => ({
      rows: [{ recovery_alert_sent_at: null }],
    }));
    // 2) UPDATE integrations recovery_alert_sent_at stamp (must succeed
    //    with rowCount >= 1 so the function continues to the email step
    //    rather than bailing on a missing row).
    queryMock.mockImplementationOnce(async () => ({ rowCount: 1, rows: [] }));
    // 3) SELECT name FROM tenants for the email template.
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

    await notifyConnectorRecovery({
      tenantId: 'tenant-recovery-optout',
      integrationId: 'integration-recovery-optout',
      connectorType: 'crm',
      provider: 'salesforce',
      outageDurationMs: 90 * 60 * 1000,
    });

    // Filter must be invoked with the 'integration_recovery' category — the
    // dedicated category that admins toggle off when they only want
    // failure alerts, not recovery confirmations.
    expect(filterRecipientsMock).toHaveBeenCalledTimes(1);
    expect(filterRecipientsMock).toHaveBeenCalledWith(
      'tenant-recovery-optout',
      ['owner@acme.test', 'admin@acme.test'],
      'integration_recovery',
    );

    // Email side effects must NOT fire when every admin opted out.
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(connectorSyncRecoveryEmailMock).not.toHaveBeenCalled();

    // In-app fanout still happens — per-user 'integration_recovery' in_app
    // preferences are honoured separately by fanoutInAppNotification, and
    // the in-app surface is what populates the admin notifications drawer.
    expect(fanoutMock).toHaveBeenCalledTimes(1);
    expect(fanoutMock.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-recovery-optout',
      type: 'integration_recovery',
      category: 'integration_recovery',
      metadata: expect.objectContaining({
        integrationId: 'integration-recovery-optout',
        provider: 'salesforce',
      }),
    });

    // The recovery_alert_sent_at throttle stamp MUST still fire even when
    // every admin opted out of email — the marker exists to suppress
    // duplicate recovery dispatch attempts on the next sync regardless of
    // whether the email itself went out.
    const stampCalls = queryMock.mock.calls.filter((c) =>
      typeof c[0] === 'string' &&
      /UPDATE integrations[\s\S]*recovery_alert_sent_at = NOW\(\)/.test(c[0]),
    );
    expect(stampCalls).toHaveLength(1);
  });
});

describe('notifySustainedConnectorFailure opt-out', () => {
  // Regression: locks in the sustained-SMS opt-out filter contract.
  // `filterUserIdsByPreference` with ('sms', 'in_app') must gate the
  // outage page so admins who explicitly turned off SMS-style alerts are
  // not woken up. If a future refactor drops the filter, this test fails.
  it('skips Twilio and skips throttle when every admin opted out of SMS-category alerts', async () => {
    // 1) SELECT name, sms_alerts_disabled FROM tenants — tenant-level SMS
    //    is enabled so we proceed past the tenant gate to the per-user check.
    queryMock.mockImplementationOnce(async () => ({
      rows: [{ name: 'Acme', sms_alerts_disabled: false }],
    }));
    // 2) SELECT id FROM tenant_notifications throttle — empty so we are
    //    not throttled by a prior sustained alert.
    queryMock.mockImplementationOnce(async () => ({ rows: [] }));

    // Two admins on file, both with valid E.164 numbers. After the opt-out
    // filter returns [], neither should be paged.
    getTenantAlertPhoneRecipientsMock.mockResolvedValueOnce([
      {
        id: 'u-1',
        phone_number: '+15551234567',
        first_name: 'Owner',
        last_name: 'One',
        email: 'owner@acme.test',
      },
      {
        id: 'u-2',
        phone_number: '+15557654321',
        first_name: 'Admin',
        last_name: 'Two',
        email: 'admin@acme.test',
      },
    ]);
    filterUserIdsMock.mockResolvedValueOnce([]);

    // Spy on global fetch so we can prove no Twilio request was made.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('{}', { status: 200 }),
    );

    try {
      await notifySustainedConnectorFailure({
        tenantId: 'tenant-sms-optout',
        integrationId: 'integration-sms-optout',
        connectorType: 'crm',
        provider: 'salesforce',
        errorMessage: 'invalid_grant',
        // Older than SUSTAINED_FAILURE_MS (1h) so we get past the outage
        // duration gate and reach the opt-out filter.
        firstFailedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      });

      // Filter must be invoked with ('sms', 'in_app') — the per-user "I
      // don't want SMS-style outage alerts" preference proxy.
      expect(filterUserIdsMock).toHaveBeenCalledTimes(1);
      expect(filterUserIdsMock).toHaveBeenCalledWith(
        ['u-1', 'u-2'],
        'sms',
        'in_app',
      );

      // No Twilio request, no in-app fanout, and no per-recipient audit
      // INSERTs — the function bails immediately when nobody is opted in.
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(fanoutMock).not.toHaveBeenCalled();
      const auditInserts = queryMock.mock.calls.filter((c) =>
        typeof c[0] === 'string' &&
        /INSERT INTO connector_alert_recipients/.test(c[0]),
      );
      expect(auditInserts).toHaveLength(0);

      // The 24h SMS throttle row in tenant_notifications must NOT be
      // recorded — leaving it clear lets the next sustained-failure check
      // retry once an admin re-enables SMS alerts.
      const throttleInserts = queryMock.mock.calls.filter((c) =>
        typeof c[0] === 'string' &&
        /INSERT INTO tenant_notifications/.test(c[0]),
      );
      expect(throttleInserts).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
