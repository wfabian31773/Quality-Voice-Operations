import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Wrench } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import Maintenance from '../pages/Maintenance';

interface MaintenanceState {
  enabled: boolean;
  message: string | null;
  scheduled_for: string | null;
}

/**
 * Paths that ALWAYS render through the gate even when maintenance mode is on.
 *
 * Background (BL-013):
 *   When maintenance was global, a platform admin who got logged out (or who
 *   landed in an unauthenticated tab) had no way back in: `/login` itself
 *   was blocked, and so was `/admin/*`. The whole point of maintenance mode
 *   is to give operators a way to keep working ON the system while users
 *   are kept OUT, so we whitelist:
 *
 *     - `/login`             — operators must be able to sign in
 *     - `/healthz`           — uptime/health probes never get a 503 SPA
 *     - `/admin/*`           — the entire platform-admin console
 *     - `/accept-invite`     — invited operators can still finish onboarding
 *     - `/auth/verify-email` — email-verification deep links keep working
 *
 *   Anyone (logged-in or not) who lands on these paths bypasses the gate.
 *   That's safe because the platform-admin guard / login form themselves
 *   still enforce auth.
 */
const WHITELISTED_PREFIXES = [
  '/login',
  '/healthz',
  '/admin',
  '/accept-invite',
  '/auth/verify-email',
];

function isWhitelisted(pathname: string): boolean {
  return WHITELISTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Thin yellow strip rendered at the top of every console when maintenance
 * mode is on AND the current user has bypassed the full-screen gate (i.e.
 * platform admins, or anyone on a whitelisted path). This makes the
 * maintenance status visible across the admin / ops / tenant layouts as
 * the BL-013 acceptance criteria require.
 */
function MaintenanceStatusBanner({ state }: { state: MaintenanceState }) {
  return (
    <div
      role="status"
      data-testid="maintenance-status-banner"
      className="bg-amber-100 border-b border-amber-300 text-amber-900 px-4 py-2 text-sm flex items-center gap-2 dark:bg-amber-900/30 dark:border-amber-700 dark:text-amber-100"
    >
      <Wrench className="h-4 w-4 shrink-0" />
      <span className="font-medium">Maintenance mode is ON.</span>
      <span className="truncate">
        {state.message
          ? state.message
          : 'Tenants are seeing the maintenance screen — admin consoles remain accessible.'}
      </span>
    </div>
  );
}

export default function MaintenanceGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<MaintenanceState | null>(null);
  const { user } = useAuth();
  const location = useLocation();

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      api
        .get<MaintenanceState>('/platform/maintenance')
        .then((data) => {
          if (!cancelled) setState(data);
        })
        .catch(() => {
          if (!cancelled) setState({ enabled: false, message: null, scheduled_for: null });
        });
    };
    check();
    const id = setInterval(check, 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const onWhitelistedPath = isWhitelisted(location.pathname);
  const isAdmin = !!user?.isPlatformAdmin;

  // BL-013: anyone landing on a whitelisted path (login, /admin/*, health
  // probes, invite/verify links) bypasses the gate, AND any logged-in
  // platform admin bypasses the gate everywhere — otherwise we'd lock the
  // very people who turned maintenance on out of the system that lets them
  // turn it back off.
  const bypass = useMemo(() => {
    if (!state?.enabled) return true;
    if (onWhitelistedPath) return true;
    if (isAdmin) return true;
    return false;
  }, [state?.enabled, onWhitelistedPath, isAdmin]);

  // First-paint fail-closed: until the `/platform/maintenance` poll resolves
  // we don't yet know whether maintenance is on. Letting protected children
  // render in that window would briefly leak tenant content if maintenance
  // is actually ON. So for authenticated non-admin users on non-whitelisted
  // paths we hold a neutral splash until we have a definitive answer.
  // Logged-out users and admins can render through immediately — they're
  // either heading for /login (whitelisted) or are entitled to bypass.
  if (state === null && user && !isAdmin && !onWhitelistedPath) {
    return (
      <div
        data-testid="maintenance-gate-loading"
        className="min-h-screen flex items-center justify-center bg-surface-secondary"
        aria-busy="true"
        aria-label="Checking system status"
      />
    );
  }

  if (state?.enabled && !bypass) {
    return <Maintenance message={state.message} scheduledFor={state.scheduled_for} />;
  }

  return (
    <>
      {state?.enabled && <MaintenanceStatusBanner state={state} />}
      {children}
    </>
  );
}
