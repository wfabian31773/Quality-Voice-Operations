import { getPlatformPool } from '../../db';
import { createLogger } from '../../core/logger';
import { sendEmail, connectorSyncErrorEmail, connectorSyncRecoveryEmail } from '../../email';
import {
  fanoutInAppNotification,
  filterEmailRecipientsByPreference,
  filterUserIdsByPreference,
} from '../../notifications/NotificationPreferences';
import type { ConnectorType } from './types';
import type { TenantId } from '../../core/types';

const logger = createLogger('CONNECTOR_SYNC_ALERT');

const REVENUE_CRITICAL_PROVIDERS = new Set(['salesforce', 'hubspot', 'quickbooks']);

const PROVIDER_LABELS: Record<string, string> = {
  salesforce: 'Salesforce',
  hubspot: 'HubSpot',
  quickbooks: 'QuickBooks',
};

const NOTIFICATION_TYPE = 'integration';
const SMS_NOTIFICATION_TYPE = 'integration_sms';
const RECOVERY_NOTIFICATION_TYPE = 'integration_recovery';
const THROTTLE_HOURS = 24;
const SMS_THROTTLE_HOURS = 24;
const RECOVERY_THROTTLE_HOURS = 24;

// How long an integration must be in the error state before we escalate to SMS.
export const SUSTAINED_FAILURE_MS = 60 * 60 * 1000; // 1 hour

export function isRevenueCriticalProvider(provider: string | undefined | null): boolean {
  if (!provider) return false;
  return REVENUE_CRITICAL_PROVIDERS.has(provider.toLowerCase());
}

function appBaseUrl(): string {
  return (
    process.env.APP_URL ??
    `https://${process.env.REPLIT_DEV_DOMAIN ?? 'localhost:5173'}`
  );
}

interface AlertParams {
  tenantId: TenantId;
  integrationId: string;
  connectorType: ConnectorType;
  provider: string;
  errorMessage: string | null;
}

export async function notifyConnectorSyncError(params: AlertParams): Promise<void> {
  const { tenantId, integrationId, connectorType, provider } = params;

  if (!isRevenueCriticalProvider(provider)) return;

  const pool = getPlatformPool();

  try {
    const { rows: throttleRows } = await pool.query(
      `SELECT id FROM tenant_notifications
       WHERE tenant_id = $1
         AND type = $2
         AND LOWER(metadata ->> 'provider') = LOWER($3)
         AND created_at > NOW() - ($4 || ' hours')::interval
       LIMIT 1`,
      [tenantId, NOTIFICATION_TYPE, provider, String(THROTTLE_HOURS)],
    );
    if (throttleRows.length > 0) {
      logger.debug('Connector sync alert suppressed by 24h throttle', {
        tenantId,
        integrationId,
        provider,
      });
      return;
    }
  } catch (err) {
    logger.warn('Failed to check sync alert throttle (will still attempt to send)', {
      tenantId,
      integrationId,
      error: String(err),
    });
  }

  const providerLabel = PROVIDER_LABELS[provider.toLowerCase()] ?? provider;
  const errorMessage = params.errorMessage ?? 'Sync failed';
  const reconnectPath = `/connectors?integration=${encodeURIComponent(integrationId)}`;
  const reconnectUrl = `${appBaseUrl().replace(/\/$/, '')}${reconnectPath}`;

  const title = `${providerLabel} integration is failing`;
  const message = `Latest sync to ${providerLabel} failed: ${errorMessage.slice(0, 200)}. Open Connectors to reconnect.`;

  const inAppMetadata = {
    link: reconnectPath,
    integrationId,
    connectorType,
    provider,
    errorMessage: errorMessage.slice(0, 500),
  };

  try {
    await fanoutInAppNotification({
      tenantId,
      type: NOTIFICATION_TYPE,
      title,
      message,
      metadata: inAppMetadata,
      category: 'integration',
    });
  } catch (err) {
    logger.error('Failed to fan out connector sync in-app notification', {
      tenantId,
      integrationId,
      error: String(err),
    });
  }

  let tenantName: string | undefined;
  let recipients: string[] = [];
  try {
    const { rows: tenantRows } = await pool.query(
      `SELECT name FROM tenants WHERE id = $1`,
      [tenantId],
    );
    if (tenantRows.length > 0) {
      tenantName = (tenantRows[0].name as string | null) ?? undefined;
    }

    const { rows: userRows } = await pool.query(
      `SELECT email FROM users
       WHERE tenant_id = $1
         AND role IN ('admin', 'owner')
         AND email IS NOT NULL
         AND COALESCE(is_active, TRUE) = TRUE
       LIMIT 5`,
      [tenantId],
    );
    recipients = userRows
      .map((r) => (r.email as string | null) ?? '')
      .filter((e): e is string => Boolean(e));
  } catch (err) {
    logger.warn('Failed to look up tenant admins for sync alert email', {
      tenantId,
      error: String(err),
    });
  }

  if (recipients.length === 0) {
    logger.info('No tenant admins found to email about connector sync failure', {
      tenantId,
      integrationId,
      provider,
    });
    return;
  }

  const beforeFilter = recipients.length;
  recipients = await filterEmailRecipientsByPreference(tenantId, recipients, 'integration');
  if (recipients.length === 0) {
    logger.info('All admin recipients opted out of integration email notifications', {
      tenantId,
      integrationId,
      provider,
      removed: beforeFilter,
    });
    return;
  }

  const detectedAt = new Date().toUTCString();
  const { subject, html, text } = connectorSyncErrorEmail({
    tenantName,
    providerLabel,
    errorMessage,
    reconnectUrl,
    detectedAt,
  });

  for (const to of recipients) {
    try {
      const result = await sendEmail({ to, subject, html, text });
      if (!result.success) {
        logger.warn('Connector sync alert email send failed', {
          tenantId,
          integrationId,
          to,
          error: result.error,
        });
      }
    } catch (err) {
      logger.warn('Connector sync alert email threw', {
        tenantId,
        integrationId,
        to,
        error: String(err),
      });
    }
  }

  try {
    await pool.query(
      `UPDATE integrations
          SET auth_alert_sent_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2`,
      [integrationId, tenantId],
    );
  } catch (err) {
    logger.warn('Failed to stamp auth_alert_sent_at after per-event alert', {
      tenantId,
      integrationId,
      error: String(err),
    });
  }

  logger.info('Connector sync error alert dispatched', {
    tenantId,
    integrationId,
    provider,
    recipients: recipients.length,
  });
}

