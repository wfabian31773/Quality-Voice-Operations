import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  queryMock,
  sendEmailMock,
  connectorAutoDisabledEmailMock,
  connectorReconnectNeededEmailMock,
  connectorSyncErrorEmailMock,
  connectorSyncDigestEmailMock,
  fanoutMock,
  filterRecipientsMock,
  writeAuditLogMock,
  getConnectorAlertSettingsMock,
  loadMuteSetsForTenantsMock,
  recordDigestSentMock,
} = vi.hoisted(() => ({
  queryMock: vi.fn(),
  sendEmailMock: vi.fn(),
  connectorAutoDisabledEmailMock: vi.fn(() => ({
    subject: 'We disabled your integration',
    html: '<p>html</p>',
    text: 'text',
  })),
  connectorReconnectNeededEmailMock: vi.fn(() => ({
    subject: 'Reconnect needed',
    html: '<p>html</p>',
    text: 'text',
  })),
  connectorSyncErrorEmailMock: vi.fn(() => ({
    subject: 'Sync error',
    html: '<p>html</p>',
    text: 'text',
  })),
  connectorSyncDigestEmailMock: vi.fn(() => ({
    subject: 'Connector digest',
    html: '<p>html</p>',
    text: 'text',
  })),
  fanoutMock: vi.fn().mockResolvedValue(undefined),
  filterRecipientsMock: vi.fn(async (_t: string, e: string[]) => e),
  writeAuditLogMock: vi.fn().mockResolvedValue(undefined),
  getConnectorAlertSettingsMock: vi.fn(async () => ({
    digestMode: false,
    digestLastSentAt: null,
    updatedAt: null,
    updatedBy: null,
  })),
  loadMuteSetsForTenantsMock: vi.fn(async () => new Map()),
  recordDigestSentMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
}));

vi.mock('../../email', () => ({
  sendEmail: sendEmailMock,
  connectorSyncErrorEmail: connectorSyncErrorEmailMock,
  connectorAutoDisabledEmail: connectorAutoDisabledEmailMock,
  connectorReconnectNeededEmail: connectorReconnectNeededEmailMock,
  connectorSyncDigestEmail: connectorSyncDigestEmailMock,
}));

vi.mock('../../notifications/NotificationPreferences', () => ({
  fanoutInAppNotification: fanoutMock,
  filterEmailRecipientsByPreference: filterRecipientsMock,
}));

vi.mock('../../audit/AuditService', () => ({
  writeAuditLog: writeAuditLogMock,
}));

vi.mock('./ConnectorAlertPreferences', () => ({
  getConnectorAlertSettings: getConnectorAlertSettingsMock,
  loadMuteSetsForTenants: loadMuteSetsForTenantsMock,
  recordDigestSent: recordDigestSentMock,
}));

import {
  dispatchConnectorAuthAlert,
  getAutoDisableThresholdDays,
  isAuthError,
  runConnectorAuthAlertCycle,
  runConnectorAutoDisableCycle,
} from './ConnectorAuthAlertScheduler';

function setupQueries(opts: {
  pending: Array<{
    tenant_id: string;
    integration_id: string;
    provider: string;
    integration_type: string;
    name: string | null;
    last_sync_status: string | null;
    last_sync_error: string | null;
    last_sync_error_at: Date | null;
  }>;
  flipRowCount?: number;
  tenantName?: string | null;
  adminEmails?: string[];
}) {
  queryMock.mockReset();
  // Order of queries inside runConnectorAutoDisableCycle per row:
  //   1. SELECT pending
  //   2. UPDATE integrations SET is_enabled = FALSE ... (per row)
  //   3. SELECT name FROM tenants ... (per row, in getTenantAdmins)
  //   4. SELECT email FROM users ... (per row, in getTenantAdmins)
  queryMock.mockImplementationOnce(async () => ({ rows: opts.pending }));
  for (let i = 0; i < opts.pending.length; i += 1) {
    queryMock.mockImplementationOnce(async () => ({ rowCount: opts.flipRowCount ?? 1 }));
    queryMock.mockImplementationOnce(async () => ({
      rows: opts.tenantName !== undefined ? [{ name: opts.tenantName }] : [],
    }));
    queryMock.mockImplementationOnce(async () => ({
      rows: (opts.adminEmails ?? ['admin@example.com']).map((email) => ({ email })),
    }));
  }
}

