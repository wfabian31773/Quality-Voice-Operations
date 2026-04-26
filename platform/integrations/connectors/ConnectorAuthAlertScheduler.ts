import { getPlatformPool } from '../../db';
import { createLogger } from '../../core/logger';
import {
  sendEmail,
  connectorSyncErrorEmail,
  connectorAutoDisabledEmail,
} from '../../email';
import {
  fanoutInAppNotification,
  filterEmailRecipientsByPreference,
} from '../../notifications/NotificationPreferences';
import { writeAuditLog } from '../../audit/AuditService';

const logger = createLogger('CONNECTOR_AUTH_ALERT');

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const INITIAL_DELAY_MS = 5 * 60 * 1000;
const MAX_RECIPIENTS_PER_TENANT = 5;

/**
 * Number of days a connector must remain in an auth-error / needs_reconnect
 * state before the scheduler auto-disables it. Configurable via the
 * `CONNECTOR_AUTO_DISABLE_DAYS` env var (must parse to a positive integer);
 * otherwise defaults to 14.
 */
export function getAutoDisableThresholdDays(): number {
  const raw = process.env.CONNECTOR_AUTO_DISABLE_DAYS;
  if (raw === undefined || raw === '') return 14;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 14;
  return parsed;
}

const AUTH_ERROR_REGEX = /\b(401|403|unauthorized|forbidden|invalid[_ -]?(grant|token|credential|auth)|expired|refresh.*(failed|token)|token.*expired|auth(entication)?[ _-]?(failed|error)|missing.*(token|credential)|not_authed|token_revoked|account_inactive)\b/i;

const PROVIDER_LABELS: Record<string, string> = {
  salesforce: 'Salesforce',
  hubspot: 'HubSpot',
  quickbooks: 'QuickBooks',
  google: 'Google',
  google_calendar: 'Google Calendar',
  outlook: 'Outlook',
  outlook_calendar: 'Outlook Calendar',
  microsoft: 'Microsoft',
  pipedrive: 'Pipedrive',
  slack: 'Slack',
  zapier: 'Zapier',
  twilio: 'Twilio',
};

function providerLabel(provider: string | null | undefined): string {
  if (!provider) return 'Integration';
  return PROVIDER_LABELS[provider.toLowerCase()] ?? provider;
}

export function isAuthError(message: string | null | undefined): boolean {
  if (!message) return false;
  return AUTH_ERROR_REGEX.test(message);
}

function appBaseUrl(): string {
  return (
    process.env.APP_URL ??
    `https://${process.env.REPLIT_DEV_DOMAIN ?? 'localhost:5173'}`
  );
}

interface PendingAuthFailure {
  tenant_id: string;
  integration_id: string;
  provider: string;
  integration_type: string;
  name: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  last_sync_error_at: Date | null;
}

export async function findPendingAuthFailures(): Promise<PendingAuthFailure[]> {
  const pool = getPlatformPool();
  const { rows } = await pool.query<PendingAuthFailure>(
    `SELECT tenant_id,
            id AS integration_id,
            provider,
            integration_type::text AS integration_type,
            name,
            last_sync_status,
            last_sync_error,
            last_sync_error_at
       FROM integrations
      WHERE is_enabled = TRUE
        AND auth_alert_sent_at IS NULL
        AND (
          last_sync_status = 'needs_reconnect'
          OR (last_sync_status = 'error' AND last_sync_error IS NOT NULL)
        )
      ORDER BY last_sync_error_at NULLS LAST, tenant_id, provider`,
  );
  return rows.filter((r) =>
    r.last_sync_status === 'needs_reconnect' || isAuthError(r.last_sync_error),
  );
}

