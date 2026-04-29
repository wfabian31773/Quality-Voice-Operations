import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __test,
  getCrmRevalidationMetricsSnapshot,
  recordRevalidationCycle,
  resetCrmRevalidationMetricsForTest,
  type PerTenantBreakdown,
} from './CrmCallerIdentityRevalidationMetrics';

function emptyBreakdown(overrides: Partial<PerTenantBreakdown> = {}): PerTenantBreakdown {
  return {
    scanned: 0, validated: 0, staleScrubbed: 0, skippedNoConfig: 0, failed: 0, ...overrides,
  };
}

describe('CrmCallerIdentityRevalidationMetrics', () => {
  beforeEach(() => resetCrmRevalidationMetricsForTest());
  afterEach(() => resetCrmRevalidationMetricsForTest());

  it('starts with zeroed totals and no history', () => {
    const snap = getCrmRevalidationMetricsSnapshot();
    expect(snap.totals).toEqual({
      cyclesRun: 0, cyclesThrew: 0, scanned: 0, validated: 0,
      staleScrubbed: 0, skippedNoConfig: 0, failed: 0,
    });
    expect(snap.lastCycle).toBeNull();
    expect(snap.recentCycles).toHaveLength(0);
    expect(snap.perTenant).toHaveLength(0);
  });

  it('accumulates totals and pushes the cycle to history', () => {
    const start = 1_700_000_000_000;
    recordRevalidationCycle({
      startedAtMs: start,
      finishedAtMs: start + 250,
      result: { scanned: 5, validated: 4, staleScrubbed: 1, skippedNoConfig: 0, failed: 0 },
      perTenantDeltas: new Map([
        ['tenant-a', emptyBreakdown({ scanned: 3, validated: 3 })],
        ['tenant-b', emptyBreakdown({ scanned: 2, validated: 1, staleScrubbed: 1 })],
      ]),
      threw: false,
    });

    const snap = getCrmRevalidationMetricsSnapshot();
    expect(snap.totals.cyclesRun).toBe(1);
    expect(snap.totals.scanned).toBe(5);
    expect(snap.totals.validated).toBe(4);
    expect(snap.totals.staleScrubbed).toBe(1);
    expect(snap.lastCycle?.durationMs).toBe(250);
    expect(snap.recentCycles).toHaveLength(1);
    expect(snap.perTenant.map((t) => t.tenantId)).toEqual(['tenant-b', 'tenant-a']);
  });

  it('sorts per-tenant rows: failures first, then scrub volume, then scanned', () => {
    const now = Date.now();
    recordRevalidationCycle({
      startedAtMs: now, finishedAtMs: now,
      result: { scanned: 9, validated: 6, staleScrubbed: 2, skippedNoConfig: 0, failed: 1 },
      perTenantDeltas: new Map([
        ['quiet', emptyBreakdown({ scanned: 1, validated: 1 })],
        ['heavy-scrub', emptyBreakdown({ scanned: 4, validated: 2, staleScrubbed: 2 })],
        ['failing', emptyBreakdown({ scanned: 4, validated: 3, failed: 1 })],
      ]),
      threw: false,
    });

    const snap = getCrmRevalidationMetricsSnapshot();
    expect(snap.perTenant.map((t) => t.tenantId)).toEqual(['failing', 'heavy-scrub', 'quiet']);
  });

  it('keeps recent cycles bounded to RECENT_CYCLES_LIMIT', () => {
    for (let i = 0; i < __test.RECENT_CYCLES_LIMIT + 5; i += 1) {
      recordRevalidationCycle({
        startedAtMs: 1_000 + i,
        finishedAtMs: 1_000 + i,
        result: { scanned: 1, validated: 1, staleScrubbed: 0, skippedNoConfig: 0, failed: 0 },
        perTenantDeltas: new Map(),
        threw: false,
      });
    }
    const snap = getCrmRevalidationMetricsSnapshot();
    expect(snap.recentCycles).toHaveLength(__test.RECENT_CYCLES_LIMIT);
    expect(snap.totals.cyclesRun).toBe(__test.RECENT_CYCLES_LIMIT + 5);
  });

  it('counts thrown cycles separately', () => {
    recordRevalidationCycle({
      startedAtMs: 0, finishedAtMs: 100,
      result: { scanned: 0, validated: 0, staleScrubbed: 0, skippedNoConfig: 0, failed: 0 },
      perTenantDeltas: new Map(),
      threw: true,
    });
    const snap = getCrmRevalidationMetricsSnapshot();
    expect(snap.totals.cyclesRun).toBe(1);
    expect(snap.totals.cyclesThrew).toBe(1);
    expect(snap.lastCycle?.threw).toBe(true);
  });

  it('evicts least-recently-touched tenants past PER_TENANT_LIMIT', () => {
    const limit = __test.PER_TENANT_LIMIT;
    // Seed limit+5 distinct tenants in a single cycle. They all share the
    // same finishedAt, so eviction order falls back to insertion order
    // (Map iteration).
    const deltas = new Map<string, PerTenantBreakdown>();
    for (let i = 0; i < limit + 5; i += 1) {
      deltas.set(`tenant-${i.toString().padStart(4, '0')}`, emptyBreakdown({ scanned: 1, validated: 1 }));
    }
    recordRevalidationCycle({
      startedAtMs: 0, finishedAtMs: 0,
      result: { scanned: limit + 5, validated: limit + 5, staleScrubbed: 0, skippedNoConfig: 0, failed: 0 },
      perTenantDeltas: deltas,
      threw: false,
    });
    const snap = getCrmRevalidationMetricsSnapshot();
    expect(snap.perTenant.length).toBe(limit);
    expect(snap.perTenantTracked).toBe(limit);
  });

  it('clamps negative durations to zero', () => {
    recordRevalidationCycle({
      startedAtMs: 1_000, finishedAtMs: 500,
      result: { scanned: 0, validated: 0, staleScrubbed: 0, skippedNoConfig: 0, failed: 0 },
      perTenantDeltas: new Map(),
      threw: false,
    });
    expect(getCrmRevalidationMetricsSnapshot().lastCycle?.durationMs).toBe(0);
  });
});
