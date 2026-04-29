import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';
import { withPrivilegedClient } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';
import {
  ensureFreshOAuthToken,
  isRefreshableProvider,
  getConnectorConfig,
  listConnectorConfigs,
  listConnectorTokenHealth,
} from '../../../platform/integrations/connectors';
import { getRefreshableProviders } from '../../../platform/integrations/connectors/tokenRefresh';
import { dispatchConnectorAuthAlert } from '../../../platform/integrations/connectors/ConnectorAuthAlertScheduler';
import {
  REFRESH_CYCLE_INTERVAL_MS,
  STALE_CYCLE_THRESHOLD,
  TOKEN_EXPIRING_HORIZON_MS,
  computeStaleEvaluation,
  type TokenHealthStatus,
} from '../../../platform/integrations/connectors/connectorStaleHealth';
import {
  getCrmRevalidationMetricsSnapshot,
} from '../../../platform/integrations/connectors/CrmCallerIdentityRevalidationMetrics';
import { writeAuditLog, extractIp } from '../../../platform/audit/AuditService';
import type { ConnectorType } from '../../../platform/integrations/connectors/types';
import {
  getCallerId,
  listUnhealthyVerifiedCallers,
  type CallerHealthResult,
  type CallerHealthStatus,
  type UnhealthyVerifiedCallerRow,
  type VerifiedCallerId,
} from '../../../platform/telephony/TrustedCallerService';
import { dispatchVerifiedCallerAlert } from '../../../platform/telephony/VerifiedCallerHealthScheduler';
import {
  getLatestAlertSummariesByCaller,
  listVerifiedCallerAlertHistory,
  type VerifiedCallerAlertSummary,
} from '../../../platform/telephony/VerifiedCallerAlertHistory';

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
  refreshable: boolean;
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

interface TokenHealthRow {
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  integrationId: string;
  integrationType: string;
  provider: string;
  name: string | null;
  lastSyncStatus: string | null;
  lastSyncAt: string | null;
  lastSyncErrorAt: string | null;
  tokenIssuedAt: string | null;
  tokenExpiresAt: string | null;
  tokenDecryptFailed: boolean;
  /** Status combining `needs_reconnect` with token freshness. */
  status: TokenHealthStatus;
  /** Milliseconds until the token expires (negative when expired). Null when unknown. */
  expiresInMs: number | null;
  /**
   * Whole sweep cycles since the worker last successfully refreshed (or
   * since the token expired, when no issued_at is available). Null when we
   * cannot reason about the cycle count.
   */
  cyclesSinceRefresh: number | null;
  /**
   * True when the worker should have refreshed the token by now but
   * hasn't — i.e. the token is expired or in needs_reconnect AND we have
   * been past that point for >=2 sweep cycles. Surfaces wedged tokens.
   */
  stale: boolean;
}

// Default window for the proactive "Expiring soon" triage bucket. Wider
// than the per-row badge horizon so ops can plan reconnect work a couple of
// days ahead instead of only after the worker has failed. Caller can
// override via `?expiringWithinHours=` (1h..7d).
const DEFAULT_EXPIRING_SOON_HOURS = 48;
const MIN_EXPIRING_SOON_HOURS = 1;
const MAX_EXPIRING_SOON_HOURS = 24 * 7;

/**
 * Row shape for the proactive "Expiring soon" triage bucket — a slim view
 * of `TokenHealthRow` shipped as a separate array so the UI can render a
 * dedicated table without re-filtering the larger token-health snapshot.
 *
 * Only includes connectors that are still currently healthy
 * (`lastSyncStatus` is neither `needs_reconnect` nor `error`) and whose
 * token expires within the configured window. Already-expired or
 * already-failed connectors continue to be surfaced in the existing
 * `connectors` / `tokenHealth` arrays.
 */
interface ExpiringSoonRow {
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  integrationId: string;
  integrationType: string;
  provider: string;
  name: string | null;
  lastSyncStatus: string | null;
  lastSyncAt: string | null;
  tokenIssuedAt: string | null;
  tokenExpiresAt: string | null;
  /** Milliseconds until expiry (always > 0 for rows in this bucket). */
  expiresInMs: number;
}

/**
 * One row in the "Stuck connector messages" subview. Sourced from
 * `outbox_events` rows that the drain worker has parked in `failed` (with
 * a future `next_attempt_at`) or moved to `dead_letter` (attempts hit
 * `max_attempts`). Archived rows (`archived_at IS NOT NULL`) are excluded.
 */
interface StuckOutboxEventRow {
  id: string;
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  integrationId: string | null;
  integrationProvider: string | null;
  integrationName: string | null;
  integrationType: string | null;
  eventType: string;
  status: 'failed' | 'dead_letter';
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string | null;
}

