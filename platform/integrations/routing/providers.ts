/**
 * Routing-provider implementations. Each adapter takes an origin/dest
 * pair and returns a {@link DriveEta} or throws. The high-level
 * `routing.ts` module is responsible for caching, env-driven provider
 * selection, and falling back to the haversine estimator when the
 * preferred provider fails.
 *
 * Provider configuration:
 *   - DISPATCH_ROUTING_PROVIDER = haversine | osrm | mapbox | google
 *     (default: `haversine` — zero-dependency safe default that works
 *      out of the box and is clearly labeled as an estimate in the UI)
 *   - DISPATCH_ROUTING_OSRM_URL = base URL for an OSRM router
 *     (default: `https://router.project-osrm.org` — the OSRM project's
 *      free public instance; production tenants should host their own)
 *   - MAPBOX_ACCESS_TOKEN = mapbox token for the `mapbox` provider
 *   - GOOGLE_MAPS_API_KEY = google distance-matrix API key for the
 *     `google` provider
 */

import type { DriveEta, GeoPoint, RoutingProviderName } from './types';

// Average urban driving speed in m/s (~50 km/h) used by the haversine
// fallback. This intentionally errs slightly slow so we don't promise
// customers an arrival window we can't hit.
const HAVERSINE_AVG_SPEED_MPS = 50_000 / 3600;

// Minutes of slack added to the haversine estimate to roughly account
// for the geodesic-vs-driving gap (turn penalties, one-way streets,
// the fact that you can't drive in a straight line). Calibrated against
// random Mapbox-vs-haversine spot checks across mid-density US cities.
const HAVERSINE_DETOUR_MULTIPLIER = 1.3;

const EARTH_RADIUS_M = 6_371_000;

function toRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.lat - a.lat);
  const dLon = toRadians(b.lon - a.lon);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h =
    sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function haversineEta(origin: GeoPoint, dest: GeoPoint): DriveEta {
  const distance = haversineMeters(origin, dest);
  const seconds = (distance / HAVERSINE_AVG_SPEED_MPS) * HAVERSINE_DETOUR_MULTIPLIER;
  return {
    durationSeconds: Math.max(0, Math.round(seconds)),
    distanceMeters: Math.round(distance),
    provider: 'haversine',
    computedAtMs: Date.now(),
  };
}

interface FetchLike {
  (input: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }): Promise<{
    ok: boolean;
    status: number;
    json(): Promise<unknown>;
    text(): Promise<string>;
  }>;
}

function getFetch(): FetchLike {
  if (typeof fetch !== 'function') {
    throw new Error('global fetch is not available in this runtime');
  }
  return fetch as unknown as FetchLike;
}

function withTimeout(ms: number): { signal: AbortSignal; clear: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(t) };
}

const ROUTING_TIMEOUT_MS = 4_000;

export async function osrmEta(
  origin: GeoPoint,
  dest: GeoPoint,
  opts?: { baseUrl?: string; fetchImpl?: FetchLike },
): Promise<DriveEta> {
  const base =
    opts?.baseUrl ??
    process.env.DISPATCH_ROUTING_OSRM_URL ??
    'https://router.project-osrm.org';
  const fetchImpl = opts?.fetchImpl ?? getFetch();

  // OSRM expects {lon},{lat};{lon},{lat} (longitude first).
  const url = `${base.replace(/\/$/, '')}/route/v1/driving/${origin.lon},${origin.lat};${dest.lon},${dest.lat}?overview=false`;

  const t = withTimeout(ROUTING_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: t.signal });
    if (!res.ok) {
      throw new Error(`osrm: HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      code?: string;
      routes?: Array<{ duration?: number; distance?: number }>;
    };
    if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
      throw new Error(`osrm: no route (${data.code ?? 'unknown'})`);
    }
    const r = data.routes[0];
    return {
      durationSeconds: Math.max(0, Math.round(r.duration ?? 0)),
      distanceMeters: typeof r.distance === 'number' ? Math.round(r.distance) : null,
      provider: 'osrm',
      computedAtMs: Date.now(),
    };
  } finally {
    t.clear();
  }
}

export async function mapboxEta(
  origin: GeoPoint,
  dest: GeoPoint,
  opts?: { token?: string; fetchImpl?: FetchLike },
): Promise<DriveEta> {
  const token = opts?.token ?? process.env.MAPBOX_ACCESS_TOKEN ?? '';
  if (!token) {
    throw new Error('mapbox: MAPBOX_ACCESS_TOKEN is required');
  }
  const fetchImpl = opts?.fetchImpl ?? getFetch();

  const url = `https://api.mapbox.com/directions/v5/mapbox/driving/${origin.lon},${origin.lat};${dest.lon},${dest.lat}?overview=false&access_token=${encodeURIComponent(token)}`;
  const t = withTimeout(ROUTING_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: t.signal });
    if (!res.ok) {
      throw new Error(`mapbox: HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      code?: string;
      routes?: Array<{ duration?: number; distance?: number }>;
    };
    if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
      throw new Error(`mapbox: no route (${data.code ?? 'unknown'})`);
    }
    const r = data.routes[0];
    return {
      durationSeconds: Math.max(0, Math.round(r.duration ?? 0)),
      distanceMeters: typeof r.distance === 'number' ? Math.round(r.distance) : null,
      provider: 'mapbox',
      computedAtMs: Date.now(),
    };
  } finally {
    t.clear();
  }
}

export async function googleEta(
  origin: GeoPoint,
  dest: GeoPoint,
  opts?: { apiKey?: string; fetchImpl?: FetchLike },
): Promise<DriveEta> {
  const apiKey = opts?.apiKey ?? process.env.GOOGLE_MAPS_API_KEY ?? '';
  if (!apiKey) {
    throw new Error('google: GOOGLE_MAPS_API_KEY is required');
  }
  const fetchImpl = opts?.fetchImpl ?? getFetch();

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${origin.lat},${origin.lon}&destinations=${dest.lat},${dest.lon}&mode=driving&key=${encodeURIComponent(apiKey)}`;
  const t = withTimeout(ROUTING_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: t.signal });
    if (!res.ok) {
      throw new Error(`google: HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      status?: string;
      rows?: Array<{
        elements?: Array<{
          status?: string;
          duration?: { value?: number };
          distance?: { value?: number };
        }>;
      }>;
    };
    if (data.status !== 'OK') {
      throw new Error(`google: status ${data.status ?? 'unknown'}`);
    }
    const el = data.rows?.[0]?.elements?.[0];
    if (!el || el.status !== 'OK') {
      throw new Error(`google: element status ${el?.status ?? 'missing'}`);
    }
    return {
      durationSeconds: Math.max(0, Math.round(el.duration?.value ?? 0)),
      distanceMeters: typeof el.distance?.value === 'number' ? Math.round(el.distance.value) : null,
      provider: 'google',
      computedAtMs: Date.now(),
    };
  } finally {
    t.clear();
  }
}

export function getConfiguredRoutingProvider(): RoutingProviderName {
  const raw = String(process.env.DISPATCH_ROUTING_PROVIDER ?? 'haversine').toLowerCase();
  if (raw === 'osrm' || raw === 'mapbox' || raw === 'google' || raw === 'haversine') {
    return raw;
  }
  return 'haversine';
}
