/**
 * Coverage for the `languageBreakdown` field added to getCallAnalytics()
 * by migration 082.
 *
 * The aggregation must:
 *   - group calls by COALESCE(cs.language, a.language) so legacy rows fall
 *     back to the agent's currently configured language
 *   - emit `null` (not the string "null") for rows where neither the
 *     snapshot nor the agent has a language, so the dashboard can render
 *     them as "Unknown" instead of silently misattributing them
 *   - return one entry per language code, with the per-language call count
 *
 * The DB query is mocked so the test can exercise the post-processing
 * logic in isolation without standing up Postgres.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const queryMock = vi.fn();
const releaseMock = vi.fn();
const connectMock = vi.fn(async () => ({
  query: queryMock,
  release: releaseMock,
}));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({ connect: connectMock, query: queryMock }),
  withTenantContext: vi.fn(
    async (
      _client: unknown,
      _tenantId: string,
      fn: () => Promise<void>,
    ) => fn(),
  ),
  withPrivilegedClient: vi.fn(),
}));

beforeEach(() => {
  queryMock.mockReset();
  releaseMock.mockReset();
  connectMock.mockClear();
});

interface Call {
  sql: string;
  values: unknown[];
}

function calls(): Call[] {
  return queryMock.mock.calls.map((c) => ({
    sql: String(c[0]),
    values: (c[1] as unknown[]) ?? [],
  }));
}

describe('getCallAnalytics — languageBreakdown', () => {
  it('aggregates a mix of populated and null language rows correctly', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) {
        return { rows: [] };
      }
      if (s.includes('set_config')) return { rows: [] };

      // Summary aggregate (totals + state breakdown)
      if (s.includes('COUNT(*) FILTER (WHERE direction =')) {
        return {
          rows: [
            {
              total_calls: 10,
              inbound_calls: 8,
              outbound_calls: 2,
              avg_duration: 42.5,
              completed_calls: 9,
              failed_calls: 1,
              escalated_calls: 0,
              total_cost_cents: 1234,
            },
          ],
        };
      }

      // Daily breakdown
      if (s.includes('GROUP BY DATE(created_at)')) {
        return {
          rows: [
            {
              day: '2026-04-29',
              calls: 10,
              avg_duration: 42.5,
              inbound: 8,
              outbound: 2,
            },
          ],
        };
      }

      // Language breakdown — exercises the COALESCE(cs.language, a.language)
      // group-by. Three buckets: snapshot-populated ('es'), legacy fallback
      // ('en' came from a.language because cs.language was NULL), and
      // truly-unknown (NULL bucket because neither side had a value).
      if (s.includes('COALESCE(cs.language, a.language)')) {
        return {
          rows: [
            { language: 'es', calls: 5 },
            { language: 'en', calls: 3 },
            { language: null, calls: 2 },
          ],
        };
      }

      return { rows: [] };
    });

    const { getCallAnalytics } = await import(
      '../../platform/analytics/AnalyticsService'
    );

    const from = new Date('2026-04-01T00:00:00Z');
    const to = new Date('2026-05-01T00:00:00Z');

    const result = await getCallAnalytics('tenant-A', from, to);

    expect(result.totalCalls).toBe(10);
    expect(result.languageBreakdown).toEqual([
      { language: 'es', calls: 5 },
      { language: 'en', calls: 3 },
      { language: null, calls: 2 },
    ]);

    // Sanity-check the SQL itself: a regression that drops the COALESCE
    // expression would silently distort the breakdown for legacy rows.
    const langCall = calls().find((c) =>
      c.sql.includes('COALESCE(cs.language, a.language)'),
    );
    expect(langCall, 'expected a SELECT that aggregates by COALESCE(cs.language, a.language)').toBeTruthy();
    expect(langCall!.sql).toMatch(/LEFT JOIN agents a/i);
    expect(langCall!.sql).toMatch(
      /GROUP BY\s+COALESCE\s*\(\s*cs\.language\s*,\s*a\.language\s*\)/i,
    );
  });

  it('returns an empty languageBreakdown when no calls fall in the window', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) {
        return { rows: [] };
      }
      if (s.includes('set_config')) return { rows: [] };
      if (s.includes('COUNT(*) FILTER (WHERE direction =')) {
        return {
          rows: [
            {
              total_calls: 0,
              inbound_calls: 0,
              outbound_calls: 0,
              avg_duration: 0,
              completed_calls: 0,
              failed_calls: 0,
              escalated_calls: 0,
              total_cost_cents: 0,
            },
          ],
        };
      }
      return { rows: [] };
    });

    const { getCallAnalytics } = await import(
      '../../platform/analytics/AnalyticsService'
    );

    const result = await getCallAnalytics(
      'tenant-A',
      new Date('2026-04-01T00:00:00Z'),
      new Date('2026-05-01T00:00:00Z'),
    );

    expect(result.totalCalls).toBe(0);
    expect(result.languageBreakdown).toEqual([]);
  });

  it('coerces empty/whitespace language strings to null so the UI can show "Unknown"', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const s = String(sql);
      if (s.startsWith('BEGIN') || s.startsWith('COMMIT') || s.startsWith('ROLLBACK')) {
        return { rows: [] };
      }
      if (s.includes('set_config')) return { rows: [] };
      if (s.includes('COUNT(*) FILTER (WHERE direction =')) {
        return {
          rows: [
            {
              total_calls: 4,
              inbound_calls: 4,
              outbound_calls: 0,
              avg_duration: 0,
              completed_calls: 4,
              failed_calls: 0,
              escalated_calls: 0,
              total_cost_cents: 0,
            },
          ],
        };
      }
      if (s.includes('GROUP BY DATE(created_at)')) {
        return { rows: [] };
      }
      if (s.includes('COALESCE(cs.language, a.language)')) {
        return {
          rows: [
            { language: '   ', calls: 2 },
            { language: '', calls: 1 },
            { language: 'de', calls: 1 },
          ],
        };
      }
      return { rows: [] };
    });

    const { getCallAnalytics } = await import(
      '../../platform/analytics/AnalyticsService'
    );

    const result = await getCallAnalytics(
      'tenant-A',
      new Date('2026-04-01T00:00:00Z'),
      new Date('2026-05-01T00:00:00Z'),
    );

    // Both blank-string buckets normalise to null; the real language
    // bucket survives unchanged. Order matches the SQL's ORDER BY calls DESC.
    expect(result.languageBreakdown).toEqual([
      { language: null, calls: 2 },
      { language: null, calls: 1 },
      { language: 'de', calls: 1 },
    ]);
  });
});
