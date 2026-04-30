import '../styles/tw-app.css';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import {
  Radio, Bug, Plug2, Coins, ShieldCheck,
  LogOut, Moon, Sun, Menu, X, Cpu, Repeat, ScrollText,
} from 'lucide-react';
import { useState, useEffect, useMemo } from 'react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import PlatformAssistant from './PlatformAssistant';
import PortalSwitcher from './PortalSwitcher';
import AppFooter from './AppFooter';
import NotificationsCenter from './NotificationsCenter';
import Modal from './Modal';
import GlobalScopeBanner from './GlobalScopeBanner';

interface NavItem {
  to: string;
  icon: typeof Radio;
  i18nKey: string;
  exact?: boolean;
}

interface NavGroup {
  i18nKey: string;
  items: NavItem[];
}

const OPS_GROUPS: NavGroup[] = [
  {
    i18nKey: 'admin_nav.ops_groups.live',
    items: [
      { to: '/ops/monitor', icon: Radio, i18nKey: 'admin_nav.ops.monitor', exact: true },
      { to: '/ops/reliability', icon: ShieldCheck, i18nKey: 'admin_nav.ops.reliability' },
    ],
  },
  {
    i18nKey: 'admin_nav.ops_groups.investigation',
    items: [
      { to: '/ops/call-debug', icon: Bug, i18nKey: 'admin_nav.ops.debugger' },
      { to: '/ops/integration-diagnostics', icon: Plug2, i18nKey: 'admin_nav.ops.diagnostics' },
      { to: '/ops/cost', icon: Coins, i18nKey: 'admin_nav.ops.cost' },
      { to: '/ops/digital-twin', icon: Cpu, i18nKey: 'admin_nav.ops.digital_twin' },
    ],
  },
  {
    i18nKey: 'admin_nav.ops_groups.data',
    items: [
      { to: '/ops/backfill-calls', icon: Repeat, i18nKey: 'admin_nav.ops.backfill_calls' },
    ],
  },
];

function roleI18nKey(rawRole: string | undefined, isPlatformAdmin: boolean): string {
  if (isPlatformAdmin) return 'admin_nav.role.platform_admin';
  switch (rawRole) {
    case 'tenant_owner': return 'admin_nav.role.tenant_owner';
    case 'operations_manager': return 'admin_nav.role.operations_manager';
    case 'billing_admin': return 'admin_nav.role.billing_admin';
    case 'agent_developer': return 'admin_nav.role.agent_developer';
    case 'support_reviewer': return 'admin_nav.role.support_reviewer';
    default: return 'admin_nav.role.viewer';
  }
}

export default function OpsLayout() {
  const { user, logout } = useAuth();
  const { dark, toggle } = useTheme();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [mobileOpen, setMobileOpen] = useState(false);
  // Auto-close the mobile menu when the viewport crosses the lg breakpoint so
  // the underlying <Modal>'s scroll lock doesn't strand desktop users.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const onChange = () => { if (mq.matches) setMobileOpen(false); };
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
          <h1 className="text-lg font-bold text-on-sidebar tracking-tight font-display">{t('brand.name')}</h1>
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-success/30 text-on-sidebar uppercase tracking-wider">{t('admin_nav.ops_badge')}</span>
        </div>
        <p className="text-xs text-sidebar-text mt-1 truncate" title={user?.email}>{user?.email}</p>
      </div>

      <nav
        aria-label={t('admin_nav.ops_console')}
        className="flex-1 px-3 py-4 space-y-5 overflow-y-auto"
      >
        {OPS_GROUPS.map((group) => (
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
        containerClassName="fixed inset-0 z-50 flex lg:hidden print:hidden"
        panelClassName="relative w-64 h-full bg-sidebar-bg focus:outline-none"
      >
        <aside className="h-full w-full">
          {sidebar}
        </aside>
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
              {mobileOpen ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
            </button>
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-primary">
              <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
              <span className="hidden sm:inline">{t('admin_nav.ops_console')}</span>
              <span className="sm:hidden">{t('admin_nav.ops_badge')}</span>
            </span>
            <span
              className="hidden md:inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-success/40 bg-success-light text-success text-[10px] font-semibold uppercase tracking-wider"
              title={`${roleLabel} · ${user?.email ?? ''}`}
            >
              <ShieldCheck className="h-3 w-3" aria-hidden="true" />
              {roleLabel}
            </span>
          </div>

          <div className="flex items-center gap-1">
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

        <div className="px-4 lg:px-6 pt-3 print:hidden">
          <GlobalScopeBanner variant="global" compact />
        </div>

        <main className="flex-1 overflow-y-auto p-4 lg:p-8">
          <Outlet />
        </main>
        <AppFooter />
      </div>

      <PlatformAssistant />
    </div>
  );
}
