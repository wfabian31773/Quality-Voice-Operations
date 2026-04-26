import { getPlatformPool } from '../../db';
import { createLogger } from '../../core/logger';
import {
  sendEmail,
  connectorSyncErrorEmail,
  connectorAutoDisabledEmail,
  connectorReconnectNeededEmail,
  connectorSyncDigestEmail,
} from '../../email';
import {
  fanoutInAppNotification,
  filterEmailRecipientsByPreference,
} from '../../notifications/NotificationPreferences';
import { writeAuditLog } from '../../audit/AuditService';
import {
  getConnectorAlertSettings,
  loadMuteSetsForTenants,
  recordDigestSent,
} from './ConnectorAlertPreferences';
import { getTenantAlertEmailRecipients } from './ConnectorAlertRecipients';

const logger = createLogger('CONNECTOR_AUTH_ALERT');

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const INITIAL_DELAY_MS = 5 * 60 * 1000;
const MAX_RECIPIENTS_PER_TENANT = 5;
const DIGEST_THROTTLE_MS = 24 * 60 * 60 * 1000;

/** How long after a previous alert before we'll send another one for the same integration. */
const ALERT_THROTTLE_MS = 24 * 60 * 60 * 1000;

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
        AND (
          auth_alert_sent_at IS NULL
          OR auth_alert_sent_at < NOW() - INTERVAL '24 hours'
        )
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

async function getTenantAdmins(tenantId: string): Promise<{
  name: string | undefined;
  emails: string[];
  userIds: string[];
}> {
  const pool = getPlatformPool();
  let name: string | undefined;
  let emails: string[] = [];
  let userIds: string[] = [];
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

  // Delegated to the shared helper so this lookup stays in lock-step with
  // the SyncErrorAlerter's per-event / digest / recovery / SMS recipient
  // queries — every connector notification class must agree on who counts
  // as a notification recipient.
  const recipients = await getTenantAlertEmailRecipients(tenantId, MAX_RECIPIENTS_PER_TENANT);
  emails = recipients.emails;
  userIds = recipients.userIds;

  return { name, emails, userIds };
}

/**
 * Unconditional throttle stamp used by force-issue paths (operator-triggered
 * re-issue from the admin Connector Health panel). Skips the conditional
 * throttle predicate so the slot is reset to NOW() even when an alert was
 * sent inside the last 24h. Subsequent automated cycles will still respect
 * the freshly-stamped 24h window.
 */
async function stampAuthAlertSlot(integrationId: string, tenantId: string): Promise<void> {
  const pool = getPlatformPool();
  try {
    await pool.query(
      `UPDATE integrations
          SET auth_alert_sent_at = NOW(), updated_at = NOW()
        WHERE id = $1 AND tenant_id = $2`,
      [integrationId, tenantId],
    );
  } catch (err) {
    logger.warn('Failed to stamp auth alert slot for force re-issue', {
      tenantId,
      integrationId,
      error: String(err),
    });
  }
}

/** Atomic 24h slot claim; true on win, false on race loss or DB error (fail-closed). */
async function claimAuthAlertSlot(integrationId: string, tenantId: string): Promise<boolean> {
  const pool = getPlatformPool();
  try {
    const result = await pool.query(
      `UPDATE integrations
          SET auth_alert_sent_at = NOW(), updated_at = NOW()
        WHERE id = $1
          AND tenant_id = $2
          AND (
            auth_alert_sent_at IS NULL
            OR auth_alert_sent_at < NOW() - INTERVAL '24 hours'
          )`,
      [integrationId, tenantId],
    );
    return (result as { rowCount?: number }).rowCount === 1;
  } catch (err) {
    logger.warn('Failed to claim auth alert slot', {
      tenantId,
      integrationId,
      error: String(err),
    });
    return false;
  }
}

