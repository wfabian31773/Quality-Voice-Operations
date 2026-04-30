import { randomUUID } from 'crypto';
import { getPlatformPool } from '../../db';
import { createLogger } from '../../core/logger';
import { sendEmail, connectorSyncErrorEmail, connectorSyncRecoveryEmail, normaliseMessageId } from '../../email';
import {
  fanoutInAppNotification,
  filterEmailRecipientsByPreference,
  filterUserIdsByPreference,
} from '../../notifications/NotificationPreferences';
import {
  getConnectorAlertSettings,
  isConnectorMuted,
} from './ConnectorAlertPreferences';
import {
  getTenantAlertEmailRecipients,
  getTenantAlertPhoneRecipients,
} from './ConnectorAlertRecipients';
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

interface RecipientAuditRow {
  tenantId: TenantId;
  integrationId: string;
  dispatchId: string;
  notificationType: 'integration' | 'integration_sms';
  channel: 'email' | 'sms';
  userId: string | null;
  recipientName: string | null;
  recipientEmail: string | null;
  recipientPhone: string | null;
  deliveryStatus: 'sent' | 'failed' | 'skipped';
  deliveryError: string | null;
  twilioStatusCode: number | null;
  /**
   * Twilio Message SID returned by /Messages.json. Used by the
   * `/twilio/sms-status` webhook to find this row when Twilio reports
   * delivery progress. Null for email rows, Twilio-not-configured rows, and
   * the rare case where Twilio accepted the request but didn't return a
   * SID we could parse.
   */
  twilioMessageSid: string | null;
  // Lookup key for the /connectors/email-status webhook. Null for SMS
  // rows, console-mode sends, and skipped recipients.
  emailMessageId: string | null;
}

