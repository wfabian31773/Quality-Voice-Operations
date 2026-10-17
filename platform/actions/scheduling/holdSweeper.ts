// Releases expired `held` bookings about once a minute (tools spec §1.4:
// "A sweeper also expires holds every minute"). Registered in
// platform/runtime/schedulers.ts as `scheduling-hold-sweeper`, so it follows
// SCHEDULERS_ENABLED and role gating like every other scheduler.
//
// It only moves held rows to 'cancelled' (via expireStaleHolds), which can
// never violate the 122 exclusion constraints, and every error is logged
// and swallowed: nothing here surfaces to a caller.

import { createLogger } from '../../core/logger';
import { getPrivilegedPool, withTenantClient } from '../../db';
import type { TenantTx } from '../core/types';
import { expireStaleHolds } from './holds';

export const HOLD_SWEEP_INTERVAL_MS = 60_000;
/** Most (tenant, provider, resource) groups released per tick. */
export const HOLD_SWEEP_BATCH = 500;

export interface StaleHoldGroup {
  tenantId: string;
  providerId: string | null;
  resourceId: string | null;
}

export interface HoldSweepLogger {
  info: (message: string, context?: Record<string, unknown>) => void;
  error: (message: string, context?: Record<string, unknown>) => void;
}

export interface HoldSweepDeps {
  /** Cross-tenant lookup of who has expired holds. */
  findStaleGroups: (limit: number) => Promise<StaleHoldGroup[]>;
  /** Tenant-bound (RLS) transaction for one group's release. */
  withTenantTx: <T>(tenantId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  logger: HoldSweepLogger;
}

export interface HoldSweepResult {
  skipped: boolean;
  groups: number;
  released: number;
  failed: number;
}

async function findStaleGroupsDefault(limit: number): Promise<StaleHoldGroup[]> {
  const { rows } = await getPrivilegedPool().query<{
    tenant_id: string;
    provider_id: string | null;
    resource_id: string | null;
  }>(
    `SELECT tenant_id, provider_id, resource_id
       FROM bookings
      WHERE status = 'held'
        AND hold_expires_at <= NOW()
        AND (provider_id IS NOT NULL OR resource_id IS NOT NULL)
      GROUP BY tenant_id, provider_id, resource_id
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({ tenantId: r.tenant_id, providerId: r.provider_id, resourceId: r.resource_id }));
}

let defaultLogger: HoldSweepLogger | null = null;

function defaultDeps(): HoldSweepDeps {
  defaultLogger ??= createLogger('SCHEDULING_HOLD_SWEEPER');
  return {
    findStaleGroups: findStaleGroupsDefault,
    withTenantTx: (tenantId, fn) => withTenantClient(tenantId, (client) => fn(client as TenantTx)),
    logger: defaultLogger,
  };
}

let running = false;
let timer: ReturnType<typeof setInterval> | null = null;

/** True while a sweep is mid-flight (worker shutdown waits for it). */
export function holdSweepInFlight(): boolean {
  return running;
}

/**
 * One sweep. Overlapping calls are skipped, not queued. Never throws:
 * a failed group is logged and the rest still run.
 */
export async function runHoldSweepCycle(deps: HoldSweepDeps = defaultDeps()): Promise<HoldSweepResult> {
  if (running) return { skipped: true, groups: 0, released: 0, failed: 0 };
  running = true;
  const result: HoldSweepResult = { skipped: false, groups: 0, released: 0, failed: 0 };
  try {
    const groups = await deps.findStaleGroups(HOLD_SWEEP_BATCH);
    result.groups = groups.length;
    for (const g of groups) {
      try {
        const { expiredBookingIds } = await deps.withTenantTx(g.tenantId, (tx) =>
          expireStaleHolds(tx, g.tenantId, g.providerId, { resourceId: g.resourceId }),
        );
        result.released += expiredBookingIds.length;
      } catch (err) {
        result.failed += 1;
        deps.logger.error('Failed to release expired holds', { tenantId: g.tenantId, error: String(err) });
      }
    }
    if (result.released > 0) {
      deps.logger.info('Released expired holds', { released: result.released, groups: result.groups });
    }
  } catch (err) {
    result.failed += 1;
    deps.logger.error('Hold sweep failed', { error: String(err) });
  } finally {
    running = false;
  }
  return result;
}

export function startHoldSweeper(intervalMs: number = HOLD_SWEEP_INTERVAL_MS, deps?: HoldSweepDeps): void {
  if (timer) return;
  timer = setInterval(() => {
    void runHoldSweepCycle(deps);
  }, intervalMs);
}

export function stopHoldSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
