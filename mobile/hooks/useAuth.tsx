import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  loadStoredCredentials,
  saveCredentials,
  clearCredentials,
  updateSelectedResource,
  type StoredCredentials,
} from '@/lib/auth';
import type { ApiClient } from '@/lib/api';

interface AuthState {
  ready: boolean;
  signedIn: boolean;
  baseUrl: string | null;
  apiKey: string | null;
  resourceId: string | null;
  resourceName: string | null;
  client: ApiClient | null;
  signIn: (creds: StoredCredentials) => Promise<void>;
  signOut: () => Promise<void>;
  setResource: (id: string | null, name: string | null) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [creds, setCreds] = useState<StoredCredentials | null>(null);
  const [ready, setReady] = useState(false);

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

  const signIn = useCallback(async (next: StoredCredentials) => {
    await saveCredentials(next);
    setCreds(next);
  }, []);

  const signOut = useCallback(async () => {
    await clearCredentials();
    setCreds(null);
  }, []);

  const setResource = useCallback(
    async (id: string | null, name: string | null) => {
      await updateSelectedResource(id, name);
      setCreds((prev) =>
        prev ? { ...prev, resourceId: id, resourceName: name } : prev,
      );
    },
    [],
  );

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
      client,
      signIn,
      signOut,
      setResource,
    };
  }, [creds, ready, signIn, signOut, setResource]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used inside AuthProvider');
  }
  return ctx;
}