const STUCK_OUTBOX_DEFAULT_LIMIT = 100;
const STUCK_OUTBOX_MAX_LIMIT = 500;

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
  const expiringWithinHours = clampInt(
    req.query.expiringWithinHours,
    DEFAULT_EXPIRING_SOON_HOURS,
    MIN_EXPIRING_SOON_HOURS,
    MAX_EXPIRING_SOON_HOURS,
  );
  const expiringSoonWindowMs = expiringWithinHours * 60 * 60 * 1000;
  const stuckOutboxLimit = clampInt(
    req.query.stuckOutboxLimit,
    STUCK_OUTBOX_DEFAULT_LIMIT,
    1,
    STUCK_OUTBOX_MAX_LIMIT,
  );

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

      const { rows: stuckOutboxRows } = await client.query(
        `SELECT
            oe.id, oe.tenant_id, oe.event_type, oe.status,
            oe.attempts, oe.max_attempts, oe.last_error,
            oe.next_attempt_at, oe.created_at, oe.updated_at,
            oe.integration_id,
            i.provider AS integration_provider,
            i.name AS integration_name,
            i.integration_type::text AS integration_type,
            t.name AS tenant_name, t.slug AS tenant_slug
           FROM outbox_events oe
           LEFT JOIN integrations i
             ON i.id = oe.integration_id AND i.tenant_id = oe.tenant_id
           LEFT JOIN tenants t ON t.id = oe.tenant_id
          WHERE oe.status IN ('failed', 'dead_letter')
            AND oe.archived_at IS NULL
          ORDER BY
            CASE oe.status WHEN 'dead_letter' THEN 0 ELSE 1 END,
            COALESCE(oe.next_attempt_at, oe.updated_at, oe.created_at) DESC NULLS LAST
          LIMIT $1`,
        [stuckOutboxLimit],
      );

      const { rows: stuckOutboxSummaryRows } = await client.query(
        `SELECT
            COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
            COUNT(*) FILTER (WHERE status = 'dead_letter') AS dead_letter_count,
            COUNT(DISTINCT tenant_id) AS affected_tenants
           FROM outbox_events
          WHERE status IN ('failed', 'dead_letter')
            AND archived_at IS NULL`,
      );

      return {
        connectorRows,
        summaryRows,
        eventRows,
        stuckOutboxRows,
        stuckOutboxSummaryRows,
      };
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
      // Single source of truth for "can the admin retry refresh?": the same
      // helper the refresh endpoint uses to gate the request. Embedding the
      // flag in the GET response keeps the UI from re-encoding the provider
      // list and avoids drift when a new OAuth provider is added.
      refreshable: isRefreshableProvider((r.provider as string) ?? ''),
    }));

    const summaryRow = result.summaryRows[0] ?? {};
    const summary = {
      needsReconnect: parseInt(String(summaryRow.needs_reconnect ?? '0'), 10),
      syncError: parseInt(String(summaryRow.sync_error ?? '0'), 10),
      healthy: parseInt(String(summaryRow.healthy ?? '0'), 10),
      totalEnabled: parseInt(String(summaryRow.total ?? '0'), 10),
      affectedTenants: parseInt(String(summaryRow.affected_tenants ?? '0'), 10),
      // Filled in below once the token health snapshot has been computed
      // (or left at 0 when the snapshot helper failed).
      expiringSoon: 0,
    };

    const stuckOutboxEvents: StuckOutboxEventRow[] = result.stuckOutboxRows.map((r) => ({
      id: r.id as string,
      tenantId: r.tenant_id as string,
      tenantName: (r.tenant_name as string) ?? null,
      tenantSlug: (r.tenant_slug as string) ?? null,
      integrationId: (r.integration_id as string) ?? null,
      integrationProvider: (r.integration_provider as string) ?? null,
      integrationName: (r.integration_name as string) ?? null,
      integrationType: (r.integration_type as string) ?? null,
      eventType: r.event_type as string,
      status: r.status as 'failed' | 'dead_letter',
      attempts: parseInt(String(r.attempts ?? '0'), 10),
      maxAttempts: parseInt(String(r.max_attempts ?? '0'), 10),
      lastError: (r.last_error as string) ?? null,
      nextAttemptAt: r.next_attempt_at
        ? new Date(r.next_attempt_at as string).toISOString()
        : null,
      createdAt: new Date(r.created_at as string).toISOString(),
      updatedAt: r.updated_at ? new Date(r.updated_at as string).toISOString() : null,
    }));

    const stuckSummaryRow = result.stuckOutboxSummaryRows[0] ?? {};
    const stuckOutboxSummary = {
      failed: parseInt(String(stuckSummaryRow.failed_count ?? '0'), 10),
      deadLetter: parseInt(String(stuckSummaryRow.dead_letter_count ?? '0'), 10),
      affectedTenants: parseInt(String(stuckSummaryRow.affected_tenants ?? '0'), 10),
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

    let tokenHealth: TokenHealthRow[] = [];
    try {
      const refreshableProviders = getRefreshableProviders();
      const snapshots = await listConnectorTokenHealth(refreshableProviders);
      const now = Date.now();
      tokenHealth = snapshots.map((s) => {
        // Single source of truth for "is this connector stale?". Same
        // helper backs the off-hours `ConnectorStaleAlertScheduler` digest
        // so the badge in the UI and the email never disagree.
        const evaluation = computeStaleEvaluation(s, now);
        return {
          tenantId: s.tenantId,
          tenantName: s.tenantName,
          tenantSlug: s.tenantSlug,
          integrationId: s.integrationId,
          integrationType: s.integrationType,
          provider: s.provider,
          name: s.name,
          lastSyncStatus: s.lastSyncStatus,
          lastSyncAt: s.lastSyncAt,
          lastSyncErrorAt: s.lastSyncErrorAt,
          tokenIssuedAt: s.tokenIssuedAt !== null ? new Date(s.tokenIssuedAt).toISOString() : null,
          tokenExpiresAt: s.tokenExpiresAt !== null ? new Date(s.tokenExpiresAt).toISOString() : null,
          tokenDecryptFailed: s.tokenDecryptFailed,
          status: evaluation.status,
          expiresInMs: evaluation.expiresInMs,
          cyclesSinceRefresh: evaluation.cyclesSinceRefresh,
          stale: evaluation.stale,
        };
      });
    } catch (err) {
      // Token snapshot is best-effort. If decryption or DB access fails for
      // the entire fan-out we still want to return the rest of the health
      // payload so ops can keep triaging.
      logger.warn('Failed to load token health snapshot', { error: String(err) });
      tokenHealth = [];
    }

    // "Expiring soon" surfaces still-healthy connectors whose token will
    // expire within the configured window so ops can plan reconnect work
    // before the worker actually fails. We deliberately exclude rows that
    // are already in `needs_reconnect` / `error` (those have their own
    // tables) and rows whose token has already expired (also covered by
    // tokenHealth's `expired` status). `expiresInMs > 0` guards against
    // surfacing already-expired tokens here.
    const expiringSoon: ExpiringSoonRow[] = tokenHealth
      .filter((r) => {
        if (r.lastSyncStatus === 'needs_reconnect' || r.lastSyncStatus === 'error') return false;
        if (r.expiresInMs === null) return false;
        if (r.expiresInMs <= 0) return false;
        return r.expiresInMs <= expiringSoonWindowMs;
      })
      .map((r) => ({
        tenantId: r.tenantId,
        tenantName: r.tenantName,
        tenantSlug: r.tenantSlug,
        integrationId: r.integrationId,
        integrationType: r.integrationType,
        provider: r.provider,
        name: r.name,
        lastSyncStatus: r.lastSyncStatus,
        lastSyncAt: r.lastSyncAt,
        tokenIssuedAt: r.tokenIssuedAt,
        tokenExpiresAt: r.tokenExpiresAt,
        // Non-null guaranteed by the filter above.
        expiresInMs: r.expiresInMs as number,
      }))
      .sort((a, b) => a.expiresInMs - b.expiresInMs);

    summary.expiringSoon = expiringSoon.length;

    // Snapshot the in-process CRM caller-identity revalidation sweep
    // counters so the Connector Health view can render scanned /
    // validated / staleScrubbed / failed totals alongside the existing
    // observability tables. Cheap (in-memory) and best-effort: the rest
    // of the payload is far too valuable to fail the response over a
    // metrics snapshot bug.
    let crmRevalidation: ReturnType<typeof getCrmRevalidationMetricsSnapshot> | null = null;
    try {
      crmRevalidation = getCrmRevalidationMetricsSnapshot();
    } catch (err) {
      logger.warn('Failed to load CRM revalidation metrics snapshot', { error: String(err) });
    }

    return res.json({
      connectors,
      recentRefreshFailures,
      summary,
      tokenHealth,
      tokenHealthRefreshIntervalMs: REFRESH_CYCLE_INTERVAL_MS,
      tokenHealthExpiringHorizonMs: TOKEN_EXPIRING_HORIZON_MS,
      tokenHealthStaleCycleThreshold: STALE_CYCLE_THRESHOLD,
      expiringSoon,
      expiringSoonWindowMs,
      expiringSoonWithinHours: expiringWithinHours,
      stuckOutboxEvents,
      stuckOutboxSummary,
      stuckOutboxLimit,
      crmRevalidation,
      window: { sinceDays, eventsLimit, expiringWithinHours, stuckOutboxLimit },
    });
  } catch (err) {
    logger.error('Failed to query connector health', { error: String(err) });
    return res.status(500).json({ error: 'Failed to query connector health' });
  }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TenantLookupRow {
  id: string;
  name: string | null;
  slug: string | null;
  status: string | null;
  plan: string | null;
}

