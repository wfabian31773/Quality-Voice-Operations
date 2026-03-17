const BASE = '/api';

let token: string | null = (() => {
  try { return localStorage.getItem('auth_token'); } catch { return null; }
})();

export function setToken(t: string | null) {
  token = t;
  try {
    if (t) localStorage.setItem('auth_token', t);
    else localStorage.removeItem('auth_token');
  } catch {}
}

export function getToken() {
  return token;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const tokenAtStart = token;
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string>),
  };
  if (tokenAtStart) headers['Authorization'] = `Bearer ${tokenAtStart}`;
  if (init?.body && typeof init.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${BASE}${path}`, { ...init, headers, credentials: 'include' });

  if (res.status === 401) {
    if (token === tokenAtStart) {
      setToken(null);
      const publicPaths = ['/demo', '/login', '/accept-invite'];
      const isPublicPage = publicPaths.some((p) => window.location.pathname.startsWith(p));
      if (!isPublicPage) {
        window.location.href = '/login';
      }
    }
    throw new Error('Unauthorized');
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (res.status === 403 && body.error === 'TENANT_NOT_PROVISIONED') {
      const isOnboarding = window.location.pathname.startsWith('/onboarding');
      if (!isOnboarding) {
        window.location.href = '/onboarding';
      }
      throw new Error('Account setup incomplete');
    }
    if (res.status === 403) {
      const msg = body.error || 'Insufficient permissions';
      const err = new Error(msg);
      (err as Record<string, unknown>).status = 403;
      throw err;
    }
    throw new Error(body.error || body.message || `Request failed: ${res.status}`);
  }

  if (res.status === 204) return {} as T;
  return res.json();
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
