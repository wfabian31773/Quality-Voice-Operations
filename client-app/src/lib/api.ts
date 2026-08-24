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

// Task #1279: friendlier user-visible fallback messages when the server
// doesn't supply a `body.error` / `body.message`. The raw "Request failed:
// <status>" wording used to leak straight into UI alerts (the onboarding
// template-update failure being the canonical example). We keep the HTTP
// status on the thrown error (`err.status`) so callers, logs, and Sentry
// breadcrumbs can still branch on it; only the user-visible `err.message`
// changes.
const NETWORK_ERROR_MESSAGE =
  "Couldn't reach the server. Check your connection and try again.";
const SERVER_ERROR_MESSAGE =
  "The server didn't respond as expected. Please try again.";
const GENERIC_ERROR_MESSAGE = 'Something went wrong. Please try again.';

function fallbackMessageForStatus(status: number): string {
  if (status === 403) return 'Insufficient permissions';
  if (status >= 500) return SERVER_ERROR_MESSAGE;
  return GENERIC_ERROR_MESSAGE;
}

export interface RequestOptions {
  signal?: AbortSignal;
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

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { ...init, headers, credentials: 'include' });
  } catch (networkErr) {
    // fetch() rejects on transient network failures (offline, DNS, CORS
    // preflight refusal, etc) with messages like "Failed to fetch" that
    // are useless to end users. Replace with a short, plain-English
    // message but preserve the original on `err.cause` so dev tools and
    // Sentry can still see the underlying reason.
    const err = new Error(NETWORK_ERROR_MESSAGE);
    Object.assign(err, { status: 0, body: null, cause: networkErr });
    throw err;
  }

  if (res.status === 401) {
    if (token === tokenAtStart) {
      setToken(null);
      const publicPaths = ['/demo', '/login', '/signup', '/accept-invite', '/pricing'];
      const isPublicPage = publicPaths.some((p) => window.location.pathname.startsWith(p));
      if (!isPublicPage) {
        // Task #499 / #1513: preserve the page the user was on so we can
        // bring them back after they sign in again. Login.tsx already runs
        // the value through `safeRedirect()`, but we ALSO build a
        // same-origin relative path here (matching the guard in
        // ProtectedRoute.tsx) so a tampered location can never become an
        // open-redirect vector.
        const { pathname, search, hash } = window.location;
        const target = `${pathname}${search}${hash}`;
        const isSameOriginPath =
          target.startsWith('/') && !target.startsWith('//') && !target.startsWith('/\\');
        window.location.href =
          isSameOriginPath && target !== '/'
            ? `/login?next=${encodeURIComponent(target)}`
            : '/login';
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
    const msg = body.error || body.message || fallbackMessageForStatus(res.status);
    const err = new Error(msg);
    Object.assign(err, { status: res.status, body });
    throw err;
  }

  if (res.status === 204) return {} as T;
  return res.json();
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>(path, { signal: opts?.signal }),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined, signal: opts?.signal }),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined, signal: opts?.signal }),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined, signal: opts?.signal }),
  delete: <T>(path: string, opts?: RequestOptions) => request<T>(path, { method: 'DELETE', signal: opts?.signal }),
};
