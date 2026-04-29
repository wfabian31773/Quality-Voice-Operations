/**
 * In-process geocode queue for the dispatch_jobs write path.
 *
 * Why: the lazy geocode block on the live-map ETA path and the
 * route-replay endpoint pays a one-time provider round-trip the first
 * time anyone reads a freshly created (or freshly edited) job. The
 * `scripts/backfill-dispatch-job-geocodes.ts` one-shot covers the
 * historical backlog but does nothing for jobs created *after* it ran.
 *
 * This queue closes the gap by hooking the create/update endpoints:
 * when a job is inserted with a non-empty `address`, or its address
 * column changes, we enqueue a geocode that resolves and persists the
 * `address_lat` / `address_lon` columns out-of-band — usually well
 * before the first dispatcher ever opens the live map for that row.
 *
 * Design choices:
 *   - **Fire-and-forget.** Callers never await the geocode; the
 *     create/update endpoint returns the row immediately. Even if the
 *     provider is slow or down, the user-facing latency is unchanged.
 *   - **Single in-process worker.** A small Map of pending jobs is
 *     drained by a single async loop so we never issue more than one
 *     concurrent provider request. This makes rate-limiting trivial
 *     and matches the backfill's serial execution model.
 *   - **Per-provider rate limit.** The minimum interval between
 *     provider calls is derived from {@link defaultRpsFor}, which
 *     mirrors the same env-driven defaults the backfill honors
 *     (Nominatim 1 rps, Mapbox 5 rps, Google 10 rps).
 *   - **Address dedup.** {@link geocodeAddressCached} already coalesces
 *     same-address lookups via its 24h in-memory cache, so two enqueues
 *     for the same address resolve to a single provider call.
 *   - **Latest-wins per job.** If a job is edited twice in quick
 *     succession (e.g. address typo correction), the pending entry is
 *     overwritten so the worker only runs the geocode for the latest
 *     address — never persisting stale coords.
 *   - **Concurrent-edit safe.** The persist UPDATE re-checks
 *     `address = $address` so an unrelated edit between SELECT and
 *     UPDATE is never clobbered with stale coords.
 *   - **Provider=none short-circuit.** When DISPATCH_GEOCODE_PROVIDER
 *     is `none`, enqueueing is a no-op so deployments that opt out of
 *     geocoding aren't surprised by background work.
 */

import type { Pool } from 'pg';
import { createLogger } from '../../core/logger';
import { geocodeAddressCached } from './index';
import { getConfiguredGeocoderProvider } from './geocoder';
import { defaultRpsFor } from './rateLimits';
import type { GeoPoint, GeocoderProviderName } from './types';

const logger = createLogger('JOB_GEOCODE_QUEUE');

interface PendingEntry {
  tenantId: string;
  address: string;
}

const pending = new Map<string, PendingEntry>();
let workerActive = false;
let workerCompletion: Promise<void> | null = null;
let lastCallAtMs = 0;

export interface JobGeocodeQueueOverrides {
  /** Geocoder lookup. Defaults to {@link geocodeAddressCached}. */
  geocode?: (tenantId: string, address: string) => Promise<GeoPoint | null>;
  /** Persist hook. Defaults to an UPDATE on `dispatch_jobs`. */
  persist?: (
    pool: Pool,
    tenantId: string,
    jobId: string,
    address: string,
    point: GeoPoint,
  ) => Promise<void>;
  /** Sleep helper (rate-limit pacing). Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Force a specific min-interval between provider calls. Defaults to
   * `1000 / defaultRpsFor(provider)`. Tests pass `0` to skip pacing.
   */
  minIntervalMs?: number | null;
  /**
   * Force a specific provider for the no-op short-circuit. Defaults
   * to {@link getConfiguredGeocoderProvider}. Used by tests that want
   * to bypass the env var.
   */
  providerOverride?: GeocoderProviderName | null;
}

