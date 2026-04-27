import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { STORAGE_KEYS } from './api';

async function read(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(key);
  }
  return SecureStore.getItemAsync(key);
}

async function write(key: string, value: string | null): Promise<void> {
  if (Platform.OS === 'web') {
    if (typeof window === 'undefined') return;
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    return;
  }
  if (value === null) {
    await SecureStore.deleteItemAsync(key);
  } else {
    await SecureStore.setItemAsync(key, value);
  }
}

export interface StoredCredentials {
  baseUrl: string;
  apiKey: string;
  resourceId: string | null;
  resourceName: string | null;
  pushToken: string | null;
  pushEnabled: boolean;
  /** Per-device secret used to bind location pings to a single resource_id. */
  deviceSecret: string | null;
}

export async function loadStoredCredentials(): Promise<StoredCredentials | null> {
  const [
    baseUrl,
    apiKey,
    resourceId,
    resourceName,
    pushToken,
    pushEnabled,
    deviceSecret,
  ] = await Promise.all([
    read(STORAGE_KEYS.baseUrl),
    read(STORAGE_KEYS.apiKey),
    read(STORAGE_KEYS.resourceId),
    read(STORAGE_KEYS.resourceName),
    read(STORAGE_KEYS.pushToken),
    read(STORAGE_KEYS.pushEnabled),
    read(STORAGE_KEYS.deviceSecret),
  ]);

  if (!baseUrl || !apiKey) return null;
  return {
    baseUrl,
    apiKey,
    resourceId,
    resourceName,
    pushToken,
    pushEnabled: pushEnabled !== 'false',
    deviceSecret,
  };
}

export async function saveCredentials(
  creds: StoredCredentials,
): Promise<void> {
  await Promise.all([
    write(STORAGE_KEYS.baseUrl, creds.baseUrl),
    write(STORAGE_KEYS.apiKey, creds.apiKey),
    write(STORAGE_KEYS.resourceId, creds.resourceId),
    write(STORAGE_KEYS.resourceName, creds.resourceName),
    write(STORAGE_KEYS.pushToken, creds.pushToken),
    write(STORAGE_KEYS.pushEnabled, creds.pushEnabled ? 'true' : 'false'),
    write(STORAGE_KEYS.deviceSecret, creds.deviceSecret),
  ]);
}

export async function clearCredentials(): Promise<void> {
  await Promise.all([
    write(STORAGE_KEYS.baseUrl, null),
    write(STORAGE_KEYS.apiKey, null),
    write(STORAGE_KEYS.resourceId, null),
    write(STORAGE_KEYS.resourceName, null),
    write(STORAGE_KEYS.pushToken, null),
    write(STORAGE_KEYS.pushEnabled, null),
    write(STORAGE_KEYS.deviceSecret, null),
  ]);
}

export async function updateStoredDeviceSecret(
  deviceSecret: string | null,
): Promise<void> {
  await write(STORAGE_KEYS.deviceSecret, deviceSecret);
}

/**
 * Stable per-install identifier used as the synthetic push_token when a
 * device enrolls for location tracking before (or without) the OS
 * issuing a real Expo push token. Generated on first read, cached
 * thereafter, so a single install always reuses the same user_devices
 * row server-side.
 */
export async function getOrCreateInstallId(): Promise<string> {
  const existing = await read(STORAGE_KEYS.installId);
  if (existing && existing.length >= 8) return existing;
  // RFC 4122-ish v4 from Math.random — collision risk is negligible at
  // tenant scale and we don't need cryptographic uniqueness here, just
  // a stable per-install discriminator. The pairing code (admin-issued)
  // is the actual security gate.
  const hex = (n: number) => Math.floor(Math.random() * 16 ** n).toString(16).padStart(n, '0');
  const id = `${hex(8)}-${hex(4)}-4${hex(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${hex(3)}-${hex(12)}`;
  await write(STORAGE_KEYS.installId, id);
  return id;
}

export async function updateSelectedResource(
  resourceId: string | null,
  resourceName: string | null,
): Promise<void> {
  await Promise.all([
    write(STORAGE_KEYS.resourceId, resourceId),
    write(STORAGE_KEYS.resourceName, resourceName),
  ]);
}

export async function updateStoredPushToken(
  token: string | null,
): Promise<void> {
  await write(STORAGE_KEYS.pushToken, token);
}

export async function updateStoredPushEnabled(
  enabled: boolean,
): Promise<void> {
  await write(STORAGE_KEYS.pushEnabled, enabled ? 'true' : 'false');
}

export async function readLastHandledPushId(): Promise<string | null> {
  return read(STORAGE_KEYS.lastPushHandled);
}

export async function writeLastHandledPushId(id: string): Promise<void> {
  await write(STORAGE_KEYS.lastPushHandled, id);
}
