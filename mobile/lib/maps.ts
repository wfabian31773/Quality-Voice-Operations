import AsyncStorage from '@react-native-async-storage/async-storage';
import { Linking, Platform } from 'react-native';
import { isOffline } from './connectivity';

export async function openDirections(address: string): Promise<void> {
  const encoded = encodeURIComponent(address.trim());
  const webFallback = `https://www.google.com/maps/dir/?api=1&destination=${encoded}`;
  const native =
    Platform.OS === 'ios'
      ? `maps://?daddr=${encoded}&dirflg=d`
      : Platform.OS === 'android'
        ? `google.navigation:q=${encoded}`
        : webFallback;

  try {
    await Linking.openURL(native);
  } catch {
    try {
      await Linking.openURL(webFallback);
    } catch {
      // Nothing more we can do; surface no error to the caller.
    }
  }
}

const EARTH_RADIUS_KM = 6371;

export function haversineKm(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

export function estimateDriveMinutes(distanceKm: number): number {
  const AVERAGE_KMH = 40;
  const minutes = (distanceKm / AVERAGE_KMH) * 60;
  return Math.max(1, Math.round(minutes));
}

export function formatDistance(distanceKm: number): string {
  if (distanceKm < 1) {
    return `${Math.round(distanceKm * 1000)} m`;
  }
  if (distanceKm < 10) {
    return `${distanceKm.toFixed(1)} km`;
  }
  return `${Math.round(distanceKm)} km`;
}

export function formatEta(minutes: number): string {
  if (minutes < 60) return `~${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `~${h} h` : `~${h} h ${m} min`;
}

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

type LocationModuleType = typeof import('expo-location');

let LocationModule: LocationModuleType | null = null;

if (isNative) {
  try {
    LocationModule = require('expo-location') as LocationModuleType;
  } catch {
    LocationModule = null;
  }
}

export interface Coords {
  latitude: number;
  longitude: number;
}

interface GeocodeCacheEntry {
  coords: Coords | null;
  expiresAt: number;
  lastAccessedAt: number;
}

const CACHE_STORAGE_KEY = 'voiceai.tech.geocodeCache.v1';
const GEOCODE_SUCCESS_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const GEOCODE_FAILURE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 200;
const PERSIST_DEBOUNCE_MS = 1_000;

const geocodeCache = new Map<string, GeocodeCacheEntry>();
const inFlightGeocodes = new Map<string, Promise<Coords | null>>();

let hydrationPromise: Promise<void> | null = null;
let pendingPersist: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

function normalizeAddressKey(address: string): string {
  return address.trim().toLowerCase();
}

function isCoords(value: unknown): value is Coords {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<Coords>;
  return (
    typeof v.latitude === 'number' &&
    typeof v.longitude === 'number' &&
    Number.isFinite(v.latitude) &&
    Number.isFinite(v.longitude)
  );
}

function isValidEntry(value: unknown): value is GeocodeCacheEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<GeocodeCacheEntry>;
  if (typeof v.expiresAt !== 'number' || !Number.isFinite(v.expiresAt)) {
    return false;
  }
  if (
    typeof v.lastAccessedAt !== 'number' ||
    !Number.isFinite(v.lastAccessedAt)
  ) {
    return false;
  }
  if (v.coords !== null && !isCoords(v.coords)) return false;
  return true;
}

async function hydrateGeocodeCache(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(CACHE_STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as { version?: unknown }).version !== 1
    ) {
      await AsyncStorage.removeItem(CACHE_STORAGE_KEY).catch(() => {});
      return;
    }
    const entries = (parsed as { entries?: unknown }).entries;
    if (!entries || typeof entries !== 'object') return;
    const now = Date.now();
    for (const [key, value] of Object.entries(
      entries as Record<string, unknown>,
    )) {
      if (typeof key !== 'string' || !key) continue;
      if (!isValidEntry(value)) continue;
      if (value.expiresAt <= now) continue;
      // Don't clobber anything written since hydration began.
      if (geocodeCache.has(key)) continue;
      geocodeCache.set(key, value);
    }
  } catch {
    // Stored shape changed or corrupt; reset so future writes start fresh.
    try {
      await AsyncStorage.removeItem(CACHE_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}

export function ensureGeocodeCacheHydrated(): Promise<void> {
  if (!hydrationPromise) {
    hydrationPromise = hydrateGeocodeCache();
  }
  return hydrationPromise;
}

// Kick off hydration eagerly so the in-memory cache is ready by first render.
void ensureGeocodeCacheHydrated();

function trimCacheForPersistence(): Record<string, GeocodeCacheEntry> {
  const now = Date.now();
  const surviving: Array<[string, GeocodeCacheEntry]> = [];
  for (const [key, entry] of geocodeCache) {
    if (entry.expiresAt <= now) {
      geocodeCache.delete(key);
      continue;
    }
    surviving.push([key, entry]);
  }
  if (surviving.length > MAX_CACHE_ENTRIES) {
    surviving.sort((a, b) => b[1].lastAccessedAt - a[1].lastAccessedAt);
    for (const [key] of surviving.slice(MAX_CACHE_ENTRIES)) {
      geocodeCache.delete(key);
    }
  }
  const out: Record<string, GeocodeCacheEntry> = {};
  for (const [key, entry] of geocodeCache) {
    out[key] = entry;
  }
  return out;
}

async function flushGeocodeCache(): Promise<void> {
  if (!dirty) return;
  dirty = false;
  const entries = trimCacheForPersistence();
  try {
    await AsyncStorage.setItem(
      CACHE_STORAGE_KEY,
      JSON.stringify({ version: 1, entries }),
    );
  } catch {
    // Best-effort persistence; in-memory cache remains the source of truth.
  }
}

function schedulePersist(): void {
  dirty = true;
  if (pendingPersist) return;
  pendingPersist = setTimeout(() => {
    pendingPersist = null;
    void flushGeocodeCache();
  }, PERSIST_DEBOUNCE_MS);
}

function setCacheEntry(key: string, coords: Coords | null): void {
  const now = Date.now();
  const expiresAt =
    coords === null
      ? now + GEOCODE_FAILURE_TTL_MS
      : now + GEOCODE_SUCCESS_TTL_MS;
  geocodeCache.set(key, { coords, expiresAt, lastAccessedAt: now });
  // Only persist successful (or web no-op) entries with a meaningful TTL.
  // Failures get a short TTL and there's no need to write them to disk.
  if (coords !== null) {
    schedulePersist();
  }
}

function readCachedGeocode(key: string): GeocodeCacheEntry | null {
  const entry = geocodeCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    geocodeCache.delete(key);
    if (entry.coords !== null) {
      schedulePersist();
    }
    return null;
  }
  // Touch for LRU bookkeeping; rely on the next mutation to flush.
  entry.lastAccessedAt = Date.now();
  return entry;
}

export function getCachedGeocode(address: string): Coords | null {
  const key = normalizeAddressKey(address);
  if (!key) return null;
  const entry = readCachedGeocode(key);
  return entry ? entry.coords : null;
}

export async function geocodeAddress(
  address: string,
): Promise<Coords | null> {
  const key = normalizeAddressKey(address);
  if (!key) return null;
  await ensureGeocodeCacheHydrated();
  const cached = readCachedGeocode(key);
  if (cached) return cached.coords;
  const existing = inFlightGeocodes.get(key);
  if (existing) return existing;

  if (!isNative || !LocationModule) {
    setCacheEntry(key, null);
    return null;
  }

  const promise = (async () => {
    try {
      const results = await LocationModule!.geocodeAsync(address);
      const first = results[0];
      const coords: Coords | null = first
        ? { latitude: first.latitude, longitude: first.longitude }
        : null;
      setCacheEntry(key, coords);
      return coords;
    } catch {
      setCacheEntry(key, null);
      return null;
    } finally {
      inFlightGeocodes.delete(key);
    }
  })();

  inFlightGeocodes.set(key, promise);
  return promise;
}

export async function clearGeocodeCache(): Promise<void> {
  geocodeCache.clear();
  inFlightGeocodes.clear();
  dirty = false;
  if (pendingPersist) {
    clearTimeout(pendingPersist);
    pendingPersist = null;
  }
  try {
    await AsyncStorage.removeItem(CACHE_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export interface RouteResult {
  coordinates: Coords[];
  distanceKm: number;
  durationMinutes: number;
}

const DEFAULT_ROUTING_BASE = 'https://router.project-osrm.org';
const ROUTING_BASE = (
  process.env.EXPO_PUBLIC_ROUTING_URL ?? DEFAULT_ROUTING_BASE
).replace(/\/+$/, '');
const ROUTING_TIMEOUT_MS = 6_000;
const ROUTE_CACHE_MAX = 50;
const ROUTE_SUCCESS_TTL_MS = 5 * 60 * 1000; // 5 minutes
const ROUTE_FAILURE_TTL_MS = 30_000;
// Quantize coordinates to ~100m so nearby technician positions reuse the
// same cached route instead of refetching on every GPS jitter.
const ROUTE_COORD_QUANTIZE = 1_000;

interface RouteCacheEntry {
  result: RouteResult | null;
  expiresAt: number;
}

const routeCache = new Map<string, RouteCacheEntry>();
const inFlightRoutes = new Map<string, Promise<RouteResult | null>>();

function quantizeCoord(value: number): number {
  return Math.round(value * ROUTE_COORD_QUANTIZE) / ROUTE_COORD_QUANTIZE;
}

function buildRouteKey(origin: Coords, destination: Coords): string {
  return [
    quantizeCoord(origin.latitude),
    quantizeCoord(origin.longitude),
    quantizeCoord(destination.latitude),
    quantizeCoord(destination.longitude),
  ].join(',');
}

function rememberRoute(
  key: string,
  result: RouteResult | null,
  ttl: number,
): void {
  if (routeCache.size >= ROUTE_CACHE_MAX) {
    const oldestKey = routeCache.keys().next().value;
    if (oldestKey !== undefined) routeCache.delete(oldestKey);
  }
  routeCache.set(key, { result, expiresAt: Date.now() + ttl });
}

export function getCachedRoute(
  origin: Coords,
  destination: Coords,
): RouteResult | null {
  const entry = routeCache.get(buildRouteKey(origin, destination));
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) return null;
  return entry.result;
}

export type CachedRouteStatus =
  | { kind: 'miss' }
  | { kind: 'hit'; result: RouteResult }
  | { kind: 'unavailable' };

export function peekCachedRoute(
  origin: Coords,
  destination: Coords,
): CachedRouteStatus {
  const entry = routeCache.get(buildRouteKey(origin, destination));
  if (!entry || entry.expiresAt <= Date.now()) return { kind: 'miss' };
  if (entry.result) return { kind: 'hit', result: entry.result };
  return { kind: 'unavailable' };
}

export async function fetchRoute(
  origin: Coords,
  destination: Coords,
): Promise<RouteResult | null> {
  const key = buildRouteKey(origin, destination);
  const cached = routeCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.result;
  const existing = inFlightRoutes.get(key);
  if (existing) return existing;
  if (isOffline()) return null;
  if (typeof fetch !== 'function') return null;

  const url =
    `${ROUTING_BASE}/route/v1/driving/` +
    `${origin.longitude},${origin.latitude};` +
    `${destination.longitude},${destination.latitude}` +
    `?overview=full&geometries=geojson&alternatives=false&steps=false`;

  const promise = (async () => {
    const controller =
      typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeout = controller
      ? setTimeout(() => controller.abort(), ROUTING_TIMEOUT_MS)
      : null;
    try {
      const res = await fetch(url, {
        signal: controller?.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        rememberRoute(key, null, ROUTE_FAILURE_TTL_MS);
        return null;
      }
      const data = (await res.json()) as {
        code?: string;
        routes?: Array<{
          distance?: number;
          duration?: number;
          geometry?: { coordinates?: unknown };
        }>;
      };
      const route = data?.routes?.[0];
      const rawCoords = route?.geometry?.coordinates;
      if (
        data?.code !== 'Ok' ||
        !route ||
        typeof route.distance !== 'number' ||
        typeof route.duration !== 'number' ||
        !Array.isArray(rawCoords) ||
        rawCoords.length < 2
      ) {
        rememberRoute(key, null, ROUTE_FAILURE_TTL_MS);
        return null;
      }
      const coordinates: Coords[] = [];
      for (const point of rawCoords) {
        if (!Array.isArray(point) || point.length < 2) continue;
        const [lon, lat] = point as [unknown, unknown];
        if (
          typeof lat !== 'number' ||
          typeof lon !== 'number' ||
          !Number.isFinite(lat) ||
          !Number.isFinite(lon)
        ) {
          continue;
        }
        coordinates.push({ latitude: lat, longitude: lon });
      }
      if (coordinates.length < 2) {
        rememberRoute(key, null, ROUTE_FAILURE_TTL_MS);
        return null;
      }
      const result: RouteResult = {
        coordinates,
        distanceKm: route.distance / 1000,
        durationMinutes: Math.max(1, Math.round(route.duration / 60)),
      };
      rememberRoute(key, result, ROUTE_SUCCESS_TTL_MS);
      return result;
    } catch {
      rememberRoute(key, null, ROUTE_FAILURE_TTL_MS);
      return null;
    } finally {
      if (timeout) clearTimeout(timeout);
      inFlightRoutes.delete(key);
    }
  })();

  inFlightRoutes.set(key, promise);
  return promise;
}

export function clearRouteCache(): void {
  routeCache.clear();
  inFlightRoutes.clear();
}
