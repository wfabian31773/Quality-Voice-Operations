import { useEffect, useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import type { Coords } from '@/lib/maps';

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

export type TechnicianLocationStatus =
  | 'idle'
  | 'unsupported'
  | 'requesting'
  | 'granted'
  | 'denied'
  | 'error';

interface InternalState {
  status: TechnicianLocationStatus;
  origin: Coords | null;
  error: string | null;
}

let state: InternalState = {
  status: isNative && LocationModule ? 'idle' : 'unsupported',
  origin: null,
  error: null,
};

const listeners = new Set<() => void>();
let inFlight: Promise<void> | null = null;

function emit() {
  state = { ...state };
  for (const listener of listeners) listener();
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

function getSnapshot(): InternalState {
  return state;
}

async function ensureLocation(): Promise<void> {
  if (!isNative || !LocationModule) return;
  if (state.status === 'granted' && state.origin) return;
  if (state.status === 'denied') return;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    state.status = 'requesting';
    state.error = null;
    emit();
    try {
      const { status } =
        await LocationModule!.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        state.status = 'denied';
        state.error = 'Location permission was not granted.';
        emit();
        return;
      }
      const position = await LocationModule!.getCurrentPositionAsync({
        accuracy: LocationModule!.Accuracy.Balanced,
      });
      state.origin = {
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
      };
      state.status = 'granted';
      emit();
    } catch {
      state.status = 'error';
      state.error = "We couldn't read your current location.";
      emit();
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

export interface UseTechnicianLocationResult {
  status: TechnicianLocationStatus;
  origin: Coords | null;
  error: string | null;
  request: () => Promise<void>;
}

export function useTechnicianLocation(
  autoRequest = true,
): UseTechnicianLocationResult {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (autoRequest) {
      void ensureLocation();
    }
  }, [autoRequest]);

  return {
    status: snapshot.status,
    origin: snapshot.origin,
    error: snapshot.error,
    request: ensureLocation,
  };
}
