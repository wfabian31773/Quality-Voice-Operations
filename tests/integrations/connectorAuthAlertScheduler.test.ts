import { describe, it, expect, beforeEach, vi } from 'vitest';

const queryMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
}));

const sendEmailMock = vi.fn(async () => ({ success: true }));

vi.mock('../../platform/email', () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...(args as [])),
  connectorSyncErrorEmail: () => ({ subject: 's', html: 'h', text: 't' }),
  connectorReconnectNeededEmail: () => ({ subject: 'reconnect', html: 'h', text: 't' }),
  connectorAutoDisabledEmail: () => ({ subject: 'disabled', html: 'h', text: 't' }),
  connectorSyncDigestEmail: () => ({
    subject: 'digest',
    html: 'h',
    text: 't',
  }),
}));

const fanoutInAppNotificationMock = vi.fn(async () => undefined);
const filterEmailRecipientsByPreferenceMock = vi.fn(
  async (_tenantId: string, recipients: string[]) => recipients,
);

vi.mock('../../platform/notifications/NotificationPreferences', () => ({
  fanoutInAppNotification: (...args: unknown[]) =>
    fanoutInAppNotificationMock(...(args as [])),
  filterEmailRecipientsByPreference: (...args: unknown[]) =>
    filterEmailRecipientsByPreferenceMock(...(args as [string, string[]])),
}));

interface FailureRow {
  tenant_id: string;
  integration_id: string;
  provider: string;
  integration_type: string;
  name: string | null;
  last_sync_status: string;
  last_sync_error: string;
  last_sync_error_at: Date | null;
}

function makeFailure(overrides: Partial<FailureRow> = {}): FailureRow {
  return {
    tenant_id: 'tenant-1',
    integration_id: 'int-1',
    provider: 'salesforce',
    integration_type: 'crm',
    name: 'Acme Salesforce',
    last_sync_status: 'needs_reconnect',
    last_sync_error: '401 unauthorized',
    last_sync_error_at: new Date(Date.now() - 30 * 60 * 1000),
    ...overrides,
  };
}

interface RouterOpts {
  failures: FailureRow[];
  digestMode: boolean;
  digestLastSentAt: Date | null;
  admins: string[];
  /**
   * If set, the digest_last_sent_at update succeeds; the integration update
   * we use to inspect what got stamped is captured into here so tests can
   * inspect them.
   */
  stamps: string[];
}

