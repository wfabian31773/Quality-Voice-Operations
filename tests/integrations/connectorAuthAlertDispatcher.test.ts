import { describe, it, expect, beforeEach, vi } from 'vitest';

const queryMock = vi.fn<
  (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>
>();
const sendEmailMock = vi.fn<(input: Record<string, unknown>) => Promise<{ success: boolean }>>();
const reconnectTemplateMock = vi.fn<(input: Record<string, unknown>) => {
  subject: string;
  html: string;
  text: string;
}>();
const syncErrorTemplateMock = vi.fn<(input: Record<string, unknown>) => {
  subject: string;
  html: string;
  text: string;
}>();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
}));

vi.mock('../../platform/email', () => ({
  sendEmail: (input: Record<string, unknown>) => sendEmailMock(input),
  connectorReconnectNeededEmail: (input: Record<string, unknown>) =>
    reconnectTemplateMock(input),
  connectorSyncErrorEmail: (input: Record<string, unknown>) => syncErrorTemplateMock(input),
}));

beforeEach(() => {
  queryMock.mockReset();
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ success: true });
  reconnectTemplateMock.mockReset();
  reconnectTemplateMock.mockReturnValue({
    subject: 'reconnect-subject',
    html: 'reconnect-html',
    text: 'reconnect-text',
  });
  syncErrorTemplateMock.mockReset();
  syncErrorTemplateMock.mockReturnValue({
    subject: 'sync-error-subject',
    html: 'sync-error-html',
    text: 'sync-error-text',
  });
});

const baseParams = {
  tenantId: 'tenant-1',
  integrationId: 'int-1',
  provider: 'hubspot',
  connectorType: 'crm',
};

// Query order in dispatchConnectorAuthAlert (post-refactor):
//  1. integration row SELECT
//  2. claimAuthAlertSlot (UPDATE integrations SET auth_alert_sent_at; conditional)
//  3. tenant name (getTenantAdmins)
//  4. admin recipients lookup (getTenantAdmins)
//  5. recentInAppNotificationExists
//  6. fanoutInAppNotification: load tenant users (intersected with admin IDs)
//  7. fanoutInAppNotification: filterUserIdsByPreference (in_app)
//  8. INSERT per eligible user
//  9. filterEmailRecipientsByPreference
// (no trailing stamp — the claim at step 2 already stamped)

