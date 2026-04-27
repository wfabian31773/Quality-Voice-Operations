import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Constants from 'expo-constants';
import {
  loadStoredCredentials,
  saveCredentials,
  clearCredentials,
  updateSelectedResource,
  updateStoredPushToken,
  updateStoredPushEnabled,
  type StoredCredentials,
} from '@/lib/auth';
import { api, type ApiClient } from '@/lib/api';
import {
  getDeviceLabel,
  registerForPushNotificationsAsync,
} from '@/lib/push';

interface AuthState {
  ready: boolean;
  signedIn: boolean;
  baseUrl: string | null;
  apiKey: string | null;
  resourceId: string | null;
  resourceName: string | null;
  pushToken: string | null;
  pushEnabled: boolean;
  pushSyncing: boolean;
  pushError: string | null;
  client: ApiClient | null;
  signIn: (creds: Omit<StoredCredentials, 'pushToken' | 'pushEnabled'>) => Promise<void>;
  signOut: () => Promise<void>;
  setResource: (id: string | null, name: string | null) => Promise<void>;
  setPushEnabled: (enabled: boolean) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

function appVersion(): string {
  const v = (Constants as unknown as {
    expoConfig?: { version?: string };
  }).expoConfig?.version;
  return v ?? '0.0.0';
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [creds, setCreds] = useState<StoredCredentials | null>(null);
  const [ready, setReady] = useState(false);
  const [pushSyncing, setPushSyncing] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const lastSyncedKey = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadStoredCredentials()
      .then((stored) => {
        if (!cancelled) {
          setCreds(stored);
        }
      })
      .catch(() => {
        if (!cancelled) setCreds(null);
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(
    async (next: Omit<StoredCredentials, 'pushToken' | 'pushEnabled'>) => {
      const merged: StoredCredentials = {
        ...next,
        pushToken: null,
        pushEnabled: true,
      };
      await saveCredentials(merged);
      setCreds(merged);
    },
    [],
  );

  const signOut = useCallback(async () => {
    const current = creds;
    const client: ApiClient | null = current
      ? { baseUrl: current.baseUrl, apiKey: current.apiKey }
      : null;
    if (client && current?.pushToken) {
      try {
        await api.deleteDevice(client, current.pushToken);
      } catch {
        // best-effort; clearing creds locally is more important
      }
    }
    await clearCredentials();
    lastSyncedKey.current = null;
    setCreds(null);
  }, [creds]);

  const setResource = useCallback(
    async (id: string | null, name: string | null) => {
      await updateSelectedResource(id, name);
      setCreds((prev) =>
        prev ? { ...prev, resourceId: id, resourceName: name } : prev,
      );
      lastSyncedKey.current = null;
    },
    [],
  );

  const setPushEnabled = useCallback(
    async (enabled: boolean) => {
      await updateStoredPushEnabled(enabled);
      setCreds((prev) => (prev ? { ...prev, pushEnabled: enabled } : prev));
      lastSyncedKey.current = null;
    },
    [],
  );

  // Device registration / sync effect: runs whenever credentials, the
  // selected resource, or the push toggle changes. Registers an Expo push
  // token on enable, and POSTs/PATCHes the device record server-side so the
  // backend knows where to send dispatch notifications. On disable, the
  // device row is updated to push_enabled=false (token kept for reuse).
  useEffect(() => {
    if (!creds) return;
    const client: ApiClient = {
      baseUrl: creds.baseUrl,
      apiKey: creds.apiKey,
    };
    const key = [
      creds.baseUrl,
      creds.apiKey,
      creds.resourceId ?? '',
      creds.pushEnabled ? '1' : '0',
      creds.pushToken ?? '',
    ].join('|');
    if (lastSyncedKey.current === key) return;
    lastSyncedKey.current = key;

    let cancelled = false;
    (async () => {
      setPushSyncing(true);
      setPushError(null);
      try {
        if (creds.pushEnabled) {
          const reg = await registerForPushNotificationsAsync();
          if (cancelled) return;
          if (!reg) {
            setPushError(
              'Push notifications were not granted on this device.',
            );
            return;
          }
          await api.registerDevice(client, {
            token: reg.token,
            platform: reg.platform,
            resource_id: creds.resourceId,
            device_label: getDeviceLabel(),
            app_version: appVersion(),
            push_enabled: true,
          });
          if (creds.pushToken !== reg.token) {
            await updateStoredPushToken(reg.token);
            if (!cancelled) {
              setCreds((prev) =>
                prev ? { ...prev, pushToken: reg.token } : prev,
              );
            }
          }
        } else if (creds.pushToken) {
          await api.updateDevice(client, creds.pushToken, {
            push_enabled: false,
          });
        }
      } catch (err) {
        if (!cancelled) {
          setPushError(
            err instanceof Error ? err.message : 'Failed to sync device.',
          );
          // allow another retry on next change
          lastSyncedKey.current = null;
        }
      } finally {
        if (!cancelled) setPushSyncing(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [creds]);

  const value = useMemo<AuthState>(() => {
    const client: ApiClient | null = creds
      ? { baseUrl: creds.baseUrl, apiKey: creds.apiKey }
      : null;
    return {
      ready,
      signedIn: creds !== null,
      baseUrl: creds?.baseUrl ?? null,
      apiKey: creds?.apiKey ?? null,
      resourceId: creds?.resourceId ?? null,
      resourceName: creds?.resourceName ?? null,
      pushToken: creds?.pushToken ?? null,
      pushEnabled: creds?.pushEnabled ?? true,
      pushSyncing,
      pushError,
      client,
      signIn,
      signOut,
      setResource,
      setPushEnabled,
    };
  }, [
    creds,
    ready,
    pushSyncing,
    pushError,
    signIn,
    signOut,
    setResource,
    setPushEnabled,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return ctx;
}
