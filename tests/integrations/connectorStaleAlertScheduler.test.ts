import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { ConnectorTokenHealthRow } from '../../platform/integrations/connectors/db';

const queryMock = vi.fn<
  (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>
>();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
}));

const sendEmailMock = vi.fn(async () => ({ success: true }));
vi.mock('../../platform/email', () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...(args as [Record<string, unknown>])),
}));

const slackMock = vi.fn(async () => ({ success: true }));
vi.mock('../../platform/messaging/SlackWebhookNotifier', () => ({
  postToOpsSlackWebhook: (...args: unknown[]) =>
    slackMock(...(args as [Record<string, unknown>])),
}));

const listTokenHealthMock = vi.fn<
  (
    providers: string[],
    options?: { onTenantError?: 'skip' | 'throw' },
  ) => Promise<ConnectorTokenHealthRow[]>
>();
vi.mock('../../platform/integrations/connectors/db', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../platform/integrations/connectors/db')
  >();
  return {
    ...actual,
    // Capture the options arg so a test can assert the scheduler runs in
    // strict mode (per-tenant failures should bubble up, not be silently
    // swallowed into a partial snapshot).
    listConnectorTokenHealth: (
      providers: string[],
      options?: { onTenantError?: 'skip' | 'throw' },
    ) => listTokenHealthMock(providers, options),
  };
});

vi.mock('../../platform/integrations/connectors/tokenRefresh', () => ({
  getRefreshableProviders: () => ['salesforce', 'hubspot', 'google'],
}));

const REFRESH_CYCLE_MS = 15 * 60 * 1000;
const STALE_THRESHOLD = 2;
const NOW = Date.parse('2026-04-01T12:00:00Z');

function makeRow(overrides: Partial<ConnectorTokenHealthRow> = {}): ConnectorTokenHealthRow {
  return {
    tenantId: 'tenant-A',
    tenantName: 'Acme',
    tenantSlug: 'acme',
    integrationId: 'int-1',
    integrationType: 'crm',
    provider: 'salesforce',
    name: 'Acme Salesforce',
    isEnabled: true,
    lastSyncStatus: 'needs_reconnect',
    lastSyncAt: null,
    // 3 cycles past the failure → past STALE_THRESHOLD of 2 cycles.
    lastSyncErrorAt: new Date(NOW - 3 * REFRESH_CYCLE_MS).toISOString(),
    tokenIssuedAt: NOW - 24 * 60 * 60 * 1000,
    tokenExpiresAt: NOW - REFRESH_CYCLE_MS,
    tokenDecryptFailed: false,
    ...overrides,
  };
}

beforeEach(() => {
  queryMock.mockReset();
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ success: true });
  slackMock.mockReset();
  slackMock.mockResolvedValue({ success: true });
  listTokenHealthMock.mockReset();
});

function installLedger(rows: unknown[]): void {
  // Default everything to "no rows" except the ledger SELECT and the admin
  // email lookup, both of which we wire below. This keeps the test focused
  // on the scheduler's branching logic without re-stubbing every helper.
  queryMock.mockImplementation(async (sql: string) => {
    const text = String(sql);
    if (text.includes('FROM connector_stale_alerts') && text.includes('SELECT')) {
      return { rows };
    }
    if (text.includes('FROM users') && text.includes('is_platform_admin')) {
      return { rows: [{ email: 'ops@qvo.test' }] };
    }
    return { rows: [] };
  });
}

