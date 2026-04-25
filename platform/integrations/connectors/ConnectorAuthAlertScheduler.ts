import { getPlatformPool } from '../../db';
import { createLogger } from '../../core/logger';
import { sendEmail, connectorSyncErrorEmail } from '../../email';

const logger = createLogger('CONNECTOR_AUTH_ALERT');

const CHECK_INTERVAL_MS = 30 * 60 * 1000;
const INITIAL_DELAY_MS = 5 * 60 * 1000;
const MAX_RECIPIENTS_PER_TENANT = 5;

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
  const pool = getPlatformPool();
  try {
    await pool.query(
      `INSERT INTO tenant_notifications (tenant_id, type, title, message, metadata)
       VALUES ($1, 'integration', $2, $3, $4)`,
      [
        params.tenantId,
        params.title,
        params.message,
        JSON.stringify({
          link: params.reconnectPath,
          integrationId: params.integrationId,
          connectorType: params.connectorType,
          provider: params.provider,
          reason: 'auth_error',
          errorMessage: params.errorMessage.slice(0, 500),
        }),
      ],
    );
  } catch (err) {
    logger.warn('Failed to insert in-app auth alert notification', {
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

    const { name: tenantName, emails: recipients } = await getTenantAdmins(tenantId);

    if (recipients.length === 0) {
      logger.info('Connector auth-alert: no admin recipients, marking sent to avoid retries', {
        tenantId,
        integrationId,
        provider,
      });
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

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

export function startConnectorAuthAlertScheduler(intervalMs: number = CHECK_INTERVAL_MS): void {
  if (timer) return;

  initialTimer = setTimeout(() => {
    runConnectorAuthAlertCycle().catch((err) => {
      logger.error('Initial connector auth-alert cycle failed', { error: String(err) });
    });
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    runConnectorAuthAlertCycle().catch((err) => {
      logger.error('Connector auth-alert cycle failed', { error: String(err) });
    });
  }, intervalMs);

  logger.info('Connector auth-alert scheduler started', { intervalMs });
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
