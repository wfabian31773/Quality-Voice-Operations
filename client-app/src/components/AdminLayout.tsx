import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import {
  Building2, BarChart3, Store, CreditCard, Shield,
  LogOut, Moon, Sun, Menu, X, Compass, Inbox, History,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import PlatformAssistant from './PlatformAssistant';
import PortalSwitcher from './PortalSwitcher';
import AppFooter from './AppFooter';
import NotificationsCenter from './NotificationsCenter';
import LanguageSwitcher from './LanguageSwitcher';
import Modal from './Modal';

interface NavItem {
  to: string;
  icon: typeof Building2;
  i18nKey: string;
}

const adminLinks: NavItem[] = [
  { to: '/admin/dashboard', icon: Building2, i18nKey: 'admin_nav.tenants' },
  { to: '/admin/analytics', icon: BarChart3, i18nKey: 'admin_nav.analytics' },
  { to: '/admin/sales-inbox', icon: Inbox, i18nKey: 'admin_nav.sales_inbox' },
  { to: '/admin/marketplace', icon: Store, i18nKey: 'admin_nav.marketplace' },
  { to: '/admin/billing', icon: CreditCard, i18nKey: 'admin_nav.billing' },
  { to: '/admin/security', icon: Shield, i18nKey: 'admin_nav.security' },
  { to: '/admin/governance', icon: Compass, i18nKey: 'admin_nav.governance' },
  { to: '/admin/ingest-backfill', icon: History, i18nKey: 'admin_nav.backfill' },
];

export default function AdminLayout() {
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

  const sidebar = (
    <div className="flex flex-col h-full">
      <div className="px-6 py-5 border-b border-white/10">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold text-white tracking-tight font-display">{t('brand.name')}</h1>
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 uppercase tracking-wider">{t('admin_nav.badge')}</span>
        </div>
        <p className="text-xs text-sidebar-text mt-0.5 truncate">{user?.email}</p>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {adminLinks.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.to === '/admin/dashboard'}
            onClick={() => setMobileOpen(false)}
            className={({ isActive }) =>
              clsx(
                'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                isActive
                  ? 'bg-purple-600 text-white'
                  : 'text-sidebar-text hover:bg-sidebar-hover hover:text-white',
              )
            }
          >
            <link.icon className="h-4.5 w-4.5 shrink-0" />
            {t(link.i18nKey)}
          </NavLink>
        ))}
      </nav>

      <div className="px-3 py-4 border-t border-white/10 space-y-1">
        <PortalSwitcher />
        <LanguageSwitcher variant="sidebar" />
        <button
          onClick={toggle}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-sidebar-text hover:bg-sidebar-hover hover:text-white w-full transition-colors"
        >
          {dark ? <Sun className="h-4.5 w-4.5" /> : <Moon className="h-4.5 w-4.5" />}
          {dark ? t('theme.light') : t('theme.dark')}
        </button>
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-sidebar-text hover:bg-sidebar-hover hover:text-white w-full transition-colors"
        >
          <LogOut className="h-4.5 w-4.5" />
          {t('actions.sign_out')}
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden">
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
        <header className="flex items-center justify-between px-4 py-2 bg-surface border-b border-border print:hidden">
          <div className="flex items-center gap-3">
            <button
              className="lg:hidden p-1.5 -ml-1.5"
              onClick={() => setMobileOpen(true)}
              aria-label={t('actions.open_menu')}
              aria-expanded={mobileOpen}
            >
              {mobileOpen ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
            </button>
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-purple-600 dark:text-purple-300">
              <span className="h-1.5 w-1.5 rounded-full bg-purple-500" aria-hidden="true" />
              {t('admin_nav.console')}
            </span>
          </div>
          <div className="flex items-center gap-1">
            <NotificationsCenter />
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 lg:p-8">
          <Outlet />
        </main>
        <AppFooter />
      </div>

      <PlatformAssistant />
    </div>
  );
}