/**
 * Read-only, platform-admin–scoped view of a single tenant's connectors.
 * Backs the "Open tenant connectors" deep link in the Connector Health
 * actions column so a platform admin signed into the platform tenant can
 * inspect the affected tenant's connector list without an impersonation
 * token swap. Every load is logged in `audit_logs` so we keep a trail of
 * who looked at which tenant's integrations.
 *
 * Non-platform-admins fall through `requirePlatformAdmin` and receive a
 * 403 from that middleware before this handler ever runs.
 */
router.get(
  '/platform/tenants/:tenantId/connectors',
  requireAuth,
  requirePlatformAdmin,
  async (req, res) => {
    const { tenantId } = req.params;
    if (!UUID_RE.test(tenantId)) {
      return res.status(400).json({ error: 'Invalid tenantId' });
    }

    try {
      const tenant = await withPrivilegedClient(async (client) => {
        const { rows } = await client.query(
          `SELECT id, name, slug, status, plan
             FROM tenants
            WHERE id = $1
            LIMIT 1`,
          [tenantId],
        );
        return (rows[0] as unknown as TenantLookupRow | undefined) ?? null;
      });

      if (!tenant) {
        return res.status(404).json({ error: 'Tenant not found' });
      }

      const connectors = await listConnectorConfigs(tenantId);

      // Audit the cross-tenant peek. Best-effort — a write failure should
      // not prevent the admin from seeing the data they need to triage.
      try {
        await writeAuditLog({
          tenantId,
          actorUserId: req.user!.userId,
          actorRole: 'platform_admin',
          action: 'platform_admin.tenant_connectors_viewed',
          resourceType: 'tenant',
          resourceId: tenantId,
          severity: 'info',
          changes: {
            connectorCount: connectors.length,
            integrationFocus:
              typeof req.query.integration === 'string'
                ? req.query.integration
                : null,
          },
          ipAddress: extractIp(req),
          userAgent: req.headers['user-agent'],
        });
      } catch (auditErr) {
        logger.warn('Failed to audit platform tenant connectors view', {
          tenantId,
          adminUserId: req.user!.userId,
          error: String(auditErr),
        });
      }

      logger.info('Platform admin viewed tenant connectors', {
        tenantId,
        adminUserId: req.user!.userId,
        connectorCount: connectors.length,
      });

      return res.json({
        tenant: {
          id: tenant.id,
          name: tenant.name,
          slug: tenant.slug,
          status: tenant.status,
          plan: tenant.plan,
        },
        connectors,
      });
    } catch (err) {
      logger.error('Failed to load tenant connectors for platform admin', {
        tenantId,
        adminUserId: req.user?.userId,
        error: String(err),
      });
      return res.status(500).json({ error: 'Failed to load tenant connectors' });
    }
  },
);

