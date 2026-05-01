// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Coverage for `recomputeCostAnalytics`: drift-repair UPDATE, the
// scan/repair report, and rollback on error.

type Row = Record<string, unknown>;

interface FakeClient {
  query: ReturnType<typeof vi.fn>;
  release: () => void;
}

const releaseSpy = vi.fn();
const fakeClient: FakeClient = {
  query: vi.fn(),
  release: releaseSpy,
};

const fakePool = {
  connect: vi.fn(async () => fakeClient),
};

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => fakePool,
  withTenantContext: async (
    _c: unknown,
    _tid: string,
    fn: () => Promise<void> | void,
  ) => {
    await fn();
  },
}));

function rowsResult(rows: Row[]) {
  return { rows, rowCount: rows.length };
}

beforeEach(() => {
  fakeClient.query.mockReset();
  fakePool.connect.mockClear();
  releaseSpy.mockClear();
});

describe('recomputeCostAnalytics', () => {
  it('repairs drifting total_cost_cents rows and returns a fresh summary', async () => {
    const updateCalls: { sql: string; params: unknown[] }[] = [];

    fakeClient.query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const lower = String(sql).toLowerCase().trim();
      if (lower.startsWith('begin') || lower.startsWith('commit') || lower.startsWith('rollback')) {
        return rowsResult([]);
      }
      if (lower.startsWith('select set_config')) {
        return rowsResult([]);
      }

      if (lower.includes('count(*)::int as scanned')) {
        return rowsResult([{ scanned: 7 }]);
      }

      if (lower.startsWith('update conversation_costs')) {
        updateCalls.push({ sql, params: params ?? [] });
        return rowsResult([
          { id: 'cc-1' },
          { id: 'cc-2' },
          { id: 'cc-3' },
        ]);
      }

      // Read-side aggregation that runs after the repair.
      if (lower.includes('count(*)::int as total_conversations')) {
        return rowsResult([
          {
            total_conversations: 7,
            total_cost_cents: 2100,
            avg_cost_cents: 300,
            total_stt: 400,
            total_llm: 1200,
            total_tts: 350,
            total_infra: 150,
            total_tokens_saved: 800,
            total_cache_hits: 5,
            total_cache_misses: 2,
          },
        ]);
      }
      if (lower.includes('group by date(created_at)')) {
        return rowsResult([
          { date: '2026-04-20', total_cost_cents: 1100, conversation_count: 4, avg_cost_cents: 275, cache_hits: 3 },
          { date: '2026-04-21', total_cost_cents: 1000, conversation_count: 3, avg_cost_cents: 333, cache_hits: 2 },
        ]);
      }
      if (lower.includes('group by model_tier')) {
        return rowsResult([
          { tier: 'standard', count: 5, avg_cost_cents: 320 },
          { tier: 'economy', count: 2, avg_cost_cents: 200 },
        ]);
      }
      if (lower.includes("to_char(created_at, 'yyyy-mm')")) {
        return rowsResult([
          { month: '2026-04', total_cost_cents: 2100, conversation_count: 7 },
        ]);
      }
      return rowsResult([]);
    });

    const { recomputeCostAnalytics } = await import(
      '../../platform/billing/cost/CostAnalyticsService'
    );

    const result = await recomputeCostAnalytics(
      'tenant-1',
      new Date('2026-04-20T00:00:00Z'),
      new Date('2026-04-22T00:00:00Z'),
    );

    // Recompute report.
    expect(result.tenantId).toBe('tenant-1');
    expect(result.from).toBe('2026-04-20T00:00:00.000Z');
    expect(result.to).toBe('2026-04-22T00:00:00.000Z');
    expect(result.rowsScanned).toBe(7);
    expect(result.rowsRepaired).toBe(3);
    expect(typeof result.durationMs).toBe('number');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof result.recomputedAt).toBe('string');
    expect(() => new Date(result.recomputedAt)).not.toThrow();

    // The repair query rewrites total_cost_cents from its components,
    // limited to drifting rows in the requested window — pin that.
    expect(updateCalls).toHaveLength(1);
    const update = updateCalls[0];
    expect(update.sql).toMatch(/UPDATE\s+conversation_costs/i);
    expect(update.sql).toMatch(/total_cost_cents\s*=\s*stt_cost_cents/i);
    expect(update.sql).toMatch(/total_cost_cents\s*<>\s*\(/i);
    expect(update.params[0]).toBe('tenant-1');
    expect(update.params[1]).toBe('2026-04-20T00:00:00.000Z');
    expect(update.params[2]).toBe('2026-04-22T00:00:00.000Z');

    // Embedded analytics summary must match the GET shape end-to-end.
    expect(result.summary.totalConversations).toBe(7);
    expect(result.summary.totalCostCents).toBe(2100);
    expect(result.summary.avgCostPerConversationCents).toBe(300);
    expect(result.summary.dailyBreakdown).toHaveLength(2);
    expect(result.summary.tierDistribution).toEqual([
      { tier: 'standard', count: 5, percentage: 71, avgCostCents: 320 },
      { tier: 'economy', count: 2, percentage: 29, avgCostCents: 200 },
    ]);
    expect(result.summary.monthlyCostTrend).toEqual([
      { month: '2026-04', totalCostCents: 2100, conversationCount: 7 },
    ]);

    // Two pool connections: one for the repair transaction, one for
    // the read aggregation that runs in its own tenant-scoped session.
    expect(fakePool.connect).toHaveBeenCalledTimes(2);
    expect(releaseSpy).toHaveBeenCalledTimes(2);
  });

  it('reports zero repairs when no rows have drifted', async () => {
    fakeClient.query.mockImplementation(async (sql: string) => {
      const lower = String(sql).toLowerCase().trim();
      if (lower.startsWith('begin') || lower.startsWith('commit') || lower.startsWith('rollback')) {
        return rowsResult([]);
      }
      if (lower.startsWith('select set_config')) {
        return rowsResult([]);
      }
      if (lower.includes('count(*)::int as scanned')) {
        return rowsResult([{ scanned: 4 }]);
      }
      if (lower.startsWith('update conversation_costs')) {
        return rowsResult([]);
      }
      if (lower.includes('count(*)::int as total_conversations')) {
        return rowsResult([
          {
            total_conversations: 4,
            total_cost_cents: 800,
            avg_cost_cents: 200,
            total_stt: 100,
            total_llm: 500,
            total_tts: 150,
            total_infra: 50,
            total_tokens_saved: 0,
            total_cache_hits: 0,
            total_cache_misses: 0,
          },
        ]);
      }
      return rowsResult([]);
    });

    const { recomputeCostAnalytics } = await import(
      '../../platform/billing/cost/CostAnalyticsService'
    );

    const result = await recomputeCostAnalytics(
      'tenant-2',
      new Date('2026-04-20T00:00:00Z'),
      new Date('2026-04-22T00:00:00Z'),
    );

    expect(result.rowsScanned).toBe(4);
    expect(result.rowsRepaired).toBe(0);
    expect(result.summary.totalConversations).toBe(4);
    expect(result.summary.totalCostCents).toBe(800);
    expect(result.summary.cacheHitRate).toBe(0);
  });

  it('rolls back the repair transaction on failure and surfaces the error', async () => {
    fakeClient.query.mockImplementation(async (sql: string) => {
      const lower = String(sql).toLowerCase().trim();
      if (lower.startsWith('begin') || lower.startsWith('rollback')) {
        return rowsResult([]);
      }
      if (lower.startsWith('select set_config')) {
        return rowsResult([]);
      }
      if (lower.includes('count(*)::int as scanned')) {
        return rowsResult([{ scanned: 1 }]);
      }
      if (lower.startsWith('update conversation_costs')) {
        throw new Error('boom');
      }
      return rowsResult([]);
    });

    const { recomputeCostAnalytics } = await import(
      '../../platform/billing/cost/CostAnalyticsService'
    );

    await expect(
      recomputeCostAnalytics(
        'tenant-err',
        new Date('2026-04-20T00:00:00Z'),
        new Date('2026-04-22T00:00:00Z'),
      ),
    ).rejects.toThrow('boom');

    // The connection must always be released, and ROLLBACK must have
    // been called so the transaction doesn't linger.
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    const calls = fakeClient.query.mock.calls.map(([sql]) => String(sql).toLowerCase().trim());
    expect(calls.some((c) => c.startsWith('rollback'))).toBe(true);
    expect(calls.some((c) => c.startsWith('commit'))).toBe(false);
  });
});
