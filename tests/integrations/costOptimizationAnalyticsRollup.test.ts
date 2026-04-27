// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression test for BL-023 — analytics rollups that read from
 * `conversation_costs` (the cost-optimization dashboard) must keep
 * everything in integer cents end-to-end. A 100× regression in either
 * direction (cents treated as dollars OR cents divided by 100) would
 * fail this test.
 *
 * Companion to `tests/integrations/costAnalyticsRollup.test.ts`, which
 * covers the `usage_metrics` rollup path.
 */

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

describe('getCostOptimizationAnalytics — cents stay cents (BL-023 regression)', () => {
  it('preserves integer cents across summary, daily, tier, and monthly rollups', async () => {
    fakeClient.query.mockImplementation(async (sql: string) => {
      const lower = String(sql).toLowerCase().trim();
      if (lower.startsWith('begin') || lower.startsWith('commit') || lower.startsWith('rollback')) {
        return rowsResult([]);
      }
      if (lower.startsWith('select set_config')) {
        return rowsResult([]);
      }

      // Summary rollup — three conversations, $1.50 / $2.50 / $3.00 totals.
      if (lower.includes('count(*)::int as total_conversations')) {
        return rowsResult([
          {
            total_conversations: 3,
            total_cost_cents: 700,
            avg_cost_cents: 233,
            total_stt: 90,
            total_llm: 510,
            total_tts: 70,
            total_infra: 30,
            total_tokens_saved: 1200,
            total_cache_hits: 4,
            total_cache_misses: 6,
          },
        ]);
      }
      // Daily breakdown.
      if (lower.includes('group by date(created_at)')) {
        return rowsResult([
          { date: '2026-04-20', total_cost_cents: 400, conversation_count: 2, avg_cost_cents: 200, cache_hits: 3 },
          { date: '2026-04-21', total_cost_cents: 300, conversation_count: 1, avg_cost_cents: 300, cache_hits: 1 },
        ]);
      }
      // Tier distribution.
      if (lower.includes('group by model_tier')) {
        return rowsResult([
          { tier: 'standard', count: 2, avg_cost_cents: 250 },
          { tier: 'economy', count: 1, avg_cost_cents: 200 },
        ]);
      }
      // Monthly trend.
      if (lower.includes("to_char(created_at, 'yyyy-mm')")) {
        return rowsResult([
          { month: '2026-04', total_cost_cents: 700, conversation_count: 3 },
        ]);
      }
      return rowsResult([]);
    });

    const { getCostOptimizationAnalytics } = await import(
      '../../platform/billing/cost/CostAnalyticsService'
    );

    const result = await getCostOptimizationAnalytics(
      'tenant-1',
      new Date('2026-04-20T00:00:00Z'),
      new Date('2026-04-22T00:00:00Z'),
    );

    // Summary stays in cents.
    expect(result.totalConversations).toBe(3);
    expect(result.totalCostCents).toBe(700);          // $7.00
    expect(result.avgCostPerConversationCents).toBe(233); // $2.33
    expect(result.totalSttCostCents).toBe(90);
    expect(result.totalLlmCostCents).toBe(510);
    expect(result.totalTtsCostCents).toBe(70);
    expect(result.totalInfraCostCents).toBe(30);

    // No 100× either direction.
    expect(result.totalCostCents).not.toBe(70000);
    expect(result.totalCostCents).not.toBe(7);

    // Daily breakdown sums to the summary total.
    const dailySum = result.dailyBreakdown.reduce((s, d) => s + d.totalCostCents, 0);
    expect(dailySum).toBe(result.totalCostCents);
    expect(result.dailyBreakdown).toEqual([
      { date: '2026-04-20', totalCostCents: 400, conversationCount: 2, avgCostCents: 200, cacheHits: 3 },
      { date: '2026-04-21', totalCostCents: 300, conversationCount: 1, avgCostCents: 300, cacheHits: 1 },
    ]);

    // Monthly trend stays in cents and lines up with the summary for April.
    expect(result.monthlyCostTrend).toEqual([
      { month: '2026-04', totalCostCents: 700, conversationCount: 3 },
    ]);

    // Tier distribution preserves cents in avgCostCents and the percentages
    // are integer percents (not cents — would catch a unit confusion).
    expect(result.tierDistribution).toEqual([
      { tier: 'standard', count: 2, percentage: 67, avgCostCents: 250 },
      { tier: 'economy', count: 1, percentage: 33, avgCostCents: 200 },
    ]);

    // Savings breakdown is also denominated in cents (cacheSavings = hits * avg).
    expect(result.savingsBreakdown.cacheSavingsCents).toBe(4 * 233);
    expect(result.savingsBreakdown.routingSavingsCents).toBe(1 * Math.max(0, 233 - 200)); // premium fallback to summary avg
    expect(result.savingsBreakdown.totalSavingsCents).toBe(
      result.savingsBreakdown.cacheSavingsCents +
        result.savingsBreakdown.routingSavingsCents +
        result.savingsBreakdown.compressionSavingsCents,
    );

    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  it('returns zeros (not NaN, not 100x) when there are no conversations', async () => {
    fakeClient.query.mockImplementation(async (sql: string) => {
      const lower = String(sql).toLowerCase().trim();
      if (lower.startsWith('begin') || lower.startsWith('commit') || lower.startsWith('rollback')) {
        return rowsResult([]);
      }
      if (lower.includes('count(*)::int as total_conversations')) {
        return rowsResult([
          {
            total_conversations: 0,
            total_cost_cents: 0,
            avg_cost_cents: 0,
            total_stt: 0,
            total_llm: 0,
            total_tts: 0,
            total_infra: 0,
            total_tokens_saved: 0,
            total_cache_hits: 0,
            total_cache_misses: 0,
          },
        ]);
      }
      return rowsResult([]);
    });

    const { getCostOptimizationAnalytics } = await import(
      '../../platform/billing/cost/CostAnalyticsService'
    );

    const result = await getCostOptimizationAnalytics(
      'tenant-1',
      new Date('2026-04-20T00:00:00Z'),
      new Date('2026-04-22T00:00:00Z'),
    );

    expect(result.totalConversations).toBe(0);
    expect(result.totalCostCents).toBe(0);
    expect(result.avgCostPerConversationCents).toBe(0);
    expect(result.cacheHitRate).toBe(0);
    expect(result.dailyBreakdown).toEqual([]);
    expect(result.tierDistribution).toEqual([]);
    expect(result.monthlyCostTrend).toEqual([]);
    expect(result.savingsBreakdown.totalSavingsCents).toBe(0);
  });
});
