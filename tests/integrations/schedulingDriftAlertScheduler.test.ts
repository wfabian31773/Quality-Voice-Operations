import { describe, it, expect, beforeEach, vi } from 'vitest';

const queryMock = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ query: queryMock }),
}));

const sendEmailMock = vi.fn(async () => ({ success: true }));

vi.mock('../../platform/email', () => ({
  sendEmail: (...args: unknown[]) => sendEmailMock(...(args as [])),
  connectorSchedulingDriftEmail: (params: {
    drifted: Array<{ refType: string; name: string; providerLabel: string }>;
  }) => ({
    subject: `drift-${params.drifted.length}`,
    html: `<ul>${params.drifted.map((d) => `<li>${d.refType}:${d.name}:${d.providerLabel}</li>`).join('')}</ul>`,
    text: params.drifted.map((d) => `${d.refType}:${d.name}:${d.providerLabel}`).join('\n'),
  }),
}));

const filterEmailRecipientsByPreferenceMock = vi.fn(
  async (_tenantId: string, recipients: string[]) => recipients,
);

vi.mock('../../platform/notifications/NotificationPreferences', () => ({
  filterEmailRecipientsByPreference: (...args: unknown[]) =>
    filterEmailRecipientsByPreferenceMock(...(args as [string, string[], string])),
}));

interface DriftRow {
  tenant_id: string;
  tenant_name: string | null;
  ref_type: 'agent' | 'phone_number';
  ref_id: string;
  ref_name: string | null;
  provider: string;
}

interface RouterOpts {
  driftRows: DriftRow[];
  admins: string[];
  /**
   * If non-empty, the conditional UPDATE to claim the slot returns rowCount=0
   * for these tenant ids (race lost / already stamped within 24h).
   */
  losingTenants?: Set<string>;
  /** Captured tenant ids that successfully claimed the slot. */
  claimed: string[];
  /** Captured tenant ids whose slot was released (no recipients / SMTP fail). */
  released: string[];
}

function installRouter(opts: RouterOpts): void {
  const losing = opts.losingTenants ?? new Set<string>();
  queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
    const text = String(sql);

    // findPendingSchedulingDrift
    if (text.includes('FROM drifted d') && text.includes('JOIN tenants tn')) {
      return { rows: opts.driftRows };
    }

    // claimSchedulingDriftSlot
    if (
      text.includes('UPDATE tenants') &&
      text.includes('scheduling_drift_alert_sent_at = NOW()')
    ) {
      const tenantId = (params?.[0] as string) ?? '';
      if (losing.has(tenantId)) {
        return { rows: [], rowCount: 0 };
      }
      opts.claimed.push(tenantId);
      return { rows: [], rowCount: 1 };
    }

    // releaseSchedulingDriftSlot
    if (
      text.includes('UPDATE tenants') &&
      text.includes('scheduling_drift_alert_sent_at = NULL')
    ) {
      opts.released.push((params?.[0] as string) ?? '');
      return { rows: [], rowCount: 1 };
    }

    // getTenantAlertEmailRecipients (LEFT JOIN user_roles)
    if (text.includes('FROM users') && text.includes('LEFT JOIN user_roles')) {
      return { rows: opts.admins.map((email) => ({ id: `u-${email}`, email })) };
    }

    return { rows: [] };
  });
}

beforeEach(() => {
  queryMock.mockReset();
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ success: true });
  filterEmailRecipientsByPreferenceMock.mockReset();
  filterEmailRecipientsByPreferenceMock.mockImplementation(
    async (_t: string, r: string[]) => r,
  );
});