describe('ConnectorStaleAlertScheduler – decideStaleAlerts', () => {
  it('alerts new outages and skips ones inside the cooldown window', async () => {
    const { decideStaleAlerts } = await import(
      '../../platform/integrations/connectors/ConnectorStaleAlertScheduler'
    );

    const stale = [
      {
        tenantId: 'tenant-A',
        tenantName: 'Acme',
        tenantSlug: 'acme',
        integrationId: 'int-NEW',
        integrationType: 'crm',
        provider: 'salesforce',
        providerLabel: 'Salesforce',
        name: 'New SF',
        lastSyncStatus: 'needs_reconnect',
        lastSyncAt: null,
        lastSyncErrorAt: null,
        status: 'needs_reconnect' as const,
        cyclesSinceRefresh: 4,
        expiresInMs: -3_600_000,
      },
      {
        tenantId: 'tenant-A',
        tenantName: 'Acme',
        tenantSlug: 'acme',
        integrationId: 'int-RECENT',
        integrationType: 'crm',
        provider: 'hubspot',
        providerLabel: 'HubSpot',
        name: 'Recent HS',
        lastSyncStatus: 'needs_reconnect',
        lastSyncAt: null,
        lastSyncErrorAt: null,
        status: 'needs_reconnect' as const,
        cyclesSinceRefresh: 3,
        expiresInMs: null,
      },
    ];

    const ledger = [
      // Inside cooldown — should be suppressed.
      {
        tenant_id: 'tenant-A',
        integration_id: 'int-RECENT',
        last_alerted_at: new Date(NOW - 2 * 24 * 60 * 60 * 1000),
        resolved_at: null,
        alert_count: 1,
      },
    ];

    const decision = decideStaleAlerts(stale, ledger, NOW);

    expect(decision.toAlert.map((e) => e.integrationId)).toEqual(['int-NEW']);
    expect(decision.suppressed.map((e) => e.integrationId)).toEqual(['int-RECENT']);
    expect(decision.recovered).toEqual([]);
  });

  it('re-alerts when the cooldown has elapsed and treats resolved rows as new outages', async () => {
    const { decideStaleAlerts } = await import(
      '../../platform/integrations/connectors/ConnectorStaleAlertScheduler'
    );

    const stale = [
      {
        tenantId: 'tenant-A',
        tenantName: 'Acme',
        tenantSlug: 'acme',
        integrationId: 'int-OLD',
        integrationType: 'crm',
        provider: 'salesforce',
        providerLabel: 'Salesforce',
        name: 'Long-running SF',
        lastSyncStatus: 'needs_reconnect',
        lastSyncAt: null,
        lastSyncErrorAt: null,
        status: 'needs_reconnect' as const,
        cyclesSinceRefresh: 800,
        expiresInMs: -10_000_000_000,
      },
      {
        tenantId: 'tenant-B',
        tenantName: 'Beta',
        tenantSlug: 'beta',
        integrationId: 'int-REGRESSED',
        integrationType: 'crm',
        provider: 'hubspot',
        providerLabel: 'HubSpot',
        name: 'Regressed HS',
        lastSyncStatus: 'needs_reconnect',
        lastSyncAt: null,
        lastSyncErrorAt: null,
        status: 'needs_reconnect' as const,
        cyclesSinceRefresh: 4,
        expiresInMs: null,
      },
    ];

    const ledger = [
      {
        tenant_id: 'tenant-A',
        integration_id: 'int-OLD',
        // 8 days ago > 7-day cooldown → re-alert.
        last_alerted_at: new Date(NOW - 8 * 24 * 60 * 60 * 1000),
        resolved_at: null,
        alert_count: 5,
      },
      {
        tenant_id: 'tenant-B',
        integration_id: 'int-REGRESSED',
        // Still inside cooldown, BUT marked resolved → fresh outage.
        last_alerted_at: new Date(NOW - 1 * 24 * 60 * 60 * 1000),
        resolved_at: new Date(NOW - 12 * 60 * 60 * 1000),
        alert_count: 2,
      },
    ];

    const decision = decideStaleAlerts(stale, ledger, NOW);
    expect(decision.toAlert.map((e) => e.integrationId).sort()).toEqual([
      'int-OLD',
      'int-REGRESSED',
    ]);
    expect(decision.suppressed).toEqual([]);
  });

  it('marks ledger rows as recovered when the connector is no longer stale', async () => {
    const { decideStaleAlerts } = await import(
      '../../platform/integrations/connectors/ConnectorStaleAlertScheduler'
    );

    const ledger = [
      {
        tenant_id: 'tenant-A',
        integration_id: 'int-FIXED',
        last_alerted_at: new Date(NOW - 3 * 24 * 60 * 60 * 1000),
        resolved_at: null,
        alert_count: 1,
      },
      {
        tenant_id: 'tenant-A',
        integration_id: 'int-ALREADY-RESOLVED',
        last_alerted_at: new Date(NOW - 60 * 24 * 60 * 60 * 1000),
        resolved_at: new Date(NOW - 30 * 24 * 60 * 60 * 1000),
        alert_count: 1,
      },
    ];

    const decision = decideStaleAlerts([], ledger, NOW);
    expect(decision.toAlert).toEqual([]);
    expect(decision.suppressed).toEqual([]);
    expect(decision.recovered).toEqual([
      { tenantId: 'tenant-A', integrationId: 'int-FIXED' },
    ]);
  });
});

