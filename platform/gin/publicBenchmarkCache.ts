/**
 * Cache helpers for the assembled public GIN benchmark snapshot.
 *
 * Lives in `platform/gin/` (not in the route file) so both the public
 * benchmark route AND the GIN scheduler can talk to the same cache key
 * without creating a layering violation (platform/ -> server/).
 */

import { createLogger } from '../core/logger';
import { getCacheClient } from '../infra/cache';

const logger = createLogger('GIN_PUBLIC_CACHE');

export interface PublicBenchmarkRow {
  vertical: string;
  metric: string;
  cohortAvg: string;
  median: string;
  topQuartile: string;
  cohortSize: number;
}

export interface PublicBenchmarkPayload {
  status: 'live' | 'preview' | 'illustrative';
  snapshotAt: string | null;
  kAnonymity: number;
  refreshCadence: string;
  source: string;
  rows: PublicBenchmarkRow[];
}

export const PUBLIC_BENCHMARK_CACHE_KEY = 'gin:public:benchmarks:v1';
// ~15 minutes — fresh data lands at most once per GIN aggregation cycle, and
// the scheduler busts this key after a successful run anyway.
export const PUBLIC_BENCHMARK_CACHE_TTL_SECONDS = 15 * 60;

export async function readCachedPublicBenchmark(): Promise<PublicBenchmarkPayload | null> {
  try {
    const cache = await getCacheClient();
    return await cache.getJson<PublicBenchmarkPayload>(PUBLIC_BENCHMARK_CACHE_KEY);
  } catch (err) {
    logger.warn('Cache read failed, falling through to DB', { error: String(err) });
    return null;
  }
}

export async function writeCachedPublicBenchmark(payload: PublicBenchmarkPayload): Promise<void> {
  try {
    const cache = await getCacheClient();
    await cache.setJson(PUBLIC_BENCHMARK_CACHE_KEY, payload, PUBLIC_BENCHMARK_CACHE_TTL_SECONDS);
  } catch (err) {
    logger.warn('Cache write failed', { error: String(err) });
  }
}

/**
 * Invalidate the cached public benchmark snapshot. Called by the GIN
 * scheduler after a successful aggregation cycle so the marketing page
 * picks up new data on the next request instead of waiting for TTL.
 */
export async function invalidatePublicBenchmarkCache(): Promise<void> {
  try {
    const cache = await getCacheClient();
    await cache.del(PUBLIC_BENCHMARK_CACHE_KEY);
    logger.info('Public GIN benchmark cache invalidated');
  } catch (err) {
    logger.warn('Failed to invalidate public benchmark cache', { error: String(err) });
  }
}