/** Per-integrationId in-app dedupe (provider fallback for legacy rows). */
async function recentInAppNotificationExists(
  tenantId: string,
  integrationId: string,
  provider: string,
): Promise<boolean> {
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM tenant_notifications
        WHERE tenant_id = $1
          AND type = 'integration'
          AND created_at > NOW() - INTERVAL '24 hours'
          AND (
            metadata ->> 'integrationId' = $2
            OR (
              metadata ->> 'integrationId' IS NULL
              AND LOWER(metadata ->> 'provider') = LOWER($3)
            )
          )
        LIMIT 1`,
      [tenantId, integrationId, provider],
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
  reason: string;
  /** Restrict fan-out to these user IDs; empty/undefined = tenant-wide. */
  recipientUserIds?: string[];
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
        reason: params.reason,
        errorMessage: params.errorMessage.slice(0, 500),
      },
      category: 'integration',
      userIds: params.recipientUserIds,
    });
  } catch (err) {
    logger.warn('Failed to fan out in-app auth alert notification', {
      tenantId: params.tenantId,
      integrationId: params.integrationId,
      error: String(err),
    });
  }
}

export interface DispatchAuthAlertParams {
  tenantId: string;
  integrationId: string;
  provider: string;
  connectorType: string;
  errorMessage?: string | null;
  detectedAt?: string | null;
  reason?: 'needs_reconnect' | 'auth_error';
  /**
   * When true, the dispatcher still does the throttle check, atomic slot
   * claim, and in-app fanout, but skips sending the per-event email. The
   * cycle loop uses this for tenants in digest mode so the row is buffered
   * for a once-per-24h tenant digest instead of fanning out N emails.
   */
  suppressEmail?: boolean;
  /**
   * When true, bypass the 24h throttle window (both the fast-path check
   * and `claimAuthAlertSlot`). Used by operator-triggered manual re-issue
   * from the Platform Admin Connector Health panel — busy customers
   * sometimes miss the first nudge. The dispatcher still stamps
   * `auth_alert_sent_at` so subsequent automated cycles remain throttled.
   */
  force?: boolean;
}

export interface DispatchAuthAlertResult {
  status: 'sent' | 'throttled' | 'no_recipients' | 'skipped';
  emailedRecipients: number;
}

/** Dispatch a reconnect alert for one integration; 24h-throttled via auth_alert_sent_at. */
export async function dispatchConnectorAuthAlert(
  params: DispatchAuthAlertParams,
): Promise<DispatchAuthAlertResult> {
  const pool = getPlatformPool();
  const reason = params.reason ?? 'needs_reconnect';

  let row: {
    name: string | null;
    integration_type: string;
    auth_alert_sent_at: Date | string | null;
    last_sync_error: string | null;
    last_sync_error_at: Date | string | null;
  } | null = null;
  try {
    const { rows } = await pool.query<{
      name: string | null;
      integration_type: string;
      auth_alert_sent_at: Date | string | null;
      last_sync_error: string | null;
      last_sync_error_at: Date | string | null;
    }>(
      `SELECT name,
              integration_type::text AS integration_type,
              auth_alert_sent_at,
              last_sync_error,
              last_sync_error_at
         FROM integrations
        WHERE tenant_id = $1 AND id = $2
        LIMIT 1`,
      [params.tenantId, params.integrationId],
    );
    if (rows.length > 0) row = rows[0];
  } catch (err) {
    logger.warn('Failed to load integration row for auth alert dispatch', {
      tenantId: params.tenantId,
      integrationId: params.integrationId,
      error: String(err),
    });
  }

  if (!row) {
    return { status: 'skipped', emailedRecipients: 0 };
  }

  // Fast-path throttle check; atomic claim below is the race-safe source of truth.
  // Operator-triggered re-issue (params.force === true) skips both the
  // fast-path check and the conditional UPDATE so a busy customer can be
  // nudged again inside the 24h window.
  if (!params.force && row.auth_alert_sent_at) {
    const sentMs = new Date(row.auth_alert_sent_at as string | Date).getTime();
    if (Number.isFinite(sentMs) && Date.now() - sentMs < ALERT_THROTTLE_MS) {
      logger.debug('Connector auth alert suppressed by 24h throttle', {
        tenantId: params.tenantId,
        integrationId: params.integrationId,
        provider: params.provider,
      });
      return { status: 'throttled', emailedRecipients: 0 };
    }
  }

  // In digest mode we deliberately skip the slot claim here. The caller is
  // responsible for stamping auth_alert_sent_at via claimAuthAlertSlot ONLY
  // after the per-tenant digest email actually delivers — otherwise a 24h
  // throttle window or transient SMTP outage would silently drop the failure
  // (findPendingAuthFailures filters on auth_alert_sent_at IS NULL). The
  // in-app fanout below stays deduped by recentInAppNotificationExists.
  if (!params.suppressEmail) {
    if (params.force) {
      // Force-stamp so subsequent automated cycles still respect the 24h
      // throttle from this manual re-issue.
      await stampAuthAlertSlot(params.integrationId, params.tenantId);
    } else {
      const claimed = await claimAuthAlertSlot(params.integrationId, params.tenantId);
      if (!claimed) {
        logger.debug('Connector auth alert claim lost (race or throttle)', {
          tenantId: params.tenantId,
          integrationId: params.integrationId,
          provider: params.provider,
        });
        return { status: 'throttled', emailedRecipients: 0 };
      }
    }
  }

  const label =
    typeof row.name === 'string' && row.name.trim().length > 0
      ? row.name.trim()
      : providerLabel(params.provider);
  const errorMessage =
    params.errorMessage ?? row.last_sync_error ?? 'Authentication failed; reconnect required';
  const reconnectPath = `/connectors?integration=${encodeURIComponent(params.integrationId)}`;
  const reconnectUrl = `${appBaseUrl().replace(/\/$/, '')}${reconnectPath}`;
  const detectedAtSource =
    params.detectedAt ?? (row.last_sync_error_at ? new Date(row.last_sync_error_at as string | Date).toISOString() : null);
  const detectedAt = detectedAtSource ? new Date(detectedAtSource).toUTCString() : new Date().toUTCString();

  const title = `${label} integration needs to be reconnected`;
  const message =
    reason === 'needs_reconnect'
      ? `${label} can't sync until you reauthorize it. Open Connectors to reconnect.`
      : `Latest sync to ${label} failed: ${errorMessage.slice(0, 200)}. Open Connectors to reconnect.`;

  const {
    name: tenantName,
    emails: rawRecipients,
    userIds: adminUserIds,
  } = await getTenantAdmins(params.tenantId);

  const alreadyNotifiedInApp = await recentInAppNotificationExists(
    params.tenantId,
    params.integrationId,
    params.provider,
  );
  if (!alreadyNotifiedInApp) {
    await insertInAppNotification({
      tenantId: params.tenantId,
      integrationId: params.integrationId,
      connectorType: params.connectorType ?? row.integration_type,
      provider: params.provider,
      reconnectPath,
      title,
      message,
      errorMessage,
      reason,
      recipientUserIds: adminUserIds,
    });
  }

  // Digest-mode short-circuit: throttle slot claimed and in-app fanned out
  // above; the cycle loop will buffer this row into the per-tenant digest
  // email instead of sending one email per failure.
  if (params.suppressEmail) {
    logger.debug('Per-event email suppressed by digest mode', {
      tenantId: params.tenantId,
      integrationId: params.integrationId,
      provider: params.provider,
    });
    return { status: 'sent', emailedRecipients: 0 };
  }

  if (rawRecipients.length === 0) {
    logger.info('Connector auth-alert: no admin recipients, slot already claimed', {
      tenantId: params.tenantId,
      integrationId: params.integrationId,
      provider: params.provider,
    });
    return { status: 'no_recipients', emailedRecipients: 0 };
  }

  const recipients = await filterEmailRecipientsByPreference(
    params.tenantId,
    rawRecipients,
    'integration',
  );
  if (recipients.length === 0) {
    logger.info(
      'Connector auth-alert: all admin recipients opted out of integration emails, slot already claimed',
      {
        tenantId: params.tenantId,
        integrationId: params.integrationId,
        provider: params.provider,
        removed: rawRecipients.length,
      },
    );
    return { status: 'no_recipients', emailedRecipients: 0 };
  }

  const { subject, html, text } =
    reason === 'needs_reconnect'
      ? connectorReconnectNeededEmail({
          tenantName,
          providerLabel: label,
          errorMessage,
          reconnectUrl,
          detectedAt,
        })
      : connectorSyncErrorEmail({
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
          tenantId: params.tenantId,
          integrationId: params.integrationId,
          to,
          error: result.error,
        });
      }
    } catch (err) {
      logger.warn('Connector auth-alert email threw', {
        tenantId: params.tenantId,
        integrationId: params.integrationId,
        to,
        error: String(err),
      });
    }
  }

  // Claimed the slot but delivered nothing — surface for ops alerting.
  if (delivered === 0 && recipients.length > 0) {
    logger.error('Connector auth-alert claim succeeded but zero emails delivered', {
      tenantId: params.tenantId,
      integrationId: params.integrationId,
      provider: params.provider,
      attemptedRecipients: recipients.length,
      reason,
    });
  }

  logger.info('Connector auth-alert dispatched', {
    tenantId: params.tenantId,
    integrationId: params.integrationId,
    provider: params.provider,
    recipients: recipients.length,
    delivered,
    reason,
  });

  return { status: 'sent', emailedRecipients: delivered };
}

