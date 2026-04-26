import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  queryMock,
  sendEmailMock,
  connectorAutoDisabledEmailMock,
  fanoutMock,
  filterRecipientsMock,
  writeAuditLogMock,
} = vi.hoisted(() => ({
  queryMock: vi.fn(),
  sendEmailMock: vi.fn(),
  connectorAutoDisabledEmailMock: vi.fn(() => ({
    subject: 'We disabled your integration',
    html: '<p>html</p>',
    text: 'text',
  })),
  fanoutMock: vi.fn().mockResolvedValue(undefined),
  filterRecipientsMock: vi.fn(async (_t: string, e: string[]) => e),
  writeAuditLogMock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
}));

vi.mock('../../email', () => ({
  sendEmail: sendEmailMock,
  connectorSyncErrorEmail: vi.fn(() => ({ subject: 's', html: 'h', text: 't' })),
  connectorAutoDisabledEmail: connectorAutoDisabledEmailMock,
}));

vi.mock('../../notifications/NotificationPreferences', () => ({
  fanoutInAppNotification: fanoutMock,
  filterEmailRecipientsByPreference: filterRecipientsMock,
}));

vi.mock('../../audit/AuditService', () => ({
  writeAuditLog: writeAuditLogMock,
}));

import {
  getAutoDisableThresholdDays,
  isAuthError,
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
  writeAuditLogMock.mockClear();
  connectorAutoDisabledEmailMock.mockClear();
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