interface IntegrationLookupRow {
  id: string;
  tenant_id: string;
  integration_type: string;
  provider: string;
  name: string | null;
  is_enabled: boolean;
  last_sync_status: string | null;
  last_sync_error: string | null;
  last_sync_error_at: Date | string | null;
  auth_alert_sent_at: Date | string | null;
}

async function loadIntegrationForAdminAction(
  tenantId: string,
  integrationId: string,
): Promise<IntegrationLookupRow | null> {
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT id, tenant_id, integration_type::text AS integration_type, provider, name,
              is_enabled, last_sync_status, last_sync_error, last_sync_error_at,
              auth_alert_sent_at
         FROM integrations
        WHERE id = $1 AND tenant_id = $2
        LIMIT 1`,
      [integrationId, tenantId],
    );
    return (rows[0] as unknown as IntegrationLookupRow | undefined) ?? null;
  });
}

/**
 * Operator-triggered token refresh from the Platform Admin Connector Health
 * panel. Loads the connector config (decrypts credentials) and forces a
 * refresh exchange even when the cached `token_expires_at` says the token is
 * still valid — the underlying provider may have already revoked it. On
 * refresh failure the connector is marked `needs_reconnect` (via
 * ensureFreshOAuthToken's existing failure path) and the admin sees the
 * provider's error message in the response so they can copy it into a
 * support thread.
 */
router.post(
  '/platform/connector-health/integrations/:tenantId/:integrationId/refresh',
  requireAuth,
  requirePlatformAdmin,
  async (req, res) => {
    const { tenantId, integrationId } = req.params;
    if (!UUID_RE.test(tenantId) || !UUID_RE.test(integrationId)) {
      return res.status(400).json({ error: 'Invalid tenantId or integrationId' });
    }

    const row = await loadIntegrationForAdminAction(tenantId, integrationId);
    if (!row) {
      return res.status(404).json({ error: 'Integration not found' });
    }
    if (!isRefreshableProvider(row.provider)) {
      return res.status(400).json({
        error: `Provider "${row.provider}" does not support OAuth token refresh from this panel.`,
      });
    }

    const config = await getConnectorConfig(
      tenantId,
      row.integration_type as ConnectorType,
      row.provider,
    );
    if (!config) {
      return res.status(404).json({
        error:
          'Connector config not found or disabled. The tenant may have removed or disabled this integration.',
      });
    }

    try {
      await ensureFreshOAuthToken(config, { force: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('Admin-triggered token refresh failed', {
        tenantId,
        integrationId,
        provider: row.provider,
        adminUserId: req.user!.userId,
        error: message,
      });
      try {
        await writeAuditLog({
          tenantId,
          actorUserId: req.user!.userId,
          actorRole: 'platform_admin',
          action: 'connector.admin_refresh_failed',
          resourceType: 'connector',
          resourceId: integrationId,
          severity: 'warning',
          changes: { provider: row.provider, error: message.slice(0, 500) },
          ipAddress: extractIp(req),
        });
      } catch {
        // best-effort
      }
      return res.status(502).json({
        ok: false,
        error: message,
        message: `Refresh failed: ${message.slice(0, 200)}`,
      });
    }

    logger.info('Admin-triggered token refresh succeeded', {
      tenantId,
      integrationId,
      provider: row.provider,
      adminUserId: req.user!.userId,
    });
    try {
      await writeAuditLog({
        tenantId,
        actorUserId: req.user!.userId,
        actorRole: 'platform_admin',
        action: 'connector.admin_refresh_succeeded',
        resourceType: 'connector',
        resourceId: integrationId,
        severity: 'info',
        changes: { provider: row.provider },
        ipAddress: extractIp(req),
      });
    } catch {
      // best-effort
    }

    return res.json({
      ok: true,
      provider: row.provider,
      message: 'Token refresh succeeded.',
    });
  },
);

/**
 * Operator-triggered re-issue of the connector reconnect email. Bypasses
 * the 24h throttle so a busy customer can be nudged again, but still
 * stamps `auth_alert_sent_at` so the next automated cycle respects the
 * fresh window. The dispatcher returns delivery counts which we surface
 * back to the admin so they know whether the email actually went out.
 */
router.post(
  '/platform/connector-health/integrations/:tenantId/:integrationId/alert',
  requireAuth,
  requirePlatformAdmin,
  async (req, res) => {
    const { tenantId, integrationId } = req.params;
    if (!UUID_RE.test(tenantId) || !UUID_RE.test(integrationId)) {
      return res.status(400).json({ error: 'Invalid tenantId or integrationId' });
    }

    const row = await loadIntegrationForAdminAction(tenantId, integrationId);
    if (!row) {
      return res.status(404).json({ error: 'Integration not found' });
    }

    const reason: 'needs_reconnect' | 'auth_error' =
      row.last_sync_status === 'needs_reconnect' ? 'needs_reconnect' : 'auth_error';

    let result;
    try {
      result = await dispatchConnectorAuthAlert({
        tenantId,
        integrationId,
        provider: row.provider,
        connectorType: row.integration_type,
        errorMessage: row.last_sync_error,
        detectedAt: row.last_sync_error_at
          ? new Date(row.last_sync_error_at).toISOString()
          : null,
        reason,
        force: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Admin-triggered reconnect alert dispatch threw', {
        tenantId,
        integrationId,
        provider: row.provider,
        adminUserId: req.user!.userId,
        error: message,
      });
      return res.status(500).json({ ok: false, error: message });
    }

    try {
      await writeAuditLog({
        tenantId,
        actorUserId: req.user!.userId,
        actorRole: 'platform_admin',
        action: 'connector.admin_alert_reissued',
        resourceType: 'connector',
        resourceId: integrationId,
        severity: 'info',
        changes: {
          provider: row.provider,
          status: result.status,
          emailedRecipients: result.emailedRecipients,
          reason,
        },
        ipAddress: extractIp(req),
      });
    } catch {
      // best-effort
    }

    logger.info('Admin-triggered reconnect alert dispatched', {
      tenantId,
      integrationId,
      provider: row.provider,
      adminUserId: req.user!.userId,
      status: result.status,
      emailedRecipients: result.emailedRecipients,
    });

    let message: string;
    if (result.status === 'sent' && result.emailedRecipients > 0) {
      message = `Reconnect email sent to ${result.emailedRecipients} admin${result.emailedRecipients === 1 ? '' : 's'}.`;
    } else if (result.status === 'sent') {
      message = 'Reconnect alert delivered (in-app only — no admin recipients eligible for email).';
    } else if (result.status === 'no_recipients') {
      message = 'No tenant admin recipients are eligible for connector emails. In-app notification was still fanned out.';
    } else if (result.status === 'skipped') {
      message = 'Could not load integration row for dispatch (it may have been removed).';
    } else {
      message = `Reconnect email status: ${result.status}.`;
    }

    return res.json({
      ok: true,
      status: result.status,
      emailedRecipients: result.emailedRecipients,
      reason,
      message,
    });
  },
);

interface StuckOutboxLookupRow {
  id: string;
  tenant_id: string;
  status: 'failed' | 'dead_letter' | 'pending' | 'processing' | 'delivered';
  attempts: number;
  max_attempts: number;
  event_type: string;
  integration_id: string | null;
  archived_at: Date | string | null;
}

async function loadStuckOutboxRow(
  tenantId: string,
  eventId: string,
): Promise<StuckOutboxLookupRow | null> {
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT id, tenant_id, status::text AS status, attempts, max_attempts,
              event_type, integration_id, archived_at
         FROM outbox_events
        WHERE id = $1 AND tenant_id = $2
        LIMIT 1`,
      [eventId, tenantId],
    );
    return (rows[0] as unknown as StuckOutboxLookupRow | undefined) ?? null;
  });
}