async function getTenantAdmins(tenantId: string): Promise<{ name: string | undefined; emails: string[] }> {
  const pool = getPlatformPool();
  let name: string | undefined;
  let emails: string[] = [];
  try {
    const { rows: tenantRows } = await pool.query(
      `SELECT name FROM tenants WHERE id = $1`,
      [tenantId],
    );
    if (tenantRows.length > 0) {
      name = (tenantRows[0].name as string | null) ?? undefined;
    }
  } catch (err) {
    logger.warn('Failed to look up tenant name', { tenantId, error: String(err) });
  }

  try {
    const { rows } = await pool.query(
      `SELECT email FROM users
        WHERE tenant_id = $1
          AND role IN ('admin', 'owner')
          AND email IS NOT NULL
          AND COALESCE(is_active, TRUE) = TRUE
        LIMIT $2`,
      [tenantId, MAX_RECIPIENTS_PER_TENANT],
    );
    emails = rows
      .map((r) => (r.email as string | null) ?? '')
      .filter((e): e is string => Boolean(e));
  } catch (err) {
    logger.warn('Failed to look up tenant admin emails', { tenantId, error: String(err) });
  }

  return { name, emails };
}

async function recordAlertSent(integrationId: string, tenantId: string): Promise<void> {
  const pool = getPlatformPool();
  try {
    await pool.query(
      `UPDATE integrations
          SET auth_alert_sent_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2`,
      [integrationId, tenantId],
    );
  } catch (err) {
    logger.warn('Failed to mark auth alert as sent', {
      tenantId,
      integrationId,
      error: String(err),
    });
  }
}

