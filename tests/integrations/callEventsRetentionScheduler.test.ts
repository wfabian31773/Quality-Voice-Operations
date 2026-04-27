// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Unit test for BL-044 — `CallEventsRetentionScheduler` cycle wiring.
 *
 * Verifies that one cycle:
 *   1. Calls ensure_call_events_partition() once for the current month and
 *      once for the following month (both dates are first-of-month UTC).
 *   2. Calls prune_call_events_older_than() with the configured retention
 *      window and surfaces the dropped partitions.
 *   3. Records the outcome in `call_events_retention_runs` (migration 081)
 *      so the Platform Admin retention panel can show "the prune ran today"
 *      without anyone having to shell into the database.
 *
 * The actual SQL helpers are exercised end-to-end by
 * migrations/078_call_events_partition_and_usage_metrics_index.sql against
 * the dev database during `npm run db:migrate`; this test pins the JS-side
 * contract so a future refactor cannot silently change which helper the
 * scheduler invokes or which arguments it passes.
 */

interface FakePool {
  query: ReturnType<typeof vi.fn>;
}

const fakePool: FakePool = {
  query: vi.fn(),
};

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => fakePool,
}));

import { runCallEventsRetentionCycle } from '../../platform/billing/CallEventsRetentionScheduler';

beforeEach(() => {
  fakePool.query.mockReset();
});

describe('runCallEventsRetentionCycle', () => {
  it('ensures current+next month partitions, prunes with the configured window, and records the run', async () => {
    fakePool.query
      .mockResolvedValueOnce({ rows: [{ ensure_call_events_partition: 'call_events_2026_04' }] })
      .mockResolvedValueOnce({ rows: [{ ensure_call_events_partition: 'call_events_2026_05' }] })
      .mockResolvedValueOnce({
        rows: [{ prune_call_events_older_than: ['call_events_2025_01', 'call_events_2025_02'] }],
      })
      .mockResolvedValueOnce({ rows: [] }); // bookkeeping insert

    const result = await runCallEventsRetentionCycle(90);

    expect(result.ensured).toEqual(['call_events_2026_04', 'call_events_2026_05']);
    expect(result.dropped).toEqual(['call_events_2025_01', 'call_events_2025_02']);

    expect(fakePool.query).toHaveBeenCalledTimes(4);

    const [ensureCurrent, ensureNext, prune, record] = fakePool.query.mock.calls;

    expect(ensureCurrent[0]).toContain('ensure_call_events_partition');
    expect(ensureNext[0]).toContain('ensure_call_events_partition');
    expect(prune[0]).toContain('prune_call_events_older_than');
    expect(prune[1]).toEqual([90]);

    // Both ensure calls must target the first-of-month UTC.
    const ensureCurrentArg = new Date(ensureCurrent[1][0]);
    const ensureNextArg = new Date(ensureNext[1][0]);
    expect(ensureCurrentArg.getUTCDate()).toBe(1);
    expect(ensureCurrentArg.getUTCHours()).toBe(0);
    expect(ensureNextArg.getUTCDate()).toBe(1);
    expect(ensureNextArg.getUTCHours()).toBe(0);

    // The "next month" call must be exactly one calendar month after the
    // "current month" call (handles year-end rollover via Date arithmetic).
    const expectedNext = new Date(ensureCurrentArg);
    expectedNext.setUTCMonth(expectedNext.getUTCMonth() + 1);
    expect(ensureNextArg.toISOString()).toBe(expectedNext.toISOString());

    // The bookkeeping INSERT must capture the outcome so the admin panel
    // (read at GET /platform/call-events-retention) can show the most
    // recent successful cycle.
    expect(record[0]).toContain('INSERT INTO call_events_retention_runs');
    const [, status, retainDays, ensured, dropped, errorMessage] = record[1] as [
      string,
      string,
      number,
      string[],
      string[],
      string | null,
    ];
    expect(status).toBe('success');
    expect(retainDays).toBe(90);
    expect(ensured).toEqual(['call_events_2026_04', 'call_events_2026_05']);
    expect(dropped).toEqual(['call_events_2025_01', 'call_events_2025_02']);
    expect(errorMessage).toBeNull();
  });

  it('returns empty arrays when nothing was created or pruned', async () => {
    fakePool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] }); // bookkeeping insert

    const result = await runCallEventsRetentionCycle(90);

    expect(result.ensured).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it('respects a custom retention window', async () => {
    fakePool.query
      .mockResolvedValueOnce({ rows: [{ ensure_call_events_partition: 'p1' }] })
      .mockResolvedValueOnce({ rows: [{ ensure_call_events_partition: 'p2' }] })
      .mockResolvedValueOnce({ rows: [{ prune_call_events_older_than: [] }] })
      .mockResolvedValueOnce({ rows: [] }); // bookkeeping insert

    await runCallEventsRetentionCycle(30);

    expect(fakePool.query.mock.calls[2][1]).toEqual([30]);
    // The recorded retention_days argument must match the cycle's window.
    expect(fakePool.query.mock.calls[3][1]?.[2]).toBe(30);
  });

  it('records a failure row and rethrows when a helper query fails', async () => {
    const helperErr = new Error('boom');
    fakePool.query
      .mockResolvedValueOnce({ rows: [{ ensure_call_events_partition: 'p1' }] })
      .mockRejectedValueOnce(helperErr)
      .mockResolvedValueOnce({ rows: [] }); // bookkeeping insert (failure)

    await expect(runCallEventsRetentionCycle(90)).rejects.toThrow('boom');

    expect(fakePool.query).toHaveBeenCalledTimes(3);
    const lastCall = fakePool.query.mock.calls[2];
    expect(lastCall[0]).toContain('INSERT INTO call_events_retention_runs');
    const [, status, , , , errorMessage] = lastCall[1] as [
      string,
      string,
      number,
      string[],
      string[],
      string | null,
    ];
    expect(status).toBe('failure');
    expect(errorMessage).toBe('boom');
  });
});