/**
 * Operator-triggered "Retry now" for a stuck outbox event. Resets the row
 * back to `pending` with `next_attempt_at = NOW()` so the next drain cycle
 * picks it up. Attempts are zeroed because:
 *
 *   1. `dead_letter` rows have `attempts >= max_attempts`, and the drain
 *      claim filters on `attempts < max_attempts`, so without a reset the
 *      row would never be claimed.
 *   2. `failed` rows have backoff baked into `next_attempt_at`; collapsing
 *      that to NOW() AND resetting attempts gives the operator the same
 *      "fresh shot" semantics regardless of which bucket the row was in.
 *
 * Archived rows are also un-archived in case an operator wants to revive
 * a row that was previously dismissed.
 */
router.post(
  '/platform/connector-health/outbox/:tenantId/:eventId/retry',
  requireAuth,
  requirePlatformAdmin,
  async (req, res) => {
    const { tenantId, eventId } = req.params;
    if (!UUID_RE.test(tenantId) || !UUID_RE.test(eventId)) {
      return res.status(400).json({ error: 'Invalid tenantId or eventId' });
    }

    const row = await loadStuckOutboxRow(tenantId, eventId);
    if (!row) {
      return res.status(404).json({ error: 'Outbox event not found' });
    }

    if (row.status !== 'failed' && row.status !== 'dead_letter') {
      return res.status(409).json({
        error: `Outbox event is in status "${row.status}" and is not retryable. Only failed/dead_letter rows can be requeued.`,
      });
    }

    const previousStatus = row.status;
    const previousAttempts = row.attempts;

    let updatedCount = 0;
    try {
      await withPrivilegedClient(async (client) => {
        // Status predicate guards against TOCTOU: if the drain worker
        // (or another admin) flipped this row between our SELECT above
        // and this UPDATE, rowCount will be 0 and we'll surface a 409.
        const result = await client.query(
          `UPDATE outbox_events
              SET status = 'pending',
                  attempts = 0,
                  next_attempt_at = NOW(),
                  last_error = NULL,
                  archived_at = NULL,
                  updated_at = NOW()
            WHERE id = $1
              AND tenant_id = $2
              AND status IN ('failed', 'dead_letter')`,
          [eventId, tenantId],
        );
        updatedCount = result.rowCount ?? 0;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Failed to requeue stuck outbox event', {
        tenantId,
        eventId,
        adminUserId: req.user?.userId,
        error: message,
      });
      return res.status(500).json({ ok: false, error: 'Failed to requeue outbox event' });
    }

    if (updatedCount === 0) {
      logger.warn('Stuck outbox retry lost a race — row state changed before UPDATE', {
        tenantId,
        eventId,
        previousStatus,
        adminUserId: req.user?.userId,
      });
      return res.status(409).json({
        ok: false,
        error:
          'Outbox event status changed before the retry could be applied. Refresh and try again.',
      });
    }

    try {
      await writeAuditLog({
        tenantId,
        actorUserId: req.user!.userId,
        actorRole: 'platform_admin',
        action: 'connector.outbox_retry_queued',
        resourceType: 'outbox_event',
        resourceId: eventId,
        severity: 'info',
        changes: {
          eventType: row.event_type,
          integrationId: row.integration_id,
          previousStatus,
          previousAttempts,
          maxAttempts: row.max_attempts,
        },
        ipAddress: extractIp(req),
      });
    } catch {
      // best-effort
    }

    logger.info('Admin requeued stuck outbox event', {
      tenantId,
      eventId,
      previousStatus,
      adminUserId: req.user!.userId,
    });

    return res.json({
      ok: true,
      message:
        previousStatus === 'dead_letter'
          ? 'Dead-letter event requeued. The drain worker will retry it on the next cycle.'
          : 'Failed event requeued. The drain worker will retry it on the next cycle.',
      previousStatus,
    });
  },
);

