/**
 * Periodic background sweeper that deletes expired route-export archives
 * from object storage and clears the corresponding bookkeeping columns
 * on `dispatch_route_export_jobs` (migration 090).
 *
 * Each async route export uploads a ZIP into the private object bucket
 * with a 7-day download window (`download_expires_at`). The download
 * handler in `server/admin-api/routes/dispatch.ts` already refuses to
 * serve archives past that window, but the underlying object lingers in
 * the bucket forever — quietly accumulating storage cost and a copy of
 * customer GPS data far past its useful life. This scheduler closes
 * that gap by:
 *
 *   1. Selecting rows where `download_expires_at < NOW()` that still
 *      have an `archive_object_path`.
 *   2. Deleting the matching object via the privileged storage client
 *      (the same path the download handler uses).
 *   3. Clearing `archive_object_path`, `download_token`, and
 *      `archive_bytes` on the row so the cleanup is idempotent on a
 *      retry.
 *   4. Writing one `audit_logs` row per cleanup so the deletion is
 *      traceable per-tenant.
 *
 * The job is tenant-agnostic: it scans across every tenant in a single
 * pass under `withPrivilegedClient` (RLS off) so a privileged background
 * cleanup never has to switch session context per row.
 */

import { createLogger } from '../core/logger';
import { withPrivilegedClient } from '../db';
import { writeAuditLog } from '../audit/AuditService';
import { ObjectStorageService } from '../../server/replit_integrations/object_storage';

const logger = createLogger('ROUTE_EXPORT_ARCHIVE_CLEANUP');

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1h
const INITIAL_DELAY_MS = 2 * 60 * 1000;     // wait 2 min after boot
const DEFAULT_BATCH_LIMIT = 100;

export interface RouteExportArchiveCleanupResult {
  scanned: number;
  deleted: number;
  alreadyGone: number;
  failed: number;
}

interface ExpiredExportRow {
  id: string;
  tenant_id: string;
  archive_object_path: string;
  archive_filename: string | null;
  download_expires_at: string | Date | null;
}

/**
 * Run a single cleanup cycle. Exposed for tests and for the admin-API
 * boot loop. Errors deleting an individual archive are logged and
 * counted but do not abort the cycle — so one badly-permissioned row
 * never blocks the others from being swept.
 */
export async function runRouteExportArchiveCleanupCycle(
  options: {
    batchLimit?: number;
    storage?: Pick<ObjectStorageService, 'deletePrivateObject'>;
  } = {},
): Promise<RouteExportArchiveCleanupResult> {
  const limit = Math.max(1, options.batchLimit ?? DEFAULT_BATCH_LIMIT);
  const storage = options.storage ?? new ObjectStorageService();

  const result: RouteExportArchiveCleanupResult = {
    scanned: 0,
    deleted: 0,
    alreadyGone: 0,
    failed: 0,
  };

  let expired: ExpiredExportRow[];
  try {
    expired = await withPrivilegedClient(async (client) => {
      const { rows } = await client.query(
        `SELECT id, tenant_id, archive_object_path, archive_filename,
                download_expires_at
           FROM dispatch_route_export_jobs
          WHERE archive_object_path IS NOT NULL
            AND download_expires_at IS NOT NULL
            AND download_expires_at < NOW()
          ORDER BY download_expires_at
          LIMIT $1`,
        [limit],
      );
      return rows as unknown as ExpiredExportRow[];
    });
  } catch (err) {
    logger.error('Failed to read expired route export archives', {
      error: String(err),
    });
    return result;
  }

  result.scanned = expired.length;
  if (expired.length === 0) return result;

  for (const row of expired) {
    try {
      // Delete the object first. If we cleared the row before deleting
      // and then the storage call failed, we'd leak the path forever
      // (the next cycle wouldn't see it). Do storage → DB so a partial
      // failure simply re-runs next cycle and converges to clean.
      const deleted = await storage.deletePrivateObject(row.archive_object_path);
      if (deleted) result.deleted += 1;
      else result.alreadyGone += 1;

      await withPrivilegedClient(async (client) => {
        await client.query(
          `UPDATE dispatch_route_export_jobs
              SET archive_object_path = NULL,
                  download_token      = NULL,
                  archive_bytes       = NULL
            WHERE id = $1`,
          [row.id],
        );
      });

      // Best-effort audit so a missing audit_logs row never blocks the
      // primary cleanup work. Each row's tenant gets its own audit
      // entry so per-tenant compliance review can see the deletion.
      await writeAuditLog({
        tenantId: row.tenant_id,
        actorUserId: 'system',
        actorRole: 'system',
        action: 'dispatch.route_export.archive_purged',
        resourceType: 'dispatch_route_export_job',
        resourceId: row.id,
        severity: 'info',
        changes: {
          archive_object_path: row.archive_object_path,
          archive_filename: row.archive_filename ?? null,
          download_expires_at: row.download_expires_at
            ? new Date(row.download_expires_at as string | Date).toISOString()
            : null,
          object_already_gone: !deleted,
          source: 'scheduled_sweep',
        },
      }).catch((auditErr) => {
        logger.warn('Failed to write audit entry for route export archive purge', {
          exportJobId: row.id,
          tenantId: row.tenant_id,
          error: String(auditErr),
        });
      });
    } catch (err) {
      result.failed += 1;
      logger.error('Failed to clean up expired route export archive', {
        exportJobId: row.id,
        tenantId: row.tenant_id,
        archiveObjectPath: row.archive_object_path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (result.deleted > 0 || result.alreadyGone > 0 || result.failed > 0) {
    logger.info('Route export archive cleanup cycle complete', {
      scanned: result.scanned,
      deleted: result.deleted,
      alreadyGone: result.alreadyGone,
      failed: result.failed,
    });
  }

  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

export function startRouteExportArchiveCleanupScheduler(
  intervalMs: number = DEFAULT_INTERVAL_MS,
): void {
  if (timer) return;

  initialTimer = setTimeout(() => {
    runRouteExportArchiveCleanupCycle().catch((err) => {
      logger.error('Initial route export archive cleanup cycle failed', {
        error: String(err),
      });
    });
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    runRouteExportArchiveCleanupCycle().catch((err) => {
      logger.error('Route export archive cleanup cycle failed', {
        error: String(err),
      });
    });
  }, intervalMs);

  logger.info('Route export archive cleanup scheduler started', { intervalMs });
}

export function stopRouteExportArchiveCleanupScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Route export archive cleanup scheduler stopped');
  }
}

export const ROUTE_EXPORT_ARCHIVE_CLEANUP_DEFAULTS = {
  intervalMs: DEFAULT_INTERVAL_MS,
  batchLimit: DEFAULT_BATCH_LIMIT,
} as const;
