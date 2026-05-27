import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
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
 *   are kept OUT, so we whitelist exactly the three paths called out in
 *   BL-013:
 *
 *     - `/login`   — operators must be able to sign in
 *     - `/healthz` — uptime/health probes never get a 503 SPA
 *     - `/admin/*` — the entire platform-admin console
 *
 *   Anyone (logged-in or not) who lands on these paths bypasses the gate.
 *   That's safe because the platform-admin guard / login form themselves
 *   still enforce auth.
 */
const WHITELISTED_PREFIXES = ['/login', '/healthz', '/admin'];

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
  const { t } = useTranslation();
  return (
    <div
      role="status"
      data-testid="maintenance-status-banner"
      className="bg-warning-light border-b border-warning text-warning px-4 py-2 text-sm flex items-center gap-2 dark:bg-warning dark:border-warning dark:text-warning"
    >
      <Wrench className="h-4 w-4 shrink-0" />
      <span className="font-medium">{t('maintenance_banner.label')}</span>
      <span className="truncate">
        {state.message
          ? state.message
          : t('maintenance_banner.default_message')}
      </span>
    </div>
  );
}

/**
 * Poll cadences for `/platform/maintenance`.
 *
 *   - OFF (or first-paint unknown): 60s — the safety poll.
 *   - ON: 5s — once tenants are blocked, we want them back in the app within
 *     a few seconds of an operator flipping maintenance back off, not up to
 *     a minute later.
 *
 * The fast cadence is only active while the gate is actively blocking users,
 * so the extra request volume is bounded to the (rare, short) maintenance
 * window itself.
 */
const POLL_INTERVAL_OFF_MS = 60_000;
const POLL_INTERVAL_ON_MS = 5_000;

export default function MaintenanceGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<MaintenanceState | null>(null);
  const { user } = useAuth();
  const { t } = useTranslation();
  const location = useLocation();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    // Track the latest known enabled state inside the effect so the scheduler
    // can pick the right cadence without re-running the whole effect (which
    // would tear down and rebuild the listeners on every state change).
    let currentEnabled = false;

    const schedule = () => {
      if (cancelled) return;
      if (timer !== null) clearTimeout(timer);
      const delay = currentEnabled ? POLL_INTERVAL_ON_MS : POLL_INTERVAL_OFF_MS;
      timer = setTimeout(check, delay);
    };

    const check = () => {
      if (cancelled || inFlight) {
        // If a request is already in flight, just re-arm the timer so we
        // don't pile up overlapping requests on slow networks.
        if (!cancelled) schedule();
        return;
      }
      inFlight = true;
      api
        .get<MaintenanceState>('/platform/maintenance')
        .then((data) => {
          if (cancelled) return;
          currentEnabled = !!data.enabled;
          setState(data);
        })
        .catch(() => {
          if (cancelled) return;
          // Treat errors as "unknown / probably off" — but keep the existing
          // poll cadence so a transient outage during a maintenance window
          // doesn't strand tenants on the maintenance screen forever.
          setState((prev) => prev ?? { enabled: false, message: null, scheduled_for: null });
        })
        .finally(() => {
          inFlight = false;
          schedule();
        });
    };

    // Re-check immediately when the tab becomes visible again. Browsers
    // throttle background timers heavily, so a tab that was hidden during
    // the maintenance window may otherwise sit on a stale "enabled" view
    // until its next throttled tick. Firing on visibilitychange catches it
    // up the moment the user looks at the tab again.
    const onVisibility = () => {
      if (document.visibilityState === 'visible') check();
    };
    document.addEventListener('visibilitychange', onVisibility);

    check();

    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
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
        aria-label={t('maintenance_banner.checking_status')}
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
