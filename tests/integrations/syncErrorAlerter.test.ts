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
  // Production strips angle brackets off the message id before persisting it
  // for the email-status webhook. Without a stub here the call throws and
  // every "sent" outcome silently degrades to "failed".
  normaliseMessageId: (id?: string | null) =>
    typeof id === 'string' && id.length > 0 ? id.replace(/^<|>$/g, '') : null,
}));

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  queryMock.mockReset();
  fetchMock.mockReset();
  sendEmailMock.mockReset();
  sendEmailMock.mockResolvedValue({ success: true });
  // Default fallback: any query a test did not explicitly script returns
  // an empty rowset instead of `undefined`, which would crash production
  // code that destructures `.rows`. Tests opt into a richer world via
  // `mockScenario(...)`.
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  process.env.TWILIO_ACCOUNT_SID = 'AC_test';
  process.env.TWILIO_AUTH_TOKEN = 'token_test';
  process.env.TWILIO_SMS_FROM = '+15555550100';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

// ---------------------------------------------------------------------------
// Scenario-based query dispatcher
//
// Tests describe the world the alerter is running against (which users the
// tenant has, who's an admin recipient, what preferences they hold, what
// throttle markers are stamped, etc.) instead of enumerating every database
// query in call order. The dispatcher answers each query the production code
// makes by SQL fingerprint, NOT by call order, so production-side changes
// (an extra audit INSERT, a new column on a SELECT, an internal helper that
// runs another lookup) only require touching this helper instead of
// re-counting every test's `mockResolvedValueOnce` chain.
//
// Tests then assert OUTCOMES (Twilio called, email sent, the right INSERT
// happened) by filtering `queryMock.mock.calls` / `fetchMock.mock.calls`
// with the same SQL substrings used here.
// ---------------------------------------------------------------------------

interface ScenarioEmailRecipient {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
}

interface ScenarioPhoneRecipient {
  id: string;
  phone: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}

interface MockScenario {
  /** Connector mute lookup: when true, every alert is suppressed. */
  muted?: boolean;
  /** Tenant lookup. `null` = tenant row does not exist. */
  tenant?: { name?: string | null; smsAlertsDisabled?: boolean } | null;
  /** Admin recipients returned by the shared email helper. */
  emailRecipients?: ScenarioEmailRecipient[];
  /** Emails (case-insensitive) whose `email` pref is OFF. */
  emailOptOuts?: string[];
  /** Admin recipients returned by the shared phone helper. */
  phoneRecipients?: ScenarioPhoneRecipient[];
  /** Tenant users returned for the in-app fanout audience. */
  tenantUsers?: string[];
  /** User IDs whose `in_app` pref is OFF for the queried category. */
  inAppOptOuts?: string[];
  /** Existing per-event email throttle row in `tenant_notifications`. */
  emailThrottleHit?: boolean;
  /** Existing per-integration SMS throttle row in `tenant_notifications`. */
  smsThrottleHit?: boolean;
  /**
   * Recovery throttle marker on the integrations row. `'absent'` means the
   * row is missing entirely; null/undefined means present with no marker.
   */
  recoveryAlertSentAt?: Date | string | null | 'absent';
  /** When true, tenant has digest mode on (suppresses per-event email). */
  digestMode?: boolean;
  /** rowCount returned by the auth_alert_sent_at UPDATE. Default 1. */
  stampAuthAlertRowCount?: number;
  /** rowCount returned by the recovery_alert_sent_at UPDATE. Default 1. */
  stampRecoveryRowCount?: number;
  /** When true, the recovery_alert_sent_at UPDATE throws. */
  stampRecoveryThrows?: boolean;
  /** Latest-failed candidates returned by the resend dispatcher query. */
  resendCandidates?: Array<{
    user_id: string | null;
    recipient_name: string | null;
    recipient_email: string | null;
    recipient_phone: string | null;
    delivery_status: string;
  }>;
}

