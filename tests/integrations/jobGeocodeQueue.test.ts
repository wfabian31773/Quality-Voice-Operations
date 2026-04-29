/**
 * Behavior tests for the write-path geocode queue
 * (`platform/integrations/routing/jobGeocodeQueue`).
 *
 * The queue is a fire-and-forget hook called from the dispatch job
 * create/update/follow-up endpoints so freshly written rows land with
 * cached `address_lat`/`address_lon` populated. These tests pin the
 * non-trivial parts of that contract:
 *
 *   1. enqueue is a no-op for empty addresses, falsy job/tenant, and
 *      when DISPATCH_GEOCODE_PROVIDER=none.
 *   2. enqueue returns synchronously (no await on the provider) yet
 *      eventually persists via UPDATE on dispatch_jobs.
 *   3. The persist UPDATE re-checks `address = $address` so a
 *      concurrent edit between SELECT and UPDATE is never clobbered.
 *   4. A geocode that returns null (no_result) leaves the row alone
 *      rather than nulling out a previously-cached coord.
 *   5. Two enqueues for the same job collapse to the latest address
 *      (latest-wins) so a typo correction never persists stale coords.
 *   6. A burst of enqueues respects the configured rate limit
 *      (`defaultRpsFor`) — i.e. min-interval pacing applied between
 *      provider calls, mirroring the backfill's behavior.
 *   7. A geocode failure (provider throws) does not stop the worker
 *      from draining the rest of the pending queue.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetJobGeocodeQueueForTests,
  __setJobGeocodeQueueOverridesForTests,
  __waitForJobGeocodeQueueIdleForTests,
  enqueueJobGeocode,
} from '../../platform/integrations/routing/jobGeocodeQueue';

interface QueryCall {
  sql: string;
  params: unknown[];
}

function makePool(impl: (call: QueryCall) => unknown = () => ({ rowCount: 1 })) {
  const calls: QueryCall[] = [];
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    const call = { sql, params };
    calls.push(call);
    return impl(call) ?? { rowCount: 1 };
  });
  // The queue only uses `pool.query`; cast through unknown for the
  // narrow surface the production helper consumes.
  return { pool: { query } as unknown as Parameters<typeof enqueueJobGeocode>[0], calls, query };
}

beforeEach(() => {
  __resetJobGeocodeQueueForTests();
  delete process.env.DISPATCH_GEOCODE_PROVIDER;
});

afterEach(() => {
  __resetJobGeocodeQueueForTests();
  delete process.env.DISPATCH_GEOCODE_PROVIDER;
});

describe('enqueueJobGeocode no-op short-circuits', () => {
  it('does not call the provider for empty addresses', async () => {
    const geocode = vi.fn(async () => ({ lat: 1, lon: 2 }));
    __setJobGeocodeQueueOverridesForTests({ geocode, minIntervalMs: 0 });

    const { pool, query } = makePool();
    enqueueJobGeocode(pool, 'tenant-A', 'job-1', '   ');
    enqueueJobGeocode(pool, 'tenant-A', 'job-1', '');
    enqueueJobGeocode(pool, 'tenant-A', 'job-1', null as unknown as string);
    enqueueJobGeocode(pool, 'tenant-A', 'job-1', undefined as unknown as string);

    await __waitForJobGeocodeQueueIdleForTests(50);
    expect(geocode).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('does not call the provider when tenantId or jobId is missing', async () => {
    const geocode = vi.fn(async () => ({ lat: 1, lon: 2 }));
    __setJobGeocodeQueueOverridesForTests({ geocode, minIntervalMs: 0 });

    const { pool, query } = makePool();
    enqueueJobGeocode(pool, '', 'job-1', '500 Folsom St');
    enqueueJobGeocode(pool, 'tenant-A', '', '500 Folsom St');

    await __waitForJobGeocodeQueueIdleForTests(50);
    expect(geocode).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it('does nothing when DISPATCH_GEOCODE_PROVIDER=none (or override="none")', async () => {
    const geocode = vi.fn(async () => ({ lat: 1, lon: 2 }));
    __setJobGeocodeQueueOverridesForTests({
      geocode,
      minIntervalMs: 0,
      providerOverride: 'none',
    });

    const { pool, query } = makePool();
    enqueueJobGeocode(pool, 'tenant-A', 'job-1', '500 Folsom St');

    await __waitForJobGeocodeQueueIdleForTests(50);
    expect(geocode).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});

describe('enqueueJobGeocode persistence', () => {
  it('returns synchronously and eventually UPDATEs dispatch_jobs with the trimmed address', async () => {
    const geocode = vi.fn(async () => ({ lat: 37.7749, lon: -122.4194 }));
    __setJobGeocodeQueueOverridesForTests({
      geocode,
      minIntervalMs: 0,
      providerOverride: 'nominatim',
    });

    const { pool, calls } = makePool();

    const before = Date.now();
    enqueueJobGeocode(pool, 'tenant-A', 'job-1', '  500 Folsom St, SF  ');
    const elapsed = Date.now() - before;
    // Synchronous return: even with a slow geocode, enqueue returns
    // basically instantly. 50ms is generous for any CI flake.
    expect(elapsed).toBeLessThan(50);

    await __waitForJobGeocodeQueueIdleForTests();

    expect(geocode).toHaveBeenCalledWith('tenant-A', '500 Folsom St, SF');
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/UPDATE dispatch_jobs/);
    expect(calls[0].params).toEqual([
      37.7749,
      -122.4194,
      '500 Folsom St, SF',
      'job-1',
      'tenant-A',
    ]);
  });

  it('persist UPDATE re-checks btrim(address) = $3 (concurrent-edit safe + whitespace-tolerant)', async () => {
    __setJobGeocodeQueueOverridesForTests({
      geocode: async () => ({ lat: 1, lon: 2 }),
      minIntervalMs: 0,
      providerOverride: 'nominatim',
    });

    const { pool, calls } = makePool();
    enqueueJobGeocode(pool, 'tenant-A', 'job-1', '500 Folsom St');
    await __waitForJobGeocodeQueueIdleForTests();

    const sql = calls[0].sql;
    // The WHERE must constrain by id, tenant_id, AND the *trimmed*
    // address we geocoded against — so (a) a racing UPDATE that
    // changes `address` before our persist runs leaves the row
    // untouched, and (b) rows whose stored `address` happens to have
    // leading/trailing whitespace still match (we trim the parameter
    // ourselves on enqueue).
    expect(sql).toMatch(/WHERE\s+id\s*=\s*\$4/);
    expect(sql).toMatch(/AND\s+tenant_id\s*=\s*\$5/);
    expect(sql).toMatch(/AND\s+btrim\(address\)\s*=\s*\$3/);
  });

  it('skips the UPDATE entirely when the geocode returns null', async () => {
    const geocode = vi.fn(async () => null);
    __setJobGeocodeQueueOverridesForTests({
      geocode,
      minIntervalMs: 0,
      providerOverride: 'nominatim',
    });

    const { pool, query } = makePool();
    enqueueJobGeocode(pool, 'tenant-A', 'job-1', 'no such place');
    await __waitForJobGeocodeQueueIdleForTests();

    expect(geocode).toHaveBeenCalledTimes(1);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('enqueueJobGeocode batching semantics', () => {
  it('latest-wins: two enqueues for the same job collapse to the second address', async () => {
    let resolveFirstCall: (() => void) | null = null;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstCall = resolve;
    });
    let releaseFirstCall: (() => void) | null = null;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirstCall = resolve;
    });

    const calledWith: string[] = [];
    let callIndex = 0;
    __setJobGeocodeQueueOverridesForTests({
      geocode: async (_tenantId, address) => {
        calledWith.push(address);
        callIndex += 1;
        if (callIndex === 1) {
          resolveFirstCall?.();
          await firstHeld;
        }
        return { lat: 0, lon: 0 };
      },
      minIntervalMs: 0,
      providerOverride: 'nominatim',
    });

    const { pool } = makePool();
    // First enqueue starts the worker and the geocode hangs on
    // `firstHeld` so the worker is *inside* the first iteration.
    enqueueJobGeocode(pool, 'tenant-A', 'job-1', 'old address');
    await firstStarted;
    // Now overwrite with a corrected address — Map.set replaces.
    enqueueJobGeocode(pool, 'tenant-A', 'job-1', 'corrected address');
    enqueueJobGeocode(pool, 'tenant-A', 'job-1', 'final address');
    // Release the in-flight geocode so the worker drains.
    releaseFirstCall?.();
    await __waitForJobGeocodeQueueIdleForTests();

    // We expect the first call to have used 'old address' (already
    // in-flight when we overwrote), then a single follow-up that uses
    // 'final address' — never 'corrected address'.
    expect(calledWith).toEqual(['old address', 'final address']);
  });

  it('honors min-interval rate limit between consecutive geocode calls', async () => {
    const geocodeTimes: number[] = [];
    let now = 1_000_000;
    const sleep = vi.fn(async (ms: number) => {
      now += ms;
    });
    __setJobGeocodeQueueOverridesForTests({
      geocode: async () => {
        geocodeTimes.push(now);
        // Bump simulated clock so successive calls aren't all at the
        // same instant.
        now += 1;
        return { lat: 0, lon: 0 };
      },
      sleep,
      minIntervalMs: 1000,
      providerOverride: 'nominatim',
    });

    // Patch Date.now into our virtual clock for the duration of this test.
    const realNow = Date.now;
    Date.now = () => now;

    try {
      const { pool } = makePool();
      enqueueJobGeocode(pool, 'tenant-A', 'job-1', 'addr 1');
      enqueueJobGeocode(pool, 'tenant-A', 'job-2', 'addr 2');
      enqueueJobGeocode(pool, 'tenant-A', 'job-3', 'addr 3');
      await __waitForJobGeocodeQueueIdleForTests();
    } finally {
      Date.now = realNow;
    }

    // First call: no wait (lastCallAt=0 in fresh queue means delta is
    // negative). Second + third must be at least 1000ms apart from the
    // previous call. Sleep should have been called for the gaps.
    expect(geocodeTimes.length).toBe(3);
    expect(geocodeTimes[1] - geocodeTimes[0]).toBeGreaterThanOrEqual(1000);
    expect(geocodeTimes[2] - geocodeTimes[1]).toBeGreaterThanOrEqual(1000);
    expect(sleep).toHaveBeenCalled();
  });
});

describe('enqueueJobGeocode error handling', () => {
  it('keeps draining when a single geocode call throws', async () => {
    const seen: string[] = [];
    __setJobGeocodeQueueOverridesForTests({
      geocode: async (_tenantId, address) => {
        seen.push(address);
        if (address === 'boom') throw new Error('provider down');
        return { lat: 1, lon: 2 };
      },
      minIntervalMs: 0,
      providerOverride: 'nominatim',
    });

    const { pool, calls } = makePool();
    enqueueJobGeocode(pool, 'tenant-A', 'job-1', 'addr-A');
    enqueueJobGeocode(pool, 'tenant-A', 'job-2', 'boom');
    enqueueJobGeocode(pool, 'tenant-A', 'job-3', 'addr-B');
    await __waitForJobGeocodeQueueIdleForTests();

    expect(seen).toEqual(['addr-A', 'boom', 'addr-B']);
    // Two persists (the failing 'boom' is skipped).
    expect(calls).toHaveLength(2);
    expect(calls[0].params[3]).toBe('job-1');
    expect(calls[1].params[3]).toBe('job-3');
  });

  it('keeps draining when the persist UPDATE throws', async () => {
    __setJobGeocodeQueueOverridesForTests({
      geocode: async () => ({ lat: 1, lon: 2 }),
      minIntervalMs: 0,
      providerOverride: 'nominatim',
    });

    let i = 0;
    const { pool, query } = makePool(() => {
      i += 1;
      if (i === 1) throw new Error('db gone');
      return { rowCount: 1 };
    });
    enqueueJobGeocode(pool, 'tenant-A', 'job-1', 'addr-A');
    enqueueJobGeocode(pool, 'tenant-A', 'job-2', 'addr-B');
    await __waitForJobGeocodeQueueIdleForTests();

    expect(query).toHaveBeenCalledTimes(2);
  });
});
