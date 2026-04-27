// Live location reporting for active jobs. Single global tracker;
// foreground-only fallback if background permission is denied.
import { Platform } from 'react-native';
import type { ApiClient, DispatchTransition } from './api';
import { api, ApiError } from './api';

type LocationModuleType = typeof import('expo-location');

const isNative = Platform.OS === 'ios' || Platform.OS === 'android';

let LocationModule: LocationModuleType | null = null;
if (isNative) {
  try {
    LocationModule = require('expo-location') as LocationModuleType;
  } catch {
    LocationModule = null;
  }
}

const ACTIVE_TRANSITIONS = new Set<DispatchTransition>([
  'en_route',
  'on_site',
  'in_progress',
]);

export function statusRequiresTracking(
  status: DispatchTransition | string,
): boolean {
  return ACTIVE_TRANSITIONS.has(status as DispatchTransition);
}

interface ActiveTracker {
  jobId: string;
  resourceId: string;
  deviceSecret: string;
  client: ApiClient;
  subscription: { remove: () => void } | null;
  fallbackTimer: ReturnType<typeof setInterval> | null;
  inFlight: boolean;
}

let active: ActiveTracker | null = null;
let lastErrorAt = 0;
let lastError: string | null = null;

export function getLastTrackingError(): { message: string; at: number } | null {
  return lastError ? { message: lastError, at: lastErrorAt } : null;
}

function recordError(err: unknown): void {
  lastError = err instanceof Error ? err.message : String(err);
  lastErrorAt = Date.now();
}

async function ensureForegroundPermission(): Promise<boolean> {
  if (!LocationModule) return false;
  const current = await LocationModule.getForegroundPermissionsAsync();
  if (current.status === 'granted') return true;
  const requested = await LocationModule.requestForegroundPermissionsAsync();
  return requested.status === 'granted';
}

async function ensureBackgroundPermission(): Promise<boolean> {
  if (!LocationModule) return false;
  // Background permission is iOS-Always or Android-ACCESS_BACKGROUND_LOCATION.
  // Some platforms / dev clients don't expose background API at all — guard.
  const getter = (
    LocationModule as unknown as {
      getBackgroundPermissionsAsync?: () => Promise<{ status: string }>;
    }
  ).getBackgroundPermissionsAsync;
  const requester = (
    LocationModule as unknown as {
      requestBackgroundPermissionsAsync?: () => Promise<{ status: string }>;
    }
  ).requestBackgroundPermissionsAsync;
  if (!getter || !requester) return false;
  try {
    const current = await getter.call(LocationModule);
    if (current.status === 'granted') return true;
    const requested = await requester.call(LocationModule);
    return requested.status === 'granted';
  } catch {
    return false;
  }
}

async function postFix(
  tracker: ActiveTracker,
  position: {
    coords: {
      latitude: number;
      longitude: number;
      accuracy?: number | null;
      heading?: number | null;
      speed?: number | null;
    };
    timestamp: number;
  },
): Promise<void> {
  if (tracker.inFlight) return;
  tracker.inFlight = true;
  try {
    await api.reportResourceLocation(
      tracker.client,
      tracker.resourceId,
      {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy_m:
          typeof position.coords.accuracy === 'number'
            ? position.coords.accuracy
            : null,
        heading_deg:
          typeof position.coords.heading === 'number' &&
          position.coords.heading >= 0
            ? position.coords.heading
            : null,
        speed_mps:
          typeof position.coords.speed === 'number' &&
          position.coords.speed >= 0
            ? position.coords.speed
            : null,
        active_job_id: tracker.jobId,
        recorded_at: new Date(position.timestamp ?? Date.now()).toISOString(),
      },
      tracker.deviceSecret,
    );
    lastError = null;
  } catch (err) {
    recordError(err);
    if (err instanceof ApiError && (err.status === 409 || err.status === 403)) {
      void stopTracking();
    }
  } finally {
    tracker.inFlight = false;
  }
}

// Start (or replace) the active location subscription. Returns false on
// denied permission or unsupported platform.
export async function startTracking(args: {
  client: ApiClient;
  resourceId: string;
  jobId: string;
  deviceSecret: string;
}): Promise<boolean> {
  if (!isNative || !LocationModule) return false;
  if (!args.resourceId || !args.deviceSecret) return false;

  if (
    active &&
    active.jobId === args.jobId &&
    active.resourceId === args.resourceId &&
    active.deviceSecret === args.deviceSecret &&
    (active.subscription || active.fallbackTimer)
  ) {
    return true;
  }

  await stopTracking();

  const fgOk = await ensureForegroundPermission();
  if (!fgOk) {
    recordError(new Error('Foreground location permission was not granted.'));
    return false;
  }
  await ensureBackgroundPermission();

  const tracker: ActiveTracker = {
    jobId: args.jobId,
    resourceId: args.resourceId,
    deviceSecret: args.deviceSecret,
    client: args.client,
    subscription: null,
    fallbackTimer: null,
    inFlight: false,
  };
  active = tracker;

  try {
    const initial = await LocationModule.getCurrentPositionAsync({
      accuracy: LocationModule.Accuracy.Balanced,
    });
    await postFix(tracker, initial);
  } catch (err) {
    recordError(err);
  }

  try {
    tracker.subscription = await LocationModule.watchPositionAsync(
      {
        accuracy: LocationModule.Accuracy.Balanced,
        timeInterval: 30_000,
        distanceInterval: 25,
      },
      (loc: Parameters<Parameters<LocationModuleType['watchPositionAsync']>[1]>[0]) => {
        if (active !== tracker) return;
        void postFix(tracker, loc);
      },
    );
  } catch (err) {
    recordError(err);
    tracker.fallbackTimer = setInterval(() => {
      if (active !== tracker || !LocationModule) return;
      LocationModule.getCurrentPositionAsync({
        accuracy: LocationModule.Accuracy.Balanced,
      })
        .then((pos: Awaited<ReturnType<LocationModuleType['getCurrentPositionAsync']>>) =>
          postFix(tracker, pos),
        )
        .catch(recordError);
    }, 45_000);
  }

  return true;
}

/**
 * Stop the active subscription (if any). Safe to call repeatedly.
 */
export async function stopTracking(): Promise<void> {
  const current = active;
  active = null;
  if (!current) return;
  try {
    current.subscription?.remove();
  } catch {
    // ignore
  }
  if (current.fallbackTimer) {
    clearInterval(current.fallbackTimer);
  }
}