function mockScenario(scenario: MockScenario = {}): void {
  const tenantUsers = scenario.tenantUsers ?? [];
  const inAppOptOuts = new Set(scenario.inAppOptOuts ?? []);
  const emailOptOuts = new Set(
    (scenario.emailOptOuts ?? []).map((e) => e.toLowerCase()),
  );

  queryMock.mockImplementation(async (sqlIn: unknown, params?: unknown) => {
    const sql = String(sqlIn);
    const args = (params as unknown[] | undefined) ?? [];

    // Connector mute lookup.
    if (sql.includes('FROM connector_alert_mutes')) {
      return scenario.muted
        ? { rows: [{ scope: 'provider', target: 'salesforce' }] }
        : { rows: [] };
    }

    // Sustained-SMS tenant lookup (carries `sms_alerts_disabled`).
    if (sql.includes('sms_alerts_disabled') && sql.includes('FROM tenants')) {
      if (scenario.tenant === null) return { rows: [] };
      return {
        rows: [
          {
            name: scenario.tenant?.name ?? 'Acme',
            sms_alerts_disabled: !!scenario.tenant?.smsAlertsDisabled,
          },
        ],
      };
    }

    // Plain tenant name lookup (failure / recovery paths). Match on the
    // table + predicate rather than the exact SELECT projection so adding
    // a new column to the tenant lookup doesn't fall through to the
    // default empty-rows fallback.
    if (sql.includes('FROM tenants') && sql.includes('WHERE id = $1')) {
      if (scenario.tenant === null) return { rows: [] };
      return { rows: [{ name: scenario.tenant?.name ?? 'Acme' }] };
    }

    // Per-event sync error throttle (keyed by provider in metadata).
    if (
      sql.includes('FROM tenant_notifications') &&
      sql.includes("metadata ->> 'provider'")
    ) {
      return { rows: scenario.emailThrottleHit ? [{ id: 'prev-email' }] : [] };
    }

    // Per-integration SMS throttle (keyed by integrationId in metadata).
    if (
      sql.includes('FROM tenant_notifications') &&
      sql.includes("metadata ->> 'integrationId'")
    ) {
      return { rows: scenario.smsThrottleHit ? [{ id: 'prev-sms' }] : [] };
    }

    // Recovery throttle marker on integrations.
    if (sql.includes('SELECT recovery_alert_sent_at FROM integrations')) {
      if (scenario.recoveryAlertSentAt === 'absent') return { rows: [] };
      return {
        rows: [
          {
            recovery_alert_sent_at: scenario.recoveryAlertSentAt ?? null,
          },
        ],
      };
    }

    // Email-recipient helper query (shared LEFT JOIN user_roles UNION-style
    // gating).
    if (
      sql.includes('FROM users u') &&
      sql.includes('LEFT JOIN user_roles ur') &&
      sql.includes('u.email') &&
      !sql.includes('u.phone_number')
    ) {
      const list = scenario.emailRecipients ?? [];
      return {
        rows: list.map((r) => ({
          id: r.id,
          email: r.email,
          first_name: r.firstName ?? null,
          last_name: r.lastName ?? null,
          created_at: null,
        })),
      };
    }

    // Phone-recipient helper query (same shared gating, returns phone_number).
    if (
      sql.includes('FROM users u') &&
      sql.includes('LEFT JOIN user_roles ur') &&
      sql.includes('u.phone_number')
    ) {
      const list = scenario.phoneRecipients ?? [];
      return {
        rows: list.map((r) => ({
          id: r.id,
          phone_number: r.phone,
          first_name: r.firstName ?? null,
          last_name: r.lastName ?? null,
          email: r.email ?? null,
          created_at: null,
        })),
      };
    }

    // Email pref filter (filterEmailRecipientsByPreference).
    if (
      sql.includes('user_notification_preferences') &&
      sql.includes('LOWER(u.email)')
    ) {
      const cleaned = (args[1] as string[] | undefined) ?? [];
      const rows = cleaned
        .filter((e) => emailOptOuts.has(e.toLowerCase()))
        .map((e) => ({ email: e.toLowerCase(), enabled: false }));
      return { rows };
    }

    // user_id pref filter (filterUserIdsByPreference).
    if (
      sql.includes('SELECT user_id, enabled') &&
      sql.includes('FROM user_notification_preferences')
    ) {
      const ids = (args[2] as string[] | undefined) ?? [];
      const rows = ids
        .filter((id) => inAppOptOuts.has(id))
        .map((id) => ({ user_id: id, enabled: false }));
      return { rows };
    }

    // Fanout audience: tenant users.
    if (
      sql.includes('SELECT id FROM users') &&
      sql.includes('tenant_id = $1') &&
      sql.includes('is_active')
    ) {
      return { rows: tenantUsers.map((id) => ({ id })) };
    }

    // INSERT into tenant_notifications (per-user fanout).
    if (sql.includes('INSERT INTO tenant_notifications')) {
      return { rows: [] };
    }

    // INSERT into connector_alert_recipients (per-recipient audit).
    if (sql.includes('INSERT INTO connector_alert_recipients')) {
      return { rows: [] };
    }

    // UPDATE integrations SET auth_alert_sent_at.
    if (
      sql.includes('UPDATE integrations') &&
      sql.includes('auth_alert_sent_at')
    ) {
      return { rows: [], rowCount: scenario.stampAuthAlertRowCount ?? 1 };
    }

    // UPDATE integrations SET recovery_alert_sent_at.
    if (
      sql.includes('UPDATE integrations') &&
      sql.includes('recovery_alert_sent_at')
    ) {
      if (scenario.stampRecoveryThrows) {
        throw new Error('db down');
      }
      return { rows: [], rowCount: scenario.stampRecoveryRowCount ?? 1 };
    }

    // connector_alert_settings (digest mode).
    if (sql.includes('FROM connector_alert_settings')) {
      if (scenario.digestMode) {
        return {
          rows: [
            {
              digest_mode: true,
              digest_last_sent_at: null,
              updated_at: null,
              updated_by: null,
            },
          ],
        };
      }
      return { rows: [] };
    }

    // Resend dispatcher: latest-failed candidates per (email, phone).
    if (sql.includes('FROM connector_alert_recipients')) {
      return { rows: scenario.resendCandidates ?? [] };
    }

    return { rows: [], rowCount: 0 };
  });
}

/** Calls to `queryMock` whose SQL contains `needle`. */
function callsMatching(needle: string): unknown[][] {
  return queryMock.mock.calls.filter((c) => String(c[0]).includes(needle));
}

// ---------------------------------------------------------------------------
// Pure helper tests — no DB.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// notifySustainedConnectorFailure
// ---------------------------------------------------------------------------