export interface CycleResult {
  inspected: number;
  alerted: number;
  emailedRecipients: number;
  skippedNoRecipients: number;
  mutedSkipped: number;
  digestEmailsSent: number;
}

interface DigestEntry {
  integrationId: string;
  provider: string;
  providerLabel: string;
  name: string | null;
  errorMessage: string;
  detectedAt: Date | null;
}

export async function runConnectorAuthAlertCycle(): Promise<CycleResult> {
  let pending: PendingAuthFailure[];
  try {
    pending = await findPendingAuthFailures();
  } catch (err) {
    logger.error('Failed to query pending connector auth failures', { error: String(err) });
    return {
      inspected: 0,
      alerted: 0,
      emailedRecipients: 0,
      skippedNoRecipients: 0,
      mutedSkipped: 0,
      digestEmailsSent: 0,
    };
  }

  if (pending.length === 0) {
    logger.debug('No pending connector auth failures to alert on');
    return {
      inspected: 0,
      alerted: 0,
      emailedRecipients: 0,
      skippedNoRecipients: 0,
      mutedSkipped: 0,
      digestEmailsSent: 0,
    };
  }

  const tenantIds = Array.from(new Set(pending.map((p) => p.tenant_id)));
  const muteSets = await loadMuteSetsForTenants(tenantIds);

  // Tenant-level digest preferences are loaded once per tenant up front so a
  // long failure list doesn't fan out to N preference queries.
  const settingsByTenant = new Map<string, Awaited<ReturnType<typeof getConnectorAlertSettings>>>();
  await Promise.all(
    tenantIds.map(async (tid) => {
      settingsByTenant.set(tid, await getConnectorAlertSettings(tid));
    }),
  );

  let alerted = 0;
  let emailedRecipients = 0;
  let skippedNoRecipients = 0;
  let mutedSkipped = 0;
  let digestEmailsSent = 0;
  const digestQueueByTenant = new Map<string, DigestEntry[]>();

  for (const row of pending) {
    const tenantId = row.tenant_id;
    const integrationId = row.integration_id;
    const provider = row.provider;

    // Tenant-level mute: skip the alert entirely but claim the throttle slot
    // so we don't re-evaluate this row every cycle. The slot clears via
    // db.markSyncStatus on the next recovery → re-failure transition.
    const muteSet = muteSets.get(tenantId);
    const muted =
      !!muteSet &&
      (muteSet.providers.has(provider.toLowerCase()) ||
        muteSet.integrations.has(integrationId));
    if (muted) {
      logger.info('Connector auth-alert suppressed by mute', {
        tenantId,
        integrationId,
        provider,
      });
      mutedSkipped += 1;
      await claimAuthAlertSlot(integrationId, tenantId);
      continue;
    }

    const settings = settingsByTenant.get(tenantId);
    const digestMode = !!settings?.digestMode;

    const result = await dispatchConnectorAuthAlert({
      tenantId,
      integrationId,
      provider,
      connectorType: row.integration_type,
      errorMessage: row.last_sync_error,
      detectedAt: row.last_sync_error_at
        ? new Date(row.last_sync_error_at).toISOString()
        : null,
      reason:
        row.last_sync_status === 'needs_reconnect' ? 'needs_reconnect' : 'auth_error',
      // Digest mode: dispatcher fans out in-app (deduped) but skips both
      // the per-event email AND the auth_alert_sent_at stamp. We buffer the
      // row here and stamp each entry only after the digest delivers below
      // — otherwise a 24h throttle or SMTP outage would silently drop the
      // failure from every future digest cycle.
      suppressEmail: digestMode,
    });

    if (digestMode && result.status === 'sent') {
      const queue = digestQueueByTenant.get(tenantId) ?? [];
      queue.push({
        integrationId,
        provider,
        providerLabel: providerLabel(provider),
        name: row.name,
        errorMessage:
          row.last_sync_error ?? 'Authentication failed; reconnect required',
        detectedAt: row.last_sync_error_at
          ? new Date(row.last_sync_error_at)
          : null,
      });
      digestQueueByTenant.set(tenantId, queue);
      continue;
    }

    if (result.status === 'sent') {
      alerted += 1;
      emailedRecipients += result.emailedRecipients;
    } else if (result.status === 'no_recipients') {
      skippedNoRecipients += 1;
    }
  }

  // ---- Digest mode emails (one per tenant per 24h) ----
  for (const [tenantId, entries] of digestQueueByTenant) {
    const settings = settingsByTenant.get(tenantId);
    if (!settings?.digestMode) continue;
    if (entries.length === 0) continue;

    const lastSentMs = settings.digestLastSentAt
      ? new Date(settings.digestLastSentAt).getTime()
      : null;
    if (lastSentMs !== null && Number.isFinite(lastSentMs) && Date.now() - lastSentMs < DIGEST_THROTTLE_MS) {
      logger.debug('Digest email suppressed by 24h throttle', {
        tenantId,
        queued: entries.length,
      });
      continue;
    }

    const { name: tenantName, emails: rawRecipients } = await getTenantAdmins(tenantId);
    if (rawRecipients.length === 0) {
      logger.info('Digest email skipped: no admin recipients', { tenantId, queued: entries.length });
      continue;
    }
    const recipients = await filterEmailRecipientsByPreference(
      tenantId,
      rawRecipients,
      'integration',
    );
    if (recipients.length === 0) {
      logger.info('Digest email skipped: all admins opted out of integration emails', {
        tenantId,
        queued: entries.length,
      });
      continue;
    }

    const connectorsUrl = `${appBaseUrl().replace(/\/$/, '')}/connectors`;
    const generatedAt = new Date().toUTCString();
    const failures = entries.map((e) => ({
      providerLabel: e.providerLabel,
      name: e.name,
      errorMessage: e.errorMessage,
      detectedAt: e.detectedAt ? e.detectedAt.toUTCString() : null,
    }));
    const { subject, html, text } = connectorSyncDigestEmail({
      tenantName,
      connectorsUrl,
      generatedAt,
      failures,
    });

    let delivered = 0;
    for (const to of recipients) {
      try {
        const result = await sendEmail({ to, subject, html, text });
        if (result.success) {
          delivered += 1;
        } else {
          logger.warn('Connector digest email send failed', {
            tenantId,
            to,
            error: result.error,
          });
        }
      } catch (err) {
        logger.warn('Connector digest email threw', {
          tenantId,
          to,
          error: String(err),
        });
      }
    }

    emailedRecipients += delivered;
    if (delivered > 0) {
      digestEmailsSent += 1;
      alerted += entries.length;
      await recordDigestSent(tenantId);
      // Now that the digest has actually been delivered, mark every
      // included integration so it isn't re-emailed in the next digest.
      // (If the integration recovers and re-fails before the next cycle,
      // db.markSyncStatus will clear auth_alert_sent_at again.)
      for (const e of entries) {
        await claimAuthAlertSlot(e.integrationId, tenantId);
      }
      logger.info('Connector digest email dispatched', {
        tenantId,
        recipients: recipients.length,
        delivered,
        failures: failures.length,
      });
    } else {
      // Don't stamp digest_last_sent_at or auth_alert_sent_at when every
      // send failed — leaving both clear lets the next cycle retry
      // instead of suppressing the same failures for 24h after a
      // transient SMTP outage.
      logger.warn('Digest email had zero successful sends; not stamping throttle', {
        tenantId,
        recipients: recipients.length,
      });
    }
  }

  return {
    inspected: pending.length,
    alerted,
    emailedRecipients,
    skippedNoRecipients,
    mutedSkipped,
    digestEmailsSent,
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