describe('dispatchConnectorAuthAlert', () => {
  it('uses the dedicated reconnect-needed email template, fans out in-app, and stamps the throttle marker', async () => {
    queryMock
      // 1. integration row
      .mockResolvedValueOnce({
        rows: [
          {
            name: 'HubSpot',
            integration_type: 'crm',
            auth_alert_sent_at: null,
            last_sync_error: 'invalid_grant',
            last_sync_error_at: null,
          },
        ],
      })
      // 2. claimAuthAlertSlot (atomic stamp; rowCount=1 → we own it)
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // 3. tenant name
      .mockResolvedValueOnce({ rows: [{ name: 'Acme' }] })
      // 4. admin recipients (id + email)
      .mockResolvedValueOnce({
        rows: [
          { id: 'user-a', email: 'admin@acme.test' },
          { id: 'user-b', email: 'owner@acme.test' },
        ],
      })
      // 5. recentInAppNotificationExists
      .mockResolvedValueOnce({ rows: [] })
      // 6. fanoutInAppNotification: intersect admin IDs with active users
      .mockResolvedValueOnce({ rows: [{ id: 'user-a' }, { id: 'user-b' }] })
      // 7. fanoutInAppNotification: pref filter (none opted out)
      .mockResolvedValueOnce({ rows: [] })
      // 8. INSERT per user
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      // 9. filterEmailRecipientsByPreference (none opted out)
      .mockResolvedValueOnce({ rows: [] });

    const { dispatchConnectorAuthAlert } = await import(
      '../../platform/integrations/connectors/ConnectorAuthAlertScheduler'
    );

    const result = await dispatchConnectorAuthAlert({
      ...baseParams,
      errorMessage: 'Token refresh HTTP 401: invalid_grant',
    });

    expect(result.status).toBe('sent');
    expect(result.emailedRecipients).toBe(2);

    expect(reconnectTemplateMock).toHaveBeenCalledTimes(1);
    expect(syncErrorTemplateMock).not.toHaveBeenCalled();
    const templateArg = reconnectTemplateMock.mock.calls[0][0];
    expect(templateArg.providerLabel).toBe('HubSpot');
    expect(templateArg.tenantName).toBe('Acme');
    expect(String(templateArg.reconnectUrl)).toContain('/connectors?integration=int-1');
    expect(templateArg.errorMessage).toBe('Token refresh HTTP 401: invalid_grant');

    // In-app: 2 rows, one per admin (NOT tenant-wide).
    const insertCalls = queryMock.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO tenant_notifications'),
    );
    expect(insertCalls.length).toBe(2);
    for (const call of insertCalls) {
      const args = call[1] as unknown[];
      expect(args[2]).toBe('integration');
      const metadata = JSON.parse(args[5] as string);
      expect(metadata.integrationId).toBe('int-1');
      expect(metadata.provider).toBe('hubspot');
      expect(metadata.reason).toBe('needs_reconnect');
      expect(metadata.link).toBe('/connectors?integration=int-1');
    }
    // Confirm the in-app fanout used the restricted-by-userIds query.
    const restrictedFanout = queryMock.mock.calls.find((c) => {
      const sql = String(c[0]);
      return sql.includes('FROM users') && sql.includes('id = ANY(');
    });
    expect(restrictedFanout).toBeDefined();
    expect(restrictedFanout![1]).toEqual(['tenant-1', ['user-a', 'user-b']]);
    // Regression guard: users.id is VARCHAR in this schema; casting the
    // parameter array to uuid[] raises a Postgres type error at runtime
    // and silently drops in-app delivery. Pin the cast to varchar[].
    const restrictedSql = String(restrictedFanout![0]);
    expect(restrictedSql).toContain('varchar[]');
    expect(restrictedSql).not.toContain('uuid[]');

    // Two emails dispatched (one per recipient).
    expect(sendEmailMock).toHaveBeenCalledTimes(2);

    // Throttle marker stamped.
    const stampCall = queryMock.mock.calls.find((c) => {
      const sql = String(c[0]);
      return sql.includes('UPDATE integrations') && sql.includes('auth_alert_sent_at');
    });
    expect(stampCall).toBeDefined();
    expect(stampCall![1]).toEqual(['int-1', 'tenant-1']);
  });

  it('suppresses dispatch when auth_alert_sent_at was set within the last 24h', async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          name: 'HubSpot',
          integration_type: 'crm',
          auth_alert_sent_at: oneHourAgo,
          last_sync_error: null,
          last_sync_error_at: null,
        },
      ],
    });

    const { dispatchConnectorAuthAlert } = await import(
      '../../platform/integrations/connectors/ConnectorAuthAlertScheduler'
    );

    const result = await dispatchConnectorAuthAlert(baseParams);

    expect(result.status).toBe('throttled');
    expect(result.emailedRecipients).toBe(0);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(reconnectTemplateMock).not.toHaveBeenCalled();
  });

  it('proceeds when the throttle marker is older than the 24h window', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            name: 'HubSpot',
            integration_type: 'crm',
            auth_alert_sent_at: twoDaysAgo,
            last_sync_error: null,
            last_sync_error_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // claim
      .mockResolvedValueOnce({ rows: [{ name: 'Acme' }] }) // tenant name
      .mockResolvedValueOnce({ rows: [{ id: 'user-a', email: 'admin@acme.test' }] }) // admins
      .mockResolvedValueOnce({ rows: [] }) // recent in-app
      .mockResolvedValueOnce({ rows: [{ id: 'user-a' }] }) // fan-out: restricted
      .mockResolvedValueOnce({ rows: [] }) // pref filter
      .mockResolvedValueOnce({ rows: [] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }); // email pref filter

    const { dispatchConnectorAuthAlert } = await import(
      '../../platform/integrations/connectors/ConnectorAuthAlertScheduler'
    );

    const result = await dispatchConnectorAuthAlert({
      ...baseParams,
      errorMessage: 'token expired',
    });

    expect(result.status).toBe('sent');
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('aborts dispatch when the atomic claim is lost to a concurrent worker (rowCount=0)', async () => {
    queryMock
      // 1. integration row — local fast-path read shows null (race window!)
      .mockResolvedValueOnce({
        rows: [
          {
            name: 'HubSpot',
            integration_type: 'crm',
            auth_alert_sent_at: null,
            last_sync_error: 'invalid_grant',
            last_sync_error_at: null,
          },
        ],
      })
      // 2. claimAuthAlertSlot — another worker stamped first; rowCount=0
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const { dispatchConnectorAuthAlert } = await import(
      '../../platform/integrations/connectors/ConnectorAuthAlertScheduler'
    );

    const result = await dispatchConnectorAuthAlert(baseParams);

    expect(result.status).toBe('throttled');
    expect(result.emailedRecipients).toBe(0);
    // Critical: no in-app inserts and no email sent when claim is lost.
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(reconnectTemplateMock).not.toHaveBeenCalled();
    const insertCalls = queryMock.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO tenant_notifications'),
    );
    expect(insertCalls.length).toBe(0);
    // Only 2 queries should have run: the SELECT and the failed claim UPDATE.
    expect(queryMock).toHaveBeenCalledTimes(2);
  });

  it('skips when the integration row cannot be loaded', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    const { dispatchConnectorAuthAlert } = await import(
      '../../platform/integrations/connectors/ConnectorAuthAlertScheduler'
    );

    const result = await dispatchConnectorAuthAlert(baseParams);

    expect(result.status).toBe('skipped');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('skips both in-app and email and stamps marker when the tenant has no admins/owners on file', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            name: 'HubSpot',
            integration_type: 'crm',
            auth_alert_sent_at: null,
            last_sync_error: null,
            last_sync_error_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // claim (this IS the stamp)
      .mockResolvedValueOnce({ rows: [{ name: 'Acme' }] }) // tenant name
      .mockResolvedValueOnce({ rows: [] }) // no admin recipients
      .mockResolvedValueOnce({ rows: [] }); // recent in-app
    // fan-out is invoked with userIds=[] → short-circuits, no users.id query

    const { dispatchConnectorAuthAlert } = await import(
      '../../platform/integrations/connectors/ConnectorAuthAlertScheduler'
    );

    const result = await dispatchConnectorAuthAlert(baseParams);

    expect(result.status).toBe('no_recipients');
    expect(sendEmailMock).not.toHaveBeenCalled();

    // No in-app rows inserted (no admins to receive them).
    const insertCalls = queryMock.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO tenant_notifications'),
    );
    expect(insertCalls.length).toBe(0);

    // No tenant-wide fan-out fallback triggered.
    const tenantWideFanout = queryMock.mock.calls.find((c) => {
      const sql = String(c[0]);
      return (
        sql.includes('FROM users') &&
        sql.includes('tenant_id = $1') &&
        !sql.includes('id = ANY(') &&
        !sql.includes('LEFT JOIN user_roles')
      );
    });
    expect(tenantWideFanout).toBeUndefined();

    // Throttle marker still stamped so the periodic scheduler doesn't loop.
    const stampCall = queryMock.mock.calls.find((c) => {
      const sql = String(c[0]);
      return sql.includes('UPDATE integrations') && sql.includes('auth_alert_sent_at');
    });
    expect(stampCall).toBeDefined();
  });

  it('drops admin recipients who opted out of integration emails and still stamps the marker', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            name: 'HubSpot',
            integration_type: 'crm',
            auth_alert_sent_at: null,
            last_sync_error: null,
            last_sync_error_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // claim
      .mockResolvedValueOnce({ rows: [{ name: 'Acme' }] }) // tenant name
      .mockResolvedValueOnce({ rows: [{ id: 'user-a', email: 'admin@acme.test' }] }) // admins
      .mockResolvedValueOnce({ rows: [] }) // recent in-app
      .mockResolvedValueOnce({ rows: [{ id: 'user-a' }] }) // fan-out restricted
      .mockResolvedValueOnce({ rows: [] }) // pref filter (in_app)
      .mockResolvedValueOnce({ rows: [] }) // INSERT
      // filterEmailRecipientsByPreference: admin opted OUT
      .mockResolvedValueOnce({
        rows: [{ email: 'admin@acme.test', enabled: false }],
      });

    const { dispatchConnectorAuthAlert } = await import(
      '../../platform/integrations/connectors/ConnectorAuthAlertScheduler'
    );

    const result = await dispatchConnectorAuthAlert(baseParams);

    expect(result.status).toBe('no_recipients');
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(reconnectTemplateMock).not.toHaveBeenCalled();
    const prefFilterCall = queryMock.mock.calls.find((c) => {
      const sql = String(c[0]);
      return sql.includes('user_notification_preferences') && sql.includes('LOWER(u.email)');
    });
    expect(prefFilterCall).toBeDefined();
    expect(prefFilterCall![1][2]).toBe('integration');
  });

  it('queries both user_roles (canonical RBAC) and legacy users.role for recipients', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            name: 'HubSpot',
            integration_type: 'crm',
            auth_alert_sent_at: null,
            last_sync_error: null,
            last_sync_error_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // claim
      .mockResolvedValueOnce({ rows: [{ name: 'Acme' }] }) // tenant
      .mockResolvedValueOnce({ rows: [{ id: 'user-a', email: 'owner@acme.test' }] }) // admins
      .mockResolvedValueOnce({ rows: [] }) // recent in-app
      .mockResolvedValueOnce({ rows: [{ id: 'user-a' }] }) // fan-out restricted
      .mockResolvedValueOnce({ rows: [] }) // pref filter
      .mockResolvedValueOnce({ rows: [] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }); // email pref filter

    const { dispatchConnectorAuthAlert } = await import(
      '../../platform/integrations/connectors/ConnectorAuthAlertScheduler'
    );

    await dispatchConnectorAuthAlert(baseParams);

    const recipientCall = queryMock.mock.calls.find((c) => {
      const sql = String(c[0]);
      return sql.includes('FROM users u') && sql.includes('LEFT JOIN user_roles');
    });
    expect(recipientCall).toBeDefined();
    const sql = String(recipientCall![0]);
    expect(sql).toContain("ur.role IN ('tenant_owner', 'operations_manager')");
    expect(sql).toContain("u.role IN ('admin', 'owner', 'tenant_owner', 'operations_manager')");
  });

  it('uses the integration display name (not just provider label) so the alert names the specific connector', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            // User-named instance — should appear verbatim in the alert.
            name: 'Salesforce – West Region',
            integration_type: 'crm',
            auth_alert_sent_at: null,
            last_sync_error: 'invalid_grant',
            last_sync_error_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // claim
      .mockResolvedValueOnce({ rows: [{ name: 'Acme' }] }) // tenant
      .mockResolvedValueOnce({ rows: [{ id: 'user-a', email: 'admin@acme.test' }] }) // admins
      .mockResolvedValueOnce({ rows: [] }) // recent in-app
      .mockResolvedValueOnce({ rows: [{ id: 'user-a' }] }) // fan-out restricted
      .mockResolvedValueOnce({ rows: [] }) // pref filter
      .mockResolvedValueOnce({ rows: [] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }); // email pref filter

    const { dispatchConnectorAuthAlert } = await import(
      '../../platform/integrations/connectors/ConnectorAuthAlertScheduler'
    );

    await dispatchConnectorAuthAlert({
      ...baseParams,
      provider: 'salesforce',
      errorMessage: 'invalid_grant',
    });

    // Email template should receive the named instance, not "Salesforce".
    const templateArg = reconnectTemplateMock.mock.calls[0][0];
    expect(templateArg.providerLabel).toBe('Salesforce – West Region');
    // In-app row title/message should mention the named instance.
    const insertCall = queryMock.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO tenant_notifications'),
    );
    expect(insertCall).toBeDefined();
    const insertArgs = insertCall![1] as unknown[];
    expect(String(insertArgs[3])).toContain('Salesforce – West Region');
    expect(String(insertArgs[4])).toContain('Salesforce – West Region');
  });

  it('emits an ops-level error log when the slot is claimed but every email send fails', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            name: 'HubSpot',
            integration_type: 'crm',
            auth_alert_sent_at: null,
            last_sync_error: 'invalid_grant',
            last_sync_error_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // claim
      .mockResolvedValueOnce({ rows: [{ name: 'Acme' }] }) // tenant
      .mockResolvedValueOnce({ rows: [{ id: 'user-a', email: 'admin@acme.test' }] }) // admins
      .mockResolvedValueOnce({ rows: [] }) // recent in-app
      .mockResolvedValueOnce({ rows: [{ id: 'user-a' }] }) // fan-out restricted
      .mockResolvedValueOnce({ rows: [] }) // pref filter
      .mockResolvedValueOnce({ rows: [] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }); // email pref filter

    // Simulate transient email outage: every send fails.
    sendEmailMock.mockReset();
    sendEmailMock.mockResolvedValue({ success: false, error: 'SMTP timeout' } as {
      success: boolean;
      error?: string;
    });

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const { dispatchConnectorAuthAlert } = await import(
        '../../platform/integrations/connectors/ConnectorAuthAlertScheduler'
      );

      const result = await dispatchConnectorAuthAlert(baseParams);

      // The dispatch reports 'sent' with 0 deliveries — the slot is
      // claimed and no retry will happen for 24h. The ops error log
      // is the safety net.
      expect(result.status).toBe('sent');
      expect(result.emailedRecipients).toBe(0);

      // Confirm the safety-net error log fired (search across both
      // console.error and process.stderr.write since logger may go to
      // either depending on transport).
      const allLogged = [
        ...errorSpy.mock.calls.map((c) => c.map(String).join(' ')),
        ...stderrSpy.mock.calls.map((c) => c.map(String).join(' ')),
      ].join('\n');
      expect(allLogged).toContain('claim succeeded but zero emails delivered');
    } finally {
      errorSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('per-integration in-app dedupe: a second connector of the same provider can still alert', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            name: 'HubSpot',
            integration_type: 'crm',
            auth_alert_sent_at: null,
            last_sync_error: 'invalid_grant',
            last_sync_error_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // claim
      .mockResolvedValueOnce({ rows: [{ name: 'Acme' }] }) // tenant
      .mockResolvedValueOnce({ rows: [{ id: 'user-a', email: 'admin@acme.test' }] }) // admins
      .mockResolvedValueOnce({ rows: [] }) // recent in-app — none for THIS integration
      .mockResolvedValueOnce({ rows: [{ id: 'user-a' }] }) // fan-out restricted
      .mockResolvedValueOnce({ rows: [] }) // pref filter
      .mockResolvedValueOnce({ rows: [] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }); // email pref filter

    const { dispatchConnectorAuthAlert } = await import(
      '../../platform/integrations/connectors/ConnectorAuthAlertScheduler'
    );

    await dispatchConnectorAuthAlert(baseParams);

    // Confirm the dedupe query is keyed off integrationId (per-connector),
    // NOT off provider alone (which would suppress alerts across sibling
    // connectors of the same provider type).
    const dedupeCall = queryMock.mock.calls.find((c) => {
      const sql = String(c[0]);
      return sql.includes('FROM tenant_notifications') && sql.includes("type = 'integration'");
    });
    expect(dedupeCall).toBeDefined();
    const dedupeSql = String(dedupeCall![0]);
    expect(dedupeSql).toContain("metadata ->> 'integrationId' = $2");
    expect(dedupeCall![1]).toEqual(['tenant-1', 'int-1', 'hubspot']);
  });

  it("falls back to the generic sync-error template when reason='auth_error'", async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            name: 'HubSpot',
            integration_type: 'crm',
            auth_alert_sent_at: null,
            last_sync_error: 'sync timed out',
            last_sync_error_at: null,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // claim
      .mockResolvedValueOnce({ rows: [{ name: 'Acme' }] }) // tenant
      .mockResolvedValueOnce({ rows: [{ id: 'user-a', email: 'admin@acme.test' }] }) // admins
      .mockResolvedValueOnce({ rows: [] }) // recent in-app
      .mockResolvedValueOnce({ rows: [{ id: 'user-a' }] }) // fan-out restricted
      .mockResolvedValueOnce({ rows: [] }) // pref filter
      .mockResolvedValueOnce({ rows: [] }) // INSERT
      .mockResolvedValueOnce({ rows: [] }); // email pref filter

    const { dispatchConnectorAuthAlert } = await import(
      '../../platform/integrations/connectors/ConnectorAuthAlertScheduler'
    );

    const result = await dispatchConnectorAuthAlert({
      ...baseParams,
      reason: 'auth_error',
    });

    expect(result.status).toBe('sent');
    expect(syncErrorTemplateMock).toHaveBeenCalledTimes(1);
    expect(reconnectTemplateMock).not.toHaveBeenCalled();
  });
});
