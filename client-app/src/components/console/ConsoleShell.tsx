import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useState, useEffect, useMemo, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  LogOut,
  Moon,
  Sun,
  Menu,
  X,
  ScrollText,
  ShieldCheck,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../lib/auth';
import { useTheme } from '../../lib/theme';
import { roleI18nKey, type NavGroup } from '../../lib/roleLabel';
import PlatformAssistant from '../PlatformAssistant';
import PortalSwitcher from '../PortalSwitcher';
import AppFooter from '../AppFooter';
import NotificationsCenter from '../NotificationsCenter';
import LanguageSwitcher from '../LanguageSwitcher';
import Modal from '../Modal';

export interface ConsoleShellBadge {
  /** i18n key for the sidebar header pill text (e.g. "Admin", "Ops"). */
  label: string;
  /** Sidebar header pill background (e.g. "bg-accent/30", "bg-success/30"). */
  accentClass: string;
  /** Header status-dot color class (e.g. "bg-accent", "bg-success"). */
  dotClass: string;
  /**
   * Header role-pill: border + bg + text classes combined
   * (e.g. "border-accent/40 bg-accent-light text-accent").
   */
  pillClass: string;
}

export interface ConsoleShellProps {
  /** Sidebar badge + accent color family. */
  badge: ConsoleShellBadge;
  /** Sidebar nav groups (header eyebrow + items). */
  navGroups: NavGroup[];
  /** Accessibility label for the <nav> element. */
  navAriaLabel: string;
  /** Header pill text shown >= sm breakpoint. */
  headerTitle: string;
  /** Header pill text shown < sm. */
  headerTitleShort: string;
  /**
   * Extra header actions rendered BEFORE the audit-shortcut / theme / notifications cluster.
   * E.g. AdminLayout passes <TenantScopePicker /> here.
   */
  headerActionsBefore?: ReactNode;
  /**
   * Optional content rendered between the header and the <main>.
   * E.g. <GlobalScopeBanner />.
   */
  belowHeaderBanner?: ReactNode;
  /**
   * Whether to include LanguageSwitcher in the sidebar footer. Default true.
   * Was inconsistent before this shell (OpsLayout had no LanguageSwitcher).
   */
  includeLanguageSwitcher?: boolean;
  /** Body content (typically <Outlet />). */
  children?: ReactNode;
}

/**
 * Shared chrome for Admin + Ops consoles: sidebar (responsive +
 * mobile-menu), header (role pill + audit shortcut + theme toggle +
 * notifications), below-header banner slot, main content slot, footer,
 * and the PlatformAssistant FAB.
 *
 * AdminLayout and OpsLayout used to duplicate this verbatim with only
 * the nav data + badge color changing. This shell eliminates ~450 lines
 * of layout duplication and consolidates every "shared chrome" bug fix
 * into a single edit (mobile menu auto-close, theme toggle wiring,
 * audit shortcut, role pill, language switcher, etc.).
 *
 * Not used by TenantLayout — Tenant has a substantially different
 * chrome (search header instead of role pill, sidebar theme toggle,
 * multiple floating widgets, provisioning/onboarding routing).
 */