// NOTE: When matching SQL in this file, prefer stable structural fragments
// (table names, JOIN clauses, distinctive WHERE predicates) over volatile
// literals like role lists. The previous matcher keyed off
// `role IN ('admin', 'owner')`, which silently broke when production widened
// `getTenantAdmins` to include `tenant_owner` / `operations_manager` via a
// `user_roles` join — the test fell through to the catch-all empty result
// and the digest pipeline reported "no admin recipients".
function installRouter(opts: RouterOpts): void {
  queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
    const text = String(sql);
    // findPendingAuthFailures
    if (text.includes('FROM integrations') && text.includes('auth_alert_sent_at IS NULL')) {
      return { rows: opts.failures };
    }
    // dispatchConnectorAuthAlert: per-integration row lookup
    if (
      text.includes('FROM integrations') &&
      text.includes('WHERE tenant_id = $1 AND id = $2')
    ) {
      const integrationId = (params?.[1] as string) ?? '';
      const match = opts.failures.find((f) => f.integration_id === integrationId);
      if (!match) return { rows: [] };
      return {
        rows: [
          {
            name: match.name,
            integration_type: match.integration_type,
            auth_alert_sent_at: null,
            last_sync_error: match.last_sync_error,
            last_sync_error_at: match.last_sync_error_at,
          },
        ],
      };
    }
    // loadMuteSetsForTenants
    if (text.includes('FROM connector_alert_mutes')) {
      return { rows: [] };
    }
    // getConnectorAlertSettings
    if (text.includes('FROM connector_alert_settings')) {
      return {
        rows: [
          {
            digest_mode: opts.digestMode,
            digest_last_sent_at: opts.digestLastSentAt,
            updated_at: null,
            updated_by: null,
          },
        ],
      };
    }
    // recentInAppNotificationExists
    if (text.includes('FROM tenant_notifications')) {
      return { rows: [] };
    }
    // getTenantAdmins: tenant name lookup
    if (text.startsWith('SELECT name FROM tenants')) {
      return { rows: [{ name: 'Acme' }] };
    }
    // getTenantAdmins: admin emails. The production query was widened to
    // include tenant_owner / operations_manager via the user_roles join, so
    // we match on the stable LEFT JOIN clause rather than the old role list.
    if (text.includes('FROM users') && text.includes('LEFT JOIN user_roles')) {
      return { rows: opts.admins.map((email) => ({ email })) };
    }
    // recordDigestSent (UPSERT into connector_alert_settings)
    if (text.includes('INSERT INTO connector_alert_settings')) {
      return { rows: [] };
    }
    // recordAlertSent (per-integration auth_alert_sent_at stamp)
    if (text.includes('UPDATE integrations') && text.includes('auth_alert_sent_at = NOW()')) {
      const integrationId = (params?.[0] as string) ?? '';
      opts.stamps.push(integrationId);
      return { rows: [] };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  queryMock.mockReset();
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ success: true });
  fanoutInAppNotificationMock.mockReset();
  fanoutInAppNotificationMock.mockResolvedValue(undefined);
  filterEmailRecipientsByPreferenceMock.mockReset();
  filterEmailRecipientsByPreferenceMock.mockImplementation(
    async (_t: string, r: string[]) => r,
  );
});

