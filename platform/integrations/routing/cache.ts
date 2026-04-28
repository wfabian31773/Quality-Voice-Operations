/**
 * Per-tenant in-memory TTL cache for driving ETAs and geocoded
 * coordinates. The dispatcher live map polls every ~15s and may have
 * dozens of resources reporting at once — without caching we'd rebuild
 * the same Mapbox/Google/OSRM request for every poll.
 *
 * The cache is intentionally process-local: the live-map endpoint is
 * served by a small number of Node processes, dispatcher polling is
 * bursty in 15-second windows, and 60-second cache hits within those
 * bursts give us roughly an order-of-magnitude reduction in upstream
 * calls. A distributed cache (Redis) would be marginal at this scale and
 * would hide a routing-provider outage behind a stale layer.
 */

import type { DriveEta, GeoPoint } from './types';

interface CacheEntry<T> {
  value: T;
  expiresAtMs: number;
}

const ETA_TTL_MS = 60_000;
const GEOCODE_TTL_MS = 24 * 60 * 60 * 1000;

const etaCache = new Map<string, CacheEntry<DriveEta>>();
const geocodeCache = new Map<string, CacheEntry<GeoPoint | null>>();

function etaKey(tenantId: string, resourceId: string, jobId: string): string {
  return `${tenantId}::${resourceId}::${jobId}`;
}

function geocodeKey(tenantId: string, address: string): string {
  return `${tenantId}::${address.trim().toLowerCase()}`;
}

export function getCachedEta(
  tenantId: string,
  resourceId: string,
  jobId: string,
  nowMs: number = Date.now(),
): DriveEta | null {
  const entry = etaCache.get(etaKey(tenantId, resourceId, jobId));
  if (!entry) return null;
  if (entry.expiresAtMs <= nowMs) {
    etaCache.delete(etaKey(tenantId, resourceId, jobId));
    return null;
  }
  return entry.value;
}

export function setCachedEta(
  tenantId: string,
  resourceId: string,
  jobId: string,
  value: DriveEta,
  ttlMs: number = ETA_TTL_MS,
  nowMs: number = Date.now(),
): void {
  etaCache.set(etaKey(tenantId, resourceId, jobId), {
    value,
    expiresAtMs: nowMs + ttlMs,
  });
}

export function getCachedGeocode(
  tenantId: string,
  address: string,
  nowMs: number = Date.now(),
): GeoPoint | null | undefined {
  const entry = geocodeCache.get(geocodeKey(tenantId, address));
  if (!entry) return undefined;
  if (entry.expiresAtMs <= nowMs) {
    geocodeCache.delete(geocodeKey(tenantId, address));
    return undefined;
  }
  return entry.value;
}

export function setCachedGeocode(
  tenantId: string,
  address: string,
  value: GeoPoint | null,
  ttlMs: number = GEOCODE_TTL_MS,
  nowMs: number = Date.now(),
): void {
  geocodeCache.set(geocodeKey(tenantId, address), {
    value,
    expiresAtMs: nowMs + ttlMs,
  });
}

/** Test-only — wipes both caches between tests. */
export function __resetRoutingCachesForTests(): void {
  etaCache.clear();
  geocodeCache.clear();
}

export const ROUTING_CACHE_TTL_MS = ETA_TTL_MS;
export const GEOCODE_CACHE_TTL_MS = GEOCODE_TTL_MS;
