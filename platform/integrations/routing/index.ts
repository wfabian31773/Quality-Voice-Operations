/**
 * High-level routing service used by the dispatcher live map and the
 * customer-facing notification template substitution. Hides provider
 * selection, per-tenant ETA caching, and graceful fallback to the
 * haversine estimator behind a single `getDriveEta` call.
 */

import { createLogger } from '../../core/logger';
import {
  GEOCODE_CACHE_TTL_MS,
  ROUTING_CACHE_TTL_MS,
  __resetRoutingCachesForTests,
  getCachedEta,
  getCachedGeocode,
  setCachedEta,
  setCachedGeocode,
} from './cache';
import {
  geocodeAddress,
  getConfiguredGeocoderProvider,
} from './geocoder';
import {
  getConfiguredRoutingProvider,
  googleEta,
  haversineEta,
  mapboxEta,
  osrmEta,
} from './providers';
import type { DriveEta, GeoPoint, RoutingProviderName } from './types';

const logger = createLogger('ROUTING');

export interface DriveEtaInputs {
  tenantId: string;
  resourceId: string;
  jobId: string;
  origin: GeoPoint;
  destination: GeoPoint;
}

export interface DriveEtaResult extends DriveEta {
  /**
   * `false` when this row was freshly computed; `true` when served
   * from the per-tenant cache without re-calling the provider.
   */
  cached: boolean;
  /**
   * `true` if we asked for a real provider (osrm/mapbox/google) and
   * fell back to haversine because the provider failed. The UI uses
   * this to show a subtle "estimate" indicator.
   */
  fallback: boolean;
}

async function callProvider(
  provider: RoutingProviderName,
  origin: GeoPoint,
  destination: GeoPoint,
): Promise<DriveEta> {
  switch (provider) {
    case 'osrm':
      return osrmEta(origin, destination);
    case 'mapbox':
      return mapboxEta(origin, destination);
    case 'google':
      return googleEta(origin, destination);
    case 'haversine':
    default:
      return haversineEta(origin, destination);
  }
}

/**
 * Compute (or fetch from cache) the driving ETA from `origin` to
 * `destination`. Always resolves; on provider failure returns a
 * haversine estimate with `fallback=true` so the dispatcher map keeps
 * working through transient routing outages.
 */
export async function getDriveEta(
  inputs: DriveEtaInputs,
): Promise<DriveEtaResult> {
  const { tenantId, resourceId, jobId, origin, destination } = inputs;

  const cached = getCachedEta(tenantId, resourceId, jobId);
  if (cached) {
    return { ...cached, cached: true, fallback: false };
  }

  const preferred = getConfiguredRoutingProvider();
  let result: DriveEta;
  let fallback = false;

  try {
    result = await callProvider(preferred, origin, destination);
  } catch (err) {
    logger.warn('Routing provider failed, falling back to haversine', {
      provider: preferred,
      error: String(err),
    });
    result = haversineEta(origin, destination);
    fallback = preferred !== 'haversine';
  }

  setCachedEta(tenantId, resourceId, jobId, result);
  return { ...result, cached: false, fallback };
}

/**
 * Cached geocode lookup. Returns `null` for addresses that resolve to
 * no result (cached negatively to avoid retrying on every poll).
 */
export async function geocodeAddressCached(
  tenantId: string,
  address: string,
): Promise<GeoPoint | null> {
  const trimmed = address.trim();
  if (!trimmed) return null;
  const hit = getCachedGeocode(tenantId, trimmed);
  if (hit !== undefined) return hit;
  try {
    const provider = getConfiguredGeocoderProvider();
    const result = await geocodeAddress(trimmed, provider);
    setCachedGeocode(tenantId, trimmed, result);
    return result;
  } catch (err) {
    logger.warn('Geocoder failed', { tenantId, address: trimmed, error: String(err) });
    // Negatively cache so we don't hammer the provider on every poll
    // when it's down. The 60-second poll cadence + 24h geocode TTL
    // means a one-time outage delays geocoding by at most a day.
    setCachedGeocode(tenantId, trimmed, null);
    return null;
  }
}

export {
  ROUTING_CACHE_TTL_MS,
  GEOCODE_CACHE_TTL_MS,
  __resetRoutingCachesForTests,
};
export {
  getConfiguredRoutingProvider,
  haversineEta,
  haversineMeters,
} from './providers';
export { getConfiguredGeocoderProvider } from './geocoder';
export { defaultRpsFor } from './rateLimits';
export {
  enqueueJobGeocode,
  __resetJobGeocodeQueueForTests,
  __setJobGeocodeQueueOverridesForTests,
  __waitForJobGeocodeQueueIdleForTests,
} from './jobGeocodeQueue';
export type { JobGeocodeQueueOverrides } from './jobGeocodeQueue';
export type { DriveEta, GeoPoint, RoutingProviderName } from './types';
