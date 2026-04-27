// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression test for BL-023 — "Stop currency values from being off by 100x in analytics".
 *
 * The `usage_metrics` table stores `total_cost_cents` as integer cents. This test
 * mocks the platform pool so we can verify two invariants of `getCostAnalytics`:
 *   1. The function never divides cents by 100 internally — sums returned in
 *      `totalCostCents` and `dailyBreakdown[].totalCostCents` are still cents.
 *   2. The aggregated totals equal the sum of the per-day breakdown (no double
 *      conversion or off-by-100x bug).
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

describe('getCostAnalytics — cents stay cents (BL-023 regression)', () => {
  it('preserves integer cents and sums match the daily breakdown', async () => {
    // Sequence: BEGIN, set_config (from withTenantContext), ai sum, telephony sum, call counts, COMMIT.
    fakeClient.query.mockImplementation(async (sql: string) => {
      const lower = String(sql).toLowerCase().trim();
      if (lower.startsWith('begin') || lower.startsWith('commit') || lower.startsWith('rollback')) {
        return rowsResult([]);
      }
      if (lower.startsWith('select set_config')) {
        return rowsResult([]);
      }
      if (lower.includes("'ai_minutes'")) {
        return rowsResult([
          { day: '2026-04-20', cost_cents: 12345 }, // $123.45
          { day: '2026-04-21', cost_cents: 6789 }, // $67.89
        ]);
      }
      if (lower.includes("'calls_inbound'")) {
        return rowsResult([
          { day: '2026-04-20', cost_cents: 100 }, // $1.00
          { day: '2026-04-21', cost_cents: 250 }, // $2.50
        ]);
      }
      if (lower.includes('from call_sessions')) {
        return rowsResult([
          { day: '2026-04-20', calls: 4 },
          { day: '2026-04-21', calls: 6 },
        ]);
      }
      return rowsResult([]);
    });

    const { getCostAnalytics } = await import('../../platform/analytics/AnalyticsService');

    const result = await getCostAnalytics(
      'tenant-1',
      new Date('2026-04-20T00:00:00Z'),
      new Date('2026-04-22T00:00:00Z'),
    );

    // Daily breakdown is in cents, totalCostCents per day is the sum of openai+twilio cents.
    expect(result.dailyBreakdown).toEqual([
      { date: '2026-04-20', openaiCostCents: 12345, twilioCostCents: 100, totalCostCents: 12445, calls: 4 },
      { date: '2026-04-21', openaiCostCents: 6789, twilioCostCents: 250, totalCostCents: 7039, calls: 6 },
    ]);

    // Totals are exactly the per-day sums — never divided by 100, never multiplied by 100.
    const sumOpenai = result.dailyBreakdown.reduce((s, d) => s + d.openaiCostCents, 0);
    const sumTwilio = result.dailyBreakdown.reduce((s, d) => s + d.twilioCostCents, 0);
    const sumTotal = result.dailyBreakdown.reduce((s, d) => s + d.totalCostCents, 0);
    const sumCalls = result.dailyBreakdown.reduce((s, d) => s + d.calls, 0);

    expect(result.totalOpenaiCostCents).toBe(sumOpenai);
    expect(result.totalTwilioCostCents).toBe(sumTwilio);
    expect(result.totalCostCents).toBe(sumTotal);
    expect(result.totalCalls).toBe(sumCalls);

    // Specific magnitudes — would catch a 100x error in either direction.
    expect(result.totalCostCents).toBe(19484); // $194.84
    expect(result.totalCostCents).not.toBe(1948400); // would mean cents were treated as dollars
    expect(result.totalCostCents).not.toBe(194); // would mean cents were divided by 100

    // costPerCall is rounded cents.
    expect(result.costPerCallCents).toBe(Math.round(19484 / 10));

    expect(releaseSpy).toHaveBeenCalledTimes(1);
  });

  it('returns zeros when no usage metrics exist', async () => {
    fakeClient.query.mockImplementation(async (sql: string) => {
      const lower = String(sql).toLowerCase().trim();
      if (lower.startsWith('begin') || lower.startsWith('commit') || lower.startsWith('rollback')) {
        return rowsResult([]);
      }
      return rowsResult([]);
    });

    const { getCostAnalytics } = await import('../../platform/analytics/AnalyticsService');

    const result = await getCostAnalytics(
      'tenant-1',
      new Date('2026-04-20T00:00:00Z'),
      new Date('2026-04-22T00:00:00Z'),
    );

    expect(result.totalOpenaiCostCents).toBe(0);
    expect(result.totalTwilioCostCents).toBe(0);
    expect(result.totalCostCents).toBe(0);
    expect(result.totalCalls).toBe(0);
    expect(result.costPerCallCents).toBe(0);
    expect(result.dailyBreakdown).toEqual([]);
  });
});