export default function ConsoleShell({
  badge,
  navGroups,
  navAriaLabel,
  headerTitle,
  headerTitleShort,
  headerActionsBefore,
  belowHeaderBanner,
  includeLanguageSwitcher = true,
  children,
}: ConsoleShellProps) {
  const { user, logout } = useAuth();
  const { dark, toggle } = useTheme();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [mobileOpen, setMobileOpen] = useState(false);

  // Auto-close the mobile menu when viewport crosses the lg breakpoint
  // so the underlying <Modal>'s scroll lock doesn't strand desktop users.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = () => {
      if (mq.matches) setMobileOpen(false);
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const roleLabel = useMemo(
    () => t(roleI18nKey(user?.role, !!user?.isPlatformAdmin)),
    [t, user?.role, user?.isPlatformAdmin],
  );

  const sidebar = (
    <div className="flex flex-col h-full">
      <div className="px-6 py-5 border-b border-on-sidebar/10">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold text-on-sidebar tracking-tight font-display">
            {t('brand.name')}
          </h1>
          <span
            className={clsx(
              'text-[10px] font-semibold px-1.5 py-0.5 rounded text-on-sidebar uppercase tracking-wider',
              badge.accentClass,
            )}
          >
            {t(badge.label)}
          </span>
        </div>
        <p
          className="text-xs text-sidebar-text mt-1 truncate"
          title={user?.email}
        >
          {user?.email}
        </p>
      </div>

      <nav
        aria-label={navAriaLabel}
        className="flex-1 px-3 py-4 space-y-5 overflow-y-auto"
      >
        {navGroups.map((group) => (
          <div key={group.i18nKey} className="space-y-1">
            <p className="px-3 mb-1 text-[10px] font-semibold uppercase tracking-wider text-on-sidebar/50">
              {t(group.i18nKey)}
            </p>
            {group.items.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.exact}
                onClick={() => setMobileOpen(false)}
                className={({ isActive }) =>
                  clsx(
                    'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-primary text-on-primary shadow-[0_0_0_1px_rgba(255,255,255,0.08)_inset]'
                      : 'text-sidebar-text hover:bg-sidebar-hover hover:text-on-sidebar',
                  )
                }
              >
                <link.icon className="h-4.5 w-4.5 shrink-0" />
                {t(link.i18nKey)}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className="px-3 py-4 border-t border-on-sidebar/10 space-y-1">
        <PortalSwitcher />
        {includeLanguageSwitcher && <LanguageSwitcher variant="sidebar" />}
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-sidebar-text hover:bg-sidebar-hover hover:text-on-sidebar w-full transition-colors"
        >
          <LogOut className="h-4.5 w-4.5" />
          {t('actions.sign_out')}
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden bg-surface-secondary">
      <aside className="hidden lg:flex w-64 shrink-0 bg-sidebar-bg flex-col print:hidden">
        {sidebar}
      </aside>

      <Modal
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        ariaLabel={t('actions.open_menu')}
        containerClassName="fixed inset-0 z-drawer flex lg:hidden print:hidden"
        panelClassName="relative w-64 h-full bg-sidebar-bg focus:outline-none"
      >
        <aside className="h-full w-full">{sidebar}</aside>
      </Modal>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex items-center justify-between gap-4 px-4 lg:px-6 py-2.5 bg-surface border-b border-border print:hidden">
          <div className="flex items-center gap-3 min-w-0">
            <button
              className="lg:hidden p-1.5 -ml-1.5 text-text-secondary hover:text-text-primary transition-colors"
              onClick={() => setMobileOpen(true)}
              aria-label={t('actions.open_menu')}
              aria-expanded={mobileOpen}
            >
              {mobileOpen
                ? <X className="h-5 w-5" aria-hidden="true" />
                : <Menu className="h-5 w-5" aria-hidden="true" />}
            </button>
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-primary">
              <span
                className={clsx('h-1.5 w-1.5 rounded-full', badge.dotClass)}
                aria-hidden="true"
              />
              <span className="hidden sm:inline">{headerTitle}</span>
              <span className="sm:hidden">{headerTitleShort}</span>
            </span>
            <span
              className={clsx(
                'hidden md:inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider',
                badge.pillClass,
              )}
              title={`${roleLabel} · ${user?.email ?? ''}`}
            >
              <ShieldCheck className="h-3 w-3" aria-hidden="true" />
              {roleLabel}
            </span>
          </div>

          <div className="flex items-center gap-1">
            {headerActionsBefore}
            <button
              type="button"
              onClick={() => navigate('/admin/security?tab=audit')}
              aria-label={t('admin_nav.audit_shortcut_aria')}
              title={t('admin_nav.audit_log')}
              className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium text-text-secondary border border-border hover:text-text-primary hover:bg-surface-hover transition-colors"
            >
              <ScrollText className="h-3.5 w-3.5" aria-hidden="true" />
              {t('admin_nav.audit_log')}
            </button>
            <button
              type="button"
              onClick={toggle}
              aria-label={dark ? t('theme.light') : t('theme.dark')}
              title={dark ? t('theme.light') : t('theme.dark')}
              className="p-1.5 rounded-md text-text-secondary hover:text-text-primary hover:bg-surface-hover transition-colors"
            >
              {dark
                ? <Sun className="h-4.5 w-4.5" aria-hidden="true" />
                : <Moon className="h-4.5 w-4.5" aria-hidden="true" />}
            </button>
            <NotificationsCenter />
          </div>
        </header>

        {belowHeaderBanner && (
          <div className="px-4 lg:px-6 pt-3 print:hidden">{belowHeaderBanner}</div>
        )}

        <main className="flex-1 overflow-y-auto p-4 lg:p-8">
          {children ?? <Outlet />}
        </main>
        <AppFooter />
      </div>

      <PlatformAssistant />
    </div>
  );
}
