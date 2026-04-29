import AsyncStorage from '@react-native-async-storage/async-storage';
import { Linking, Platform } from 'react-native';

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