describe('ConnectorStaleAlertScheduler – findStaleConnectors', () => {
  it('returns only rows past the stale threshold and skips healthy ones', async () => {
    const { findStaleConnectors } = await import(
      '../../platform/integrations/connectors/ConnectorStaleAlertScheduler'
    );

    listTokenHealthMock.mockResolvedValueOnce([
      // Healthy → skip.
      makeRow({
        integrationId: 'int-healthy',
        lastSyncStatus: 'success',
        lastSyncErrorAt: null,
        tokenExpiresAt: NOW + 12 * 60 * 60 * 1000,
      }),
      // Just hit needs_reconnect 1 cycle ago → not yet stale.
      makeRow({
        integrationId: 'int-fresh-fail',
        lastSyncStatus: 'needs_reconnect',
        lastSyncErrorAt: new Date(NOW - REFRESH_CYCLE_MS).toISOString(),
      }),
      // Stale: needs_reconnect for > STALE_THRESHOLD cycles.
      makeRow({
        integrationId: 'int-stale-needs-reconnect',
        lastSyncStatus: 'needs_reconnect',
        lastSyncErrorAt: new Date(
          NOW - (STALE_THRESHOLD + 2) * REFRESH_CYCLE_MS,
        ).toISOString(),
      }),
      // Stale: token expired more than STALE_THRESHOLD cycles ago.
      makeRow({
        integrationId: 'int-stale-expired',
        lastSyncStatus: 'success',
        lastSyncErrorAt: null,
        tokenExpiresAt: NOW - (STALE_THRESHOLD + 1) * REFRESH_CYCLE_MS,
      }),
    ]);

    const result = await findStaleConnectors(NOW);
    expect(result.map((r) => r.integrationId).sort()).toEqual([
      'int-stale-expired',
      'int-stale-needs-reconnect',
    ]);
  });
});