beforeEach(() => {
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ success: true });
  fanoutMock.mockClear();
  filterRecipientsMock.mockClear();
  filterRecipientsMock.mockImplementation(async (_t: string, e: string[]) => e);
  writeAuditLogMock.mockClear();
  connectorAutoDisabledEmailMock.mockClear();
  connectorReconnectNeededEmailMock.mockClear();
  connectorSyncErrorEmailMock.mockClear();
  connectorSyncDigestEmailMock.mockClear();
  getConnectorAlertSettingsMock.mockClear();
  getConnectorAlertSettingsMock.mockResolvedValue({
    digestMode: false,
    digestLastSentAt: null,
    updatedAt: null,
    updatedBy: null,
  });
  loadMuteSetsForTenantsMock.mockClear();
  loadMuteSetsForTenantsMock.mockResolvedValue(new Map());
  recordDigestSentMock.mockClear();
  delete process.env.CONNECTOR_AUTO_DISABLE_DAYS;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('getAutoDisableThresholdDays', () => {
  it('defaults to 14 days when env is unset', () => {
    expect(getAutoDisableThresholdDays()).toBe(14);
  });

  it('reads positive integer from env', () => {
    process.env.CONNECTOR_AUTO_DISABLE_DAYS = '7';
    expect(getAutoDisableThresholdDays()).toBe(7);
  });

  it('falls back to 14 for non-numeric values', () => {
    process.env.CONNECTOR_AUTO_DISABLE_DAYS = 'banana';
    expect(getAutoDisableThresholdDays()).toBe(14);
  });

  it('falls back to 14 for non-positive values', () => {
    process.env.CONNECTOR_AUTO_DISABLE_DAYS = '0';
    expect(getAutoDisableThresholdDays()).toBe(14);
    process.env.CONNECTOR_AUTO_DISABLE_DAYS = '-3';
    expect(getAutoDisableThresholdDays()).toBe(14);
  });
});

describe('isAuthError gating', () => {
  it('matches common auth-class errors', () => {
    expect(isAuthError('HTTP 401 Unauthorized')).toBe(true);
    expect(isAuthError('invalid_grant')).toBe(true);
    expect(isAuthError('refresh token expired')).toBe(true);
    expect(isAuthError('token_revoked')).toBe(true);
  });

  it('does not match transient 5xx / network errors', () => {
    expect(isAuthError('HTTP 502 bad gateway')).toBe(false);
    expect(isAuthError('ECONNRESET')).toBe(false);
    expect(isAuthError(null)).toBe(false);
  });
});

