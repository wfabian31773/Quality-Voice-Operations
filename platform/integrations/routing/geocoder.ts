/**
 * Address → lat/lon adapter used to seed the cached `address_lat` /
 * `address_lon` columns on `dispatch_jobs`. We only invoke a geocoder
 * when a job has an address but no cached coordinates (or its address
 * has changed since we last cached).
 *
 * Provider configuration:
 *   - DISPATCH_GEOCODE_PROVIDER = none | nominatim | mapbox | google
 *     (default: `nominatim` — free, no API key. Production tenants
 *      should configure their own provider via env. `none` disables
 *      geocoding entirely; the live map will simply omit ETA for jobs
 *      without pre-populated coords.)
 *   - DISPATCH_GEOCODE_NOMINATIM_URL = base URL (default
 *     `https://nominatim.openstreetmap.org`)
 *   - DISPATCH_GEOCODE_USER_AGENT = required UA per Nominatim policy
 *     (default identifies the platform; tenants on prod should set
 *     their own contact email here).
 *   - MAPBOX_ACCESS_TOKEN, GOOGLE_MAPS_API_KEY for the other providers.
 */

import type { GeocoderProviderName, GeoPoint } from './types';

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

const GEOCODE_TIMEOUT_MS = 5_000;

export function getConfiguredGeocoderProvider(): GeocoderProviderName {
  const raw = String(process.env.DISPATCH_GEOCODE_PROVIDER ?? 'nominatim').toLowerCase();
  if (raw === 'none' || raw === 'nominatim' || raw === 'mapbox' || raw === 'google') {
    return raw;
  }
  return 'nominatim';
}

export async function nominatimGeocode(
  address: string,
  opts?: { baseUrl?: string; userAgent?: string; fetchImpl?: FetchLike },
): Promise<GeoPoint | null> {
  const base =
    opts?.baseUrl ??
    process.env.DISPATCH_GEOCODE_NOMINATIM_URL ??
    'https://nominatim.openstreetmap.org';
  const ua =
    opts?.userAgent ??
    process.env.DISPATCH_GEOCODE_USER_AGENT ??
    'qvo-dispatch-eta/1.0 (operations@qvo.example)';
  const fetchImpl = opts?.fetchImpl ?? getFetch();

  const url = `${base.replace(/\/$/, '')}/search?format=json&limit=1&q=${encodeURIComponent(address)}`;
  const t = withTimeout(GEOCODE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      signal: t.signal,
      headers: { 'User-Agent': ua, Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`nominatim: HTTP ${res.status}`);
    }
    const data = (await res.json()) as Array<{ lat?: string; lon?: string }>;
    if (!Array.isArray(data) || data.length === 0) return null;
    const first = data[0];
    const lat = parseFloat(String(first.lat ?? ''));
    const lon = parseFloat(String(first.lon ?? ''));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  } finally {
    t.clear();
  }
}

export async function mapboxGeocode(
  address: string,
  opts?: { token?: string; fetchImpl?: FetchLike },
): Promise<GeoPoint | null> {
  const token = opts?.token ?? process.env.MAPBOX_ACCESS_TOKEN ?? '';
  if (!token) {
    throw new Error('mapbox-geocode: MAPBOX_ACCESS_TOKEN is required');
  }
  const fetchImpl = opts?.fetchImpl ?? getFetch();
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(address)}.json?limit=1&access_token=${encodeURIComponent(token)}`;
  const t = withTimeout(GEOCODE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: t.signal });
    if (!res.ok) throw new Error(`mapbox-geocode: HTTP ${res.status}`);
    const data = (await res.json()) as { features?: Array<{ center?: [number, number] }> };
    const center = data.features?.[0]?.center;
    if (!center || center.length < 2) return null;
    const [lon, lat] = center;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    return { lat, lon };
  } finally {
    t.clear();
  }
}

export async function googleGeocode(
  address: string,
  opts?: { apiKey?: string; fetchImpl?: FetchLike },
): Promise<GeoPoint | null> {
  const apiKey = opts?.apiKey ?? process.env.GOOGLE_MAPS_API_KEY ?? '';
  if (!apiKey) {
    throw new Error('google-geocode: GOOGLE_MAPS_API_KEY is required');
  }
  const fetchImpl = opts?.fetchImpl ?? getFetch();
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${encodeURIComponent(apiKey)}`;
  const t = withTimeout(GEOCODE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: t.signal });
    if (!res.ok) throw new Error(`google-geocode: HTTP ${res.status}`);
    const data = (await res.json()) as {
      status?: string;
      results?: Array<{ geometry?: { location?: { lat?: number; lng?: number } } }>;
    };
    if (data.status !== 'OK') return null;
    const loc = data.results?.[0]?.geometry?.location;
    if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return null;
    return { lat: loc.lat, lon: loc.lng };
  } finally {
    t.clear();
  }
}

/**
 * High-level geocode dispatcher used by the routing service. Returns
 * `null` (not throws) on a "no result" outcome so the caller can cache
 * the negative result and avoid hammering the provider for unknown
 * addresses on every poll.
 */
export async function geocodeAddress(
  address: string,
  provider: GeocoderProviderName = getConfiguredGeocoderProvider(),
): Promise<GeoPoint | null> {
  const trimmed = address.trim();
  if (!trimmed) return null;
  switch (provider) {
    case 'none':
      return null;
    case 'mapbox':
      return mapboxGeocode(trimmed);
    case 'google':
      return googleGeocode(trimmed);
    case 'nominatim':
    default:
      return nominatimGeocode(trimmed);
  }
}