describe('ConnectorStaleAlertScheduler – runConnectorStaleAlertCycle', () => {
  it('sends a digest email + Slack and stamps the ledger when there are new stale connectors', async () => {
    const { runConnectorStaleAlertCycle } = await import(
      '../../platform/integrations/connectors/ConnectorStaleAlertScheduler'
    );

    listTokenHealthMock.mockResolvedValueOnce([
      makeRow({ integrationId: 'int-stale-1' }),
      makeRow({
        integrationId: 'int-stale-2',
        provider: 'hubspot',
        name: 'Acme HubSpot',
      }),
    ]);

    installLedger([]);

    const result = await runConnectorStaleAlertCycle({ nowMs: NOW });

    expect(result.staleCount).toBe(2);
    expect(result.alertedCount).toBe(2);
    expect(result.emailDelivered).toBe(true);
    expect(result.slackDelivered).toBe(true);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendEmailMock.mock.calls[0][0]).toMatchObject({
      to: 'ops@qvo.test',
      subject: expect.stringContaining('connectors wedged'),
    });
    expect(slackMock).toHaveBeenCalledTimes(1);

    // Two upserts into connector_stale_alerts (one per stale row).
    const upsertCalls = queryMock.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO connector_stale_alerts'),
    );
    expect(upsertCalls).toHaveLength(2);
    // Sorted alphabetically by integration name → "Acme HubSpot" before "Acme Salesforce".
    const stamped = upsertCalls
      .map((c) => c[1] as unknown[])
      .map((p) => ({ tenantId: p[0], integrationId: p[1], provider: p[2], status: p[3] }));
    expect(stamped).toEqual(
      expect.arrayContaining([
        { tenantId: 'tenant-A', integrationId: 'int-stale-1', provider: 'salesforce', status: 'needs_reconnect' },
        { tenantId: 'tenant-A', integrationId: 'int-stale-2', provider: 'hubspot', status: 'needs_reconnect' },
      ]),
    );
  });

  it('suppresses re-alerts for ledger entries inside the cooldown window', async () => {
    const { runConnectorStaleAlertCycle } = await import(
      '../../platform/integrations/connectors/ConnectorStaleAlertScheduler'
    );

    listTokenHealthMock.mockResolvedValueOnce([makeRow({ integrationId: 'int-old' })]);

    installLedger([
      {
        tenant_id: 'tenant-A',
        integration_id: 'int-old',
        last_alerted_at: new Date(NOW - 24 * 60 * 60 * 1000),
        resolved_at: null,
        alert_count: 1,
      },
    ]);

    const result = await runConnectorStaleAlertCycle({ nowMs: NOW });

    expect(result.staleCount).toBe(1);
    expect(result.alertedCount).toBe(0);
    expect(result.suppressedCount).toBe(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(slackMock).not.toHaveBeenCalled();

    const upsertCalls = queryMock.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO connector_stale_alerts'),
    );
    expect(upsertCalls).toHaveLength(0);
  });

  it('stamps recoveries when previously-alerted rows are no longer stale', async () => {
    const { runConnectorStaleAlertCycle } = await import(
      '../../platform/integrations/connectors/ConnectorStaleAlertScheduler'
    );

    listTokenHealthMock.mockResolvedValueOnce([]);

    installLedger([
      {
        tenant_id: 'tenant-A',
        integration_id: 'int-fixed',
        last_alerted_at: new Date(NOW - 3 * 24 * 60 * 60 * 1000),
        resolved_at: null,
        alert_count: 1,
      },
    ]);

    const result = await runConnectorStaleAlertCycle({ nowMs: NOW });

    expect(result.recoveredCount).toBe(1);
    expect(result.alertedCount).toBe(0);

    const updateCalls = queryMock.mock.calls.filter(([sql]) =>
      String(sql).includes('UPDATE connector_stale_alerts')
      && String(sql).includes('resolved_at = NOW()'),
    );
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0][1]).toEqual(['tenant-A', 'int-fixed']);
  });

  it('does not stamp the ledger when both Slack and email fail and admins are configured', async () => {
    const { runConnectorStaleAlertCycle } = await import(
      '../../platform/integrations/connectors/ConnectorStaleAlertScheduler'
    );

    listTokenHealthMock.mockResolvedValueOnce([makeRow({ integrationId: 'int-stale-1' })]);
    installLedger([]);
    sendEmailMock.mockResolvedValueOnce({ success: false, error: 'smtp down' } as never);
    slackMock.mockResolvedValueOnce({ success: false, error: 'slack 500' } as never);

    const result = await runConnectorStaleAlertCycle({ nowMs: NOW });

    expect(result.alertedCount).toBe(0);
    expect(result.emailDelivered).toBe(false);
    expect(result.slackDelivered).toBe(false);

    const upsertCalls = queryMock.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO connector_stale_alerts'),
    );
    expect(upsertCalls).toHaveLength(0);
  });

  it('requests strict per-tenant error mode so partial snapshots cannot mass-resolve the ledger', async () => {
    const { runConnectorStaleAlertCycle } = await import(
      '../../platform/integrations/connectors/ConnectorStaleAlertScheduler'
    );

    listTokenHealthMock.mockResolvedValueOnce([]);
    installLedger([
      {
        tenant_id: 'tenant-A',
        integration_id: 'int-still-broken',
        last_alerted_at: new Date(NOW - 24 * 60 * 60 * 1000),
        resolved_at: null,
        alert_count: 1,
      },
    ]);

    await runConnectorStaleAlertCycle({ nowMs: NOW });

    // Scheduler MUST opt into strict mode so per-tenant decrypt/load
    // failures bubble out instead of being silently dropped (which would
    // cause "no longer in stale set" → mass auto-resolve).
    expect(listTokenHealthMock).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ onTenantError: 'throw' }),
    );
  });

  it('aborts the cycle without touching the ledger when the snapshot fetch fails', async () => {
    const { runConnectorStaleAlertCycle } = await import(
      '../../platform/integrations/connectors/ConnectorStaleAlertScheduler'
    );

    listTokenHealthMock.mockRejectedValueOnce(new Error('db unreachable'));

    // Pre-existing unresolved ledger entries that MUST NOT be auto-resolved
    // when the snapshot read failed — otherwise the next successful cycle
    // would re-page ops for every still-broken connector.
    installLedger([
      {
        tenant_id: 'tenant-A',
        integration_id: 'int-still-broken-1',
        last_alerted_at: new Date(NOW - 24 * 60 * 60 * 1000),
        resolved_at: null,
        alert_count: 1,
      },
      {
        tenant_id: 'tenant-A',
        integration_id: 'int-still-broken-2',
        last_alerted_at: new Date(NOW - 24 * 60 * 60 * 1000),
        resolved_at: null,
        alert_count: 3,
      },
    ]);

    const result = await runConnectorStaleAlertCycle({ nowMs: NOW });

    expect(result.snapshotLoadFailed).toBe(true);
    expect(result.alertedCount).toBe(0);
    expect(result.recoveredCount).toBe(0);
    expect(result.emailDelivered).toBe(false);
    expect(result.slackDelivered).toBe(false);

    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(slackMock).not.toHaveBeenCalled();

    // No INSERT (alert) and no UPDATE (resolve) writes against the ledger.
    const writeCalls = queryMock.mock.calls.filter(([sql]) => {
      const text = String(sql);
      return (
        text.includes('INSERT INTO connector_stale_alerts') ||
        (text.includes('UPDATE connector_stale_alerts') && text.includes('resolved_at'))
      );
    });
    expect(writeCalls).toHaveLength(0);
  });

  it('still stamps the ledger when there are no platform admin emails to notify', async () => {
    const { runConnectorStaleAlertCycle } = await import(
      '../../platform/integrations/connectors/ConnectorStaleAlertScheduler'
    );

    listTokenHealthMock.mockResolvedValueOnce([makeRow({ integrationId: 'int-stale-1' })]);

    queryMock.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes('FROM connector_stale_alerts') && text.includes('SELECT')) {
        return { rows: [] };
      }
      if (text.includes('FROM users') && text.includes('is_platform_admin')) {
        return { rows: [] };
      }
      return { rows: [] };
    });

    const result = await runConnectorStaleAlertCycle({ nowMs: NOW });

    expect(result.alertedCount).toBe(1);
    expect(result.emailDelivered).toBe(false);
    expect(sendEmailMock).not.toHaveBeenCalled();

    const upsertCalls = queryMock.mock.calls.filter(([sql]) =>
      String(sql).includes('INSERT INTO connector_stale_alerts'),
    );
    expect(upsertCalls).toHaveLength(1);
  });
});
