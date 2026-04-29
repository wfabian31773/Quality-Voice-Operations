import { getPlatformPool } from '../../db';
import { createLogger } from '../../core/logger';

const logger = createLogger('CONNECTOR_ALERT_RECIPIENTS');

export interface TenantAlertEmailRecipient {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
}

export interface TenantAlertEmailRecipientSet {
  emails: string[];
  userIds: string[];
  /**
   * Parallel array to `emails`/`userIds` carrying the full user record so
   * downstream callers (e.g. the per-recipient outage audit log persisted
   * by SyncErrorAlerter) can record recipient names alongside addresses
   * without re-querying the users table.
   */
  recipients: TenantAlertEmailRecipient[];
}

/**
 * Look up the users who should receive connector email notifications for a
 * tenant. Mirrors the recipient query used by
 * `ConnectorAuthAlertScheduler.getTenantAdmins` so every connector
 * notification class — per-event email, digest email, recovery email — fans
 * out to the same set of people. The query unions the legacy `users.role`
 * column with the canonical `user_roles` join so a tenant owner or
 * operations manager who only carries the role via `user_roles` is still
 * included alongside legacy `admin` / `owner` users.
 *
 * The role lists are kept as inline `IN (...)` literals (not parameterized
 * arrays) so the SQL stays grep-able — production audits and the
 * connector-auth-alert dispatcher test both inspect this query verbatim to
 * make sure the recipient gating doesn't silently regress.
 */
export async function getTenantAlertEmailRecipients(
  tenantId: string,
  limit: number,
): Promise<TenantAlertEmailRecipientSet> {
  const pool = getPlatformPool();
  try {
    // ORDER BY makes the LIMIT subset deterministic for large admin teams.
    // DISTINCT collapses duplicates from users who hold the role via both
    // user_roles and the legacy users.role column.
    const { rows } = await pool.query<{
      id: string | null;
      email: string | null;
      first_name: string | null;
      last_name: string | null;
    }>(
      `SELECT DISTINCT u.id, u.email, u.first_name, u.last_name, u.created_at
         FROM users u
         LEFT JOIN user_roles ur
           ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id
        WHERE u.tenant_id = $1
          AND COALESCE(u.is_active, TRUE) = TRUE
          AND u.email IS NOT NULL
          AND (
            ur.role IN ('tenant_owner', 'operations_manager')
            OR u.role IN ('admin', 'owner', 'tenant_owner', 'operations_manager')
          )
        ORDER BY u.created_at NULLS LAST, u.id
        LIMIT $2`,
      [tenantId, limit],
    );
    const recipients: TenantAlertEmailRecipient[] = rows
      .map((r) => ({
        id: (r.id as string | null) ?? '',
        email: (r.email as string | null) ?? '',
        firstName: (r.first_name as string | null) ?? null,
        lastName: (r.last_name as string | null) ?? null,
      }))
      .filter((r) => r.id && r.email);
    const userIds = recipients.map((r) => r.id);
    const emails = recipients.map((r) => r.email);
    return { emails, userIds, recipients };
  } catch (err) {
    logger.warn('Failed to load tenant alert email recipients', {
      tenantId,
      error: String(err),
    });
    return { emails: [], userIds: [], recipients: [] };
  }
}

export interface TenantAlertPhoneRecipient {
  id: string;
  phone_number: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

/**
 * Look up the phone numbers that should receive sustained-failure SMS
 * escalations for a tenant. Uses the same role gating as the email
 * recipient query so the SMS path agrees with the email path on who counts
 * as an on-call notification recipient.
 */
export async function getTenantAlertPhoneRecipients(
  tenantId: string,
  limit: number,
): Promise<TenantAlertPhoneRecipient[]> {
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query<{
      id: string | null;
      phone_number: string | null;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
    }>(
      `SELECT DISTINCT u.id, u.phone_number, u.first_name, u.last_name, u.email, u.created_at
         FROM users u
         LEFT JOIN user_roles ur
           ON ur.user_id = u.id AND ur.tenant_id = u.tenant_id
        WHERE u.tenant_id = $1
          AND COALESCE(u.is_active, TRUE) = TRUE
          AND u.phone_number IS NOT NULL
          AND u.phone_number <> ''
          AND (
            ur.role IN ('tenant_owner', 'operations_manager')
            OR u.role IN ('admin', 'owner', 'tenant_owner', 'operations_manager')
          )
        ORDER BY u.created_at NULLS LAST, u.id
        LIMIT $2`,
      [tenantId, limit],
    );
    return rows
      .map((r) => ({
        id: (r.id as string | null) ?? '',
        phone_number: (r.phone_number as string | null) ?? '',
        first_name: (r.first_name as string | null) ?? null,
        last_name: (r.last_name as string | null) ?? null,
        email: (r.email as string | null) ?? null,
      }))
      .filter((r) => r.id && r.phone_number);
  } catch (err) {
    logger.warn('Failed to load tenant alert phone recipients', {
      tenantId,
      error: String(err),
    });
    return [];
  }
}
