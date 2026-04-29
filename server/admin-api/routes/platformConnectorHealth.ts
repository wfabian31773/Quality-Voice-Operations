import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';
import { withPrivilegedClient } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';
import {
  ensureFreshOAuthToken,
  isRefreshableProvider,
  getConnectorConfig,
  listConnectorTokenHealth,
} from '../../../platform/integrations/connectors';
import { getRefreshableProviders } from '../../../platform/integrations/connectors/tokenRefresh';
import { dispatchConnectorAuthAlert } from '../../../platform/integrations/connectors/ConnectorAuthAlertScheduler';
import { writeAuditLog, extractIp } from '../../../platform/audit/AuditService';
import type { ConnectorType } from '../../../platform/integrations/connectors/types';

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

type TokenHealthStatus = 'healthy' | 'expiring' | 'expired' | 'needs_reconnect' | 'unknown';

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

// Mirror the scheduler's check interval so the UI can render
// "X cycles since refresh" using the same yardstick the worker uses.
// Kept locally (vs. exported from the scheduler) to avoid pulling the
// scheduler module — and its setInterval side effects — into the route.
const REFRESH_CYCLE_INTERVAL_MS = 15 * 60 * 1000;
// Window inside which we treat a still-valid token as "expiring soon" for
// the green/yellow/red badge. Matches the scheduler's refresh horizon.
const TOKEN_EXPIRING_HORIZON_MS = 24 * 60 * 60 * 1000;
// Number of sweep cycles past expiry before we badge a connector as
// "stale" (worker keeps failing). 2 cycles ≈ 30min of missed refreshes.
const STALE_CYCLE_THRESHOLD = 2;
// Default window for the proactive "Expiring soon" triage bucket. Wider
// than the per-row badge horizon so ops can plan reconnect work a couple of
// days ahead instead of only after the worker has failed. Caller can
// override via `?expiringWithinHours=` (1h..7d).
const DEFAULT_EXPIRING_SOON_HOURS = 48;
const MIN_EXPIRING_SOON_HOURS = 1;
const MAX_EXPIRING_SOON_HOURS = 24 * 7;

function computeTokenHealthStatus(
  lastSyncStatus: string | null,
  expiresInMs: number | null,
): TokenHealthStatus {
  if (lastSyncStatus === 'needs_reconnect') return 'needs_reconnect';
  if (expiresInMs === null) return 'unknown';
  if (expiresInMs <= 0) return 'expired';
  if (expiresInMs <= TOKEN_EXPIRING_HORIZON_MS) return 'expiring';
  return 'healthy';
}

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
        const expiresInMs = s.tokenExpiresAt !== null ? s.tokenExpiresAt - now : null;
        const status = computeTokenHealthStatus(s.lastSyncStatus, expiresInMs);

        // "Cycles since refresh" prefers the worker's view (when did we
        // last successfully mint a token), falling back to "how long has
        // this token been expired" so we can still flag wedged connectors
        // that never had an issued_at recorded.
        let cyclesSinceRefresh: number | null = null;
        if (s.tokenIssuedAt !== null) {
          const ageMs = now - s.tokenIssuedAt;
          cyclesSinceRefresh = Math.max(0, Math.floor(ageMs / REFRESH_CYCLE_INTERVAL_MS));
        } else if (expiresInMs !== null && expiresInMs < 0) {
          cyclesSinceRefresh = Math.floor(-expiresInMs / REFRESH_CYCLE_INTERVAL_MS);
        }

        // Stale = the worker should have rotated this token by now but
        // hasn't. Captures both "expired & untouched" and
        // "needs_reconnect & nothing has happened since".
        let stale = false;
        if (status === 'needs_reconnect') {
          if (s.lastSyncErrorAt) {
            const errAgeMs = now - Date.parse(s.lastSyncErrorAt);
            if (
              Number.isFinite(errAgeMs)
              && errAgeMs >= STALE_CYCLE_THRESHOLD * REFRESH_CYCLE_INTERVAL_MS
            ) {
              stale = true;
            }
          }
        } else if (status === 'expired') {
          if (expiresInMs !== null && -expiresInMs >= STALE_CYCLE_THRESHOLD * REFRESH_CYCLE_INTERVAL_MS) {
            stale = true;
          }
        }

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
          status,
          expiresInMs,
          cyclesSinceRefresh,
          stale,
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
      window: { sinceDays, eventsLimit, expiringWithinHours },
    });
  } catch (err) {
    logger.error('Failed to query connector health', { error: String(err) });
    return res.status(500).json({ error: 'Failed to query connector health' });
  }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export default router;