describe('runConnectorAutoDisableCycle', () => {
  it('returns zero counts when nothing pending', async () => {
    queryMock.mockReset();
    queryMock.mockImplementationOnce(async () => ({ rows: [] }));

    const result = await runConnectorAutoDisableCycle(14);

    expect(result).toEqual({
      inspected: 0,
      disabled: 0,
      emailedRecipients: 0,
      skippedNoRecipients: 0,
    });
    expect(fanoutMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(writeAuditLogMock).not.toHaveBeenCalled();
  });

  it('flips integration, fans out notification, audits, and emails admins', async () => {
    const failedAt = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    setupQueries({
      pending: [
        {
          tenant_id: 'tenant-1',
          integration_id: 'integration-1',
          provider: 'salesforce',
          integration_type: 'crm',
          name: 'Salesforce',
          last_sync_status: 'needs_reconnect',
          last_sync_error: 'invalid_grant',
          last_sync_error_at: failedAt,
        },
      ],
      tenantName: 'Acme',
      adminEmails: ['owner@acme.test', 'admin@acme.test'],
    });

    const result = await runConnectorAutoDisableCycle(14);

    expect(result.inspected).toBe(1);
    expect(result.disabled).toBe(1);
    expect(result.emailedRecipients).toBe(2);
    expect(result.skippedNoRecipients).toBe(0);

    // The atomic flip query re-asserts is_enabled = TRUE, last_sync_status,
    // and (for error rows) the exact last_sync_error so the auth-class regex
    // applied at SELECT time can't be raced past by a status change.
    const flipCall = queryMock.mock.calls[1];
    expect(flipCall[0]).toMatch(/UPDATE integrations[\s\S]*is_enabled = FALSE/);
    expect(flipCall[0]).toMatch(/auto_disabled_at = NOW\(\)/);
    expect(flipCall[0]).toMatch(/is_enabled = TRUE/);
    expect(flipCall[0]).toMatch(/auto_disabled_at IS NULL/);
    expect(flipCall[0]).toMatch(/last_sync_status = \$3/);
    expect(flipCall[0]).toMatch(/last_sync_error = \$4/);
    expect(flipCall[1]).toEqual([
      'integration-1',
      'tenant-1',
      'needs_reconnect',
      'invalid_grant',
    ]);

    expect(fanoutMock).toHaveBeenCalledTimes(1);
    expect(fanoutMock.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-1',
      type: 'integration_disabled',
      category: 'integration',
      metadata: expect.objectContaining({
        reason: 'auto_disabled',
        provider: 'salesforce',
        integrationId: 'integration-1',
      }),
    });

    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        actorUserId: 'system',
        action: 'connector.auto_disabled',
        resourceType: 'connector',
        resourceId: 'integration-1',
      }),
    );

    expect(connectorAutoDisabledEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantName: 'Acme',
        providerLabel: 'Salesforce',
      }),
    );

    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    expect(sendEmailMock.mock.calls.map((c) => c[0].to)).toEqual([
      'owner@acme.test',
      'admin@acme.test',
    ]);
  });

  it('skips email but still disables when admins have opted out', async () => {
    setupQueries({
      pending: [
        {
          tenant_id: 'tenant-1',
          integration_id: 'integration-2',
          provider: 'hubspot',
          integration_type: 'crm',
          name: 'HubSpot',
          last_sync_status: 'error',
          last_sync_error: 'HTTP 401 unauthorized',
          last_sync_error_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        },
      ],
      tenantName: 'Acme',
      adminEmails: ['admin@acme.test'],
    });
    filterRecipientsMock.mockResolvedValueOnce([]);

    const result = await runConnectorAutoDisableCycle(14);

    expect(result.disabled).toBe(1);
    expect(result.emailedRecipients).toBe(0);
    expect(result.skippedNoRecipients).toBe(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
    // Notification + audit still happen because the flip succeeded.
    expect(fanoutMock).toHaveBeenCalledTimes(1);
    expect(writeAuditLogMock).toHaveBeenCalledTimes(1);
  });

  // Regression: locks in the auto-disable opt-out filter contract.
  it('regression: routes auto-disable email recipients through the integration opt-out filter', async () => {
    const failedAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    setupQueries({
      pending: [
        {
          tenant_id: 'tenant-optout',
          integration_id: 'integration-optout',
          provider: 'hubspot',
          integration_type: 'crm',
          name: 'HubSpot',
          last_sync_status: 'needs_reconnect',
          last_sync_error: 'invalid_grant',
          last_sync_error_at: failedAt,
        },
      ],
      tenantName: 'Acme',
      adminEmails: ['owner@acme.test', 'ops@acme.test', 'admin@acme.test'],
    });
    filterRecipientsMock.mockResolvedValueOnce([]);

    const result = await runConnectorAutoDisableCycle(14);

    expect(filterRecipientsMock).toHaveBeenCalledTimes(1);
    expect(filterRecipientsMock).toHaveBeenCalledWith(
      'tenant-optout',
      ['owner@acme.test', 'ops@acme.test', 'admin@acme.test'],
      'integration',
    );

    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(connectorAutoDisabledEmailMock).not.toHaveBeenCalled();

    expect(result.inspected).toBe(1);
    expect(result.disabled).toBe(1);
    expect(result.emailedRecipients).toBe(0);
    expect(result.skippedNoRecipients).toBe(1);
    expect(fanoutMock).toHaveBeenCalledTimes(1);
    expect(fanoutMock.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-optout',
      type: 'integration_disabled',
      category: 'integration',
      metadata: expect.objectContaining({
        reason: 'auto_disabled',
        integrationId: 'integration-optout',
      }),
    });
    expect(writeAuditLogMock).toHaveBeenCalledTimes(1);
    expect(writeAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-optout',
        action: 'connector.auto_disabled',
        resourceType: 'connector',
        resourceId: 'integration-optout',
      }),
    );
  });

  it('disables a needs_reconnect row even when last_sync_error is null', async () => {
    // This is the regression case: a connector that flipped from healthy
    // straight into `needs_reconnect` (e.g. expired refresh token via
    // `markConnectorReconnectNeeded`). With the COALESCE() change in db.ts,
    // `last_sync_error_at` is now stamped on transition, so it ages out and
    // the auth-class gate (status === 'needs_reconnect') still passes.
    setupQueries({
      pending: [
        {
          tenant_id: 'tenant-1',
          integration_id: 'integration-rr',
          provider: 'salesforce',
          integration_type: 'crm',
          name: 'Salesforce',
          last_sync_status: 'needs_reconnect',
          last_sync_error: null,
          last_sync_error_at: new Date(Date.now() - 21 * 24 * 60 * 60 * 1000),
        },
      ],
      tenantName: 'Acme',
      adminEmails: ['admin@acme.test'],
    });

    const result = await runConnectorAutoDisableCycle(14);

    expect(result.inspected).toBe(1);
    expect(result.disabled).toBe(1);
    expect(result.emailedRecipients).toBe(1);

    const flipCall = queryMock.mock.calls[1];
    // The OR clause must let needs_reconnect pass even with null error string.
    expect(flipCall[0]).toMatch(/last_sync_status = 'needs_reconnect'/);
    expect(flipCall[1]).toEqual([
      'integration-rr',
      'tenant-1',
      'needs_reconnect',
      null,
    ]);
  });

  it('does not double-fire when the atomic flip loses the race', async () => {
    setupQueries({
      pending: [
        {
          tenant_id: 'tenant-1',
          integration_id: 'integration-3',
          provider: 'pipedrive',
          integration_type: 'crm',
          name: 'Pipedrive',
          last_sync_status: 'needs_reconnect',
          last_sync_error: 'token_revoked',
          last_sync_error_at: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
        },
      ],
      flipRowCount: 0,
    });

    const result = await runConnectorAutoDisableCycle(14);

    expect(result.inspected).toBe(1);
    expect(result.disabled).toBe(0);
    expect(result.emailedRecipients).toBe(0);
    expect(fanoutMock).not.toHaveBeenCalled();
    expect(writeAuditLogMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });
});

