import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const queryMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
}));

const sendEmailMock = vi.fn(async () => ({ success: true }));

vi.mock('../../platform/email', () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...args as []),
  connectorSyncErrorEmail: () => ({ subject: 's', html: 'h', text: 't' }),
  connectorSyncRecoveryEmail: () => ({
    subject: 'recovery',
    html: 'h',
    text: 't',
  }),
}));

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  queryMock.mockReset();
  fetchMock.mockReset();
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ success: true });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  process.env.TWILIO_ACCOUNT_SID = 'AC_test';
  process.env.TWILIO_AUTH_TOKEN = 'token_test';
  process.env.TWILIO_SMS_FROM = '+15555550100';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

describe('normalizeE164', () => {
  it('accepts already-normalized E.164 numbers', async () => {
    const { normalizeE164 } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    expect(normalizeE164('+15551234567')).toBe('+15551234567');
  });

  it('strips common formatting characters and keeps the leading plus', async () => {
    const { normalizeE164 } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    expect(normalizeE164(' +1 (555) 123-4567 ')).toBe('+15551234567');
    expect(normalizeE164('+1.555.123.4567')).toBe('+15551234567');
  });

  it('rejects numbers without a leading plus or with invalid characters', async () => {
    const { normalizeE164 } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    expect(normalizeE164('5551234567')).toBeNull();
    expect(normalizeE164('not-a-number')).toBeNull();
    expect(normalizeE164('+1234567')).toBeNull(); // too short
    expect(normalizeE164('+1234567890123456')).toBeNull(); // too long
    expect(normalizeE164(null)).toBeNull();
    expect(normalizeE164('')).toBeNull();
  });
});

describe('isRevenueCriticalProvider', () => {
  it('matches Salesforce, HubSpot, QuickBooks regardless of casing', async () => {
    const { isRevenueCriticalProvider } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    expect(isRevenueCriticalProvider('salesforce')).toBe(true);
    expect(isRevenueCriticalProvider('HubSpot')).toBe(true);
    expect(isRevenueCriticalProvider('QUICKBOOKS')).toBe(true);
    expect(isRevenueCriticalProvider('slack')).toBe(false);
    expect(isRevenueCriticalProvider(undefined)).toBe(false);
    expect(isRevenueCriticalProvider(null)).toBe(false);
  });
});

