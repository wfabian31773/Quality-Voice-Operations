import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';
import { withPrivilegedClient } from '../../../platform/db';
import { createLogger } from '../../../platform/core/logger';

const router = Router();
const logger = createLogger('PLATFORM_PUSH_HEALTH');

const DEFAULT_WINDOW_DAYS = 7;
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 30;

const DEFAULT_RECENT_LIMIT = 50;
const MAX_RECENT_LIMIT = 200;

const PER_TENANT_LIMIT = 100;

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const parsed = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? '0'), 10);
  return Number.isFinite(n) ? n : 0;
}

interface PerTenantRow {
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  attempts: number;
  attempted: number;
  accepted: number;
  retired: number;
  dropped: number;
  failureCount: number;
  lastAttemptAt: string | null;
}

interface RecentFailureRow {
  id: string;
  tenantId: string;
  tenantName: string | null;
  tenantSlug: string | null;
  event: string | null;
  attempted: number;
  accepted: number;
  retired: number;
  dropped: number;
  failureReason: string | null;
  occurredAt: string;
}

interface PushHealthResponse {
  windowDays: number;
  generatedAt: string;
  totals: {
    attempts: number;
    attempted: number;
    accepted: number;
    retired: number;
    dropped: number;
    failureCount: number;
    affectedTenants: number;
  };
  perTenant: PerTenantRow[];
  perTenantTracked: number;
  perTenantLimit: number;
  recentFailures: RecentFailureRow[];
  recentFailuresLimit: number;
}

/**
 * Push delivery health snapshot.
 *
 * Aggregates rows from `push_delivery_attempts` (written by
 * `platform/notifications/PushDispatcher.ts` on every fan-out) so platform
 * operators can see at-a-glance whether a tenant's push pipeline is healthy
 * — total attempts, how many Expo accepted, how many devices were retired,
 * how many were dropped on the floor, and recent failures with the coarse
 * failure reason.
 */
router.get(
  '/platform/push-health',
  requireAuth,
  requirePlatformAdmin,
  async (req, res) => {
    const windowDays = clampInt(
      req.query.windowDays,
      DEFAULT_WINDOW_DAYS,
      MIN_WINDOW_DAYS,
      MAX_WINDOW_DAYS,
    );
    const recentLimit = clampInt(
      req.query.recentLimit,
      DEFAULT_RECENT_LIMIT,
      1,
      MAX_RECENT_LIMIT,
    );

    try {
      const result = await withPrivilegedClient(async (client) => {
        const { rows: totalsRows } = await client.query(
          `SELECT
              COUNT(*)::bigint AS attempts,
              COALESCE(SUM(attempted), 0)::bigint AS attempted,
              COALESCE(SUM(accepted), 0)::bigint AS accepted,
              COALESCE(SUM(retired), 0)::bigint AS retired,
              COALESCE(SUM(dropped), 0)::bigint AS dropped,
              COUNT(*) FILTER (
                WHERE failure_reason IS NOT NULL OR dropped > 0
              )::bigint AS failure_count,
              COUNT(DISTINCT tenant_id)::bigint AS affected_tenants
             FROM push_delivery_attempts
            WHERE created_at >= NOW() - ($1::int || ' days')::interval`,
          [windowDays],
        );

        const { rows: perTenantRows } = await client.query(
          `SELECT
              p.tenant_id,
              t.name AS tenant_name,
              t.slug AS tenant_slug,
              COUNT(*)::bigint AS attempts,
              COALESCE(SUM(p.attempted), 0)::bigint AS attempted,
              COALESCE(SUM(p.accepted), 0)::bigint AS accepted,
              COALESCE(SUM(p.retired), 0)::bigint AS retired,
              COALESCE(SUM(p.dropped), 0)::bigint AS dropped,
              COUNT(*) FILTER (
                WHERE p.failure_reason IS NOT NULL OR p.dropped > 0
              )::bigint AS failure_count,
              MAX(p.created_at) AS last_attempt_at
             FROM push_delivery_attempts p
             LEFT JOIN tenants t ON t.id = p.tenant_id
            WHERE p.created_at >= NOW() - ($1::int || ' days')::interval
            GROUP BY p.tenant_id, t.name, t.slug
            ORDER BY
              -- Worst offenders first: most dropped + retired, then most
              -- recent attempt as a tiebreaker.
              (COALESCE(SUM(p.dropped), 0) + COALESCE(SUM(p.retired), 0)) DESC,
              MAX(p.created_at) DESC
            LIMIT $2`,
          [windowDays, PER_TENANT_LIMIT],
        );

        const { rows: recentFailureRows } = await client.query(
          `SELECT
              p.id, p.tenant_id, p.event,
              p.attempted, p.accepted, p.retired, p.dropped,
              p.failure_reason, p.created_at,
              t.name AS tenant_name, t.slug AS tenant_slug
             FROM push_delivery_attempts p
             LEFT JOIN tenants t ON t.id = p.tenant_id
            WHERE p.created_at >= NOW() - ($1::int || ' days')::interval
              AND (p.failure_reason IS NOT NULL OR p.dropped > 0)
            ORDER BY p.created_at DESC
            LIMIT $2`,
          [windowDays, recentLimit],
        );

        return { totalsRows, perTenantRows, recentFailureRows };
      });

      const totalsRow = result.totalsRows[0] ?? {};
      const totals = {
        attempts: num(totalsRow.attempts),
        attempted: num(totalsRow.attempted),
        accepted: num(totalsRow.accepted),
        retired: num(totalsRow.retired),
        dropped: num(totalsRow.dropped),
        failureCount: num(totalsRow.failure_count),
        affectedTenants: num(totalsRow.affected_tenants),
      };

      const perTenant: PerTenantRow[] = result.perTenantRows.map((r) => ({
        tenantId: r.tenant_id as string,
        tenantName: (r.tenant_name as string) ?? null,
        tenantSlug: (r.tenant_slug as string) ?? null,
        attempts: num(r.attempts),
        attempted: num(r.attempted),
        accepted: num(r.accepted),
        retired: num(r.retired),
        dropped: num(r.dropped),
        failureCount: num(r.failure_count),
        lastAttemptAt: r.last_attempt_at
          ? new Date(r.last_attempt_at as string).toISOString()
          : null,
      }));

      const recentFailures: RecentFailureRow[] = result.recentFailureRows.map((r) => ({
        id: String(r.id),
        tenantId: r.tenant_id as string,
        tenantName: (r.tenant_name as string) ?? null,
        tenantSlug: (r.tenant_slug as string) ?? null,
        event: (r.event as string) ?? null,
        attempted: num(r.attempted),
        accepted: num(r.accepted),
        retired: num(r.retired),
        dropped: num(r.dropped),
        failureReason: (r.failure_reason as string) ?? null,
        occurredAt: new Date(r.created_at as string).toISOString(),
      }));

      const response: PushHealthResponse = {
        windowDays,
        generatedAt: new Date().toISOString(),
        totals,
        perTenant,
        perTenantTracked: perTenant.length,
        perTenantLimit: PER_TENANT_LIMIT,
        recentFailures,
        recentFailuresLimit: recentLimit,
      };

      res.json(response);
    } catch (err) {
      logger.error('Failed to load platform push delivery health', {
        error: String(err),
      });
      res.status(500).json({ error: 'Failed to load push delivery health' });
    }
  },
);

export default router;