/**
 * Operator-triggered "Mark resolved" for a `dead_letter` outbox event.
 * Soft-archives the row by stamping `archived_at` so the Stuck panel and
 * the drain worker both ignore it, while keeping the original payload and
 * error message in place for forensics. Only `dead_letter` rows are
 * eligible — `failed` rows still have automatic retries pending and
 * shouldn't be archived from the panel.
 */
router.post(
  '/platform/connector-health/outbox/:tenantId/:eventId/archive',
  requireAuth,
  requirePlatformAdmin,
  async (req, res) => {
    const { tenantId, eventId } = req.params;
    if (!UUID_RE.test(tenantId) || !UUID_RE.test(eventId)) {
      return res.status(400).json({ error: 'Invalid tenantId or eventId' });
    }

    const row = await loadStuckOutboxRow(tenantId, eventId);
    if (!row) {
      return res.status(404).json({ error: 'Outbox event not found' });
    }

    if (row.archived_at) {
      return res.json({
        ok: true,
        message: 'Outbox event was already archived.',
        alreadyArchived: true,
      });
    }

    if (row.status !== 'dead_letter') {
      return res.status(409).json({
        error: `Only dead_letter rows can be marked resolved. This row is in status "${row.status}".`,
      });
    }

    let updatedCount = 0;
    try {
      await withPrivilegedClient(async (client) => {
        // Status / archived_at predicates guard against TOCTOU: if the
        // row was requeued (status flipped off dead_letter) or archived
        // by another admin between our SELECT and UPDATE, rowCount will
        // be 0 and we surface a 409 instead of silently no-oping.
        const result = await client.query(
          `UPDATE outbox_events
              SET archived_at = NOW(),
                  updated_at = NOW()
            WHERE id = $1
              AND tenant_id = $2
              AND status = 'dead_letter'
              AND archived_at IS NULL`,
          [eventId, tenantId],
        );
        updatedCount = result.rowCount ?? 0;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Failed to archive stuck outbox event', {
        tenantId,
        eventId,
        adminUserId: req.user?.userId,
        error: message,
      });
      return res.status(500).json({ ok: false, error: 'Failed to archive outbox event' });
    }

    if (updatedCount === 0) {
      logger.warn('Stuck outbox archive lost a race — row state changed before UPDATE', {
        tenantId,
        eventId,
        adminUserId: req.user?.userId,
      });
      return res.status(409).json({
        ok: false,
        error:
          'Outbox event status changed before it could be archived. Refresh and try again.',
      });
    }

    try {
      await writeAuditLog({
        tenantId,
        actorUserId: req.user!.userId,
        actorRole: 'platform_admin',
        action: 'connector.outbox_archived',
        resourceType: 'outbox_event',
        resourceId: eventId,
        severity: 'info',
        changes: {
          eventType: row.event_type,
          integrationId: row.integration_id,
          attempts: row.attempts,
          maxAttempts: row.max_attempts,
        },
        ipAddress: extractIp(req),
      });
    } catch {
      // best-effort
    }

    logger.info('Admin archived dead-letter outbox event', {
      tenantId,
      eventId,
      adminUserId: req.user!.userId,
    });

    return res.json({
      ok: true,
      message: 'Outbox event archived. It will no longer appear in the Stuck panel.',
    });
  },
);

// ============================================================================
// Verified caller health (cross-tenant view of expiring / expired / revoked
// caller IDs surfaced from the weekly VerifiedCallerHealthScheduler).
// ============================================================================

/**
 * One row in the Platform Admin verified-caller health table. Carries
 * just the fields the UI needs (we deliberately do NOT spread the full
 * `VerifiedCallerId` so secrets like `verification_code` never escape
 * the platform tenant boundary).
 *
 * Narrow alias for the only health statuses this endpoint ever surfaces.
 * The cross-tenant query in `listUnhealthyVerifiedCallers` filters on
 * exactly these three values, so the response shape is locked to them.
 * Using a tighter union here (rather than `CallerHealthStatus`) makes the
 * API contract self-documenting and keeps consumers from having to handle
 * `'healthy' | 'unknown'` cases that can never appear in this payload.
 */
