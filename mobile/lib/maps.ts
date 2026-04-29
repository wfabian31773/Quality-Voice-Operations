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
}

const GEOCODE_FAILURE_TTL_MS = 60_000;
const geocodeCache = new Map<string, GeocodeCacheEntry>();
const inFlightGeocodes = new Map<string, Promise<Coords | null>>();

function normalizeAddressKey(address: string): string {
  return address.trim().toLowerCase();
}

function readCachedGeocode(key: string): GeocodeCacheEntry | null {
  const entry = geocodeCache.get(key);
  if (!entry) return null;
  if (entry.coords === null && entry.expiresAt <= Date.now()) {
    geocodeCache.delete(key);
    return null;
  }
  return entry;
}

export async function geocodeAddress(
  address: string,
): Promise<Coords | null> {
  const key = normalizeAddressKey(address);
  if (!key) return null;
  const cached = readCachedGeocode(key);
  if (cached) return cached.coords;
  const existing = inFlightGeocodes.get(key);
  if (existing) return existing;

  if (!isNative || !LocationModule) {
    geocodeCache.set(key, {
      coords: null,
      expiresAt: Number.POSITIVE_INFINITY,
    });
    return null;
  }

  const promise = (async () => {
    try {
      const results = await LocationModule!.geocodeAsync(address);
      const first = results[0];
      const coords: Coords | null = first
        ? { latitude: first.latitude, longitude: first.longitude }
        : null;
      geocodeCache.set(key, {
        coords,
        expiresAt:
          coords === null
            ? Date.now() + GEOCODE_FAILURE_TTL_MS
            : Number.POSITIVE_INFINITY,
      });
      return coords;
    } catch {
      geocodeCache.set(key, {
        coords: null,
        expiresAt: Date.now() + GEOCODE_FAILURE_TTL_MS,
      });
      return null;
    } finally {
      inFlightGeocodes.delete(key);
    }
  })();

  inFlightGeocodes.set(key, promise);
  return promise;
}