async function recordRecipientAudit(row: RecipientAuditRow): Promise<void> {
  try {
    const pool = getPlatformPool();
    await pool.query(
      `INSERT INTO connector_alert_recipients (
         tenant_id, integration_id, dispatch_id, notification_type, channel,
         user_id, recipient_name, recipient_email, recipient_phone,
         delivery_status, delivery_error, twilio_status_code,
         twilio_message_sid, email_message_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        row.tenantId,
        row.integrationId,
        row.dispatchId,
        row.notificationType,
        row.channel,
        row.userId,
        row.recipientName,
        row.recipientEmail,
        row.recipientPhone,
        row.deliveryStatus,
        row.deliveryError,
        row.twilioStatusCode,
        row.twilioMessageSid,
        row.emailMessageId,
      ],
    );
  } catch (err) {
    logger.warn('Failed to persist connector alert recipient audit row', {
      tenantId: row.tenantId,
      integrationId: row.integrationId,
      dispatchId: row.dispatchId,
      channel: row.channel,
      error: String(err),
    });
  }
}

function buildDisplayName(
  firstName: string | null,
  lastName: string | null,
): string | null {
  const trimmed = [firstName, lastName]
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0)
    .join(' ');
  return trimmed.length > 0 ? trimmed : null;
}

interface AlertParams {
  tenantId: TenantId;
  integrationId: string;
  connectorType: ConnectorType;
  provider: string;
  errorMessage: string | null;
  /**
   * ISO timestamp of the first consecutive sync failure for this integration,
   * if known. Used to enrich the persisted alert metadata so the tenant
   * portal's outage history can show how long the integration had been down
   * when the email alert went out.
   */
  firstFailedAt?: string | null;
}

export async function notifyConnectorSyncError(params: AlertParams): Promise<void> {
  const { tenantId, integrationId, connectorType, provider, firstFailedAt } = params;

  if (!isRevenueCriticalProvider(provider)) return;

  // Honour per-tenant connector mute preferences. A muted provider or
  // integration suppresses both the in-app fan-out and the email so the
  // admin's "I don't want alerts for this" preference is global.
  if (await isConnectorMuted(tenantId, provider, integrationId)) {
    logger.info('Connector sync error alert suppressed by mute', {
      tenantId,
      integrationId,
      provider,
    });
    return;
  }

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
  // Provider-keyed deep link so the alert still lands on the right connector
  // card if the underlying integration row was deleted between detection
  // and email send. Mirrors the dashboard's "needs reconnect" badge link
  // so tenants get the same one-click reconnect flow from email and in-app.
  const reconnectPath = `/connectors?provider=${encodeURIComponent(provider)}`;
  const reconnectUrl = `${appBaseUrl().replace(/\/$/, '')}${reconnectPath}`;

  const title = `${providerLabel} integration is failing`;
  const message = `Latest sync to ${providerLabel} failed: ${errorMessage.slice(0, 200)}. Open Connectors to reconnect.`;

  // Compute outage minutes from firstFailedAt (if known) so the persisted
  // alert metadata can power the tenant portal's outage history view.
  let outageMinutes: number | null = null;
  if (firstFailedAt) {
    const failedAtMs = Date.parse(firstFailedAt);
    if (Number.isFinite(failedAtMs)) {
      outageMinutes = Math.max(0, Math.round((Date.now() - failedAtMs) / 60000));
    }
  }

  // Look up tenant + admin emails BEFORE the in-app fan-out so the recorded
  // metadata can carry the actual recipient count. Falls back to an empty
  // recipient list on DB errors so the in-app row still gets written.
  let tenantName: string | undefined;
  let allAdminEmails: string[] = [];
  try {
    const { rows: tenantRows } = await pool.query(
      `SELECT name FROM tenants WHERE id = $1`,
      [tenantId],
    );
    if (tenantRows.length > 0) {
      tenantName = (tenantRows[0].name as string | null) ?? undefined;
    }
  } catch (err) {
    logger.warn('Failed to look up tenant name for sync alert email', {
      tenantId,
      error: String(err),
    });
  }

  // Use the shared recipient helper so per-event sync error emails reach the
  // same set of users as the auth-alert scheduler's reconnect nudges —
  // including tenant owners and operations managers who only hold the role
  // via the `user_roles` join.
  const recipientSet = await getTenantAlertEmailRecipients(tenantId, 5);
  allAdminEmails = recipientSet.emails;
  // Defensive: older callers (and test mocks) may not supply the
  // `recipients` enrichment field; fall back to a synthetic record so the
  // per-recipient audit insert below still runs with what we know.
  const recipientByEmail = new Map(
    (recipientSet.recipients ?? recipientSet.emails.map((email) => ({
      id: '',
      email,
      firstName: null,
      lastName: null,
    }))).map((r) => [r.email, r]),
  );

  let recipients: string[] = [];
  if (allAdminEmails.length > 0) {
    recipients = await filterEmailRecipientsByPreference(
      tenantId,
      allAdminEmails,
      'integration',
    );
  }

  // Stable dispatch id for this alert event. Stamped on the in-app
  // notification metadata AND on every per-recipient audit row so the
  // admin "outage timeline" detail endpoint can pivot from one to the
  // other in a single indexed lookup.
  const dispatchId = randomUUID();

  const inAppMetadata = {
    link: reconnectPath,
    integrationId,
    connectorType,
    provider,
    errorMessage: errorMessage.slice(0, 500),
    firstFailedAt: firstFailedAt ?? null,
    outageMinutes,
    recipientCount: recipients.length,
    emailRecipientCount: recipients.length,
    dispatchId,
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

  if (allAdminEmails.length === 0) {
    logger.info('No tenant admins found to email about connector sync failure', {
      tenantId,
      integrationId,
      provider,
    });
    return;
  }
  // When the tenant has digest mode enabled, skip the per-event email and
  // skip stamping auth_alert_sent_at so the scheduler can pick this failure
  // up and roll it into the next 24h digest. The in-app fan-out above has
  // already happened (subject to the existing 24h throttle).
  const alertSettings = await getConnectorAlertSettings(tenantId);
  if (alertSettings.digestMode) {
    logger.info('Per-event sync alert email suppressed by tenant digest mode', {
      tenantId,
      integrationId,
      provider,
    });
    return;
  }

  if (recipients.length === 0) {
    logger.info('All admin recipients opted out of integration email notifications', {
      tenantId,
      integrationId,
      provider,
      removed: allAdminEmails.length,
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
    const userRecord = recipientByEmail.get(to);
    let deliveryStatus: 'sent' | 'failed' = 'sent';
    let deliveryError: string | null = null;
    let emailMessageId: string | null = null;
    try {
      const result = await sendEmail({ to, subject, html, text });
      // Strip RFC 5322 angle brackets so the stored value matches the
      // canonical form the webhook parser produces from provider events.
      emailMessageId = normaliseMessageId(result.messageId);
      if (!result.success) {
        deliveryStatus = 'failed';
        deliveryError = result.error ?? 'sendEmail returned success=false';
        logger.warn('Connector sync alert email send failed', {
          tenantId,
          integrationId,
          to,
          error: result.error,
        });
      }
    } catch (err) {
      deliveryStatus = 'failed';
      deliveryError = String(err);
      logger.warn('Connector sync alert email threw', {
        tenantId,
        integrationId,
        to,
        error: String(err),
      });
    }
    await recordRecipientAudit({
      tenantId,
      integrationId,
      dispatchId,
      notificationType: NOTIFICATION_TYPE,
      channel: 'email',
      userId: userRecord?.id ?? null,
      recipientName: userRecord
        ? buildDisplayName(userRecord.firstName, userRecord.lastName)
        : null,
      recipientEmail: to,
      recipientPhone: null,
      deliveryStatus,
      deliveryError,
      twilioStatusCode: null,
      twilioMessageSid: null,
      emailMessageId: deliveryStatus === 'sent' ? emailMessageId : null,
    });
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

/**
 * Public URL Twilio should POST delivery status updates to. Mirrors the
 * pattern used by `server/admin-api/routes/phoneNumbers.ts` — explicit
 * `VOICE_GATEWAY_BASE_URL`, falling back to the Replit dev domain. Returns
 * null when neither is set, in which case we send the SMS without a
 * statusCallback so we still get HTTP-level acceptance feedback.
 */
export function getOutageSmsStatusCallbackUrl(): string | null {
  const base = process.env.VOICE_GATEWAY_BASE_URL
    ?? (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null);
  if (!base) return null;
  return `${base.replace(/\/$/, '')}/twilio/sms-status`;
}

async function sendTwilioSms(
  config: TwilioConfig,
  to: string,
  body: string,
  statusCallback: string | null,
): Promise<{ ok: boolean; status?: number; error?: string; messageSid?: string | null }> {
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`;
    const formParams: Record<string, string> = {
      To: to,
      From: config.fromNumber,
      Body: body,
    };
    if (statusCallback) {
      formParams.StatusCallback = statusCallback;
    }
    const formBody = new URLSearchParams(formParams);
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
    // Best-effort SID extraction. Twilio returns JSON like { sid: "SMxxxx", ... }.
    // We swallow parse errors and treat them as "no SID known" so the send is
    // still considered successful (the in-flight 24h throttle, in-app fan-out,
    // and audit row all proceed) — we just won't be able to correlate the
    // statusCallback webhook back to this row for that one recipient.
    let messageSid: string | null = null;
    try {
      const text = await response.text();
      if (text) {
        const parsed = JSON.parse(text) as { sid?: string };
        if (typeof parsed.sid === 'string' && parsed.sid.length > 0) {
          messageSid = parsed.sid;
        }
      }
    } catch {
      // ignore
    }
    return { ok: true, status: response.status, messageSid };
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

  // A mute on the provider or specific integration suppresses every alert
  // class — SMS included — so admins truly stop hearing about it.
  if (await isConnectorMuted(tenantId, provider, integrationId)) {
    logger.info('Sustained SMS alert suppressed by connector mute', {
      tenantId,
      integrationId,
      provider,
    });
    return;
  }

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
  // per-user "sms" notification preference. Pulled via the shared recipient
  // helper so tenant owners / operations managers who only hold the role via
  // user_roles are still paged on sustained outages.
  const phoneRecipients = await getTenantAlertPhoneRecipients(tenantId, 5);
  interface NormalizedPhone {
    user_id: string;
    phone: string;
    name: string | null;
    email: string | null;
  }
  const phoneRows: NormalizedPhone[] = phoneRecipients
    .map((r) => {
      const normalized = normalizeE164(r.phone_number);
      if (!normalized) return null;
      return {
        user_id: r.id,
        phone: normalized,
        name: buildDisplayName(r.first_name, r.last_name),
        email: r.email,
      };
    })
    .filter((p): p is NormalizedPhone => p !== null);

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
  const optedIn = phoneRows.filter((p) => optedInUsers.has(p.user_id));
  if (optedIn.length === 0) {
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
  // Provider-keyed deep link so the SMS reconnect URL still resolves to the
  // right connector card if the integration row was deleted between
  // detection and SMS send. Matches the email/in-app surfaces' link form.
  const reconnectPath = `/connectors?provider=${encodeURIComponent(provider)}`;
  const tenantPrefix = tenantName ? `[${tenantName}] ` : '';
  const smsBody =
    `${tenantPrefix}QVO alert: ${providerLabel} integration has been failing for ` +
    `${outageMinutes} min. Latest error: ${errorMessage.slice(0, 100)}. ` +
    `Reconnect at ${appBaseUrl().replace(/\/$/, '')}${reconnectPath}`;

  // Stable dispatch id for this SMS escalation. Same role as the email
  // dispatchId — pivot key for the per-recipient audit log feeding the
  // admin outage timeline.
  const dispatchId = randomUUID();

  const twilio = getTwilioConfig();
  let attempted = 0;
  let succeeded = 0;
  // Per-recipient audit rows. Persisted regardless of whether Twilio is
  // configured so the admin detail view can show "Twilio was not configured
  // when this alert fired, so the SMS was logged only" against each
  // intended recipient.
  interface SmsOutcome {
    recipient: NormalizedPhone;
    deliveryStatus: 'sent' | 'failed' | 'skipped';
    deliveryError: string | null;
    twilioStatusCode: number | null;
    twilioMessageSid: string | null;
  }
  const outcomes: SmsOutcome[] = [];
  // Resolve the statusCallback URL once. If we don't have a public base
  // URL configured we still send (Twilio acceptance + HTTP status are
  // captured), we just won't get the live `delivered`/`failed` follow-ups
  // — the panel falls back to showing the dispatch-time status only.
  const statusCallbackUrl = getOutageSmsStatusCallbackUrl();
  if (twilio) {
    for (const recipient of optedIn) {
      attempted += 1;
      const result = await sendTwilioSms(
        twilio,
        recipient.phone,
        smsBody,
        statusCallbackUrl,
      );
      if (result.ok) {
        succeeded += 1;
        outcomes.push({
          recipient,
          deliveryStatus: 'sent',
          deliveryError: null,
          twilioStatusCode: result.status ?? null,
          twilioMessageSid: result.messageSid ?? null,
        });
      } else {
        logger.warn('Sustained SMS alert send failed', {
          tenantId,
          integrationId,
          to: recipient.phone,
          status: result.status,
          error: result.error,
        });
        outcomes.push({
          recipient,
          deliveryStatus: 'failed',
          deliveryError: result.error ?? `Twilio HTTP ${result.status ?? 'error'}`,
          twilioStatusCode: result.status ?? null,
          twilioMessageSid: null,
        });
      }
    }
  } else {
    logger.info('Twilio not configured — sustained SMS alert logged only', {
      tenantId,
      integrationId,
      provider,
      phones: optedIn.length,
    });
    for (const recipient of optedIn) {
      outcomes.push({
        recipient,
        deliveryStatus: 'skipped',
        deliveryError: 'Twilio not configured in this environment',
        twilioStatusCode: null,
        twilioMessageSid: null,
      });
    }
  }

  // Insert the throttle / audit record only when (a) at least one SMS actually
  // succeeded, or (b) Twilio is not configured (so we don't spam logs every
  // sync). When Twilio is configured but every send failed, deliberately skip
  // the insert so the next sync error can retry instead of being suppressed
  // for 24h by a transient Twilio outage.
  const shouldRecord = !twilio || succeeded > 0;
  if (shouldRecord) {
    // Persist per-recipient SMS audit rows so admins can see exactly which
    // person was paged and whether Twilio actually accepted the send.
    for (const outcome of outcomes) {
      await recordRecipientAudit({
        tenantId,
        integrationId,
        dispatchId,
        notificationType: SMS_NOTIFICATION_TYPE,
        channel: 'sms',
        userId: outcome.recipient.user_id,
        recipientName: outcome.recipient.name,
        recipientEmail: outcome.recipient.email,
        recipientPhone: outcome.recipient.phone,
        deliveryStatus: outcome.deliveryStatus,
        deliveryError: outcome.deliveryError,
        twilioStatusCode: outcome.twilioStatusCode,
        twilioMessageSid: outcome.twilioMessageSid,
        emailMessageId: null,
      });
    }

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
          // Preserved so the admin "Resend to failed recipients" flow can
          // rebuild the original SMS body without guessing at the failure
          // text (the sustained-failure path used to drop this).
          errorMessage: errorMessage.slice(0, 500),
          firstFailedAt,
          outageMinutes,
          recipientCount: optedIn.length,
          smsAttempted: attempted,
          smsSucceeded: succeeded,
          twilioConfigured: Boolean(twilio),
          link: reconnectPath,
          dispatchId,
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
    recipients: optedIn.length,
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

  // Recovery emails follow the same mute rules as failure alerts — if the
  // admin doesn't want to hear about this connector at all, they don't want
  // the "back online" email either.
  if (await isConnectorMuted(tenantId, provider, integrationId)) {
    logger.info('Connector recovery alert suppressed by mute', {
      tenantId,
      integrationId,
      provider,
    });
    return;
  }

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
  // Provider-keyed deep link so the recovery email lands on the right
  // connector card even if the tenant has since renamed or removed the
  // integration row. Matches the failure-path link form so admins always
  // jump to the same place from outage and recovery notifications.
  const connectorsPath = `/connectors?provider=${encodeURIComponent(provider)}`;
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
  } catch (err) {
    logger.warn('Failed to look up tenant name for recovery email', {
      tenantId,
      error: String(err),
    });
  }

  // Recovery emails go to the same recipients as the failure path (and the
  // auth-alert scheduler) — including tenant owners and operations managers
  // who only hold the role via the `user_roles` join.
  ({ emails: recipients } = await getTenantAlertEmailRecipients(tenantId, 5));

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

export interface ResendConnectorAlertParams {
  tenantId: TenantId;
  integrationId: string;
  dispatchId: string;
  notificationType: 'integration' | 'integration_sms';
  provider: string;
  errorMessage: string | null;
  firstFailedAt: string | null;
  outageMinutes: number | null;
  tenantName?: string | null;
}

export interface ResendConnectorAlertOutcome {
  channel: 'email' | 'sms';
  candidates: number;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  twilioConfigured: boolean;
}

/**
 * Re-dispatch a connector outage alert to recipients whose latest delivery
 * status for the original `dispatch_id` is `failed` or `skipped`. Used by the
 * admin "Resend to failed recipients" action so a misconfigured Twilio
 * account or a temporarily-bouncing inbox can be retried after the operator
 * fixes the underlying problem, without re-paging recipients that already
 * received the alert.
 *
 * Behaviour:
 *   - Channel is derived from `notificationType`. We resend on the same
 *     channel the original alert used (email or SMS) — never escalate or
 *     downgrade.
 *   - Recipients are de-duplicated to the LATEST audit row per
 *     (recipient_email, recipient_phone). A retry that already succeeded
 *     in a previous resend is skipped automatically; only recipients still
 *     in `failed`/`skipped` state are paged again.
 *   - New audit rows are inserted with the SAME `dispatch_id` so the
 *     timeline view for this alert grows with the retry attempts in
 *     `dispatched_at` order.
 *   - Per-tenant mute / digest / opt-out preferences are intentionally
 *     NOT re-checked — those gates already passed at original-dispatch
 *     time and a recipient's presence in the audit table is the proof.
 *     The admin is making an explicit, audited resend decision.
 */
export async function resendConnectorAlertToFailedRecipients(
  params: ResendConnectorAlertParams,
): Promise<ResendConnectorAlertOutcome> {
  const {
    tenantId,
    integrationId,
    dispatchId,
    notificationType,
    provider,
    firstFailedAt,
  } = params;
  const channel: 'email' | 'sms' =
    notificationType === 'integration_sms' ? 'sms' : 'email';

  const pool = getPlatformPool();

  // Pull the latest audit row per (recipient_email, recipient_phone) on this
  // dispatch + channel, then keep only those whose latest status is still
  // failed or skipped. DISTINCT ON gives us a one-shot "current state"
  // projection without an extra round-trip.
  const { rows: candidateRows } = await pool.query<{
    user_id: string | null;
    recipient_name: string | null;
    recipient_email: string | null;
    recipient_phone: string | null;
    delivery_status: string;
  }>(
    `WITH latest AS (
       SELECT DISTINCT ON (
                COALESCE(recipient_email, ''),
                COALESCE(recipient_phone, '')
              )
              user_id, recipient_name, recipient_email, recipient_phone,
              delivery_status
         FROM connector_alert_recipients
        WHERE tenant_id = $1
          AND dispatch_id = $2
          AND channel = $3
        ORDER BY COALESCE(recipient_email, ''),
                 COALESCE(recipient_phone, ''),
                 dispatched_at DESC, id DESC
     )
     SELECT user_id, recipient_name, recipient_email, recipient_phone,
            delivery_status
       FROM latest
      WHERE delivery_status IN ('failed', 'skipped')`,
    [tenantId, dispatchId, channel],
  );

  const twilio = channel === 'sms' ? getTwilioConfig() : null;
  const outcome: ResendConnectorAlertOutcome = {
    channel,
    candidates: candidateRows.length,
    attempted: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    twilioConfigured: channel === 'sms' ? Boolean(twilio) : true,
  };

  if (candidateRows.length === 0) {
    return outcome;
  }

  const providerLabel = PROVIDER_LABELS[provider.toLowerCase()] ?? provider;
  const errorMessage = params.errorMessage ?? 'Sync failed';
  const reconnectPath = `/connectors?provider=${encodeURIComponent(provider)}`;
  const reconnectUrl = `${appBaseUrl().replace(/\/$/, '')}${reconnectPath}`;

  if (channel === 'email') {
    const detectedAt = new Date().toUTCString();
    const { subject, html, text } = connectorSyncErrorEmail({
      tenantName: params.tenantName ?? undefined,
      providerLabel,
      errorMessage,
      reconnectUrl,
      detectedAt,
    });

    for (const row of candidateRows) {
      const to = row.recipient_email;
      if (!to) {
        outcome.skipped += 1;
        await recordRecipientAudit({
          tenantId,
          integrationId,
          dispatchId,
          notificationType: 'integration',
          channel: 'email',
          userId: row.user_id,
          recipientName: row.recipient_name,
          recipientEmail: row.recipient_email,
          recipientPhone: null,
          deliveryStatus: 'skipped',
          deliveryError: 'No email address on file for recipient',
          twilioStatusCode: null,
          twilioMessageSid: null,
          emailMessageId: null,
        });
        continue;
      }

      outcome.attempted += 1;
      let deliveryStatus: 'sent' | 'failed' = 'sent';
      let deliveryError: string | null = null;
      let emailMessageId: string | null = null;
      try {
        const result = await sendEmail({ to, subject, html, text });
        emailMessageId = normaliseMessageId(result.messageId);
        if (!result.success) {
          deliveryStatus = 'failed';
          deliveryError = result.error ?? 'sendEmail returned success=false';
          logger.warn('Connector sync alert email resend failed', {
            tenantId,
            integrationId,
            to,
            error: result.error,
          });
        }
      } catch (err) {
        deliveryStatus = 'failed';
        deliveryError = String(err);
        logger.warn('Connector sync alert email resend threw', {
          tenantId,
          integrationId,
          to,
          error: String(err),
        });
      }
      if (deliveryStatus === 'sent') outcome.succeeded += 1;
      else outcome.failed += 1;

      await recordRecipientAudit({
        tenantId,
        integrationId,
        dispatchId,
        notificationType: 'integration',
        channel: 'email',
        userId: row.user_id,
        recipientName: row.recipient_name,
        recipientEmail: to,
        recipientPhone: null,
        deliveryStatus,
        deliveryError,
        twilioStatusCode: null,
        twilioMessageSid: null,
        emailMessageId: deliveryStatus === 'sent' ? emailMessageId : null,
      });
    }

    logger.info('Connector outage alert resend (email) complete', {
      tenantId,
      integrationId,
      dispatchId,
      provider,
      candidates: outcome.candidates,
      attempted: outcome.attempted,
      succeeded: outcome.succeeded,
      failed: outcome.failed,
      skipped: outcome.skipped,
    });
    return outcome;
  }

  // SMS path: rebuild the body using the stored outage metadata so the
  // retry text matches what the original dispatch would have read.
  let outageMinutes = params.outageMinutes;
  if (outageMinutes == null && firstFailedAt) {
    const failedAtMs = Date.parse(firstFailedAt);
    if (Number.isFinite(failedAtMs)) {
      outageMinutes = Math.max(0, Math.round((Date.now() - failedAtMs) / 60000));
    }
  }
  const tenantPrefix = params.tenantName ? `[${params.tenantName}] ` : '';
  const minutesForBody = outageMinutes ?? 0;
  const smsBody =
    `${tenantPrefix}QVO alert: ${providerLabel} integration has been failing for ` +
    `${minutesForBody} min. Latest error: ${errorMessage.slice(0, 100)}. ` +
    `Reconnect at ${appBaseUrl().replace(/\/$/, '')}${reconnectPath}`;

  // Recreate the same statusCallback URL the original SMS dispatch used so
  // resent messages also flow through the /twilio/sms-status webhook and
  // the per-recipient row gets promoted to delivered/undelivered.
  const resendStatusCallback = getOutageSmsStatusCallbackUrl();

  for (const row of candidateRows) {
    const to = row.recipient_phone;
    if (!to) {
      outcome.skipped += 1;
      await recordRecipientAudit({
        tenantId,
        integrationId,
        dispatchId,
        notificationType: 'integration_sms',
        channel: 'sms',
        userId: row.user_id,
        recipientName: row.recipient_name,
        recipientEmail: row.recipient_email,
        recipientPhone: null,
        deliveryStatus: 'skipped',
        deliveryError: 'No phone number on file for recipient',
        twilioStatusCode: null,
        twilioMessageSid: null,
        emailMessageId: null,
      });
      continue;
    }

    if (!twilio) {
      outcome.skipped += 1;
      await recordRecipientAudit({
        tenantId,
        integrationId,
        dispatchId,
        notificationType: 'integration_sms',
        channel: 'sms',
        userId: row.user_id,
        recipientName: row.recipient_name,
        recipientEmail: row.recipient_email,
        recipientPhone: to,
        deliveryStatus: 'skipped',
        deliveryError: 'Twilio is not configured on this server',
        twilioStatusCode: null,
        twilioMessageSid: null,
        emailMessageId: null,
      });
      continue;
    }

    outcome.attempted += 1;
    const result = await sendTwilioSms(twilio, to, smsBody, resendStatusCallback);
    if (result.ok) {
      outcome.succeeded += 1;
      await recordRecipientAudit({
        tenantId,
        integrationId,
        dispatchId,
        notificationType: 'integration_sms',
        channel: 'sms',
        userId: row.user_id,
        recipientName: row.recipient_name,
        recipientEmail: row.recipient_email,
        recipientPhone: to,
        deliveryStatus: 'sent',
        deliveryError: null,
        twilioStatusCode: result.status ?? null,
        twilioMessageSid: result.messageSid ?? null,
        emailMessageId: null,
      });
    } else {
      outcome.failed += 1;
      logger.warn('Connector outage SMS resend failed', {
        tenantId,
        integrationId,
        to,
        status: result.status,
        error: result.error,
      });
      await recordRecipientAudit({
        tenantId,
        integrationId,
        dispatchId,
        notificationType: 'integration_sms',
        channel: 'sms',
        userId: row.user_id,
        recipientName: row.recipient_name,
        recipientEmail: row.recipient_email,
        recipientPhone: to,
        deliveryStatus: 'failed',
        deliveryError: result.error ?? `Twilio HTTP ${result.status ?? 'error'}`,
        twilioStatusCode: result.status ?? null,
        twilioMessageSid: null,
        emailMessageId: null,
      });
    }
  }

  logger.info('Connector outage alert resend (sms) complete', {
    tenantId,
    integrationId,
    dispatchId,
    provider,
    candidates: outcome.candidates,
    attempted: outcome.attempted,
    succeeded: outcome.succeeded,
    failed: outcome.failed,
    skipped: outcome.skipped,
    twilioConfigured: outcome.twilioConfigured,
  });
  return outcome;
}