type UnhealthyVerifiedCallerStatus = 'expiring_soon' | 'expired' | 'revoked';

const UNHEALTHY_VERIFIED_CALLER_STATUSES: readonly UnhealthyVerifiedCallerStatus[] = [
  'expiring_soon',
  'expired',
  'revoked',
];

function isUnhealthyVerifiedCallerStatus(
  s: CallerHealthStatus | null | undefined,
): s is UnhealthyVerifiedCallerStatus {
  return s !== null && s !== undefined && (UNHEALTHY_VERIFIED_CALLER_STATUSES as readonly string[]).includes(s);
}

interface UnhealthyVerifiedCallerResponseRow {
  id: string;
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  phoneNumber: string;
  friendlyName: string | null;
  status: UnhealthyVerifiedCallerStatus;
  /**
   * Days until `expires_at` (ceil). Negative when already expired,
   * `null` when the row has no `expires_at` (typical for `revoked`).
   */
  daysRemaining: number | null;
  expiresAt: string | null;
  lastHealthCheckAt: string | null;
  lastHealthMessage: string | null;
  expiryAlertSentAt: string | null;
  /**
   * Most recent alert dispatch summary, sourced from
   * `verified_caller_alert_recipients`. `null` when no alert audit rows
   * exist for the caller (i.e. nothing has been dispatched since the
   * audit table was introduced). The panel renders the bounce badge
   * when `lastAlert.allBounced` is true.
   */
  lastAlert: VerifiedCallerAlertSummary | null;
}

const VERIFIED_CALLER_DEFAULT_LIMIT = 200;
const VERIFIED_CALLER_MAX_LIMIT = 500;