interface SustainedAlertParams extends AlertParams {
  /** ISO timestamp when this integration first failed (preserved across consecutive errors). */
  firstFailedAt: string | null;
}

interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

function getTwilioConfig(): TwilioConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_SMS_FROM || process.env.TWILIO_PHONE_NUMBER;
  if (accountSid && authToken && fromNumber) {
    return { accountSid, authToken, fromNumber };
  }
  return null;
}

/**
 * Lightweight E.164 normalization. Twilio requires numbers to start with `+`
 * followed by 8–15 digits. We strip whitespace, hyphens, parentheses, and dots,
 * keep a leading `+`, and reject anything that doesn't match. Returns null
 * when the input is unusable so callers can drop it instead of triggering a
 * Twilio 4xx (which would consume our retry budget).
 */
export function normalizeE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/[\s\-().]/g, '');
  if (!/^\+\d{8,15}$/.test(cleaned)) return null;
  return cleaned;
}

async function sendTwilioSms(
  config: TwilioConfig,
  to: string,
  body: string,
): Promise<{ ok: boolean; status?: number; error?: string }> {
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`;
    const formBody = new URLSearchParams({
      To: to,
      From: config.fromNumber,
      Body: body,
    });
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization:
          'Basic ' + Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formBody.toString(),
    });
    if (!response.ok) {
      return { ok: false, status: response.status };
    }
    return { ok: true, status: response.status };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/**
 * Send an SMS escalation when a revenue-critical connector has been failing
 * for at least SUSTAINED_FAILURE_MS. Respects:
 *   - per-integration 24h throttle (separate from email throttle)
 *   - tenant-level toggle: tenants.sms_alerts_disabled
 *   - admin/owner users with a stored phone_number
 */
export async function notifySustainedConnectorFailure(
  params: SustainedAlertParams,
): Promise<void> {
  const { tenantId, integrationId, connectorType, provider, firstFailedAt } = params;

  if (!isRevenueCriticalProvider(provider)) return;
  if (!firstFailedAt) return;

  const failedAtMs = Date.parse(firstFailedAt);
  if (!Number.isFinite(failedAtMs)) return;
  const outageMs = Date.now() - failedAtMs;
  if (outageMs < SUSTAINED_FAILURE_MS) return;

  const pool = getPlatformPool();

  // Tenant-level opt-out + lookup tenant name in one round-trip.
  let tenantName: string | undefined;
  try {
    const { rows: tenantRows } = await pool.query(
      `SELECT name, COALESCE(sms_alerts_disabled, FALSE) AS sms_alerts_disabled
         FROM tenants
        WHERE id = $1`,
      [tenantId],
    );
    if (tenantRows.length === 0) return;
    if (tenantRows[0].sms_alerts_disabled === true) {
      logger.info('Sustained connector SMS alert suppressed by tenant setting', {
        tenantId,
        integrationId,
        provider,
      });
      return;
    }
    tenantName = (tenantRows[0].name as string | null) ?? undefined;
  } catch (err) {
    logger.warn('Failed to load tenant SMS preference; skipping SMS alert', {
      tenantId,
      integrationId,
      error: String(err),
    });
    return;
  }

  // Per-integration SMS throttle (separate from the email throttle so SMS can
  // fire once per outage even if email already went out).
  try {
    const { rows: throttleRows } = await pool.query(
      `SELECT id FROM tenant_notifications
       WHERE tenant_id = $1
         AND type = $2
         AND metadata ->> 'integrationId' = $3
         AND created_at > NOW() - ($4 || ' hours')::interval
       LIMIT 1`,
      [tenantId, SMS_NOTIFICATION_TYPE, integrationId, String(SMS_THROTTLE_HOURS)],
    );
    if (throttleRows.length > 0) {
      logger.debug('Sustained SMS alert suppressed by 24h throttle', {
        tenantId,
        integrationId,
        provider,
      });
      return;
    }
  } catch (err) {
    logger.warn('Failed to check SMS alert throttle (will still attempt to send)', {
      tenantId,
      integrationId,
      error: String(err),
    });
  }

  // Admin/owner phone numbers, joined with user id so we can filter by the
  // per-user "sms" notification preference.
  let phoneRows: Array<{ user_id: string; phone: string }> = [];
  try {
    const { rows: userRows } = await pool.query<{ id: string; phone_number: string | null }>(
      `SELECT id, phone_number FROM users
        WHERE tenant_id = $1
          AND role IN ('admin', 'owner')
          AND phone_number IS NOT NULL
          AND phone_number <> ''
          AND COALESCE(is_active, TRUE) = TRUE
        LIMIT 5`,
      [tenantId],
    );
    phoneRows = userRows
      .map((r) => {
        const normalized = normalizeE164(r.phone_number);
        if (!normalized) return null;
        return { user_id: r.id, phone: normalized };
      })
      .filter((p): p is { user_id: string; phone: string } => p !== null);
  } catch (err) {
    logger.warn('Failed to look up admin phone numbers for sustained SMS alert', {
      tenantId,
      error: String(err),
    });
    return;
  }

  if (phoneRows.length === 0) {
    logger.info('No admin phone numbers on file for sustained SMS alert', {
      tenantId,
      integrationId,
      provider,
    });
    return;
  }

  // Drop recipients whose per-user "sms" in_app preference is off — that's
  // their proxy for "I don't want SMS-style outage alerts at all". Falls open
  // (everyone receives) on DB errors so a broken prefs table never silences
  // the page.
  const optedInUsers = new Set(
    await filterUserIdsByPreference(
      phoneRows.map((p) => p.user_id),
      'sms',
      'in_app',
    ),
  );
  const beforeOptOut = phoneRows.length;
  const phones = phoneRows.filter((p) => optedInUsers.has(p.user_id)).map((p) => p.phone);
  if (phones.length === 0) {
    logger.info('All admins opted out of SMS-category alerts', {
      tenantId,
      integrationId,
      provider,
      removed: beforeOptOut,
    });
    return;
  }

  const providerLabel = PROVIDER_LABELS[provider.toLowerCase()] ?? provider;
  const errorMessage = params.errorMessage ?? 'Sync failed';
  const outageMinutes = Math.round(outageMs / 60000);
  const reconnectPath = `/connectors?integration=${encodeURIComponent(integrationId)}`;
  const tenantPrefix = tenantName ? `[${tenantName}] ` : '';
  const smsBody =
    `${tenantPrefix}QVO alert: ${providerLabel} integration has been failing for ` +
    `${outageMinutes} min. Latest error: ${errorMessage.slice(0, 100)}. ` +
    `Reconnect at ${appBaseUrl().replace(/\/$/, '')}${reconnectPath}`;

  const twilio = getTwilioConfig();
  let attempted = 0;
  let succeeded = 0;
  if (twilio) {
    for (const to of phones) {
      attempted += 1;
      const result = await sendTwilioSms(twilio, to, smsBody);
      if (result.ok) {
        succeeded += 1;
      } else {
        logger.warn('Sustained SMS alert send failed', {
          tenantId,
          integrationId,
          to,
          status: result.status,
          error: result.error,
        });
      }
    }
  } else {
    logger.info('Twilio not configured — sustained SMS alert logged only', {
      tenantId,
      integrationId,
      provider,
      phones: phones.length,
    });
  }

  // Insert the throttle / audit record only when (a) at least one SMS actually
  // succeeded, or (b) Twilio is not configured (so we don't spam logs every
  // sync). When Twilio is configured but every send failed, deliberately skip
  // the insert so the next sync error can retry instead of being suppressed
  // for 24h by a transient Twilio outage.
  const shouldRecord = !twilio || succeeded > 0;
  if (shouldRecord) {
    try {
      await fanoutInAppNotification({
        tenantId,
        type: SMS_NOTIFICATION_TYPE,
        title: `${providerLabel} sustained outage`,
        message: smsBody,
        metadata: {
          integrationId,
          connectorType,
          provider,
          firstFailedAt,
          outageMinutes,
          recipientCount: phones.length,
          smsAttempted: attempted,
          smsSucceeded: succeeded,
          twilioConfigured: Boolean(twilio),
          link: reconnectPath,
        },
        category: 'sms',
      });
    } catch (err) {
      logger.error('Failed to fan out sustained SMS alert record', {
        tenantId,
        integrationId,
        error: String(err),
      });
    }
  } else {
    logger.warn(
      'All sustained SMS alerts failed to send; not recording throttle so the next sync error can retry',
      {
        tenantId,
        integrationId,
        provider,
        attempted,
      },
    );
  }

  logger.info('Sustained connector SMS alert dispatched', {
    tenantId,
    integrationId,
    provider,
    recipients: phones.length,
    smsSucceeded: succeeded,
    outageMinutes,
    throttleRecorded: shouldRecord,
  });
}

interface RecoveryAlertParams {
  tenantId: TenantId;
  integrationId: string;
  connectorType: ConnectorType;
  provider: string;
  /** Outage duration in milliseconds, if known. */
  outageDurationMs: number | null;
}

function describeOutage(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return null;
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * Send an "all clear" notification when a previously-failing connector starts
 * syncing successfully again. Mirrors notifyConnectorSyncError's gating:
 *   - only for revenue-critical providers
 *   - throttled to once per integration per 24h to prevent spam during
 *     flapping outages
 *
 * Callers should only invoke this when an integration actually transitioned
 * from an error state into success (see SyncStatusUpdateResult.transitionedToRecovery).
 */
export async function notifyConnectorRecovery(params: RecoveryAlertParams): Promise<void> {
  const { tenantId, integrationId, connectorType, provider, outageDurationMs } = params;

  if (!isRevenueCriticalProvider(provider)) return;

  const pool = getPlatformPool();

  // Recovery throttle: don't fire more than once per integration per 24h, even
  // if the connector flaps error -> success -> error -> success rapidly. This
  // is keyed by integrationId so two separate connectors for the same
  // provider (e.g. two HubSpot accounts) each get their own recovery alerts.
  //
  // The marker lives on `integrations.recovery_alert_sent_at` rather than on
  // tenant_notifications so per-user in_app preferences for the
  // 'integration_recovery' category can never bypass the throttle (an
  // installation where every admin has in_app off for recoveries used to
  // leave no row behind, which would let recovery emails be re-sent
  // every flap).
  try {
    const { rows: throttleRows } = await pool.query<{ recovery_alert_sent_at: Date | string | null }>(
      `SELECT recovery_alert_sent_at FROM integrations
        WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [integrationId, tenantId],
    );
    if (throttleRows.length > 0) {
      const sentAt = throttleRows[0].recovery_alert_sent_at;
      const sentMs = sentAt ? new Date(sentAt as string | Date).getTime() : null;
      if (
        sentMs !== null &&
        Number.isFinite(sentMs) &&
        Date.now() - sentMs < RECOVERY_THROTTLE_HOURS * 60 * 60 * 1000
      ) {
        logger.debug('Connector recovery alert suppressed by 24h throttle', {
          tenantId,
          integrationId,
          provider,
        });
        return;
      }
    }
  } catch (err) {
    logger.warn('Failed to check recovery alert throttle (will still attempt to send)', {
      tenantId,
      integrationId,
      error: String(err),
    });
  }

  const providerLabel = PROVIDER_LABELS[provider.toLowerCase()] ?? provider;
  const outageDescription = describeOutage(outageDurationMs);
  const connectorsPath = `/connectors?integration=${encodeURIComponent(integrationId)}`;
  const connectorsUrl = `${appBaseUrl().replace(/\/$/, '')}${connectorsPath}`;

  const title = `${providerLabel} integration is back online`;
  const message = outageDescription
    ? `${providerLabel} synced successfully again after ~${outageDescription}. No action needed.`
    : `${providerLabel} synced successfully again. No action needed.`;

  const recoveryMetadata = {
    link: connectorsPath,
    integrationId,
    connectorType,
    provider,
    outageDurationMs: outageDurationMs ?? null,
    outageDescription: outageDescription ?? null,
  };

  // Best-effort in-app fan-out — fanoutInAppNotification swallows its own
  // DB errors and returns 0, so we deliberately do not gate the email step
  // on the count. The throttle marker (stamped below) is what protects us
  // from re-sending emails when in-app inserts fail or every admin has
  // opted out of in-app for this category.
  try {
    await fanoutInAppNotification({
      tenantId,
      type: RECOVERY_NOTIFICATION_TYPE,
      title,
      message,
      metadata: recoveryMetadata,
      category: 'integration_recovery',
    });
  } catch (err) {
    logger.error('Failed to fan out connector recovery in-app notification', {
      tenantId,
      integrationId,
      error: String(err),
    });
  }

  // Stamp the throttle marker BEFORE the email step so even a partial /
  // failed email loop won't let the next sync re-fire recovery emails
  // within the throttle window. If this UPDATE itself fails OR matches
  // zero rows (e.g. the integration was deleted mid-flight), we bail
  // rather than risk an unbounded email loop without a persisted marker.
  try {
    const stampResult = await pool.query(
      `UPDATE integrations
          SET recovery_alert_sent_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2`,
      [integrationId, tenantId],
    );
    if ((stampResult.rowCount ?? 0) < 1) {
      logger.warn('recovery_alert_sent_at stamp matched zero rows; skipping email', {
        tenantId,
        integrationId,
      });
      return;
    }
  } catch (err) {
    logger.error('Failed to stamp recovery_alert_sent_at; skipping email to avoid unbounded retries', {
      tenantId,
      integrationId,
      error: String(err),
    });
    return;
  }

  let tenantName: string | undefined;
  let recipients: string[] = [];
  try {
    const { rows: tenantRows } = await pool.query(
      `SELECT name FROM tenants WHERE id = $1`,
      [tenantId],
    );
    if (tenantRows.length > 0) {
      tenantName = (tenantRows[0].name as string | null) ?? undefined;
    }

    const { rows: userRows } = await pool.query(
      `SELECT email FROM users
       WHERE tenant_id = $1
         AND role IN ('admin', 'owner')
         AND email IS NOT NULL
         AND COALESCE(is_active, TRUE) = TRUE
       LIMIT 5`,
      [tenantId],
    );
    recipients = userRows
      .map((r) => (r.email as string | null) ?? '')
      .filter((e): e is string => Boolean(e));
  } catch (err) {
    logger.warn('Failed to look up tenant admins for recovery email', {
      tenantId,
      error: String(err),
    });
  }

  if (recipients.length === 0) {
    logger.info('Connector recovery in-app notification recorded (no admin emails on file)', {
      tenantId,
      integrationId,
      provider,
    });
    return;
  }

  const beforeFilter = recipients.length;
  recipients = await filterEmailRecipientsByPreference(
    tenantId,
    recipients,
    'integration_recovery',
  );
  if (recipients.length === 0) {
    logger.info('All admin recipients opted out of recovery email notifications', {
      tenantId,
      integrationId,
      provider,
      removed: beforeFilter,
    });
    return;
  }

  const recoveredAt = new Date().toUTCString();
  const { subject, html, text } = connectorSyncRecoveryEmail({
    tenantName,
    providerLabel,
    connectorsUrl,
    recoveredAt,
    outageDescription,
  });

  for (const to of recipients) {
    try {
      const result = await sendEmail({ to, subject, html, text });
      if (!result.success) {
        logger.warn('Connector recovery email send failed', {
          tenantId,
          integrationId,
          to,
          error: result.error,
        });
      }
    } catch (err) {
      logger.warn('Connector recovery email threw', {
        tenantId,
        integrationId,
        to,
        error: String(err),
      });
    }
  }

  logger.info('Connector recovery alert dispatched', {
    tenantId,
    integrationId,
    provider,
    recipients: recipients.length,
    outageDurationMs,
  });
}