describe('notifySustainedConnectorFailure', () => {
  const baseParams = {
    tenantId: 'tenant-1',
    integrationId: 'int-1',
    connectorType: 'crm' as const,
    provider: 'salesforce',
    errorMessage: 'API rate limit',
  };

  it('skips non-revenue-critical providers', async () => {
    mockScenario();
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
    mockScenario();
    const { notifySustainedConnectorFailure } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifySustainedConnectorFailure({ ...baseParams, firstFailedAt: null });
    expect(queryMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips when outage is shorter than the sustained-failure threshold', async () => {
    mockScenario();
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
    mockScenario({
      tenant: { name: 'Acme', smsAlertsDisabled: true },
      phoneRecipients: [{ id: 'user-a', phone: '+15551234567' }],
    });
    const { notifySustainedConnectorFailure } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifySustainedConnectorFailure({
      ...baseParams,
      firstFailedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(callsMatching('INSERT INTO connector_alert_recipients')).toHaveLength(0);
    expect(callsMatching('INSERT INTO tenant_notifications')).toHaveLength(0);
  });

  it('respects the per-integration 24h SMS throttle', async () => {
    mockScenario({
      tenant: { name: 'Acme' },
      smsThrottleHit: true,
      phoneRecipients: [{ id: 'user-a', phone: '+15551234567' }],
    });
    const { notifySustainedConnectorFailure } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifySustainedConnectorFailure({
      ...baseParams,
      firstFailedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(callsMatching('INSERT INTO connector_alert_recipients')).toHaveLength(0);
    expect(callsMatching('INSERT INTO tenant_notifications')).toHaveLength(0);
  });

  it('logs and records when no admin phone numbers are on file', async () => {
    mockScenario({ tenant: { name: 'Acme' }, phoneRecipients: [] });
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
    mockScenario({
      tenant: { name: 'Acme' },
      phoneRecipients: [
        { id: 'user-a', phone: '+15551234567' },
        { id: 'user-b', phone: '+15557654321' },
      ],
      tenantUsers: ['user-a', 'user-b'],
    });
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
    // Regression: SMS body must include the provider-keyed reconnect link
    // (URL-encoded inside the form-urlencoded body), so admins can jump
    // straight to the right connector card from their phone whether or
    // not the integration row still exists.
    expect(body).toContain('%2Fconnectors%3Fprovider%3Dsalesforce');
    expect(body).not.toContain('%2Fconnectors%3Fintegration%3D');

    // Per-recipient fanned-out SMS notification rows: one per active user
    // (none of them opted out of the 'sms' in_app pref).
    const insertCalls = callsMatching('INSERT INTO tenant_notifications');
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

  it('passes Twilio statusCallback URL and records the returned message SID for live tracking', async () => {
    // This is the wiring the /twilio/sms-status webhook depends on:
    //   1. We must include a StatusCallback in the form body so Twilio
    //      posts back delivery progress (queued -> sent -> delivered/failed).
    //   2. We must persist the returned Message SID into
    //      connector_alert_recipients.twilio_message_sid so the webhook can
    //      find this row when those callbacks land.
    // Regressing either side silently kills the live-tracking UI.
    process.env.VOICE_GATEWAY_BASE_URL = 'https://voice.example.test';

    mockScenario({
      tenant: { name: 'Acme' },
      phoneRecipients: [{ id: 'user-a', phone: '+15551234567' }],
      tenantUsers: ['user-a'],
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ sid: 'SM_live_tracking_sid_123' }),
    } as unknown as Response);

    const { notifySustainedConnectorFailure } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifySustainedConnectorFailure({
      ...baseParams,
      firstFailedAt: new Date(Date.now() - 90 * 60 * 1000).toISOString(),
    });

    // 1. StatusCallback URL must be included in the Twilio request body.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = String((fetchMock.mock.calls[0][1] as RequestInit).body);
    expect(body).toContain(
      'StatusCallback=https%3A%2F%2Fvoice.example.test%2Ftwilio%2Fsms-status',
    );

    // 2. The returned SID must land in the recipient audit row, in the
    //    13th positional slot (matches the INSERT column order in
    //    `recordRecipientAudit`).
    const auditCall = callsMatching('INSERT INTO connector_alert_recipients')[0];
    expect(auditCall).toBeDefined();
    const auditArgs = auditCall[1] as unknown[];
    expect(auditArgs[12]).toBe('SM_live_tracking_sid_123');
  });

  it('skips SMS sends to admins who opted out of the sms category', async () => {
    mockScenario({
      tenant: { name: 'Acme' },
      phoneRecipients: [
        { id: 'user-a', phone: '+15551234567' },
        { id: 'user-b', phone: '+15557654321' },
      ],
      tenantUsers: ['user-a', 'user-b'],
      // user-a has the 'sms' in_app channel off, which doubles as the
      // SMS-recipient gating preference.
      inAppOptOuts: ['user-a'],
    });
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
    const insertCalls = callsMatching('INSERT INTO tenant_notifications');
    expect(insertCalls.length).toBe(1);
    expect((insertCalls[0][1] as unknown[])[1]).toBe('user-b');
  });

  it('does NOT record a throttle entry when Twilio is configured but every send fails', async () => {
    mockScenario({
      tenant: { name: 'Acme' },
      phoneRecipients: [
        { id: 'user-a', phone: '+15551234567' },
        { id: 'user-b', phone: '+15557654321' },
      ],
      tenantUsers: ['user-a', 'user-b'],
    });
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
    // Neither the in-app fan-out nor the per-recipient audit rows should
    // be written when every Twilio send fails — that lets the next sync
    // error retry instead of being suppressed for 24h.
    expect(callsMatching('INSERT INTO tenant_notifications')).toHaveLength(0);
    expect(callsMatching('INSERT INTO connector_alert_recipients')).toHaveLength(0);
  });

  it('still records the dispatch (for throttling) when Twilio is not configured', async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_SMS_FROM;
    delete process.env.TWILIO_PHONE_NUMBER;

    mockScenario({
      tenant: { name: 'Acme' },
      phoneRecipients: [{ id: 'user-a', phone: '+15551234567' }],
      tenantUsers: ['user-a'],
    });

    const { notifySustainedConnectorFailure } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifySustainedConnectorFailure({
      ...baseParams,
      firstFailedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    const insertCalls = callsMatching('INSERT INTO tenant_notifications');
    expect(insertCalls.length).toBe(1);
    const metadata = JSON.parse((insertCalls[0][1] as unknown[])[5] as string);
    expect(metadata.twilioConfigured).toBe(false);
    expect(metadata.smsAttempted).toBe(0);
  });

  it('SMSes a sustained-failure recipient who only holds the tenant_owner role via user_roles', async () => {
    // Regression test (mirrors the notifyConnectorSyncError user_roles test):
    // sustained-failure SMS goes through the shared recipient helper
    // (getTenantAlertPhoneRecipients), which UNIONs the legacy `users.role`
    // column with the canonical `user_roles` join. If a future refactor
    // re-narrows this lookup back to `role IN ('admin','owner')`, tenant
    // owners / operations managers whose role only lives in user_roles
    // would silently stop being paged on outages. This test pins both the
    // SQL shape and the actual Twilio dispatch.
    mockScenario({
      tenant: { name: 'Acme' },
      phoneRecipients: [{ id: 'user-owner', phone: '+15551234567' }],
      tenantUsers: ['user-owner'],
    });
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
      firstFailedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });

    // The phone recipient query MUST be the shared helper's JOIN —
    // references user_roles and accepts the canonical tenant_owner /
    // operations_manager role values. If this regresses to
    // `role IN ('admin','owner')` on users alone, user_roles-only owners
    // silently stop being paged.
    const recipientQuery = queryMock.mock.calls.find((c) => {
      const sql = String(c[0]);
      return (
        sql.includes('FROM users u') &&
        sql.includes('LEFT JOIN user_roles ur') &&
        sql.includes('u.phone_number')
      );
    });
    expect(recipientQuery).toBeDefined();
    const sql = String(recipientQuery![0]);
    expect(sql).toContain("ur.role IN ('tenant_owner', 'operations_manager')");
    expect(sql).toContain(
      "u.role IN ('admin', 'owner', 'tenant_owner', 'operations_manager')",
    );
    const recipientArgs = recipientQuery![1] as unknown[];
    expect(recipientArgs[0]).toBe('tenant-1');

    // The Twilio SMS actually went out to the user_roles-only owner.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = String((fetchMock.mock.calls[0][1] as RequestInit).body);
    expect(body).toContain('To=%2B15551234567');
    expect(body).toContain('From=%2B15555550100');
  });
});

// ---------------------------------------------------------------------------
// notifyConnectorRecovery
// ---------------------------------------------------------------------------

describe('notifyConnectorRecovery', () => {
  const baseParams = {
    tenantId: 'tenant-1',
    integrationId: 'int-1',
    connectorType: 'crm' as const,
    provider: 'salesforce',
    outageDurationMs: 90 * 60 * 1000,
  };

  it('skips non-revenue-critical providers', async () => {
    mockScenario();
    const { notifyConnectorRecovery } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorRecovery({ ...baseParams, provider: 'slack' });
    expect(queryMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('respects the 24h throttle from integrations.recovery_alert_sent_at', async () => {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    mockScenario({ recoveryAlertSentAt: oneHourAgo });

    const { notifyConnectorRecovery } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorRecovery(baseParams);

    const throttleCalls = callsMatching('SELECT recovery_alert_sent_at FROM integrations');
    expect(throttleCalls).toHaveLength(1);
    // Must scope by both id and tenant_id so two HubSpot connectors for
    // the same tenant don't suppress each other.
    expect(throttleCalls[0][1]).toEqual(['int-1', 'tenant-1']);
    expect(sendEmailMock).not.toHaveBeenCalled();
    // Bailed before any further work.
    expect(callsMatching('INSERT INTO tenant_notifications')).toHaveLength(0);
    expect(callsMatching('UPDATE integrations')).toHaveLength(0);
  });

  it('proceeds when the recovery throttle marker is older than the window', async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    mockScenario({
      recoveryAlertSentAt: twoDaysAgo,
      tenantUsers: ['user-a'],
      tenant: { name: 'Acme' },
      emailRecipients: [{ id: 'user-admin', email: 'admin@acme.test' }],
    });

    const { notifyConnectorRecovery } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorRecovery(baseParams);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('records an in-app notification and emails admins on recovery', async () => {
    mockScenario({
      recoveryAlertSentAt: null,
      tenantUsers: ['user-a', 'user-b'],
      tenant: { name: 'Acme' },
      emailRecipients: [
        { id: 'user-admin', email: 'admin@acme.test' },
        { id: 'user-owner', email: 'owner@acme.test' },
      ],
    });

    const { notifyConnectorRecovery } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorRecovery(baseParams);

    const insertCalls = callsMatching('INSERT INTO tenant_notifications');
    expect(insertCalls.length).toBe(2);
    for (const call of insertCalls) {
      const args = call[1] as unknown[];
      expect(args[2]).toBe('integration_recovery');
      const metadata = JSON.parse(args[5] as string);
      expect(metadata.integrationId).toBe('int-1');
      expect(metadata.provider).toBe('salesforce');
      expect(metadata.outageDurationMs).toBe(90 * 60 * 1000);
      expect(metadata.outageDescription).toBeTruthy();
      // Regression: recovery in-app `link` must be the provider-keyed form
      // so click-through resolves to the right connector card even if the
      // integration row was deleted between failure and recovery.
      expect(metadata.link).toBe('/connectors?provider=salesforce');
    }

    // The throttle marker must have been stamped.
    const stampCalls = queryMock.mock.calls.filter((c) => {
      const sql = String(c[0]);
      return sql.includes('UPDATE integrations') && sql.includes('recovery_alert_sent_at');
    });
    expect(stampCalls.length).toBe(1);
    expect(stampCalls[0][1]).toEqual(['int-1', 'tenant-1']);

    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    const recipients = sendEmailMock.mock.calls.map(
      (c) => (c[0] as { to: string }).to,
    );
    expect(recipients).toEqual(
      expect.arrayContaining(['admin@acme.test', 'owner@acme.test']),
    );
  });

  it('still notifies after a long outage (>7 days)', async () => {
    mockScenario({
      recoveryAlertSentAt: 'absent',
      tenantUsers: ['user-a'],
      tenant: { name: 'Acme' },
      emailRecipients: [{ id: 'user-admin', email: 'admin@acme.test' }],
    });

    const tenDaysMs = 10 * 24 * 60 * 60 * 1000;
    const { notifyConnectorRecovery } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorRecovery({ ...baseParams, outageDurationMs: tenDaysMs });

    const insertCall = callsMatching('INSERT INTO tenant_notifications')[0];
    expect(insertCall).toBeDefined();
    const metadata = JSON.parse((insertCall[1] as unknown[])[5] as string);
    expect(metadata.outageDurationMs).toBe(tenDaysMs);
    expect(metadata.outageDescription).toMatch(/day/);
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('still records the in-app notification when no admin emails are on file', async () => {
    mockScenario({
      recoveryAlertSentAt: null,
      tenantUsers: ['user-a'],
      tenant: { name: 'Acme' },
      emailRecipients: [],
    });

    const { notifyConnectorRecovery } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorRecovery({ ...baseParams, outageDurationMs: null });

    expect(callsMatching('INSERT INTO tenant_notifications')).toHaveLength(1);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('suppresses recovery email when all admins opted out of integration_recovery email but still inserts in-app entry', async () => {
    mockScenario({
      recoveryAlertSentAt: 'absent',
      tenantUsers: ['user-a'],
      tenant: { name: 'Acme' },
      emailRecipients: [{ id: 'user-admin', email: 'admin@acme.test' }],
      emailOptOuts: ['admin@acme.test'],
    });

    const { notifyConnectorRecovery } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorRecovery(baseParams);

    // The in-app notification should still have been recorded.
    const insertCalls = callsMatching('INSERT INTO tenant_notifications');
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
    mockScenario({
      recoveryAlertSentAt: 'absent',
      tenantUsers: ['user-a'],
      inAppOptOuts: ['user-a'],
      tenant: { name: 'Acme' },
      emailRecipients: [{ id: 'user-admin', email: 'admin@acme.test' }],
    });

    const { notifyConnectorRecovery } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorRecovery(baseParams);

    // No in-app rows inserted (everyone opted out).
    expect(callsMatching('INSERT INTO tenant_notifications')).toHaveLength(0);

    // Throttle marker stamped despite zero in-app inserts.
    const stampCall = queryMock.mock.calls.find((c) => {
      const sql = String(c[0]);
      return sql.includes('UPDATE integrations') && sql.includes('recovery_alert_sent_at');
    });
    expect(stampCall).toBeDefined();

    // Email DID go out (only in_app was muted, not email).
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('does not send email if the throttle stamp matches zero rows (e.g. integration deleted mid-flight)', async () => {
    mockScenario({
      recoveryAlertSentAt: null,
      tenantUsers: ['user-a'],
      stampRecoveryRowCount: 0,
    });

    const { notifyConnectorRecovery } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorRecovery(baseParams);

    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('does not send email if stamping the throttle marker fails (avoids unbounded retries)', async () => {
    mockScenario({
      recoveryAlertSentAt: null,
      tenantUsers: ['user-a'],
      stampRecoveryThrows: true,
    });

    const { notifyConnectorRecovery } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorRecovery(baseParams);

    // No email sent — bail to avoid spamming on every retry.
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('emails a recovery recipient who only holds the tenant_owner role via user_roles', async () => {
    // Regression test (mirrors the notifyConnectorSyncError user_roles test):
    // the recovery email path now goes through the shared recipient helper
    // (getTenantAlertEmailRecipients), which UNIONs the legacy `users.role`
    // column with the canonical `user_roles` join. If a future refactor
    // re-narrows this lookup back to `role IN ('admin','owner')`, tenant
    // owners / operations managers whose role only lives in user_roles
    // would silently stop receiving the "back online" email.
    mockScenario({
      recoveryAlertSentAt: null,
      tenantUsers: ['user-owner'],
      tenant: { name: 'Acme' },
      emailRecipients: [{ id: 'user-owner', email: 'owner-via-roles@acme.test' }],
    });

    const { notifyConnectorRecovery } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorRecovery(baseParams);

    // The recipient query MUST be the shared helper's JOIN — references
    // user_roles and accepts the canonical tenant_owner / operations_manager
    // role values. If this regresses to `role IN ('admin','owner')` on
    // users alone, user_roles-only owners silently stop being emailed.
    const recipientQuery = queryMock.mock.calls.find((c) => {
      const sql = String(c[0]);
      return (
        sql.includes('FROM users u') &&
        sql.includes('LEFT JOIN user_roles ur') &&
        sql.includes('u.email')
      );
    });
    expect(recipientQuery).toBeDefined();
    const sql = String(recipientQuery![0]);
    expect(sql).toContain("ur.role IN ('tenant_owner', 'operations_manager')");
    expect(sql).toContain(
      "u.role IN ('admin', 'owner', 'tenant_owner', 'operations_manager')",
    );
    const recipientArgs = recipientQuery![1] as unknown[];
    expect(recipientArgs[0]).toBe('tenant-1');

    // The recovery email actually went out to the user_roles-only owner,
    // and the email pref filter was scoped to the recovery category.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect((sendEmailMock.mock.calls[0][0] as { to: string }).to).toBe(
      'owner-via-roles@acme.test',
    );
    const prefFilterCall = queryMock.mock.calls.find((c) => {
      const s = String(c[0]);
      return s.includes('user_notification_preferences') && s.includes('LOWER(u.email)');
    });
    expect(prefFilterCall).toBeDefined();
    expect(prefFilterCall![1][2]).toBe('integration_recovery');
  });
});

// ---------------------------------------------------------------------------
// notifyConnectorSyncError
// ---------------------------------------------------------------------------

describe('notifyConnectorSyncError', () => {
  const baseParams = {
    tenantId: 'tenant-1',
    integrationId: 'int-1',
    connectorType: 'crm' as const,
    provider: 'salesforce',
    errorMessage: 'API rate limit exceeded',
  };

  it('skips non-revenue-critical providers (no throttle check, no fan-out, no email)', async () => {
    mockScenario();
    const { notifyConnectorSyncError } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorSyncError({ ...baseParams, provider: 'slack' });
    expect(queryMock).not.toHaveBeenCalled();
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('honors per-user opt-outs: drops in-app for users with integration in_app off and drops email for opted-out admins', async () => {
    mockScenario({
      tenant: { name: 'Acme' },
      emailRecipients: [
        { id: 'user-owner', email: 'owner@acme.test' },
        { id: 'user-admin', email: 'admin@acme.test' },
      ],
      emailOptOuts: ['admin@acme.test'],
      tenantUsers: ['user-a', 'user-b'],
      inAppOptOuts: ['user-a'],
    });

    const { notifyConnectorSyncError } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorSyncError(baseParams);

    // In-app: only one row inserted, and it must target user-b (user-a opted out).
    const insertCalls = callsMatching('INSERT INTO tenant_notifications');
    expect(insertCalls.length).toBe(1);
    const insertArgs = insertCalls[0][1] as unknown[];
    expect(insertArgs[1]).toBe('user-b');
    expect(insertArgs[2]).toBe('integration');
    const metadata = JSON.parse(insertArgs[5] as string);
    expect(metadata.integrationId).toBe('int-1');
    expect(metadata.provider).toBe('salesforce');
    // Regression: per-event in-app reconnect link must be the provider-keyed
    // form (`/connectors?provider=<provider>`) so it still resolves to the
    // right connector card after the integration row is deleted.
    expect(metadata.link).toBe('/connectors?provider=salesforce');

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
    mockScenario({
      tenant: { name: 'Acme' },
      emailRecipients: [{ id: 'user-admin', email: 'admin@acme.test' }],
      emailOptOuts: ['admin@acme.test'],
      tenantUsers: ['user-a'],
    });

    const { notifyConnectorSyncError } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorSyncError(baseParams);

    // In-app row still recorded for user-a.
    expect(callsMatching('INSERT INTO tenant_notifications')).toHaveLength(1);

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
    mockScenario({
      tenant: { name: 'Acme' },
      emailRecipients: [{ id: 'user-admin', email: 'admin@acme.test' }],
      tenantUsers: ['user-a'],
      inAppOptOuts: ['user-a'],
    });

    const { notifyConnectorSyncError } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorSyncError(baseParams);

    // No in-app rows inserted — every active user opted out of in_app.
    expect(callsMatching('INSERT INTO tenant_notifications')).toHaveLength(0);

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

  it('persists recipientCount, emailRecipientCount, firstFailedAt, and outageMinutes on every fanned-out in-app row', async () => {
    // Pin the enriched in-app metadata so the GET /connectors/alerts route
    // can collapse fan-out rows back into a single event with the actual
    // email recipient count and outage duration. If a future refactor of
    // notifyConnectorSyncError stops computing the recipient list before
    // fan-out (or drops one of these fields), the alerts UI silently shows
    // 0 recipients / "—" outage forever after; this test is the canary.
    const firstFailedAtIso = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    mockScenario({
      tenant: { name: 'Acme' },
      emailRecipients: [
        { id: 'user-a', email: 'a@acme.test' },
        { id: 'user-b', email: 'b@acme.test' },
        { id: 'user-c', email: 'c@acme.test' },
      ],
      // c@acme.test opted OUT, leaving 2 email recipients.
      emailOptOuts: ['c@acme.test'],
      tenantUsers: ['user-a', 'user-b', 'user-c'],
    });

    const { notifyConnectorSyncError } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorSyncError({
      ...baseParams,
      firstFailedAt: firstFailedAtIso,
    });

    const insertCalls = callsMatching('INSERT INTO tenant_notifications');
    // One fanned-out row per active tenant user (the in_app filter didn't
    // drop anyone in this test).
    expect(insertCalls.length).toBe(3);

    for (const call of insertCalls) {
      const args = call[1] as unknown[];
      // type column — confirms these are integration alerts (not SMS).
      expect(args[2]).toBe('integration');
      const metadata = JSON.parse(args[5] as string);
      // Counts reflect the EMAIL-eligible audience (post pref filter), not
      // the raw admin list — c@acme.test opted out so 3 -> 2.
      expect(metadata.recipientCount).toBe(2);
      expect(metadata.emailRecipientCount).toBe(2);
      // Outage timing was carried through verbatim from firstFailedAt and
      // computed in whole minutes from "now".
      expect(metadata.firstFailedAt).toBe(firstFailedAtIso);
      expect(metadata.outageMinutes).toBe(45);
      // Sanity: integrationId/provider/connectorType still populated so the
      // /connectors/alerts collapse query has a stable key.
      expect(metadata.integrationId).toBe('int-1');
      expect(metadata.provider).toBe('salesforce');
      expect(metadata.connectorType).toBe('crm');
    }

    // The two opted-in admins received the email.
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
  });

  it('records recipientCount=0 and outageMinutes=null when firstFailedAt is missing and every admin opts out of email', async () => {
    // Edge case: the per-event email is suppressed entirely (every admin
    // opted out of the integration email channel) and the caller never
    // supplied firstFailedAt. The in-app rows must still be written and
    // their metadata must record the zero/null values explicitly so the
    // alerts UI distinguishes "no email recipients" from "old alert
    // missing the field".
    mockScenario({
      tenant: { name: 'Acme' },
      emailRecipients: [{ id: 'user-a', email: 'a@acme.test' }],
      emailOptOuts: ['a@acme.test'],
      tenantUsers: ['user-a'],
    });

    const { notifyConnectorSyncError } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorSyncError({
      ...baseParams,
      firstFailedAt: null,
    });

    const insertCalls = callsMatching('INSERT INTO tenant_notifications');
    expect(insertCalls.length).toBe(1);
    const metadata = JSON.parse((insertCalls[0][1] as unknown[])[5] as string);
    expect(metadata.recipientCount).toBe(0);
    expect(metadata.emailRecipientCount).toBe(0);
    expect(metadata.firstFailedAt).toBeNull();
    expect(metadata.outageMinutes).toBeNull();

    // No email actually sent (everyone opted out).
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('reaches a recipient who only holds the tenant_owner role via user_roles', async () => {
    // Regression test: prior to the shared-recipient refactor, the
    // SyncErrorAlerter only matched on the legacy `users.role` column
    // ('admin','owner') and silently dropped users whose
    // tenant_owner / operations_manager role lived in the user_roles join.
    // Those users still got reconnect nudges from the auth-alert scheduler
    // but were missing from per-event sync error emails. This test asserts
    // the recipient query is now the shared helper's JOIN — accepting role
    // values from user_roles — and that an email actually goes out to a
    // user who only holds the role there.
    mockScenario({
      tenant: { name: 'Acme' },
      emailRecipients: [{ id: 'user-owner', email: 'owner-via-roles@acme.test' }],
      tenantUsers: ['user-owner'],
    });

    const { notifyConnectorSyncError } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    await notifyConnectorSyncError(baseParams);

    // The recipient query MUST be the shared helper's JOIN — i.e. it
    // references the user_roles table and the canonical tenant_owner /
    // operations_manager role values. If this assertion regresses, we've
    // gone back to the old `role IN ('admin','owner')` query that silently
    // drops user_roles-only owners.
    const recipientQuery = queryMock.mock.calls.find((c) => {
      const sql = String(c[0]);
      return (
        sql.includes('FROM users u') &&
        sql.includes('LEFT JOIN user_roles ur') &&
        sql.includes('u.email')
      );
    });
    expect(recipientQuery).toBeDefined();
    const sql = String(recipientQuery![0]);
    // user_roles must accept the canonical newer role values…
    expect(sql).toContain("ur.role IN ('tenant_owner', 'operations_manager')");
    // …and the legacy users.role column must keep accepting admin/owner
    // alongside the new role names so backwards compatibility holds.
    expect(sql).toContain(
      "u.role IN ('admin', 'owner', 'tenant_owner', 'operations_manager')",
    );
    const recipientArgs = recipientQuery![1] as unknown[];
    expect(recipientArgs[0]).toBe('tenant-1');

    // The email actually went out to the user_roles-only owner.
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    expect((sendEmailMock.mock.calls[0][0] as { to: string }).to).toBe(
      'owner-via-roles@acme.test',
    );
  });
});

// ---------------------------------------------------------------------------
// resendConnectorAlertToFailedRecipients
// ---------------------------------------------------------------------------

describe('resendConnectorAlertToFailedRecipients', () => {
  it('resends an email to each failed recipient and writes new audit rows under the same dispatchId', async () => {
    mockScenario({
      resendCandidates: [
        {
          user_id: 'user-a',
          recipient_name: 'Ada Lovelace',
          recipient_email: 'ada@acme.test',
          recipient_phone: null,
          delivery_status: 'failed',
        },
        {
          user_id: 'user-b',
          recipient_name: 'Grace Hopper',
          recipient_email: 'grace@acme.test',
          recipient_phone: null,
          delivery_status: 'skipped',
        },
      ],
    });

    const { resendConnectorAlertToFailedRecipients } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    const outcome = await resendConnectorAlertToFailedRecipients({
      tenantId: 'tenant-1',
      integrationId: 'int-1',
      dispatchId: 'disp-1',
      notificationType: 'integration',
      provider: 'salesforce',
      errorMessage: 'API rate limit',
      firstFailedAt: '2026-04-26T17:45:00.000Z',
      outageMinutes: 45,
      tenantName: 'Acme',
    });

    expect(outcome).toMatchObject({
      channel: 'email',
      candidates: 2,
      attempted: 2,
      succeeded: 2,
      failed: 0,
      skipped: 0,
    });

    // Each candidate triggered an email send.
    expect(sendEmailMock).toHaveBeenCalledTimes(2);
    const sentTos = sendEmailMock.mock.calls.map(
      (c) => (c[0] as { to: string }).to,
    );
    expect(sentTos).toEqual(
      expect.arrayContaining(['ada@acme.test', 'grace@acme.test']),
    );

    // Each candidate also produced a new INSERT into
    // connector_alert_recipients carrying the SAME dispatch_id and channel
    // 'email' so the timeline view shows the retry attempts.
    const inserts = callsMatching('INSERT INTO connector_alert_recipients');
    expect(inserts).toHaveLength(2);
    for (const call of inserts) {
      const params = call[1] as unknown[];
      expect(params[0]).toBe('tenant-1');
      expect(params[1]).toBe('int-1');
      expect(params[2]).toBe('disp-1'); // dispatch_id preserved
      expect(params[3]).toBe('integration'); // notification_type
      expect(params[4]).toBe('email'); // channel
      expect(params[9]).toBe('sent'); // delivery_status
    }
  });

  it('records failed delivery (with the error) and counts it under failed in the outcome', async () => {
    mockScenario({
      resendCandidates: [
        {
          user_id: 'user-a',
          recipient_name: 'Ada',
          recipient_email: 'ada@acme.test',
          recipient_phone: null,
          delivery_status: 'failed',
        },
      ],
    });
    sendEmailMock.mockResolvedValueOnce({ success: false, error: 'SMTP 550' });

    const { resendConnectorAlertToFailedRecipients } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    const outcome = await resendConnectorAlertToFailedRecipients({
      tenantId: 'tenant-1',
      integrationId: 'int-1',
      dispatchId: 'disp-1',
      notificationType: 'integration',
      provider: 'hubspot',
      errorMessage: 'oops',
      firstFailedAt: null,
      outageMinutes: null,
    });

    expect(outcome.attempted).toBe(1);
    expect(outcome.succeeded).toBe(0);
    expect(outcome.failed).toBe(1);
    const insert = callsMatching('INSERT INTO connector_alert_recipients')[0];
    expect(insert).toBeDefined();
    const params = insert[1] as unknown[];
    expect(params[9]).toBe('failed'); // delivery_status
    expect(params[10]).toBe('SMTP 550'); // delivery_error
  });

  it('returns candidates=0 and never sends when no failed/skipped recipients remain', async () => {
    mockScenario({ resendCandidates: [] });

    const { resendConnectorAlertToFailedRecipients } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    const outcome = await resendConnectorAlertToFailedRecipients({
      tenantId: 'tenant-1',
      integrationId: 'int-1',
      dispatchId: 'disp-1',
      notificationType: 'integration',
      provider: 'salesforce',
      errorMessage: null,
      firstFailedAt: null,
      outageMinutes: null,
    });

    expect(outcome.candidates).toBe(0);
    expect(outcome.attempted).toBe(0);
    expect(sendEmailMock).not.toHaveBeenCalled();
    // Should NOT issue any audit-insert when there's nothing to retry.
    expect(callsMatching('INSERT INTO connector_alert_recipients')).toHaveLength(0);
  });

  it('skips SMS recipients (and records skipped audit rows) when Twilio is not configured', async () => {
    delete process.env.TWILIO_ACCOUNT_SID;
    delete process.env.TWILIO_AUTH_TOKEN;
    delete process.env.TWILIO_SMS_FROM;
    mockScenario({
      resendCandidates: [
        {
          user_id: 'user-a',
          recipient_name: 'Ada',
          recipient_email: 'ada@acme.test',
          recipient_phone: '+15551234567',
          delivery_status: 'failed',
        },
      ],
    });

    const { resendConnectorAlertToFailedRecipients } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    const outcome = await resendConnectorAlertToFailedRecipients({
      tenantId: 'tenant-1',
      integrationId: 'int-1',
      dispatchId: 'disp-2',
      notificationType: 'integration_sms',
      provider: 'salesforce',
      errorMessage: 'API rate limit',
      firstFailedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      outageMinutes: 60,
      tenantName: 'Acme',
    });

    expect(outcome.channel).toBe('sms');
    expect(outcome.twilioConfigured).toBe(false);
    expect(outcome.skipped).toBe(1);
    expect(outcome.attempted).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    // The audit row records why we couldn't send.
    const insert = callsMatching('INSERT INTO connector_alert_recipients')[0];
    const params = insert[1] as unknown[];
    expect(params[3]).toBe('integration_sms');
    expect(params[4]).toBe('sms');
    expect(params[9]).toBe('skipped'); // delivery_status
    expect(String(params[10])).toMatch(/Twilio/);
  });

  it('sends an SMS via Twilio for each failed phone recipient and records sent/failed outcomes', async () => {
    mockScenario({
      resendCandidates: [
        {
          user_id: 'user-a',
          recipient_name: 'Ada',
          recipient_email: 'ada@acme.test',
          recipient_phone: '+15551111111',
          delivery_status: 'failed',
        },
        {
          user_id: 'user-b',
          recipient_name: 'Grace',
          recipient_email: 'grace@acme.test',
          recipient_phone: '+15552222222',
          delivery_status: 'skipped',
        },
      ],
    });
    fetchMock
      .mockResolvedValueOnce({ ok: true, status: 201 })
      .mockResolvedValueOnce({ ok: false, status: 400 });

    const { resendConnectorAlertToFailedRecipients } = await import(
      '../../platform/integrations/connectors/SyncErrorAlerter'
    );
    const outcome = await resendConnectorAlertToFailedRecipients({
      tenantId: 'tenant-1',
      integrationId: 'int-1',
      dispatchId: 'disp-3',
      notificationType: 'integration_sms',
      provider: 'hubspot',
      errorMessage: 'auth failed',
      firstFailedAt: null,
      outageMinutes: 90,
      tenantName: 'Acme',
    });

    expect(outcome.channel).toBe('sms');
    expect(outcome.twilioConfigured).toBe(true);
    expect(outcome.attempted).toBe(2);
    expect(outcome.succeeded).toBe(1);
    expect(outcome.failed).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Both SMS attempts produced a new audit row under the original
    // dispatch_id with channel='sms'.
    const inserts = callsMatching('INSERT INTO connector_alert_recipients');
    expect(inserts).toHaveLength(2);
    const statuses = inserts.map((c) => (c[1] as unknown[])[9]);
    expect(statuses).toEqual(expect.arrayContaining(['sent', 'failed']));
    for (const c of inserts) {
      const params = c[1] as unknown[];
      expect(params[2]).toBe('disp-3'); // dispatch_id
      expect(params[4]).toBe('sms');
    }
  });
});
