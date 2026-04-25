import { getPlatformPool } from '../../db';
import { createLogger } from '../../core/logger';
import { sendEmail, connectorSyncErrorEmail } from '../../email';
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
const THROTTLE_HOURS = 24;
const SMS_THROTTLE_HOURS = 24;

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

  try {
    await pool.query(
      `INSERT INTO tenant_notifications (tenant_id, type, title, message, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        tenantId,
        NOTIFICATION_TYPE,
        title,
        message,
        JSON.stringify({
          link: reconnectPath,
          integrationId,
          connectorType,
          provider,
          errorMessage: errorMessage.slice(0, 500),
        }),
      ],
    );
  } catch (err) {
    logger.error('Failed to insert connector sync in-app notification', {
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

  // Admin/owner phone numbers.
  let phones: string[] = [];
  try {
    const { rows: userRows } = await pool.query(
      `SELECT phone_number FROM users
        WHERE tenant_id = $1
          AND role IN ('admin', 'owner')
          AND phone_number IS NOT NULL
          AND phone_number <> ''
          AND COALESCE(is_active, TRUE) = TRUE
        LIMIT 5`,
      [tenantId],
    );
    phones = userRows
      .map((r) => normalizeE164(r.phone_number as string | null))
      .filter((p): p is string => p !== null);
  } catch (err) {
    logger.warn('Failed to look up admin phone numbers for sustained SMS alert', {
      tenantId,
      error: String(err),
    });
    return;
  }

  if (phones.length === 0) {
    logger.info('No admin phone numbers on file for sustained SMS alert', {
      tenantId,
      integrationId,
      provider,
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
      await pool.query(
        `INSERT INTO tenant_notifications (tenant_id, type, title, message, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          tenantId,
          SMS_NOTIFICATION_TYPE,
          `${providerLabel} sustained outage`,
          smsBody,
          JSON.stringify({
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
          }),
        ],
      );
    } catch (err) {
      logger.error('Failed to insert sustained SMS alert record', {
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