describe('dispatchConnectorAuthAlert opt-out', () => {
  // Regression: locks in the per-event reconnect/auth-error opt-out filter
  // contract. If a future refactor stops routing recipients through the
  // 'integration' opt-out filter, this test fails.
  it('claims throttle slot and fans out in-app but skips email when admins opted out', async () => {
    queryMock.mockReset();
    // 1. SELECT integration row
    queryMock.mockImplementationOnce(async () => ({
      rows: [
        {
          name: 'Salesforce',
          integration_type: 'crm',
          auth_alert_sent_at: null,
          last_sync_error: 'invalid_grant',
          last_sync_error_at: new Date(Date.now() - 60 * 60 * 1000),
        },
      ],
    }));
    // 2. claimAuthAlertSlot UPDATE — must still happen
    queryMock.mockImplementationOnce(async () => ({ rowCount: 1 }));
    // 3. SELECT name FROM tenants
    queryMock.mockImplementationOnce(async () => ({ rows: [{ name: 'Acme' }] }));
    // 4. SELECT users (getTenantAlertEmailRecipients)
    queryMock.mockImplementationOnce(async () => ({
      rows: [
        { id: 'u-1', email: 'owner@acme.test' },
        { id: 'u-2', email: 'admin@acme.test' },
      ],
    }));
    // 5. recentInAppNotificationExists SELECT
    queryMock.mockImplementationOnce(async () => ({ rows: [] }));

    filterRecipientsMock.mockResolvedValueOnce([]);

    const result = await dispatchConnectorAuthAlert({
      tenantId: 'tenant-optout',
      integrationId: 'integration-optout',
      provider: 'salesforce',
      connectorType: 'crm',
      errorMessage: 'invalid_grant',
      reason: 'needs_reconnect',
    });

    expect(result.status).toBe('no_recipients');
    expect(result.emailedRecipients).toBe(0);

    // Filter MUST be invoked with the 'integration' category for the
    // per-event reconnect path.
    expect(filterRecipientsMock).toHaveBeenCalledTimes(1);
    expect(filterRecipientsMock).toHaveBeenCalledWith(
      'tenant-optout',
      ['owner@acme.test', 'admin@acme.test'],
      'integration',
    );

    // Email must not go out when everyone opted out, and the email
    // template constructor must not be invoked either.
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(connectorReconnectNeededEmailMock).not.toHaveBeenCalled();
    expect(connectorSyncErrorEmailMock).not.toHaveBeenCalled();

    // Other side effects still happen: throttle slot was claimed (UPDATE
    // ran) and the in-app notification was fanned out so the inbox row
    // exists for users who didn't opt out of in-app.
    const updateCall = queryMock.mock.calls[1];
    expect(updateCall[0]).toMatch(/UPDATE integrations[\s\S]*auth_alert_sent_at = NOW\(\)/);
    expect(updateCall[1]).toEqual(['integration-optout', 'tenant-optout']);

    expect(fanoutMock).toHaveBeenCalledTimes(1);
    expect(fanoutMock.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-optout',
      type: 'integration',
      category: 'integration',
      metadata: expect.objectContaining({
        integrationId: 'integration-optout',
        provider: 'salesforce',
        reason: 'needs_reconnect',
      }),
    });
  });
});