function daysUntil(expiresAt: Date | null): number | null {
  if (!expiresAt) return null;
  const ms = expiresAt.getTime() - Date.now();
  // Ceil so a row 23h59m out still reads "1 day", and an already-expired
  // row reads as a negative number that the UI can render as "expired N
  // days ago".
  return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

function toUnhealthyVerifiedCallerResponseRow(
  row: UnhealthyVerifiedCallerRow,
  lastAlert: VerifiedCallerAlertSummary | null,
): UnhealthyVerifiedCallerResponseRow | null {
  const c = row.caller;
  // The list query is filtered to exactly the three unhealthy statuses,
  // but DB rows could theoretically arrive in any state (manual update,
  // race with the health scheduler, etc). Narrow at runtime so the API
  // contract really is `expiring_soon | expired | revoked`. Anything
  // outside that set is dropped from the payload — better to under-report
  // than to mislabel a row in a support workflow.
  if (!isUnhealthyVerifiedCallerStatus(c.lastHealthStatus)) {
    return null;
  }
  const status: UnhealthyVerifiedCallerStatus = c.lastHealthStatus;
  return {
    id: c.id,
    tenantId: c.tenantId,
    tenantName: row.tenantName,
    tenantSlug: row.tenantSlug,
    phoneNumber: c.phoneNumber,
    friendlyName: c.friendlyName,
    status,
    daysRemaining: daysUntil(c.expiresAt),
    expiresAt: c.expiresAt ? c.expiresAt.toISOString() : null,
    lastHealthCheckAt: c.lastHealthCheckAt ? c.lastHealthCheckAt.toISOString() : null,
    lastHealthMessage: c.lastHealthMessage,
    expiryAlertSentAt: c.expiryAlertSentAt ? c.expiryAlertSentAt.toISOString() : null,
    lastAlert,
  };
}

router.get(
  '/platform/verified-caller-health',
  requireAuth,
  requirePlatformAdmin,
  async (req, res) => {
    const limit = clampInt(
      req.query.limit,
      VERIFIED_CALLER_DEFAULT_LIMIT,
      1,
      VERIFIED_CALLER_MAX_LIMIT,
    );

    try {
      const rows = await listUnhealthyVerifiedCallers(limit);
      // Bulk-fetch the most recent dispatch summary for every caller in
      // the listing in a single round-trip. Empty input list short-
      // circuits inside the helper, so the no-rows path stays free.
      const summariesByCaller = await getLatestAlertSummariesByCaller(
        rows.map((r) => ({ tenantId: r.caller.tenantId, callerId: r.caller.id })),
      );
      const callers = rows
        .map((r) =>
          toUnhealthyVerifiedCallerResponseRow(
            r,
            summariesByCaller.get(r.caller.id) ?? null,
          ),
        )
        .filter((r): r is UnhealthyVerifiedCallerResponseRow => r !== null);

      const summary = callers.reduce(
        (acc, r) => {
          if (r.status === 'revoked') acc.revoked += 1;
          else if (r.status === 'expired') acc.expired += 1;
          else if (r.status === 'expiring_soon') acc.expiringSoon += 1;
          acc.tenants.add(r.tenantId);
          return acc;
        },
        {
          revoked: 0,
          expired: 0,
          expiringSoon: 0,
          tenants: new Set<string>(),
        },
      );

      return res.json({
        callers,
        summary: {
          revoked: summary.revoked,
          expired: summary.expired,
          expiringSoon: summary.expiringSoon,
          total: callers.length,
          affectedTenants: summary.tenants.size,
        },
        limit,
      });
    } catch (err) {
      logger.error('Failed to query verified caller health', { error: String(err) });
      return res.status(500).json({ error: 'Failed to query verified caller health' });
    }
  },
);

/**
 * Reconstruct a `CallerHealthResult` from the persisted row so we can
 * call `dispatchVerifiedCallerAlert` without having to re-query Twilio.
 * Defensive: if the row's status isn't an alertable value, the route
 * rejects the request (see handler) — this helper assumes a valid
 * unhealthy status.
 */
function callerHealthResultFromRow(caller: VerifiedCallerId): CallerHealthResult {
  return {
    status: (caller.lastHealthStatus ?? 'unknown') as CallerHealthStatus,
    expiresAt: caller.expiresAt,
    message: caller.lastHealthMessage,
    // Defaults to false because we're not re-running the actual health
    // check — we're just re-issuing the existing alert. Attestation
    // demotion is the scheduler's job, not the operator nudge's.
    demoteAttestation: false,
  };
}

/**
 * Cap the per-caller history payload. A tenant rarely has more than a
 * handful of admins, and the panel renders the rows newest-first, so a
 * 200-row cap covers ~25 dispatches at 8 admins each — far more than
 * support ever scrolls through. Keeps the JSON payload bounded for the
 * pathological "tenant added 50 admins" case.
 */
const VERIFIED_CALLER_ALERT_HISTORY_LIMIT = 200;

router.get(
  '/platform/verified-caller-health/:tenantId/:callerId/alert-history',
  requireAuth,
  requirePlatformAdmin,
  async (req, res) => {
    const { tenantId, callerId } = req.params;
    if (!UUID_RE.test(tenantId) || !UUID_RE.test(callerId)) {
      return res.status(400).json({ error: 'Invalid tenantId or callerId' });
    }

    try {
      const recipients = await listVerifiedCallerAlertHistory(
        tenantId,
        callerId,
        VERIFIED_CALLER_ALERT_HISTORY_LIMIT,
      );
      return res.json({
        recipients,
        limit: VERIFIED_CALLER_ALERT_HISTORY_LIMIT,
        truncated: recipients.length === VERIFIED_CALLER_ALERT_HISTORY_LIMIT,
      });
    } catch (err) {
      logger.error('Failed to load verified-caller alert history', {
        tenantId,
        callerId,
        adminUserId: req.user?.userId,
        error: String(err),
      });
      return res.status(500).json({ error: 'Failed to load alert history' });
    }
  },
);

router.post(
  '/platform/verified-caller-health/:tenantId/:callerId/alert',
  requireAuth,
  requirePlatformAdmin,
  async (req, res) => {
    const { tenantId, callerId } = req.params;
    if (!UUID_RE.test(tenantId) || !UUID_RE.test(callerId)) {
      return res.status(400).json({ error: 'Invalid tenantId or callerId' });
    }

    let caller: VerifiedCallerId | null;
    try {
      caller = await getCallerId(tenantId, callerId);
    } catch (err) {
      logger.error('Failed to load verified caller for alert re-issue', {
        tenantId,
        callerId,
        adminUserId: req.user?.userId,
        error: String(err),
      });
      return res.status(500).json({ error: 'Failed to load verified caller' });
    }

    if (!caller) {
      return res.status(404).json({ error: 'Verified caller not found' });
    }

    // Operators can only re-issue alerts for rows that are actually in
    // an alertable state. `healthy` / `unknown` / `null` would dispatch
    // a misleading "your number is expiring" email to a tenant whose
    // number is fine.
    const alertableStatuses: CallerHealthStatus[] = ['expiring_soon', 'expired', 'revoked'];
    if (!caller.lastHealthStatus || !alertableStatuses.includes(caller.lastHealthStatus)) {
      return res.status(409).json({
        error:
          'Verified caller is not in an alertable state. Only expiring_soon, expired, or revoked rows can be re-issued.',
        status: caller.lastHealthStatus,
      });
    }

    let result;
    try {
      result = await dispatchVerifiedCallerAlert({
        caller,
        result: callerHealthResultFromRow(caller),
        force: true,
        source: 'admin_reissue',
        triggeredByUserId: req.user?.userId ?? null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Admin-triggered verified-caller alert dispatch threw', {
        tenantId,
        callerId,
        adminUserId: req.user?.userId,
        error: message,
      });
      return res.status(500).json({ ok: false, error: message });
    }

    try {
      await writeAuditLog({
        tenantId,
        actorUserId: req.user!.userId,
        actorRole: 'platform_admin',
        action: 'verified_caller.admin_alert_reissued',
        resourceType: 'verified_caller_id',
        resourceId: callerId,
        severity: 'info',
        changes: {
          phoneNumber: caller.phoneNumber,
          healthStatus: caller.lastHealthStatus,
          status: result.status,
          emailedRecipients: result.emailedRecipients,
        },
        ipAddress: extractIp(req),
      });
    } catch {
      // best-effort
    }

    logger.info('Admin-triggered verified-caller alert dispatched', {
      tenantId,
      callerId,
      phoneNumber: caller.phoneNumber,
      adminUserId: req.user!.userId,
      status: result.status,
      emailedRecipients: result.emailedRecipients,
    });

    let message: string;
    if (result.status === 'sent' && result.emailedRecipients > 0) {
      message = `Alert email sent to ${result.emailedRecipients} admin${result.emailedRecipients === 1 ? '' : 's'}.`;
    } else if (result.status === 'sent') {
      message = 'Alert delivered (in-app only — no admin recipients eligible for email).';
    } else if (result.status === 'no_recipients') {
      message = 'No tenant admin recipients are eligible for verified-caller emails. In-app notification was still fanned out.';
    } else {
      message = `Alert status: ${result.status}.`;
    }

    return res.json({
      ok: true,
      message,
      status: result.status,
      emailedRecipients: result.emailedRecipients,
    });
  },
);

export default router;
