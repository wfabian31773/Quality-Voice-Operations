import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';
import { withPrivilegedClient } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';

const router = Router();
const logger = createLogger('PLATFORM_CONNECTOR_HEALTH');

const ATTENTION_STATUSES = ['needs_reconnect', 'error'];

interface ConnectorHealthRow {
  integrationId: string;
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  connectorType: string;
  provider: string;
  name: string | null;
  isEnabled: boolean;
  lastSyncStatus: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  lastSyncErrorAt: string | null;
  authAlertSentAt: string | null;
  recoveryAlertSentAt: string | null;
  updatedAt: string | null;
}

interface RefreshFailureRow {
  id: string;
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  integrationId: string | null;
  provider: string | null;
  errorMessage: string | null;
  occurredAt: string;
}

/**
 * Cross-tenant view of connectors that need ops attention. Returns the
 * connectors currently in `needs_reconnect` / `error`, plus recent
 * `connector.token_refresh_failed` audit events. Used by Platform Admin so
 * ops can triage proactive reconnect work without scrolling per-tenant
 * audit logs.
 */
function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const parsed = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

router.get('/platform/connector-health', requireAuth, requirePlatformAdmin, async (req, res) => {
  const sinceDays = clampInt(req.query.sinceDays, 7, 1, 30);
  const eventsLimit = clampInt(req.query.eventsLimit, 50, 1, 200);

  try {
    const result = await withPrivilegedClient(async (client) => {
      const { rows: connectorRows } = await client.query(
        `SELECT
            i.id, i.tenant_id, i.integration_type, i.provider, i.name,
            i.is_enabled, i.last_sync_status, i.last_sync_at,
            i.last_sync_error, i.last_sync_error_at,
            i.auth_alert_sent_at, i.recovery_alert_sent_at, i.updated_at,
            t.name AS tenant_name, t.slug AS tenant_slug
           FROM integrations i
           LEFT JOIN tenants t ON t.id = i.tenant_id
          WHERE i.last_sync_status = ANY($1::text[])
            AND i.is_enabled = TRUE
          ORDER BY
            CASE i.last_sync_status WHEN 'needs_reconnect' THEN 0 ELSE 1 END,
            COALESCE(i.last_sync_error_at, i.last_sync_at, i.updated_at) DESC NULLS LAST`,
        [ATTENTION_STATUSES],
      );

      const { rows: summaryRows } = await client.query(
        `SELECT
            COUNT(*) FILTER (WHERE last_sync_status = 'needs_reconnect') AS needs_reconnect,
            COUNT(*) FILTER (WHERE last_sync_status = 'error') AS sync_error,
            COUNT(*) FILTER (WHERE last_sync_status = 'success') AS healthy,
            COUNT(*) AS total,
            COUNT(DISTINCT tenant_id) FILTER (WHERE last_sync_status = ANY($1::text[])) AS affected_tenants
           FROM integrations
          WHERE is_enabled = TRUE`,
        [ATTENTION_STATUSES],
      );

      const { rows: eventRows } = await client.query(
        `SELECT
            a.id, a.tenant_id, a.resource_id, a.changes, a.occurred_at,
            t.name AS tenant_name, t.slug AS tenant_slug
           FROM audit_logs a
           LEFT JOIN tenants t ON t.id = a.tenant_id
          WHERE a.action = 'connector.token_refresh_failed'
            AND a.occurred_at >= NOW() - ($1::int || ' days')::interval
          ORDER BY a.occurred_at DESC
          LIMIT $2`,
        [sinceDays, eventsLimit],
      );

      return { connectorRows, summaryRows, eventRows };
    });

    const connectors: ConnectorHealthRow[] = result.connectorRows.map((r) => ({
      integrationId: r.id as string,
      tenantId: r.tenant_id as string,
      tenantName: (r.tenant_name as string) ?? null,
      tenantSlug: (r.tenant_slug as string) ?? null,
      connectorType: r.integration_type as string,
      provider: r.provider as string,
      name: (r.name as string) ?? null,
      isEnabled: r.is_enabled as boolean,
      lastSyncStatus: (r.last_sync_status as string) ?? null,
      lastSyncAt: r.last_sync_at ? new Date(r.last_sync_at as string).toISOString() : null,
      lastSyncError: (r.last_sync_error as string) ?? null,
      lastSyncErrorAt: r.last_sync_error_at
        ? new Date(r.last_sync_error_at as string).toISOString()
        : null,
      authAlertSentAt: r.auth_alert_sent_at
        ? new Date(r.auth_alert_sent_at as string).toISOString()
        : null,
      recoveryAlertSentAt: r.recovery_alert_sent_at
        ? new Date(r.recovery_alert_sent_at as string).toISOString()
        : null,
      updatedAt: r.updated_at ? new Date(r.updated_at as string).toISOString() : null,
    }));

    const summaryRow = result.summaryRows[0] ?? {};
    const summary = {
      needsReconnect: parseInt(String(summaryRow.needs_reconnect ?? '0'), 10),
      syncError: parseInt(String(summaryRow.sync_error ?? '0'), 10),
      healthy: parseInt(String(summaryRow.healthy ?? '0'), 10),
      totalEnabled: parseInt(String(summaryRow.total ?? '0'), 10),
      affectedTenants: parseInt(String(summaryRow.affected_tenants ?? '0'), 10),
    };

    const recentRefreshFailures: RefreshFailureRow[] = result.eventRows.map((r) => {
      const changes = (r.changes ?? {}) as Record<string, unknown>;
      const provider = typeof changes.provider === 'string' ? changes.provider : null;
      const errorMessage = typeof changes.error === 'string' ? changes.error : null;
      return {
        id: r.id as string,
        tenantId: r.tenant_id as string,
        tenantName: (r.tenant_name as string) ?? null,
        tenantSlug: (r.tenant_slug as string) ?? null,
        integrationId: (r.resource_id as string) ?? null,
        provider,
        errorMessage,
        occurredAt: new Date(r.occurred_at as string).toISOString(),
      };
    });

    return res.json({
      connectors,
      recentRefreshFailures,
      summary,
      window: { sinceDays, eventsLimit },
    });
  } catch (err) {
    logger.error('Failed to query connector health', { error: String(err) });
    return res.status(500).json({ error: 'Failed to query connector health' });
  }
});

export default router;
