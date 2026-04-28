/**
 * Shared types for the routing-provider adapter that powers the
 * dispatcher live-map ETA enrichment and customer-facing notification
 * substitutions.
 */

export interface GeoPoint {
  lat: number;
  lon: number;
}

export type RoutingProviderName = 'haversine' | 'osrm' | 'mapbox' | 'google';
export type GeocoderProviderName = 'none' | 'nominatim' | 'mapbox' | 'google';

export interface DriveEta {
  /**
   * Driving duration to the destination in seconds. Always >= 0.
   */
  durationSeconds: number;
  /**
   * Driving distance in meters. May be `null` when the provider only
   * returns durations.
   */
  distanceMeters: number | null;
  /**
   * Provider that produced this estimate (for telemetry / UI badging).
   */
  provider: RoutingProviderName;
  /**
   * When this row was computed (epoch ms).
   */
  computedAtMs: number;
}

export interface RoutingError {
  provider: RoutingProviderName;
  message: string;
}