describe('runConnectorAuthAlertCycle — digest mode gating', () => {
  it('does NOT stamp auth_alert_sent_at when the digest is suppressed by the 24h throttle window', async () => {
    const stamps: string[] = [];
    installRouter({
      failures: [makeFailure({ integration_id: 'int-A' })],
      digestMode: true,
      // Last digest 1h ago — well inside the 24h throttle.
      digestLastSentAt: new Date(Date.now() - 60 * 60 * 1000),
      admins: ['admin@acme.com'],
      stamps,
    });

    const { runConnectorAuthAlertCycle } = await import(
      '../../platform/integrations/connectors/ConnectorAuthAlertScheduler'
    );
    const result = await runConnectorAuthAlertCycle();

    // No email sent because the throttle suppressed it...
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(result.digestEmailsSent).toBe(0);
    // ...and CRUCIALLY no integration was stamped, so the next cycle (after
    // the throttle expires) can still pick this failure up for the digest.
    expect(stamps).toEqual([]);
  });

  it('does NOT stamp auth_alert_sent_at when every digest send fails (SMTP outage)', async () => {
    const stamps: string[] = [];
    installRouter({
      failures: [
        makeFailure({ integration_id: 'int-A' }),
        makeFailure({ integration_id: 'int-B', provider: 'hubspot' }),
      ],
      digestMode: true,
      digestLastSentAt: null,
      admins: ['admin@acme.com'],
      stamps,
    });
    sendEmailMock.mockResolvedValue({ success: false, error: 'smtp down' });

    const { runConnectorAuthAlertCycle } = await import(
      '../../platform/integrations/connectors/ConnectorAuthAlertScheduler'
    );
    const result = await runConnectorAuthAlertCycle();

    // The scheduler attempted the send but every attempt failed.
    expect(sendEmailMock).toHaveBeenCalled();
    expect(result.digestEmailsSent).toBe(0);
    // Neither integration was stamped — the next cycle can retry instead
    // of being silenced for 24h by a transient SMTP outage.
    expect(stamps).toEqual([]);
  });

  it('stamps every queued integration only after a successful digest send', async () => {
    const stamps: string[] = [];
    installRouter({
      failures: [
        makeFailure({ integration_id: 'int-A' }),
        makeFailure({ integration_id: 'int-B', provider: 'hubspot' }),
        makeFailure({ integration_id: 'int-C', provider: 'quickbooks' }),
      ],
      digestMode: true,
      digestLastSentAt: null,
      admins: ['admin@acme.com'],
      stamps,
    });

    const { runConnectorAuthAlertCycle } = await import(
      '../../platform/integrations/connectors/ConnectorAuthAlertScheduler'
    );
    const result = await runConnectorAuthAlertCycle();

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(result.digestEmailsSent).toBe(1);
    expect(result.alerted).toBe(3);
    // All three queued integrations get their auth_alert_sent_at stamped
    // exactly once, in the order they were buffered.
    expect(stamps).toEqual(['int-A', 'int-B', 'int-C']);
  });

  it('skips muted connectors entirely (stamps them so they are not re-evaluated each cycle)', async () => {
    const stamps: string[] = [];
    queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
      const text = String(sql);
      if (text.includes('FROM integrations') && text.includes('auth_alert_sent_at IS NULL')) {
        return {
          rows: [
            makeFailure({ integration_id: 'int-muted', provider: 'slack' }),
            makeFailure({ integration_id: 'int-active' }),
          ],
        };
      }
      // dispatchConnectorAuthAlert: per-integration row lookup. Without this
      // the dispatcher returns 'skipped' immediately and the active row is
      // never alerted on / claimed.
      if (
        text.includes('FROM integrations') &&
        text.includes('WHERE tenant_id = $1 AND id = $2')
      ) {
        const integrationId = (params?.[1] as string) ?? '';
        return {
          rows: [
            {
              name: 'Acme Salesforce',
              integration_type: 'crm',
              auth_alert_sent_at: null,
              last_sync_error: '401 unauthorized',
              last_sync_error_at: new Date(Date.now() - 30 * 60 * 1000),
              integration_id: integrationId,
            },
          ],
        };
      }
      if (text.includes('FROM connector_alert_mutes')) {
        // Slack is provider-muted at the tenant level.
        return {
          rows: [{ tenant_id: 'tenant-1', scope: 'provider', target: 'slack' }],
        };
      }
      if (text.includes('FROM connector_alert_settings')) {
        return {
          rows: [
            {
              digest_mode: false,
              digest_last_sent_at: null,
              updated_at: null,
              updated_by: null,
            },
          ],
        };
      }
      if (text.includes('FROM tenant_notifications')) return { rows: [] };
      if (text.startsWith('SELECT name FROM tenants')) {
        return { rows: [{ name: 'Acme' }] };
      }
      if (text.includes('FROM users') && text.includes('LEFT JOIN user_roles')) {
        return { rows: [{ email: 'admin@acme.com' }] };
      }
      if (text.includes('UPDATE integrations') && text.includes('auth_alert_sent_at = NOW()')) {
        stamps.push((params?.[0] as string) ?? '');
        // claimAuthAlertSlot inspects rowCount to decide whether the row was
        // actually claimed; without this the active connector's dispatch is
        // treated as a throttle race loss and never counted in `alerted`.
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    });

    const { runConnectorAuthAlertCycle } = await import(
      '../../platform/integrations/connectors/ConnectorAuthAlertScheduler'
    );
    const result = await runConnectorAuthAlertCycle();

    expect(result.mutedSkipped).toBe(1);
    expect(result.alerted).toBe(1);
    // Both rows get stamped: the muted one to avoid re-evaluation, and the
    // active one because the per-event email succeeded.
    expect(stamps.sort()).toEqual(['int-active', 'int-muted']);
    // And the muted Slack row never produced an email or in-app fan-out.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const fanoutCalls = fanoutInAppNotificationMock.mock.calls.map(
      (c) => (c[0] as { metadata?: { provider?: string } }).metadata?.provider,
    );
    expect(fanoutCalls).not.toContain('slack');
  });
});
