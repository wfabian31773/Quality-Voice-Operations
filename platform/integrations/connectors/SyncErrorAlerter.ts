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
const THROTTLE_HOURS = 24;

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

  logger.info('Connector sync error alert dispatched', {
    tenantId,
    integrationId,
    provider,
    recipients: recipients.length,
  });
}
