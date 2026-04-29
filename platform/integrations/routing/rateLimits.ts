/**
 * Shared per-provider rate-limit defaults for the geocoder.
 *
 * Both the one-shot backfill (`scripts/backfill-dispatch-job-geocodes.ts`)
 * and the write-path queue (`jobGeocodeQueue`) consult these so the
 * write path "respects the same DISPATCH_GEOCODE_PROVIDER rate limits
 * the backfill honors" — keeping the two surfaces from accidentally
 * drifting apart and tripping a provider quota.
 *
 * These match each provider's published free-tier policy, NOT a paid
 * contract — operators with a higher quota should override per-surface
 * (the backfill exposes `--rps=` and `DISPATCH_GEOCODE_BACKFILL_RPS`).
 *   - nominatim: 1 req/sec absolute max (OSM usage policy)
 *   - mapbox:    600 req/min on the free tier → 10 req/sec; we leave
 *                a little headroom and default to 5 req/sec
 *   - google:    50 req/sec hard limit on the Geocoding API; we
 *                default to 10 req/sec to stay polite and predictable
 *   - none:      irrelevant (no requests issued, value just satisfies
 *                callers that compute `1000 / rps`)
 */

import type { GeocoderProviderName } from './types';

export function defaultRpsFor(provider: GeocoderProviderName): number {
  switch (provider) {
    case 'mapbox':
      return 5;
    case 'google':
      return 10;
    case 'none':
      return 1;
    case 'nominatim':
    default:
      return 1;
  }
}