let overrides: JobGeocodeQueueOverrides = {};

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultPersist(
  pool: Pool,
  tenantId: string,
  jobId: string,
  address: string,
  point: GeoPoint,
): Promise<void> {
  // Re-check `btrim(address) = $3` so a concurrent address edit between
  // the geocode and the persist doesn't get clobbered with stale
  // coords. The lazy-geocode readers already check
  // `address_geocoded_for === address` and treat a mismatch as
  // "needs geocoding", so dropping the write here is safe — the next
  // enqueue (or read) will catch up.
  //
  // We compare the *trimmed* stored address against our trimmed
  // parameter so a row whose `address` column was inserted with
  // leading/trailing whitespace still matches — without it the persist
  // would silently miss those rows and they'd quietly fall back to the
  // lazy geocode path, defeating the whole point of the write-path
  // hook for the whitespace edge case.
  await pool.query(
    `UPDATE dispatch_jobs
        SET address_lat = $1,
            address_lon = $2,
            address_geocoded_at = NOW(),
            address_geocoded_for = $3
      WHERE id = $4
        AND tenant_id = $5
        AND btrim(address) = $3`,
    [point.lat, point.lon, address, jobId, tenantId],
  );
}

function resolveProvider(): GeocoderProviderName {
  return overrides.providerOverride ?? getConfiguredGeocoderProvider();
}

function resolveMinInterval(provider: GeocoderProviderName): number {
  if (overrides.minIntervalMs != null) return overrides.minIntervalMs;
  const rps = defaultRpsFor(provider);
  if (!Number.isFinite(rps) || rps <= 0) return 1000;
  return Math.ceil(1000 / rps);
}

/**
 * Enqueue a background geocode for a dispatch_jobs row. Safe to call
 * synchronously from a write-path request handler — it never throws,
 * never awaits a provider call, and always returns immediately.
 *
 * Callers should pass the *trimmed-or-raw* address as stored on the
 * row; the queue trims internally and persists with the trimmed
 * value so the `address_geocoded_for` cache key matches the lazy
 * readers' equality check.
 */
export function enqueueJobGeocode(
  pool: Pool,
  tenantId: string,
  jobId: string,
  address: string,
): void {
  if (!tenantId || !jobId) return;
  const trimmed = String(address ?? '').trim();
  if (!trimmed) return;
  if (resolveProvider() === 'none') return;
  pending.set(jobId, { tenantId, address: trimmed });
  startWorker(pool);
}

function startWorker(pool: Pool): void {
  if (workerActive) return;
  workerActive = true;
  workerCompletion = (async () => {
    try {
      const geocode = overrides.geocode ?? geocodeAddressCached;
      const persist = overrides.persist ?? defaultPersist;
      const sleep = overrides.sleep ?? realSleep;
      const provider = resolveProvider();
      const minIntervalMs = resolveMinInterval(provider);

      while (pending.size > 0) {
        // Pull the oldest entry first (insertion order) so a burst of
        // creates is processed FIFO.
        const iter = pending.entries().next();
        if (iter.done) break;
        const [jobId, entry] = iter.value;
        pending.delete(jobId);

        if (minIntervalMs > 0) {
          const wait = lastCallAtMs + minIntervalMs - Date.now();
          if (wait > 0) await sleep(wait);
        }

        let point: GeoPoint | null = null;
        try {
          lastCallAtMs = Date.now();
          point = await geocode(entry.tenantId, entry.address);
        } catch (err) {
          logger.warn('Geocode failed for write-path enqueue', {
            tenantId: entry.tenantId,
            jobId,
            error: String(err),
          });
          continue;
        }

        if (!point) {
          // No-result: leave the row alone. The lazy readers will
          // re-attempt later once the provider has the address.
          continue;
        }

        try {
          await persist(pool, entry.tenantId, jobId, entry.address, point);
        } catch (err) {
          logger.warn('Persist failed for write-path geocode', {
            tenantId: entry.tenantId,
            jobId,
            error: String(err),
          });
        }
      }
    } finally {
      workerActive = false;
      workerCompletion = null;
    }
  })();
}

/**
 * Test helper — wait for the in-flight worker (if any) to finish. The
 * production write path never awaits the queue, so tests need a way
 * to assert that the persist UPDATE has run.
 */
export async function __waitForJobGeocodeQueueIdleForTests(
  timeoutMs: number = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (workerCompletion) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error('jobGeocodeQueue: idle wait timed out');
    }
    await Promise.race([
      workerCompletion,
      new Promise((resolve) => setTimeout(resolve, remaining)),
    ]);
  }
}

/** Test helper — wipe pending entries and any worker state. */
export function __resetJobGeocodeQueueForTests(): void {
  pending.clear();
  workerActive = false;
  workerCompletion = null;
  lastCallAtMs = 0;
  overrides = {};
}

/** Test helper — install per-call overrides for the next worker run. */
export function __setJobGeocodeQueueOverridesForTests(
  next: JobGeocodeQueueOverrides,
): void {
  overrides = { ...next };
}