describe('runConnectorAuthAlertCycle digest opt-out', () => {
  // Regression: locks in the digest-cycle opt-out filter contract. The
  // per-tenant 24h digest email must route recipients through the
  // 'integration' opt-out filter, and when nobody is left it must NOT
  // record the digest sent timestamp or stamp auth_alert_sent_at on the
  // queued integrations (otherwise the next cycle would silently skip
  // the same failures for 24h).
  it('skips digest email and digest stamping when all admins opted out', async () => {
    getConnectorAlertSettingsMock.mockResolvedValue({
      digestMode: true,
      digestLastSentAt: null,
      updatedAt: null,
      updatedBy: null,
    });

    queryMock.mockReset();
    // 1. findPendingAuthFailures SELECT
    queryMock.mockImplementationOnce(async () => ({
      rows: [
        {
          tenant_id: 'tenant-digest',
          integration_id: 'integration-digest',
          provider: 'hubspot',
          integration_type: 'crm',
          name: 'HubSpot',
          last_sync_status: 'needs_reconnect',
          last_sync_error: 'invalid_grant',
          last_sync_error_at: new Date(Date.now() - 60 * 60 * 1000),
        },
      ],
    }));
    // dispatchConnectorAuthAlert(suppressEmail=true) per-row queries:
    // 2. SELECT integration row
    queryMock.mockImplementationOnce(async () => ({
      rows: [
        {
          name: 'HubSpot',
          integration_type: 'crm',
          auth_alert_sent_at: null,
          last_sync_error: 'invalid_grant',
          last_sync_error_at: new Date(Date.now() - 60 * 60 * 1000),
        },
      ],
    }));
    // (suppressEmail=true skips claimAuthAlertSlot here)
    // 3. SELECT name FROM tenants (getTenantAdmins)
    queryMock.mockImplementationOnce(async () => ({ rows: [{ name: 'Acme' }] }));
    // 4. SELECT users (getTenantAlertEmailRecipients)
    queryMock.mockImplementationOnce(async () => ({
      rows: [{ id: 'u-1', email: 'admin@acme.test' }],
    }));
    // 5. recentInAppNotificationExists SELECT
    queryMock.mockImplementationOnce(async () => ({ rows: [] }));

    // Digest loop per-tenant queries:
    // 6. SELECT name FROM tenants (getTenantAdmins)
    queryMock.mockImplementationOnce(async () => ({ rows: [{ name: 'Acme' }] }));
    // 7. SELECT users (getTenantAlertEmailRecipients)
    queryMock.mockImplementationOnce(async () => ({
      rows: [{ id: 'u-1', email: 'admin@acme.test' }],
    }));

    filterRecipientsMock.mockResolvedValueOnce([]);

    const result = await runConnectorAuthAlertCycle();

    // Filter must be invoked with the 'integration' category for the
    // digest path.
    expect(filterRecipientsMock).toHaveBeenCalledTimes(1);
    expect(filterRecipientsMock).toHaveBeenCalledWith(
      'tenant-digest',
      ['admin@acme.test'],
      'integration',
    );

    // No digest email, no digest template render.
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(connectorSyncDigestEmailMock).not.toHaveBeenCalled();

    // Digest stamping side effects must NOT happen when the email never
    // delivered — leaving them clear lets the next cycle re-evaluate
    // the same failures for any not-opted-out admin instead of locking
    // them out for 24h.
    expect(recordDigestSentMock).not.toHaveBeenCalled();
    // No second UPDATE auth_alert_sent_at slot claim was issued for the
    // queued entry (we only issued the per-row dispatch lookups above).
    const slotClaims = queryMock.mock.calls.filter((c) =>
      typeof c[0] === 'string' && /UPDATE integrations[\s\S]*auth_alert_sent_at = NOW\(\)/.test(c[0]),
    );
    expect(slotClaims).toHaveLength(0);

    // Other side effects still happen: per-row in-app fan-out fired
    // during dispatchConnectorAuthAlert (suppressEmail=true) so the
    // inbox row exists for users who didn't opt out of in-app.
    expect(fanoutMock).toHaveBeenCalledTimes(1);
    expect(fanoutMock.mock.calls[0][0]).toMatchObject({
      tenantId: 'tenant-digest',
      type: 'integration',
      category: 'integration',
    });

    expect(result.inspected).toBe(1);
    expect(result.alerted).toBe(0);
    expect(result.emailedRecipients).toBe(0);
    expect(result.digestEmailsSent).toBe(0);
  });

  // Regression: locks in that each digest entry carries `provider` through
  // to the email template so the template can render a per-row deep link to
  // /connectors?provider=<provider>. If a refactor drops the field, the
  // digest email regresses to a single bottom-of-email CTA and tenants lose
  // the one-click reconnect flow on this surface.
  it('passes provider per failure row when delivering the digest email', async () => {
    getConnectorAlertSettingsMock.mockResolvedValue({
      digestMode: true,
      digestLastSentAt: null,
      updatedAt: null,
      updatedBy: null,
    });

    queryMock.mockReset();
    // 1. findPendingAuthFailures SELECT
    queryMock.mockImplementationOnce(async () => ({
      rows: [
        {
          tenant_id: 'tenant-digest',
          integration_id: 'integration-hubspot',
          provider: 'hubspot',
          integration_type: 'crm',
          name: 'HubSpot Prod',
          last_sync_status: 'needs_reconnect',
          last_sync_error: 'invalid_grant',
          last_sync_error_at: new Date(Date.now() - 60 * 60 * 1000),
        },
        {
          tenant_id: 'tenant-digest',
          integration_id: 'integration-salesforce',
          provider: 'salesforce',
          integration_type: 'crm',
          name: null,
          last_sync_status: 'error',
          last_sync_error: 'HTTP 401 unauthorized',
          last_sync_error_at: new Date(Date.now() - 30 * 60 * 1000),
        },
      ],
    }));
    // dispatchConnectorAuthAlert(suppressEmail=true) per-row queries:
    // Row 1: SELECT integration row, SELECT tenant name, SELECT users, in-app dedupe SELECT
    queryMock.mockImplementationOnce(async () => ({
      rows: [{
        name: 'HubSpot Prod',
        integration_type: 'crm',
        auth_alert_sent_at: null,
        last_sync_error: 'invalid_grant',
        last_sync_error_at: new Date(Date.now() - 60 * 60 * 1000),
      }],
    }));
    queryMock.mockImplementationOnce(async () => ({ rows: [{ name: 'Acme' }] }));
    queryMock.mockImplementationOnce(async () => ({
      rows: [{ id: 'u-1', email: 'admin@acme.test' }],
    }));
    queryMock.mockImplementationOnce(async () => ({ rows: [] }));
    // Row 2
    queryMock.mockImplementationOnce(async () => ({
      rows: [{
        name: null,
        integration_type: 'crm',
        auth_alert_sent_at: null,
        last_sync_error: 'HTTP 401 unauthorized',
        last_sync_error_at: new Date(Date.now() - 30 * 60 * 1000),
      }],
    }));
    queryMock.mockImplementationOnce(async () => ({ rows: [{ name: 'Acme' }] }));
    queryMock.mockImplementationOnce(async () => ({
      rows: [{ id: 'u-1', email: 'admin@acme.test' }],
    }));
    queryMock.mockImplementationOnce(async () => ({ rows: [] }));
    // Digest loop per-tenant: SELECT tenant name, SELECT users
    queryMock.mockImplementationOnce(async () => ({ rows: [{ name: 'Acme' }] }));
    queryMock.mockImplementationOnce(async () => ({
      rows: [{ id: 'u-1', email: 'admin@acme.test' }],
    }));
    // Per-entry slot claims after digest delivers (UPDATE auth_alert_sent_at)
    queryMock.mockImplementationOnce(async () => ({ rowCount: 1 }));
    queryMock.mockImplementationOnce(async () => ({ rowCount: 1 }));

    const result = await runConnectorAuthAlertCycle();

    expect(connectorSyncDigestEmailMock).toHaveBeenCalledTimes(1);
    const digestArgs = connectorSyncDigestEmailMock.mock.calls[0][0] as {
      failures: Array<{ provider: string; providerLabel: string; name: string | null }>;
      connectorsUrl: string;
    };
    expect(digestArgs.failures).toHaveLength(2);
    expect(digestArgs.failures[0]).toMatchObject({
      provider: 'hubspot',
      providerLabel: 'HubSpot',
      name: 'HubSpot Prod',
    });
    expect(digestArgs.failures[1]).toMatchObject({
      provider: 'salesforce',
      providerLabel: 'Salesforce',
      name: null,
    });
    // Connectors base URL is still passed for the bottom-of-email fallback CTA.
    expect(digestArgs.connectorsUrl).toMatch(/\/connectors$/);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(recordDigestSentMock).toHaveBeenCalledWith('tenant-digest');
    expect(result.digestEmailsSent).toBe(1);
  });
});
