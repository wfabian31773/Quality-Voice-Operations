import type { CrmCallerIdentityRevalidationCycleResult } from './CrmCallerIdentityRevalidationScheduler';

/**
 * In-process metrics aggregator for the CRM caller-identity revalidation
 * sweep. The scheduler emits structured logs for every cycle, but those
 * are easy to lose in the firehose. This module keeps a tight, bounded,
 * operator-facing snapshot so the Platform Admin Connector Health view
 * can render scanned / validated / staleScrubbed / failed numbers without
 * an admin needing to grep logs.
 *
 * State is intentionally process-local (the sweep is a singleton inside
 * the admin-api process) and reset across restarts. If we ever shard the
 * scheduler to multiple workers we will need to pull this into Redis or
 * a Prometheus counter; for now the single-process model is fine.
 */

const RECENT_CYCLES_LIMIT = 50;
const PER_TENANT_LIMIT = 200;

export interface PerTenantBreakdown {
  scanned: number;
  validated: number;
  staleScrubbed: number;
  skippedNoConfig: number;
  failed: number;
}

export interface CycleHistoryEntry {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  scanned: number;
  validated: number;
  staleScrubbed: number;
  skippedNoConfig: number;
  failed: number;
  /** True when the cycle threw before completing (counters may be partial). */
  threw: boolean;
}

export interface PerTenantSnapshot extends PerTenantBreakdown {
  tenantId: string;
  lastTouchedAt: string;
}

export interface CrmRevalidationMetricsSnapshot {
  startedAt: string;
  totals: {
    cyclesRun: number;
    cyclesThrew: number;
    scanned: number;
    validated: number;
    staleScrubbed: number;
    skippedNoConfig: number;
    failed: number;
  };
  lastCycle: CycleHistoryEntry | null;
  recentCycles: CycleHistoryEntry[];
  perTenant: PerTenantSnapshot[];
  perTenantTracked: number;
  perTenantLimit: number;
}

interface PerTenantState extends PerTenantBreakdown {
  lastTouchedAtMs: number;
}

const startedAtMs = Date.now();

const totals = {
  cyclesRun: 0,
  cyclesThrew: 0,
  scanned: 0,
  validated: 0,
  staleScrubbed: 0,
  skippedNoConfig: 0,
  failed: 0,
};

let lastCycle: CycleHistoryEntry | null = null;
const recentCycles: CycleHistoryEntry[] = [];
const perTenant = new Map<string, PerTenantState>();

function pushRecent(entry: CycleHistoryEntry): void {
  recentCycles.unshift(entry);
  if (recentCycles.length > RECENT_CYCLES_LIMIT) {
    recentCycles.length = RECENT_CYCLES_LIMIT;
  }
}

function evictPerTenantIfNeeded(): void {
  if (perTenant.size <= PER_TENANT_LIMIT) return;
  // Evict the least-recently-touched entries. This keeps the snapshot
  // useful (active tenants stay) while bounding memory if we are ever
  // pointed at a very wide tenant fleet.
  const sorted = [...perTenant.entries()].sort(
    (a, b) => a[1].lastTouchedAtMs - b[1].lastTouchedAtMs,
  );
  const toEvict = sorted.length - PER_TENANT_LIMIT;
  for (let i = 0; i < toEvict; i += 1) {
    perTenant.delete(sorted[i][0]);
  }
}

function ensureTenant(tenantId: string, nowMs: number): PerTenantState {
  let state = perTenant.get(tenantId);
  if (!state) {
    state = {
      scanned: 0,
      validated: 0,
      staleScrubbed: 0,
      skippedNoConfig: 0,
      failed: 0,
      lastTouchedAtMs: nowMs,
    };
    perTenant.set(tenantId, state);
  }
  return state;
}

/**
 * Record one completed (or thrown) revalidation cycle. `perTenantDeltas`
 * lets the caller pass in per-tenant breakdown collected during the run;
 * empty map is fine when no rows were processed.
 */
export function recordRevalidationCycle(params: {
  startedAtMs: number;
  finishedAtMs: number;
  result: CrmCallerIdentityRevalidationCycleResult;
  perTenantDeltas: Map<string, PerTenantBreakdown>;
  threw: boolean;
}): void {
  const { startedAtMs: startMs, finishedAtMs, result, perTenantDeltas, threw } = params;

  totals.cyclesRun += 1;
  if (threw) totals.cyclesThrew += 1;
  totals.scanned += result.scanned;
  totals.validated += result.validated;
  totals.staleScrubbed += result.staleScrubbed;
  totals.skippedNoConfig += result.skippedNoConfig;
  totals.failed += result.failed;

  const entry: CycleHistoryEntry = {
    startedAt: new Date(startMs).toISOString(),
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: Math.max(0, finishedAtMs - startMs),
    scanned: result.scanned,
    validated: result.validated,
    staleScrubbed: result.staleScrubbed,
    skippedNoConfig: result.skippedNoConfig,
    failed: result.failed,
    threw,
  };
  lastCycle = entry;
  pushRecent(entry);

  for (const [tenantId, delta] of perTenantDeltas) {
    if (!tenantId) continue;
    const state = ensureTenant(tenantId, finishedAtMs);
    state.scanned += delta.scanned;
    state.validated += delta.validated;
    state.staleScrubbed += delta.staleScrubbed;
    state.skippedNoConfig += delta.skippedNoConfig;
    state.failed += delta.failed;
    state.lastTouchedAtMs = finishedAtMs;
  }

  evictPerTenantIfNeeded();
}

/**
 * Snapshot the current metrics. Per-tenant rows are sorted so the most
 * operationally interesting tenants (repeated failures first, then
 * heaviest scrub volume) bubble to the top of the admin UI.
 */
export function getCrmRevalidationMetricsSnapshot(): CrmRevalidationMetricsSnapshot {
  const perTenantSnapshot: PerTenantSnapshot[] = [...perTenant.entries()]
    .map(([tenantId, s]) => ({
      tenantId,
      scanned: s.scanned,
      validated: s.validated,
      staleScrubbed: s.staleScrubbed,
      skippedNoConfig: s.skippedNoConfig,
      failed: s.failed,
      lastTouchedAt: new Date(s.lastTouchedAtMs).toISOString(),
    }))
    .sort((a, b) => {
      if (b.failed !== a.failed) return b.failed - a.failed;
      if (b.staleScrubbed !== a.staleScrubbed) return b.staleScrubbed - a.staleScrubbed;
      if (b.scanned !== a.scanned) return b.scanned - a.scanned;
      return a.tenantId.localeCompare(b.tenantId);
    });

  return {
    startedAt: new Date(startedAtMs).toISOString(),
    totals: { ...totals },
    lastCycle: lastCycle ? { ...lastCycle } : null,
    recentCycles: recentCycles.map((c) => ({ ...c })),
    perTenant: perTenantSnapshot,
    perTenantTracked: perTenant.size,
    perTenantLimit: PER_TENANT_LIMIT,
  };
}

/** Reset all in-memory metrics. Intended for tests. */
export function resetCrmRevalidationMetricsForTest(): void {
  totals.cyclesRun = 0;
  totals.cyclesThrew = 0;
  totals.scanned = 0;
  totals.validated = 0;
  totals.staleScrubbed = 0;
  totals.skippedNoConfig = 0;
  totals.failed = 0;
  lastCycle = null;
  recentCycles.length = 0;
  perTenant.clear();
}

export const __test = {
  RECENT_CYCLES_LIMIT,
  PER_TENANT_LIMIT,
};
