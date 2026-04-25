import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const queryMock = vi.fn();
const fetchMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
}));

vi.mock('../../platform/email', () => ({
  sendEmail: vi.fn(async () => ({ success: true })),
  connectorSyncErrorEmail: () => ({ subject: 's', html: 'h', text: 't' }),
}));

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  queryMock.mockReset();
  fetchMock.mockReset();
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
    // Only the tenant lookup query was issued.
    expect(queryMock).toHaveBeenCalledTimes(1);
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
    expect(queryMock).toHaveBeenCalledTimes(2);
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
    // Only the four pre-send queries (tenant lookup, throttle check, phones,
    // SMS-pref filter) should have been issued — no tenant_notifications
    // insert.
    expect(queryMock).toHaveBeenCalledTimes(4);
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
