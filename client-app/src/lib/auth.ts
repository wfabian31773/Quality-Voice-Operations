import { create } from 'zustand';
import { api, setToken, getToken } from './api';

interface User {
  userId: string;
  tenantId: string;
  email: string;
  role: string;
  isPlatformAdmin?: boolean;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  initialized: boolean;
  login: (email: string, password: string) => Promise<MfaLoginFlow | null>;
  logout: () => void;
  checkAuth: () => void;
}

export type MfaLoginFlow =
  | { mode: 'setup'; flowToken: string }
  | { mode: 'challenge'; flowToken: string };

function decodeToken(token: string): User | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      return null;
    }
    if (!payload.sub || !payload.tenantId || !payload.email || !payload.role) {
      return null;
    }
    return {
      userId: payload.sub as string,
      tenantId: payload.tenantId as string,
      email: payload.email as string,
      role: payload.role as string,
      isPlatformAdmin: (payload.isPlatformAdmin as boolean) ?? false,
    };
  } catch {
    return null;
  }
}

function initUserFromStorage(): { user: User | null; initialized: boolean } {
  const token = getToken();
  if (!token) return { user: null, initialized: true };
  const user = decodeToken(token);
  if (!user) {
    setToken(null);
    return { user: null, initialized: true };
  }
  return { user, initialized: true };
}

const { user: initialUser, initialized: initializedState } = initUserFromStorage();

export const useAuth = create<AuthState>((set) => ({
  user: initialUser,
  loading: false,
  initialized: initializedState,

  login: async (email, password) => {
    const res = await api.post<{
      token?: string;
      userId?: string;
      email?: string;
      role?: string;
      tenantId?: string;
      isPlatformAdmin?: boolean;
      mfaSetupRequired?: boolean;
      mfaSetupToken?: string;
      mfaRequired?: boolean;
      mfaChallengeToken?: string;
    }>('/auth/login', { email, password });
    if (res.mfaSetupRequired && res.mfaSetupToken) {
      return { mode: 'setup', flowToken: res.mfaSetupToken };
    }
    if (res.mfaRequired && res.mfaChallengeToken) {
      return { mode: 'challenge', flowToken: res.mfaChallengeToken };
    }
    if (!res.token || !res.userId || !res.email || !res.role || !res.tenantId) {
      throw new Error('The server returned an incomplete sign-in response.');
    }
    setToken(res.token);
    set({
      user: {
        userId: res.userId,
        tenantId: res.tenantId,
        email: res.email,
        role: res.role,
        isPlatformAdmin: res.isPlatformAdmin ?? false,
      },
      loading: false,
      initialized: true,
    });
    return null;
  },

  logout: () => {
    setToken(null);
    set({ user: null, loading: false, initialized: true });
  },

  checkAuth: () => {
    const token = getToken();
    if (!token) {
      set({ user: null, loading: false, initialized: true });
      return;
    }
    const user = decodeToken(token);
    if (!user) {
      setToken(null);
      set({ user: null, loading: false, initialized: true });
      return;
    }
    set({ user, loading: false, initialized: true });
  },
}));
