// ---------------------------------------------------------------------------
// Scenario-based query dispatcher (shared test helper)
//
// Extracted from `tests/integrations/syncErrorAlerter.test.ts` so any
// connector / notification test that mocks `getPlatformPool().query` can
// describe the world the production code is running against (which users the
// tenant has, who's an admin recipient, what preferences they hold, what
// throttle markers are stamped, whether the connector is muted, ...) instead
// of enumerating every database query in call order.
//
// The dispatcher answers each query the production code makes by SQL
// fingerprint, NOT by call order, so production-side changes (an extra audit
// INSERT, a new column on a SELECT, an internal helper that runs another
// lookup) only require touching this file instead of re-counting every
// test's `mockResolvedValueOnce` chain.
//
// Tests then assert OUTCOMES (Twilio called, email sent, the right INSERT
// happened) by filtering `queryMock.mock.calls` / `fetchMock.mock.calls`
// using the same SQL substrings — `callsMatching(needle)` is provided as a
// convenience for the common case.
//
// Production helpers covered (each fingerprint comment below names the
// concrete production query it must match):
//
//   - platform/integrations/connectors/ConnectorAlertPreferences.ts
//       `isConnectorMuted`              -> `FROM connector_alert_mutes`
//       `getConnectorAlertSettings`     -> `FROM connector_alert_settings`
//   - platform/integrations/connectors/ConnectorAlertRecipients.ts
//       `getTenantAlertEmailRecipients` -> `FROM users u LEFT JOIN user_roles ur`
//                                          (selects `u.email`, NOT phone)
//       `getTenantAlertPhoneRecipients` -> same JOIN, selects `u.phone_number`
//   - platform/notifications/NotificationPreferences.ts
//       `filterEmailRecipientsByPreference`
//                                       -> `user_notification_preferences`
//                                          + `LOWER(u.email)`
//       `filterUserIdsByPreference`     -> `SELECT user_id, enabled FROM
//                                          user_notification_preferences`
//       `fanoutInAppNotification`       -> `SELECT id FROM users` with
//                                          `tenant_id = $1` + `is_active`
//                                          (audience lookup) and the
//                                          subsequent `INSERT INTO
//                                          tenant_notifications` per user
//
// Adding a new query/column to any of these helpers means updating the
// matching branch (or adding a new one) in `mockScenario` below — all tests
// that use the dispatcher then keep passing without per-test edits.
// ---------------------------------------------------------------------------

import type { Mock } from 'vitest';

export interface ScenarioEmailRecipient {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
}

export interface ScenarioPhoneRecipient {
  id: string;
  phone: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
}

export interface MockScenario {
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

export interface ScenarioDispatcher {
  /** Install / replace the scenario dispatcher on the underlying queryMock. */
  mockScenario: (scenario?: MockScenario) => void;
  /** Calls to the underlying queryMock whose SQL contains `needle`. */
  callsMatching: (needle: string) => unknown[][];
}

/**
 * Bind the scenario dispatcher to a vitest mock standing in for
 * `getPlatformPool().query`. Returns helpers tests can use to (1) describe
 * the world for the production code under test and (2) assert which queries
 * actually ran.
 */
export function createScenarioDispatcher(queryMock: Mock): ScenarioDispatcher {
  function mockScenario(scenario: MockScenario = {}): void {
    const tenantUsers = scenario.tenantUsers ?? [];
    const inAppOptOuts = new Set(scenario.inAppOptOuts ?? []);
    const emailOptOuts = new Set(
      (scenario.emailOptOuts ?? []).map((e) => e.toLowerCase()),
    );

    queryMock.mockImplementation(async (sqlIn: unknown, params?: unknown) => {
      const sql = String(sqlIn);
      const args = (params as unknown[] | undefined) ?? [];

      // isConnectorMuted (ConnectorAlertPreferences.ts).
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

      // getTenantAlertEmailRecipients — shared LEFT JOIN user_roles helper,
      // returns u.email (and explicitly NOT u.phone_number).
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

      // getTenantAlertPhoneRecipients — same JOIN, returns u.phone_number.
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

      // filterEmailRecipientsByPreference (NotificationPreferences.ts).
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

      // filterUserIdsByPreference (NotificationPreferences.ts).
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

      // fanoutInAppNotification audience lookup: tenant users.
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

      // getConnectorAlertSettings (digest mode).
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

  function callsMatching(needle: string): unknown[][] {
    return queryMock.mock.calls.filter((c) => String(c[0]).includes(needle));
  }

  return { mockScenario, callsMatching };
}