describe('runSchedulingDriftAlertCycle', () => {
  it('emails one alert per tenant containing every drifted agent and phone number', async () => {
    const claimed: string[] = [];
    const released: string[] = [];
    installRouter({
      driftRows: [
        {
          tenant_id: 'tenant-1',
          tenant_name: 'Acme',
          ref_type: 'agent',
          ref_id: 'agent-1',
          ref_name: 'Front-desk',
          provider: 'google-calendar',
        },
        {
          tenant_id: 'tenant-1',
          tenant_name: 'Acme',
          ref_type: 'phone_number',
          ref_id: 'phone-1',
          ref_name: '+15551234',
          provider: 'outlook-calendar',
        },
        {
          tenant_id: 'tenant-2',
          tenant_name: 'Globex',
          ref_type: 'agent',
          ref_id: 'agent-2',
          ref_name: 'Triage',
          provider: 'google-calendar',
        },
      ],
      admins: ['admin@example.com'],
      claimed,
      released,
    });

    const { runSchedulingDriftAlertCycle } = await import(
      '../../platform/integrations/connectors/SchedulingDriftAlertScheduler'
    );
    const result = await runSchedulingDriftAlertCycle();

    expect(result.inspected).toBe(2);
    expect(result.alerted).toBe(2);
    expect(result.emailedRecipients).toBe(2);
    expect(result.skippedNoRecipients).toBe(0);
    expect(result.throttled).toBe(0);
    expect(claimed.sort()).toEqual(['tenant-1', 'tenant-2']);
    expect(released).toEqual([]);
    expect(sendEmailMock).toHaveBeenCalledTimes(2);

    // tenant-1 email bundles both drifted targets into a single message.
    const tenant1Subject = sendEmailMock.mock.calls.find(
      (c) => (c[0] as { to: string }).to === 'admin@example.com' &&
        (c[0] as { subject: string }).subject === 'drift-2',
    );
    expect(tenant1Subject).toBeDefined();

    // tenant-2 only has one drifted target.
    const tenant2Subject = sendEmailMock.mock.calls.find(
      (c) => (c[0] as { subject: string }).subject === 'drift-1',
    );
    expect(tenant2Subject).toBeDefined();
  });

  it('releases the slot when the tenant has no admin recipients (so next cycle can retry)', async () => {
    const claimed: string[] = [];
    const released: string[] = [];
    installRouter({
      driftRows: [
        {
          tenant_id: 'tenant-1',
          tenant_name: 'Acme',
          ref_type: 'agent',
          ref_id: 'agent-1',
          ref_name: 'Front-desk',
          provider: 'google-calendar',
        },
      ],
      admins: [], // no recipients
      claimed,
      released,
    });

    const { runSchedulingDriftAlertCycle } = await import(
      '../../platform/integrations/connectors/SchedulingDriftAlertScheduler'
    );
    const result = await runSchedulingDriftAlertCycle();

    expect(claimed).toEqual(['tenant-1']);
    expect(released).toEqual(['tenant-1']);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(result.alerted).toBe(0);
    expect(result.skippedNoRecipients).toBe(1);
  });

  it('releases the slot when every email send fails (transient SMTP outage)', async () => {
    const claimed: string[] = [];
    const released: string[] = [];
    installRouter({
      driftRows: [
        {
          tenant_id: 'tenant-1',
          tenant_name: 'Acme',
          ref_type: 'agent',
          ref_id: 'agent-1',
          ref_name: 'Front-desk',
          provider: 'google-calendar',
        },
      ],
      admins: ['admin@example.com'],
      claimed,
      released,
    });
    sendEmailMock.mockResolvedValue({ success: false, error: 'smtp down' });

    const { runSchedulingDriftAlertCycle } = await import(
      '../../platform/integrations/connectors/SchedulingDriftAlertScheduler'
    );
    const result = await runSchedulingDriftAlertCycle();

    expect(claimed).toEqual(['tenant-1']);
    expect(released).toEqual(['tenant-1']);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect(result.alerted).toBe(0);
    expect(result.skippedNoRecipients).toBe(1);
  });

  it('does not send when the slot claim is lost (race with another scheduler instance)', async () => {
    const claimed: string[] = [];
    const released: string[] = [];
    installRouter({
      driftRows: [
        {
          tenant_id: 'tenant-1',
          tenant_name: 'Acme',
          ref_type: 'agent',
          ref_id: 'agent-1',
          ref_name: 'Front-desk',
          provider: 'google-calendar',
        },
      ],
      admins: ['admin@example.com'],
      losingTenants: new Set(['tenant-1']),
      claimed,
      released,
    });

    const { runSchedulingDriftAlertCycle } = await import(
      '../../platform/integrations/connectors/SchedulingDriftAlertScheduler'
    );
    const result = await runSchedulingDriftAlertCycle();

    expect(claimed).toEqual([]);
    expect(released).toEqual([]);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(result.throttled).toBe(1);
    expect(result.alerted).toBe(0);
  });

  it('respects the integration notification opt-out for admin recipients', async () => {
    const claimed: string[] = [];
    const released: string[] = [];
    installRouter({
      driftRows: [
        {
          tenant_id: 'tenant-1',
          tenant_name: 'Acme',
          ref_type: 'agent',
          ref_id: 'agent-1',
          ref_name: 'Front-desk',
          provider: 'google-calendar',
        },
      ],
      admins: ['opted-out@example.com'],
      claimed,
      released,
    });
    filterEmailRecipientsByPreferenceMock.mockResolvedValueOnce([]);

    const { runSchedulingDriftAlertCycle } = await import(
      '../../platform/integrations/connectors/SchedulingDriftAlertScheduler'
    );
    const result = await runSchedulingDriftAlertCycle();

    // The category is the existing 'integration' bucket so admins who already
    // opted out of integration emails don't get nagged through a new channel.
    expect(filterEmailRecipientsByPreferenceMock).toHaveBeenCalledWith(
      'tenant-1',
      ['opted-out@example.com'],
      'integration',
    );
    expect(claimed).toEqual(['tenant-1']);
    expect(released).toEqual(['tenant-1']);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(result.alerted).toBe(0);
    expect(result.skippedNoRecipients).toBe(1);
  });
});