async function recentInAppNotificationExists(tenantId: string, provider: string): Promise<boolean> {
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM tenant_notifications
        WHERE tenant_id = $1
          AND type = 'integration'
          AND LOWER(metadata ->> 'provider') = LOWER($2)
          AND created_at > NOW() - INTERVAL '24 hours'
        LIMIT 1`,
      [tenantId, provider],
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function insertInAppNotification(params: {
  tenantId: string;
  integrationId: string;
  connectorType: string;
  provider: string;
  reconnectPath: string;
  title: string;
  message: string;
  errorMessage: string;
}): Promise<void> {
  try {
    await fanoutInAppNotification({
      tenantId: params.tenantId,
      type: 'integration',
      title: params.title,
      message: params.message,
      metadata: {
        link: params.reconnectPath,
        integrationId: params.integrationId,
        connectorType: params.connectorType,
        provider: params.provider,
        reason: 'auth_error',
        errorMessage: params.errorMessage.slice(0, 500),
      },
      category: 'integration',
    });
  } catch (err) {
    logger.warn('Failed to fan out in-app auth alert notification', {
      tenantId: params.tenantId,
      integrationId: params.integrationId,
      error: String(err),
    });
  }
}

export interface CycleResult {
  inspected: number;
  alerted: number;
  emailedRecipients: number;
  skippedNoRecipients: number;
}

export async function runConnectorAuthAlertCycle(): Promise<CycleResult> {
  let pending: PendingAuthFailure[];
  try {
    pending = await findPendingAuthFailures();
  } catch (err) {
    logger.error('Failed to query pending connector auth failures', { error: String(err) });
    return { inspected: 0, alerted: 0, emailedRecipients: 0, skippedNoRecipients: 0 };
  }

  if (pending.length === 0) {
    logger.debug('No pending connector auth failures to alert on');
    return { inspected: 0, alerted: 0, emailedRecipients: 0, skippedNoRecipients: 0 };
  }

  let alerted = 0;
  let emailedRecipients = 0;
  let skippedNoRecipients = 0;

  for (const row of pending) {
    const { tenant_id: tenantId, integration_id: integrationId, provider } = row;
    const label = providerLabel(provider);
    const errorMessage = row.last_sync_error ?? 'Authentication failed; reconnect required';
    const reconnectPath = `/connectors?integration=${encodeURIComponent(integrationId)}`;
    const reconnectUrl = `${appBaseUrl().replace(/\/$/, '')}${reconnectPath}`;
    const detectedAtDate = row.last_sync_error_at
      ? new Date(row.last_sync_error_at)
      : new Date();
    const detectedAt = detectedAtDate.toUTCString();

    const title = `${label} integration is failing`;
    const message = `Latest sync to ${label} failed: ${errorMessage.slice(0, 200)}. Open Connectors to reconnect.`;

    const alreadyNotifiedInApp = await recentInAppNotificationExists(tenantId, provider);
    if (!alreadyNotifiedInApp) {
      await insertInAppNotification({
        tenantId,
        integrationId,
        connectorType: row.integration_type,
        provider,
        reconnectPath,
        title,
        message,
        errorMessage,
      });
    }

    const { name: tenantName, emails: rawRecipients } = await getTenantAdmins(tenantId);

    if (rawRecipients.length === 0) {
      logger.info('Connector auth-alert: no admin recipients, marking sent to avoid retries', {
        tenantId,
        integrationId,
        provider,
      });
      skippedNoRecipients += 1;
      await recordAlertSent(integrationId, tenantId);
      continue;
    }

    const recipients = await filterEmailRecipientsByPreference(
      tenantId,
      rawRecipients,
      'integration',
    );
    if (recipients.length === 0) {
      logger.info(
        'Connector auth-alert: all admin recipients opted out of integration emails, marking sent to avoid retries',
        {
          tenantId,
          integrationId,
          provider,
          removed: rawRecipients.length,
        },
      );
      skippedNoRecipients += 1;
      await recordAlertSent(integrationId, tenantId);
      continue;
    }

    const { subject, html, text } = connectorSyncErrorEmail({
      tenantName,
      providerLabel: label,
      errorMessage,
      reconnectUrl,
      detectedAt,
    });

    let delivered = 0;
    for (const to of recipients) {
      try {
        const result = await sendEmail({ to, subject, html, text });
        if (result.success) {
          delivered += 1;
        } else {
          logger.warn('Connector auth-alert email send failed', {
            tenantId,
            integrationId,
            to,
            error: result.error,
          });
        }
      } catch (err) {
        logger.warn('Connector auth-alert email threw', {
          tenantId,
          integrationId,
          to,
          error: String(err),
        });
      }
    }

    emailedRecipients += delivered;
    alerted += 1;
    await recordAlertSent(integrationId, tenantId);

    logger.info('Connector auth-alert dispatched', {
      tenantId,
      integrationId,
      provider,
      recipients: recipients.length,
      delivered,
    });
  }

  return {
    inspected: pending.length,
    alerted,
    emailedRecipients,
    skippedNoRecipients,
  };
}

interface PendingAutoDisable {
  tenant_id: string;
  integration_id: string;
  provider: string;
  integration_type: string;
  name: string | null;
  last_sync_status: string | null;
  last_sync_error: string | null;
  last_sync_error_at: Date | null;
}

/**
 * Find integrations that have been failing authentication for at least
 * `thresholdDays` and are still enabled. Mirrors the regex / status filter
 * used by `findPendingAuthFailures` so we never auto-disable for a non-auth
 * error class (e.g. transient network 5xx).
 */
export async function findIntegrationsToAutoDisable(
  thresholdDays: number,
): Promise<PendingAutoDisable[]> {
  const pool = getPlatformPool();
  const { rows } = await pool.query<PendingAutoDisable>(
    `SELECT tenant_id,
            id AS integration_id,
            provider,
            integration_type::text AS integration_type,
            name,
            last_sync_status,
            last_sync_error,
            last_sync_error_at
       FROM integrations
      WHERE is_enabled = TRUE
        AND auto_disabled_at IS NULL
        AND last_sync_error_at IS NOT NULL
        AND last_sync_error_at <= NOW() - ($1 || ' days')::interval
        AND (
          last_sync_status = 'needs_reconnect'
          OR (last_sync_status = 'error' AND last_sync_error IS NOT NULL)
        )
      ORDER BY last_sync_error_at, tenant_id, provider`,
    [String(thresholdDays)],
  );
  return rows.filter((r) =>
    r.last_sync_status === 'needs_reconnect' || isAuthError(r.last_sync_error),
  );
}

/**
 * Atomically flip `is_enabled` to FALSE and stamp `auto_disabled_at = NOW()`.
 * Returns true when the row was updated, false when another worker (or a
 * concurrent admin action) already disabled or re-enabled the integration.
 *
 * The WHERE clause re-asserts the preconditions (`is_enabled = TRUE` and the
 * failure status is unchanged) so two scheduler workers cannot both send the
 * "we disabled this" email for the same outage.
 */
async function autoDisableIntegration(row: PendingAutoDisable): Promise<boolean> {
  const pool = getPlatformPool();
  try {
    // Re-assert the full auth-class criteria the SELECT used so we cannot
    // race-disable a row whose status has just transitioned (e.g. another
    // worker observed a successful sync, or the error message changed to a
    // non-auth class). For `error` rows we additionally require the original
    // error string to still match — if the error message changed since the
    // SELECT, defer to the next cycle so the regex check runs again on the
    // fresh value.
    const result = await pool.query(
      `UPDATE integrations
          SET is_enabled = FALSE,
              auto_disabled_at = NOW(),
              updated_at = NOW()
        WHERE id = $1
          AND tenant_id = $2
          AND is_enabled = TRUE
          AND auto_disabled_at IS NULL
          AND last_sync_status = $3
          AND (
                last_sync_status = 'needs_reconnect'
             OR last_sync_error = $4
          )`,
      [row.integration_id, row.tenant_id, row.last_sync_status, row.last_sync_error],
    );
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    logger.error('Failed to auto-disable connector', {
      tenantId: row.tenant_id,
      integrationId: row.integration_id,
      error: String(err),
    });
    return false;
  }
}

export interface AutoDisableCycleResult {
  inspected: number;
  disabled: number;
  emailedRecipients: number;
  skippedNoRecipients: number;
}

export async function runConnectorAutoDisableCycle(
  thresholdDays: number = getAutoDisableThresholdDays(),
): Promise<AutoDisableCycleResult> {
  let pending: PendingAutoDisable[];
  try {
    pending = await findIntegrationsToAutoDisable(thresholdDays);
  } catch (err) {
    logger.error('Failed to query connectors eligible for auto-disable', {
      error: String(err),
    });
    return { inspected: 0, disabled: 0, emailedRecipients: 0, skippedNoRecipients: 0 };
  }

  if (pending.length === 0) {
    logger.debug('No connectors eligible for auto-disable');
    return { inspected: 0, disabled: 0, emailedRecipients: 0, skippedNoRecipients: 0 };
  }

  let disabled = 0;
  let emailedRecipients = 0;
  let skippedNoRecipients = 0;

  for (const row of pending) {
    const { tenant_id: tenantId, integration_id: integrationId, provider } = row;
    const label = providerLabel(provider);

    const flipped = await autoDisableIntegration(row);
    if (!flipped) {
      logger.debug('Auto-disable skipped: row no longer matches preconditions', {
        tenantId,
        integrationId,
        provider,
      });
      continue;
    }

    disabled += 1;

    const failedAtMs = row.last_sync_error_at
      ? new Date(row.last_sync_error_at).getTime()
      : null;
    const daysFailing = failedAtMs
      ? Math.max(thresholdDays, Math.round((Date.now() - failedAtMs) / (24 * 60 * 60 * 1000)))
      : thresholdDays;
    const errorMessage = row.last_sync_error ?? 'Authentication failed; reconnect required';
    const reconnectPath = `/connectors?integration=${encodeURIComponent(integrationId)}`;
    const reconnectUrl = `${appBaseUrl().replace(/\/$/, '')}${reconnectPath}`;
    const disabledAt = new Date().toUTCString();

    const title = `${label} integration auto-disabled`;
    const message =
      `${label} has been failing authentication for ${daysFailing} day${daysFailing === 1 ? '' : 's'} ` +
      `and was automatically disabled. Reconnect to resume event dispatch.`;

    try {
      await fanoutInAppNotification({
        tenantId,
        type: 'integration_disabled',
        title,
        message,
        metadata: {
          link: reconnectPath,
          integrationId,
          connectorType: row.integration_type,
          provider,
          reason: 'auto_disabled',
          daysFailing,
          errorMessage: errorMessage.slice(0, 500),
        },
        category: 'integration',
      });
    } catch (err) {
      logger.warn('Failed to fan out auto-disable in-app notification', {
        tenantId,
        integrationId,
        error: String(err),
      });
    }

    try {
      await writeAuditLog({
        tenantId,
        actorUserId: 'system',
        actorRole: 'system',
        action: 'connector.auto_disabled',
        resourceType: 'connector',
        resourceId: integrationId,
        severity: 'warning',
        changes: {
          provider,
          connectorType: row.integration_type,
          daysFailing,
          lastError: errorMessage.slice(0, 500),
        },
      });
    } catch {
      // best-effort; writeAuditLog already logs
    }

    const { name: tenantName, emails: rawRecipients } = await getTenantAdmins(tenantId);

    if (rawRecipients.length === 0) {
      logger.info('Connector auto-disable: no admin recipients to notify', {
        tenantId,
        integrationId,
        provider,
      });
      skippedNoRecipients += 1;
      continue;
    }

    const recipients = await filterEmailRecipientsByPreference(
      tenantId,
      rawRecipients,
      'integration',
    );
    if (recipients.length === 0) {
      logger.info(
        'Connector auto-disable: all admins opted out of integration emails',
        {
          tenantId,
          integrationId,
          provider,
          removed: rawRecipients.length,
        },
      );
      skippedNoRecipients += 1;
      continue;
    }

    const { subject, html, text } = connectorAutoDisabledEmail({
      tenantName,
      providerLabel: label,
      daysFailing,
      reconnectUrl,
      disabledAt,
      lastErrorMessage: errorMessage,
    });

    let delivered = 0;
    for (const to of recipients) {
      try {
        const result = await sendEmail({ to, subject, html, text });
        if (result.success) {
          delivered += 1;
        } else {
          logger.warn('Connector auto-disable email send failed', {
            tenantId,
            integrationId,
            to,
            error: result.error,
          });
        }
      } catch (err) {
        logger.warn('Connector auto-disable email threw', {
          tenantId,
          integrationId,
          to,
          error: String(err),
        });
      }
    }

    emailedRecipients += delivered;

    logger.info('Connector auto-disable dispatched', {
      tenantId,
      integrationId,
      provider,
      daysFailing,
      recipients: recipients.length,
      delivered,
    });
  }

  return {
    inspected: pending.length,
    disabled,
    emailedRecipients,
    skippedNoRecipients,
  };
}

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

async function runFullCycle(): Promise<void> {
  await runConnectorAuthAlertCycle();
  // Auto-disable runs after the alert cycle so that within the same tick we
  // first try to nudge admins, then sweep up the long-stale ones. The two
  // cycles operate on disjoint rows (alert cycle gates on
  // auth_alert_sent_at IS NULL, auto-disable gates on auto_disabled_at IS NULL
  // and last_sync_error_at <= NOW() - threshold) so order doesn't change behavior.
  await runConnectorAutoDisableCycle();
}

export function startConnectorAuthAlertScheduler(intervalMs: number = CHECK_INTERVAL_MS): void {
  if (timer) return;

  initialTimer = setTimeout(() => {
    runFullCycle().catch((err) => {
      logger.error('Initial connector auth-alert cycle failed', { error: String(err) });
    });
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    runFullCycle().catch((err) => {
      logger.error('Connector auth-alert cycle failed', { error: String(err) });
    });
  }, intervalMs);

  logger.info('Connector auth-alert scheduler started', {
    intervalMs,
    autoDisableThresholdDays: getAutoDisableThresholdDays(),
  });
}

export function stopConnectorAuthAlertScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Connector auth-alert scheduler stopped');
  }
}
