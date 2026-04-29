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

const schedulingDriftTemplateMock = vi.fn<(input: Record<string, unknown>) => {
  subject: string;
  html: string;
  text: string;
}>();

vi.mock('../../platform/email', () => ({
  sendEmail: (input: Record<string, unknown>) => sendEmailMock(input),
  connectorReconnectNeededEmail: (input: Record<string, unknown>) =>
    reconnectTemplateMock(input),
  connectorSyncErrorEmail: (input: Record<string, unknown>) => syncErrorTemplateMock(input),
  connectorSchedulingDriftEmail: (input: Record<string, unknown>) =>
    schedulingDriftTemplateMock(input),
}));

const findAffectedSchedulingTargetsMock = vi.fn<
  (tenantId: string, provider: string) => Promise<
    Array<{ refType: 'agent' | 'phone_number'; refId: string; name: string }>
  >
>();

vi.mock('../../platform/integrations/connectors/db', () => ({
  findAffectedSchedulingTargets: (tenantId: string, provider: string) =>
    findAffectedSchedulingTargetsMock(tenantId, provider),
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
  schedulingDriftTemplateMock.mockReset();
  schedulingDriftTemplateMock.mockReturnValue({
    subject: 'scheduling-drift-subject',
    html: 'scheduling-drift-html',
    text: 'scheduling-drift-text',
  });
  findAffectedSchedulingTargetsMock.mockReset();
  // Default: no scheduling targets reference the disconnected provider, so
  // the dispatcher falls through to the generic reconnect-needed flow.
  findAffectedSchedulingTargetsMock.mockResolvedValue([]);
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
    // Provider-keyed deep link so the email lands on the right connector
    // card whether the integration row is still present in `needs_reconnect`
    // state OR has been removed entirely (matches the dashboard badge link).
    expect(String(templateArg.reconnectUrl)).toContain('/connectors?provider=hubspot');
    expect(String(templateArg.reconnectUrl)).not.toContain('integration=');
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
      // In-app `link` matches the email's reconnect URL form so click-through
      // works whether the integration row was deleted or still present.
      expect(metadata.link).toBe('/connectors?provider=hubspot');
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

  it('uses the scheduling-drift email and target-aware in-app message when a calendar with referencing agents/phone numbers disconnects', async () => {
    findAffectedSchedulingTargetsMock.mockResolvedValue([
      { refType: 'agent', refId: 'agent-1', name: 'Front Desk Bot' },
      { refType: 'agent', refId: 'agent-2', name: 'Sales Bot' },
      { refType: 'phone_number', refId: 'pn-1', name: 'Main Line' },
    ]);
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            // Tenant-named instance (e.g. "Acme Google Calendar")
            name: 'Acme Google Calendar',
            integration_type: 'scheduling',
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

    const result = await dispatchConnectorAuthAlert({
      tenantId: 'tenant-1',
      integrationId: 'int-1',
      provider: 'google-calendar',
      connectorType: 'scheduling',
      errorMessage: 'invalid_grant',
    });

    expect(result.status).toBe('sent');
    expect(findAffectedSchedulingTargetsMock).toHaveBeenCalledWith('tenant-1', 'google-calendar');

    // The scheduling-drift email template is used (NOT the generic
    // reconnect/sync templates). It receives every affected target so the
    // email can list them as bullets.
    expect(schedulingDriftTemplateMock).toHaveBeenCalledTimes(1);
    expect(reconnectTemplateMock).not.toHaveBeenCalled();
    expect(syncErrorTemplateMock).not.toHaveBeenCalled();
    const emailArg = schedulingDriftTemplateMock.mock.calls[0][0];
    expect(emailArg.tenantName).toBe('Acme');
    // Provider-keyed deep link survives integration row deletion.
    expect(String(emailArg.connectorsUrl)).toContain('/connectors?provider=google-calendar');
    const drifted = emailArg.drifted as Array<{
      refType: string;
      name: string;
      providerLabel: string;
    }>;
    expect(drifted).toHaveLength(3);
    expect(drifted.map((d) => d.name)).toEqual([
      'Front Desk Bot',
      'Sales Bot',
      'Main Line',
    ]);
    // Provider label uses the human-readable form, not the raw key.
    expect(drifted[0].providerLabel).toBe('Acme Google Calendar');

    // Email actually delivered.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0].subject).toBe('scheduling-drift-subject');

    // In-app row title/message call out the impact and the metadata
    // surfaces the affected targets so the Notifications UI can render
    // targeted reconnect chips.
    const insertCall = queryMock.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO tenant_notifications'),
    );
    expect(insertCall).toBeDefined();
    const insertArgs = insertCall![1] as unknown[];
    const title = String(insertArgs[3]);
    const message = String(insertArgs[4]);
    expect(title).toContain('disconnected');
    expect(title).toContain('Acme Google Calendar');
    // Message summarizes the impact (count phrasing) so admins immediately
    // know what stops booking.
    expect(message).toContain('2 agents');
    expect(message).toContain('1 phone number');
    expect(message).toContain('Acme Google Calendar');

    const metadata = JSON.parse(insertArgs[5] as string);
    expect(metadata.connectorType).toBe('scheduling');
    expect(metadata.provider).toBe('google-calendar');
    // Deep link matches the email's reconnect URL (provider-keyed).
    expect(metadata.link).toBe('/connectors?provider=google-calendar');
    expect(metadata.affectedAgentCount).toBe(2);
    expect(metadata.affectedPhoneNumberCount).toBe(1);
    expect(metadata.affectedTargets).toEqual([
      { refType: 'agent', refId: 'agent-1', name: 'Front Desk Bot' },
      { refType: 'agent', refId: 'agent-2', name: 'Sales Bot' },
      { refType: 'phone_number', refId: 'pn-1', name: 'Main Line' },
    ]);
  });

  it('falls back to the generic reconnect email when a scheduling connector disconnects but no agents or phone numbers reference it', async () => {
    findAffectedSchedulingTargetsMock.mockResolvedValue([]);
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            name: 'Outlook Calendar',
            integration_type: 'scheduling',
            auth_alert_sent_at: null,
            last_sync_error: 'token expired',
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
      tenantId: 'tenant-1',
      integrationId: 'int-1',
      provider: 'outlook-calendar',
      connectorType: 'scheduling',
      errorMessage: 'token expired',
    });

    expect(result.status).toBe('sent');
    // Lookup still ran (we always check on scheduling type) but came back empty.
    expect(findAffectedSchedulingTargetsMock).toHaveBeenCalledWith('tenant-1', 'outlook-calendar');
    // Generic reconnect template used; scheduling-drift template stays cold.
    expect(reconnectTemplateMock).toHaveBeenCalledTimes(1);
    expect(schedulingDriftTemplateMock).not.toHaveBeenCalled();

    // Generic in-app metadata — no affectedTargets payload.
    const insertCall = queryMock.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO tenant_notifications'),
    );
    const metadata = JSON.parse((insertCall![1] as unknown[])[5] as string);
    expect(metadata.affectedTargets).toBeUndefined();
    expect(metadata.affectedAgentCount).toBeUndefined();
  });

  it('skips the scheduling-target lookup entirely for non-scheduling connector types', async () => {
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

    const { dispatchConnectorAuthAlert } = await import(
      '../../platform/integrations/connectors/ConnectorAuthAlertScheduler'
    );

    await dispatchConnectorAuthAlert({
      tenantId: 'tenant-1',
      integrationId: 'int-1',
      provider: 'hubspot',
      connectorType: 'crm',
    });

    // CRM connectors must NEVER trigger the scheduling-impact query —
    // it adds a needless join + transaction roundtrip and would bloat
    // unrelated CRM auth alerts with empty "affected" metadata.
    expect(findAffectedSchedulingTargetsMock).not.toHaveBeenCalled();
    expect(schedulingDriftTemplateMock).not.toHaveBeenCalled();
    expect(reconnectTemplateMock).toHaveBeenCalledTimes(1);
  });

  it('per-disconnect-episode dedup (scheduling): suppresses repeated cycles even past the 24h window while the connector remains disconnected', async () => {
    findAffectedSchedulingTargetsMock.mockResolvedValue([
      { refType: 'agent', refId: 'agent-1', name: 'Front Desk Bot' },
    ]);
    // Marker stamped 5 days ago — past the legacy 24h re-issue window.
    // For a CRM connector this would re-issue; for scheduling it must NOT.
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          name: 'Acme Google Calendar',
          integration_type: 'scheduling',
          auth_alert_sent_at: fiveDaysAgo,
          last_sync_error: 'invalid_grant',
          last_sync_error_at: fiveDaysAgo,
        },
      ],
    });

    const { dispatchConnectorAuthAlert } = await import(
      '../../platform/integrations/connectors/ConnectorAuthAlertScheduler'
    );

    const result = await dispatchConnectorAuthAlert({
      tenantId: 'tenant-1',
      integrationId: 'int-1',
      provider: 'google-calendar',
      connectorType: 'scheduling',
    });

    // Throttled out by per-episode dedup — the marker is non-null and the
    // only thing that re-arms it is a reconnect (success transition clears
    // auth_alert_sent_at to NULL via updateConnectorSyncStatus).
    expect(result.status).toBe('throttled');
    expect(result.emailedRecipients).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(schedulingDriftTemplateMock).not.toHaveBeenCalled();
    expect(reconnectTemplateMock).not.toHaveBeenCalled();
    // findAffectedSchedulingTargets must NOT run when we throttle out — no
    // need to spend a transaction enumerating agents we won't message.
    expect(findAffectedSchedulingTargetsMock).not.toHaveBeenCalled();
    // Only the integration-row SELECT ran. No claim, no fan-out queries.
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('per-disconnect-episode dedup (scheduling): a fresh disconnect after reconnect (marker reset to NULL) sends a new alert', async () => {
    findAffectedSchedulingTargetsMock.mockResolvedValue([
      { refType: 'agent', refId: 'agent-1', name: 'Front Desk Bot' },
    ]);
    // Marker is NULL — the previous disconnect was resolved (a successful
    // sync via updateConnectorSyncStatus cleared it) and the connector
    // dropped back into needs_reconnect afterwards. This is a NEW
    // disconnect event and must re-alert.
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            name: 'Acme Google Calendar',
            integration_type: 'scheduling',
            auth_alert_sent_at: null,
            last_sync_error: 'invalid_grant',
            last_sync_error_at: null,
          },
        ],
      })
      // Atomic claim must use the strict NULL-only predicate for scheduling
      // and succeed because the marker is NULL.
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ name: 'Acme' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'user-a', email: 'admin@acme.test' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'user-a' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const { dispatchConnectorAuthAlert } = await import(
      '../../platform/integrations/connectors/ConnectorAuthAlertScheduler'
    );

    const result = await dispatchConnectorAuthAlert({
      tenantId: 'tenant-1',
      integrationId: 'int-1',
      provider: 'google-calendar',
      connectorType: 'scheduling',
    });

    expect(result.status).toBe('sent');
    expect(schedulingDriftTemplateMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);

    // Verify the claim UPDATE used the strict per-episode predicate
    // (auth_alert_sent_at IS NULL), NOT the legacy 24h-window OR clause.
    const claimCall = queryMock.mock.calls.find((c) => {
      const sql = String(c[0]);
      return (
        sql.includes('UPDATE integrations') &&
        sql.includes('SET auth_alert_sent_at = NOW()') &&
        // The conditional UPDATE (claim), not the bare stamp helper.
        sql.includes('WHERE id = $1')
      );
    });
    expect(claimCall).toBeDefined();
    const claimSql = String(claimCall![0]);
    expect(claimSql).toContain('auth_alert_sent_at IS NULL');
    expect(claimSql).not.toContain("INTERVAL '24 hours'");
  });

  it('non-scheduling connector keeps the legacy 24h re-issue window (still re-alerts after the throttle expires)', async () => {
    // CRM connector: same 5-days-ago marker that is throttled-out for
    // scheduling MUST re-issue here, because persistent CRM failures still
    // get a daily nudge.
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            name: 'HubSpot',
            integration_type: 'crm',
            auth_alert_sent_at: fiveDaysAgo,
            last_sync_error: 'invalid_grant',
            last_sync_error_at: fiveDaysAgo,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ name: 'Acme' }] })
      .mockResolvedValueOnce({ rows: [{ id: 'user-a', email: 'admin@acme.test' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 'user-a' }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const { dispatchConnectorAuthAlert } = await import(
      '../../platform/integrations/connectors/ConnectorAuthAlertScheduler'
    );

    const result = await dispatchConnectorAuthAlert({
      tenantId: 'tenant-1',
      integrationId: 'int-1',
      provider: 'hubspot',
      connectorType: 'crm',
    });

    expect(result.status).toBe('sent');
    expect(reconnectTemplateMock).toHaveBeenCalledTimes(1);
    // The legacy claim predicate (with the 24h OR-clause) is preserved for
    // non-scheduling connectors so this test fails loudly if a future
    // refactor accidentally globalizes the strict NULL-only predicate.
    const claimCall = queryMock.mock.calls.find((c) => {
      const sql = String(c[0]);
      return (
        sql.includes('UPDATE integrations') &&
        sql.includes('SET auth_alert_sent_at = NOW()') &&
        sql.includes('WHERE id = $1')
      );
    });
    expect(claimCall).toBeDefined();
    const claimSql = String(claimCall![0]);
    expect(claimSql).toContain("INTERVAL '24 hours'");
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