describe('notifySustainedConnectorFailure', () => {
  const baseParams = {
    tenantId: 'tenant-1',
    integrationId: 'int-1',
    connectorType: 'crm' as const,
    provider: 'salesforce',
    errorMessage: 'API rate limit',
  };

  // The alerter now begins by checking connector_alert_mutes; tests below
  // mock it as "not muted" so they can exercise the rest of the flow.
  beforeEach(() => {
    queryMock.mockResolvedValueOnce({ rows: [] });
  });

  it('skips non-revenue-critical providers', async () => {
    const { notifySustainedConnectorFailure } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifySustainedConnectorFailure({
      ...baseParams,
      provider: 'slack',
      firstFailedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    expect(queryMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips when firstFailedAt is missing', async () => {
    const { notifySustainedConnectorFailure } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifySustainedConnectorFailure({ ...baseParams, firstFailedAt: null });
    expect(queryMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips when outage is shorter than the sustained-failure threshold', async () => {
    const { notifySustainedConnectorFailure } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifySustainedConnectorFailure({
      ...baseParams,
      firstFailedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    expect(queryMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips when tenant has SMS alerts disabled', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ name: 'Acme', sms_alerts_disabled: true }],
    });
    const { notifySustainedConnectorFailure } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifySustainedConnectorFailure({
      ...baseParams,
      firstFailedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    // Mute lookup + tenant lookup were issued; nothing else.
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('respects the per-integration 24h SMS throttle', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{ name: 'Acme', sms_alerts_disabled: false }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'prev-sms' }] }); // throttle hit
    const { notifySustainedConnectorFailure } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifySustainedConnectorFailure({
      ...baseParams,
      firstFailedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    expect(queryMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs and records when no admin phone numbers are on file', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{ name: 'Acme', sms_alerts_disabled: false }],
      })
      .mockResolvedValueOnce({ rows: [] }) // throttle empty
      .mockResolvedValueOnce({ rows: [] }); // admin phones empty

    const { notifySustainedConnectorFailure } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifySustainedConnectorFailure({
      ...baseParams,
      firstFailedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends an SMS to each admin phone and records the dispatch', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{ name: 'Acme', sms_alerts_disabled: false }],
      })
      .mockResolvedValueOnce({ rows: [] }) // throttle empty
      .mockResolvedValueOnce({
        rows: [
          { id: 'user-a', phone_number: '+15551234567' },
          { id: 'user-b', phone_number: '+15557654321' },
        ],
      })
      // filterUserIdsByPreference for SMS phones — nobody opted out.
      .mockResolvedValueOnce({ rows: [] })
      // fanoutInAppNotification: load tenant users
      .mockResolvedValueOnce({
        rows: [{ id: 'user-a' }, { id: 'user-b' }],
      })
      // fanoutInAppNotification: filterUserIdsByPreference for in_app
      .mockResolvedValueOnce({ rows: [] })
      // Per-user inserts (one per opted-in user).
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => '',
    } as unknown as Response);

    const { notifySustainedConnectorFailure } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifySustainedConnectorFailure({
      ...baseParams,
      firstFailedAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstCall = fetchMock.mock.calls[0];
    const url = firstCall[0] as string;
    const init = firstCall[1] as RequestInit;
    expect(url).toContain('api.twilio.com');
    expect(url).toContain('AC_test');
    const body = String(init.body);
    expect(body).toContain('To=%2B15551234567');
    expect(body).toContain('From=%2B15555550100');
    expect(body).toContain('Salesforce');

    // The dispatch is now fanned out per-user — every insert should target
    // the SMS notification type with the integration metadata.
    const insertCalls = queryMock.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO tenant_notifications'),
    );
    expect(insertCalls.length).toBe(2);
    for (const call of insertCalls) {
      const args = call[1] as unknown[];
      expect(args[2]).toBe('integration_sms');
      const metadata = JSON.parse(args[5] as string);
      expect(metadata.integrationId).toBe('int-1');
      expect(metadata.smsAttempted).toBe(2);
      expect(metadata.smsSucceeded).toBe(2);
      expect(metadata.twilioConfigured).toBe(true);
    }
  });

  it('skips SMS sends to admins who opted out of the sms category', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{ name: 'Acme', sms_alerts_disabled: false }],
      })
      .mockResolvedValueOnce({ rows: [] }) // throttle empty
      .mockResolvedValueOnce({
        rows: [
          { id: 'user-a', phone_number: '+15551234567' },
          { id: 'user-b', phone_number: '+15557654321' },
        ],
      })
      // filterUserIdsByPreference for SMS phones — user-a opted out.
      .mockResolvedValueOnce({
        rows: [{ user_id: 'user-a', enabled: false }],
      })
      // fanoutInAppNotification: tenant users
      .mockResolvedValueOnce({
        rows: [{ id: 'user-a' }, { id: 'user-b' }],
      })
      // fanoutInAppNotification: filterUserIdsByPreference (in_app sms)
      // user-a has the sms in_app channel off.
      .mockResolvedValueOnce({
        rows: [{ user_id: 'user-a', enabled: false }],
      })
      .mockResolvedValueOnce({ rows: [] }); // insert for user-b only

    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => '',
    } as unknown as Response);

    const { notifySustainedConnectorFailure } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifySustainedConnectorFailure({
      ...baseParams,
      firstFailedAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
    });

    // Only user-b's phone got an SMS.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = String((fetchMock.mock.calls[0][1] as RequestInit).body);
    expect(body).toContain('To=%2B15557654321');
    expect(body).not.toContain('To=%2B15551234567');

    // And only one in-app row was inserted (for user-b).
    const insertCalls = queryMock.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO tenant_notifications'),
    );
    expect(insertCalls.length).toBe(1);
    expect((insertCalls[0][1] as unknown[])[1]).toBe('user-b');
  });

  it('does NOT record a throttle entry when Twilio is configured but every send fails', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{ name: 'Acme', sms_alerts_disabled: false }],
      })
      .mockResolvedValueOnce({ rows: [] }) // throttle empty
      .mockResolvedValueOnce({
        rows: [
          { id: 'user-a', phone_number: '+15551234567' },
          { id: 'user-b', phone_number: '+15557654321' },
        ],
      })
      // filterUserIdsByPreference for SMS phones — nobody opted out.
      .mockResolvedValueOnce({ rows: [] });
    // No further queries — the fan-out into tenant_notifications must be
    // skipped when every Twilio send fails so the next sync error can retry.

    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'twilio down',
    } as unknown as Response);

    const { notifySustainedConnectorFailure } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifySustainedConnectorFailure({
      ...baseParams,
      firstFailedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Only the five pre-send queries (mute lookup, tenant lookup, throttle
    // check, phones, SMS-pref filter) should have been issued — no
    // tenant_notifications insert.
    expect(queryMock).toHaveBeenCalledTimes(5);
    const insertCalls = queryMock.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO tenant_notifications'),
    );
    expect(insertCalls.length).toBe(0);
  });

  it('still records the dispatch (for throttling) when Twilio is not configured', async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_SMS_FROM;
    delete process.env.TWILIO_PHONE_NUMBER;

    queryMock
      .mockResolvedValueOnce({
        rows: [{ name: 'Acme', sms_alerts_disabled: false }],
      })
      .mockResolvedValueOnce({ rows: [] }) // throttle empty
      .mockResolvedValueOnce({ rows: [{ id: 'user-a', phone_number: '+15551234567' }] })
      // filterUserIdsByPreference for SMS phones — nobody opted out.
      .mockResolvedValueOnce({ rows: [] })
      // fanoutInAppNotification: tenant users
      .mockResolvedValueOnce({ rows: [{ id: 'user-a' }] })
      // fanoutInAppNotification: filterUserIdsByPreference
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }); // insert

    const { notifySustainedConnectorFailure } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifySustainedConnectorFailure({
      ...baseParams,
      firstFailedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    const insertCalls = queryMock.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO tenant_notifications'),
    );
    expect(insertCalls.length).toBe(1);
    const metadata = JSON.parse((insertCalls[0][1] as unknown[])[5] as string);
    expect(metadata.twilioConfigured).toBe(false);
    expect(metadata.smsAttempted).toBe(0);
  });
});

describe('notifyConnectorRecovery', () => {
  const baseParams = {
    tenantId: 'tenant-1',
    integrationId: 'int-1',
    connectorType: 'crm' as const,
    provider: 'salesforce',
    outageDurationMs: 90 * 60 * 1000,
  };

  // Recovery now also runs the mute check first; mock it as not muted.
  beforeEach(() => {
    queryMock.mockResolvedValueOnce({ rows: [] });
  });

  it('skips non-revenue-critical providers', async () => {
    const { notifyConnectorRecovery } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorRecovery({ ...baseParams, provider: 'slack' });
    expect(queryMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('respects the 24h throttle from integrations.recovery_alert_sent_at', async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    queryMock.mockResolvedValueOnce({
      rows: [{ recovery_alert_sent_at: oneHourAgo }],
    });

    const { notifyConnectorRecovery } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorRecovery(baseParams);

    // Mute lookup + throttle check; nothing else.
    expect(queryMock).toHaveBeenCalledTimes(2);
    const throttleArgs = queryMock.mock.calls[1];
    expect(String(throttleArgs[0])).toContain('recovery_alert_sent_at');
    expect(String(throttleArgs[0])).toContain('FROM integrations');
    // Must scope by both id and tenant_id so two HubSpot connectors for
    // the same tenant don't suppress each other.
    expect(throttleArgs[1]).toEqual(['int-1', 'tenant-1']);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('proceeds when the recovery throttle marker is older than the window', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    queryMock
      .mockResolvedValueOnce({
        rows: [{ recovery_alert_sent_at: twoDaysAgo }],
      })
      .mockResolvedValueOnce({ rows: [{ id: 'user-a' }] }) // tenant users
      .mockResolvedValueOnce({ rows: [] }) // in_app pref filter
      .mockResolvedValueOnce({ rows: [] }) // INSERT for user-a
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE recovery_alert_sent_at
      .mockResolvedValueOnce({ rows: [{ name: 'Acme' }] }) // tenant lookup
      .mockResolvedValueOnce({ rows: [{ email: 'admin@acme.test' }] }) // admins
      .mockResolvedValueOnce({ rows: [] }); // email pref filter

    const { notifyConnectorRecovery } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorRecovery(baseParams);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('records an in-app notification and emails admins on recovery', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ recovery_alert_sent_at: null }] }) // throttle marker absent
      // fanoutInAppNotification: tenant users
      .mockResolvedValueOnce({
        rows: [{ id: 'user-a' }, { id: 'user-b' }],
      })
      // fanoutInAppNotification: filterUserIdsByPreference (in_app)
      .mockResolvedValueOnce({ rows: [] })
      // Per-user INSERTs into tenant_notifications
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      // UPDATE integrations SET recovery_alert_sent_at
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // tenant name lookup
      .mockResolvedValueOnce({ rows: [{ name: 'Acme' }] })
      // admin email lookup
      .mockResolvedValueOnce({
        rows: [{ email: 'admin@acme.test' }, { email: 'owner@acme.test' }],
      })
      // filterEmailRecipientsByPreference for integration_recovery email
      .mockResolvedValueOnce({ rows: [] });

    const { notifyConnectorRecovery } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorRecovery(baseParams);

    const insertCalls = queryMock.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO tenant_notifications'),
    );
    expect(insertCalls.length).toBe(2);
    for (const call of insertCalls) {
      const args = call[1] as unknown[];
      expect(args[2]).toBe('integration_recovery');
      const metadata = JSON.parse(args[5] as string);
      expect(metadata.integrationId).toBe('int-1');
      expect(metadata.provider).toBe('salesforce');
      expect(metadata.outageDurationMs).toBe(90 * 60 * 1000);
      expect(metadata.outageDescription).toBeTruthy();
    }

    // The throttle marker must have been stamped.
    const stampCall = queryMock.mock.calls.find((c) =>
      String(c[0]).includes('UPDATE integrations') &&
      String(c[0]).includes('recovery_alert_sent_at'),
    );
    expect(stampCall).toBeDefined();
    expect(stampCall![1]).toEqual(['int-1', 'tenant-1']);

    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    const recipients = sendEmailMock.mock.calls.map(
      (c) => (c[0] as { to: string }).to,
    );
    expect(recipients).toEqual(
      expect.arrayContaining(['admin@acme.test', 'owner@acme.test']),
    );
  });

  it('still notifies after a long outage (>7 days)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // throttle: no integration row found
      .mockResolvedValueOnce({ rows: [{ id: 'user-a' }] }) // tenant users
      .mockResolvedValueOnce({ rows: [] }) // in_app pref filter
      .mockResolvedValueOnce({ rows: [] }) // INSERT for user-a
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE recovery_alert_sent_at
      .mockResolvedValueOnce({ rows: [{ name: 'Acme' }] }) // tenant lookup
      .mockResolvedValueOnce({ rows: [{ email: 'admin@acme.test' }] }) // admins
      .mockResolvedValueOnce({ rows: [] }); // email pref filter

    const tenDaysMs = 10 * 24 * 60 * 60 * 1000;
    const { notifyConnectorRecovery } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorRecovery({ ...baseParams, outageDurationMs: tenDaysMs });

    const insertCall = queryMock.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO tenant_notifications'),
    );
    expect(insertCall).toBeDefined();
    const metadata = JSON.parse((insertCall![1] as unknown[])[5] as string);
    expect(metadata.outageDurationMs).toBe(tenDaysMs);
    expect(metadata.outageDescription).toMatch(/day/);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('still records the in-app notification when no admin emails are on file', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ recovery_alert_sent_at: null }] }) // throttle absent
      .mockResolvedValueOnce({ rows: [{ id: 'user-a' }] }) // tenant users
      .mockResolvedValueOnce({ rows: [] }) // in_app pref filter
      .mockResolvedValueOnce({ rows: [] }) // INSERT for user-a
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE recovery_alert_sent_at
      .mockResolvedValueOnce({ rows: [{ name: 'Acme' }] }) // tenant lookup
      .mockResolvedValueOnce({ rows: [] }); // no admin emails

    const { notifyConnectorRecovery } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorRecovery({ ...baseParams, outageDurationMs: null });

    const insertCall = queryMock.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO tenant_notifications'),
    );
    expect(insertCall).toBeDefined();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('suppresses recovery email when all admins opted out of integration_recovery email but still inserts in-app entry', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // throttle absent
      .mockResolvedValueOnce({ rows: [{ id: 'user-a' }] }) // tenant users
      .mockResolvedValueOnce({ rows: [] }) // in_app pref filter — nobody opted out
      .mockResolvedValueOnce({ rows: [] }) // INSERT for user-a
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE recovery_alert_sent_at
      .mockResolvedValueOnce({ rows: [{ name: 'Acme' }] }) // tenant lookup
      .mockResolvedValueOnce({ rows: [{ email: 'admin@acme.test' }] }) // admin emails
      // filterEmailRecipientsByPreference: admin@acme.test opted OUT of recovery email
      .mockResolvedValueOnce({
        rows: [{ email: 'admin@acme.test', enabled: false }],
      });

    const { notifyConnectorRecovery } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorRecovery(baseParams);

    // The in-app notification should still have been recorded.
    const insertCalls = queryMock.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO tenant_notifications'),
    );
    expect(insertCalls.length).toBe(1);
    expect((insertCalls[0][1] as unknown[])[2]).toBe('integration_recovery');

    // But no email should have been sent.
    expect(sendEmailMock).not.toHaveBeenCalled();

    // And the email-pref filter must have been called with the
    // 'integration_recovery' category (not the failure category).
    const prefFilterCall = queryMock.mock.calls.find((c) => {
      const sql = String(c[0]);
      return sql.includes('user_notification_preferences') && sql.includes('LOWER(u.email)');
    });
    expect(prefFilterCall).toBeDefined();
    expect(prefFilterCall![1][2]).toBe('integration_recovery');
  });

  it('still stamps the throttle marker when every admin opts out of in_app for integration_recovery, preventing repeated emails', async () => {
    // Simulate "in-app off, email on" — every active admin has opted out
    // of the in_app channel for integration_recovery, so fanout produces
    // zero rows. The throttle marker MUST still be stamped so a second
    // call within the window does not re-send the email.
    queryMock
      .mockResolvedValueOnce({ rows: [] }) // throttle absent (1st call)
      .mockResolvedValueOnce({ rows: [{ id: 'user-a' }] }) // tenant users
      // in_app pref filter — user-a explicitly OFF
      .mockResolvedValueOnce({ rows: [{ user_id: 'user-a', enabled: false }] })
      // No per-user INSERT happens because eligible list is empty.
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // UPDATE recovery_alert_sent_at
      .mockResolvedValueOnce({ rows: [{ name: 'Acme' }] }) // tenant lookup
      .mockResolvedValueOnce({ rows: [{ email: 'admin@acme.test' }] }) // admins
      .mockResolvedValueOnce({ rows: [] }); // email pref filter — nobody opted out

    const { notifyConnectorRecovery } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorRecovery(baseParams);

    // No in-app rows inserted (everyone opted out).
    const insertCalls = queryMock.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO tenant_notifications'),
    );
    expect(insertCalls.length).toBe(0);

    // Throttle marker stamped despite zero in-app inserts.
    const stampCall = queryMock.mock.calls.find((c) =>
      String(c[0]).includes('UPDATE integrations') &&
      String(c[0]).includes('recovery_alert_sent_at'),
    );
    expect(stampCall).toBeDefined();

    // Email DID go out (only in_app was muted, not email).
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('does not send email if the throttle stamp matches zero rows (e.g. integration deleted mid-flight)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ recovery_alert_sent_at: null }] }) // throttle absent
      .mockResolvedValueOnce({ rows: [{ id: 'user-a' }] }) // tenant users
      .mockResolvedValueOnce({ rows: [] }) // in_app pref filter
      .mockResolvedValueOnce({ rows: [] }) // INSERT for user-a
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // UPDATE matched 0 rows

    const { notifyConnectorRecovery } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorRecovery(baseParams);

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('does not send email if stamping the throttle marker fails (avoids unbounded retries)', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ recovery_alert_sent_at: null }] }) // throttle absent
      .mockResolvedValueOnce({ rows: [{ id: 'user-a' }] }) // tenant users
      .mockResolvedValueOnce({ rows: [] }) // in_app pref filter
      .mockResolvedValueOnce({ rows: [] }) // INSERT for user-a
      .mockRejectedValueOnce(new Error('db down')); // UPDATE recovery_alert_sent_at FAILS

    const { notifyConnectorRecovery } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorRecovery(baseParams);

    // No email sent — bail to avoid spamming on every retry.
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe('notifyConnectorSyncError', () => {
  // Query order in notifyConnectorSyncError:
  //  1. SELECT id FROM tenant_notifications ... (throttle check)
  //  2. fanoutInAppNotification:
  //       a. SELECT id FROM users WHERE tenant_id = $1 ... (tenant users)
  //       b. SELECT user_id, enabled FROM user_notification_preferences ... (in_app pref filter)
  //       c. INSERT INTO tenant_notifications ... (per opted-in user)
  //  3. SELECT name FROM tenants WHERE id = $1
  //  4. SELECT email FROM users WHERE role IN ('admin','owner') ...
  //  5. filterEmailRecipientsByPreference (SELECT ... LEFT JOIN user_notification_preferences)
  //  6. UPDATE integrations SET auth_alert_sent_at = NOW() ... (stamp marker)

  const baseParams = {
    tenantId: 'tenant-1',
    integrationId: 'int-1',
    connectorType: 'crm' as const,
    provider: 'salesforce',
    errorMessage: 'API rate limit exceeded',
  };

  it('skips non-revenue-critical providers (no throttle check, no fan-out, no email)', async () => {
    const { notifyConnectorSyncError } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorSyncError({ ...baseParams, provider: 'slack' });
    expect(queryMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('honors per-user opt-outs: drops in-app for users with integration in_app off and drops email for opted-out admins', async () => {
    queryMock
      // 1. throttle check — empty
      .mockResolvedValueOnce({ rows: [] })
      // 2a. fanoutInAppNotification: tenant users
      .mockResolvedValueOnce({
        rows: [{ id: 'user-a' }, { id: 'user-b' }],
      })
      // 2b. fanoutInAppNotification: in_app pref filter — user-a opted OUT
      //     of integration in_app channel.
      .mockResolvedValueOnce({
        rows: [{ user_id: 'user-a', enabled: false }],
      })
      // 2c. INSERT for user-b only (user-a was filtered out)
      .mockResolvedValueOnce({ rows: [] })
      // 3. tenant name
      .mockResolvedValueOnce({ rows: [{ name: 'Acme' }] })
      // 4. admin email lookup
      .mockResolvedValueOnce({
        rows: [
          { email: 'owner@acme.test' },
          { email: 'admin@acme.test' },
        ],
      })
      // 5. filterEmailRecipientsByPreference — admin@acme.test opted OUT of
      //    integration email channel.
      .mockResolvedValueOnce({
        rows: [{ email: 'admin@acme.test', enabled: false }],
      })
      // 6. UPDATE integrations SET auth_alert_sent_at
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const { notifyConnectorSyncError } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorSyncError(baseParams);

    // In-app: only one row inserted, and it must target user-b (user-a opted out).
    const insertCalls = queryMock.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO tenant_notifications'),
    );
    expect(insertCalls.length).toBe(1);
    const insertArgs = insertCalls[0][1] as unknown[];
    expect(insertArgs[1]).toBe('user-b');
    expect(insertArgs[2]).toBe('integration');
    const metadata = JSON.parse(insertArgs[5] as string);
    expect(metadata.integrationId).toBe('int-1');
    expect(metadata.provider).toBe('salesforce');

    // Email: only owner@acme.test should receive it (admin@acme.test opted out).
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect((sendEmailMock.mock.calls[0][0] as { to: string }).to).toBe('owner@acme.test');

    // The email pref filter must have been called with the 'integration' category.
    const prefFilterCall = queryMock.mock.calls.find((c) => {
      const sql = String(c[0]);
      return sql.includes('user_notification_preferences') && sql.includes('LOWER(u.email)');
    });
    expect(prefFilterCall).toBeDefined();
    expect(prefFilterCall![1][2]).toBe('integration');
  });

  it('suppresses email entirely (and logs) when every admin has opted out of integration email', async () => {
    queryMock
      // 1. throttle check — empty
      .mockResolvedValueOnce({ rows: [] })
      // 2a. tenant users
      .mockResolvedValueOnce({ rows: [{ id: 'user-a' }] })
      // 2b. in_app pref filter — nobody opted out
      .mockResolvedValueOnce({ rows: [] })
      // 2c. INSERT for user-a
      .mockResolvedValueOnce({ rows: [] })
      // 3. tenant name
      .mockResolvedValueOnce({ rows: [{ name: 'Acme' }] })
      // 4. admin emails
      .mockResolvedValueOnce({ rows: [{ email: 'admin@acme.test' }] })
      // 5. filterEmailRecipientsByPreference: admin opted OUT
      .mockResolvedValueOnce({
        rows: [{ email: 'admin@acme.test', enabled: false }],
      });
    // No further queries expected — early return before stamping
    // auth_alert_sent_at because there's nobody to email.

    const { notifyConnectorSyncError } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorSyncError(baseParams);

    // In-app row still recorded for user-a.
    const insertCalls = queryMock.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO tenant_notifications'),
    );
    expect(insertCalls.length).toBe(1);

    // No email sent.
    expect(sendEmailMock).not.toHaveBeenCalled();

    // Throttle marker was NOT stamped (the function bails before the UPDATE).
    const stampCall = queryMock.mock.calls.find((c) => {
      const sql = String(c[0]);
      return sql.includes('UPDATE integrations') && sql.includes('auth_alert_sent_at');
    });
    expect(stampCall).toBeUndefined();
  });

  it('suppresses in-app entirely when every active user has opted out of integration in_app, but still emails admins who allow integration email', async () => {
    queryMock
      // 1. throttle check — empty
      .mockResolvedValueOnce({ rows: [] })
      // 2a. tenant users
      .mockResolvedValueOnce({ rows: [{ id: 'user-a' }] })
      // 2b. in_app pref filter — user-a OFF
      .mockResolvedValueOnce({
        rows: [{ user_id: 'user-a', enabled: false }],
      })
      // 2c. (no INSERT — eligible list empty)
      // 3. tenant name
      .mockResolvedValueOnce({ rows: [{ name: 'Acme' }] })
      // 4. admin emails
      .mockResolvedValueOnce({ rows: [{ email: 'admin@acme.test' }] })
      // 5. email pref filter — nobody opted out of email
      .mockResolvedValueOnce({ rows: [] })
      // 6. UPDATE integrations SET auth_alert_sent_at
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const { notifyConnectorSyncError } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorSyncError(baseParams);

    // No in-app rows inserted — every active user opted out of in_app.
    const insertCalls = queryMock.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO tenant_notifications'),
    );
    expect(insertCalls.length).toBe(0);

    // Email still went out — opt-outs are per (category, channel).
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect((sendEmailMock.mock.calls[0][0] as { to: string }).to).toBe('admin@acme.test');

    // Throttle marker stamped after a successful email round.
    const stampCall = queryMock.mock.calls.find((c) => {
      const sql = String(c[0]);
      return sql.includes('UPDATE integrations') && sql.includes('auth_alert_sent_at');
    });
    expect(stampCall).toBeDefined();
  });
});
