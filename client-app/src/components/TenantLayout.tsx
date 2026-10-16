import '../styles/tw-app.css';
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { api } from '../lib/api';
import {
  LayoutDashboard, Bot, Phone, PhoneCall, Plug, Network,
  LogOut, Moon, Sun, Menu, BarChart3, Settings2,
  Megaphone, BookOpen, Store, ChevronDown, Boxes, Wrench,
  MessageSquare, CalendarClock, ClipboardList, Truck, Pin, Zap,
  ShieldCheck, Search, CreditCard,
} from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import PlatformAssistant from './PlatformAssistant';
import PortalSwitcher from './PortalSwitcher';
import AppFooter from './AppFooter';
import { HelpDrawer } from './HelpDrawer';
import TrialBanner from './TrialBanner';
import NotificationsCenter from './NotificationsCenter';
import LanguageSwitcher from './LanguageSwitcher';
import { Sparkles } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import CommandPalette from './CommandPalette';
import HelpWidget from './HelpWidget';
import KeyboardShortcuts from './KeyboardShortcuts';
import ProductTour, { getTourCompleted } from './ProductTour';
import { dashboardTour } from './tours';
import Modal from './Modal';
import { isQvoStaff } from '../lib/surfacePolicy';

export interface NavItem {
  to: string;
  icon: typeof LayoutDashboard;
  i18nKey: string;
}

export const tenantLinks: NavItem[] = [
  { to: '/dashboard', icon: LayoutDashboard, i18nKey: 'tenant_nav.dashboard' },
  { to: '/agents', icon: Bot, i18nKey: 'tenant_nav.agents' },
  { to: '/calls', icon: PhoneCall, i18nKey: 'tenant_nav.conversations' },
  { to: '/tickets', icon: ClipboardList, i18nKey: 'tenant_nav.tickets' },
  { to: '/knowledge-base', icon: BookOpen, i18nKey: 'tenant_nav.knowledge' },
  { to: '/phone-numbers', icon: Phone, i18nKey: 'tenant_nav.phone_numbers' },
  { to: '/billing', icon: CreditCard, i18nKey: 'tenant_nav.billing' },
];

export const internalPrimaryLinks: NavItem[] = [
  { to: '/campaigns', icon: Megaphone, i18nKey: 'tenant_nav.campaigns' },
  { to: '/analytics', icon: BarChart3, i18nKey: 'tenant_nav.analytics' },
];

export const operationsLinks: NavItem[] = [
  { to: '/autopilot', icon: Zap, i18nKey: 'tenant_nav.autopilot' },
  { to: '/sms-inbox', icon: MessageSquare, i18nKey: 'tenant_nav.sms_inbox' },
  { to: '/scheduling', icon: CalendarClock, i18nKey: 'tenant_nav.scheduling' },
  { to: '/dispatch', icon: Truck, i18nKey: 'tenant_nav.dispatch' },
];

export const configureLinks: NavItem[] = [
  { to: '/workflows', icon: Network, i18nKey: 'tenant_nav.workflows' },
  { to: '/connectors', icon: Plug, i18nKey: 'tenant_nav.integrations' },
  { to: '/trusted-callers', icon: ShieldCheck, i18nKey: 'tenant_nav.trusted_callers' },
  { to: '/marketplace', icon: Store, i18nKey: 'tenant_nav.marketplace' },
];

export const settingsLink: NavItem = { to: '/settings', icon: Settings2, i18nKey: 'tenant_nav.settings' };

export default function TenantLayout() {
  const { user, logout } = useAuth();
  const { dark, toggle } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
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
  const opsRef = useRef<HTMLDivElement>(null);
  const configureRef = useRef<HTMLDivElement>(null);
  const [opsOpen, setOpsOpen] = useState(() =>
    operationsLinks.some((l) => location.pathname.startsWith(l.to)),
  );
  const [configureOpen, setConfigureOpen] = useState(() =>
    configureLinks.some((l) => location.pathname.startsWith(l.to)),
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === '?' && !isMod) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') {
          e.preventDefault();
          setShortcutsOpen((v) => !v);
        }
      }
    };
    window.addEventListener('keydown', handler);
    const openCmd = () => setPaletteOpen(true);
    window.addEventListener('qvo:open-command-palette', openCmd);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('qvo:open-command-palette', openCmd);
    };
  }, []);

  const isPlatformAdmin = isQvoStaff(user);
  const primaryLinks = isPlatformAdmin
    ? [...tenantLinks, ...internalPrimaryLinks]
    : tenantLinks;

  useEffect(() => {
    // Only auto-launch the dashboard tour when the user is actually on the
    // dashboard. Without this gate, a brand-new tenant who lands on /autopilot
    // (or any other surface with its own tour) would have the dashboard tour
    // pop open over the page-specific tour and yank them back to /dashboard.
    if (
      !getTourCompleted() &&
      location.pathname === '/dashboard'
    ) {
      const t = setTimeout(() => setTourOpen(true), 1500);
      return () => clearTimeout(t);
    }
  }, [location.pathname]);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const sidebar = (
    <div className="flex flex-col h-full">
      <div className="px-6 py-5 border-b border-on-sidebar/15">
        <div className="flex items-center gap-2">
          {/* Real QVO logo per qvo-brand-kit. White lockup because the
              sidebar background is harbor-dark. Height matched to the
              previous wordmark text-lg so the layout doesn't shift. */}
          <img
            src="/brand/logo-lockup-white.png"
            alt={t('brand.name')}
            className="h-6 w-auto block"
            width="240"
            height="80"
          />
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-primary/30 text-on-sidebar uppercase tracking-wider">{t('tenant_nav.tenant_badge')}</span>
        </div>
        <p className="text-xs text-on-sidebar/70 mt-1 truncate" title={user?.email ?? undefined}>{user?.email}</p>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {primaryLinks.map((link) => {
          const tourKey = link.to === '/dashboard' ? 'dashboard'
            : link.to === '/agents' ? 'agents'
            : link.to === '/calls' ? 'conversations'
            : link.to === '/campaigns' ? 'campaigns'
            : link.to === '/analytics' ? 'analytics'
            : undefined;
          return (
            <div key={link.to}>
              <NavLink
                to={link.to}
                end={link.to === '/dashboard'}
                onClick={() => setMobileOpen(false)}
                data-tour={tourKey}
                className={({ isActive }) =>
                  clsx(
                    'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                    isActive
                      ? 'bg-primary-hover text-on-primary'
                      : 'text-sidebar-text hover:bg-sidebar-hover hover:text-on-sidebar',
                  )
                }
              >
                <link.icon className="h-4.5 w-4.5 shrink-0" />
                {t(link.i18nKey)}
              </NavLink>
              {link.to === '/calls' && !user?.isPlatformAdmin && (
                <PinnedCallViews onLinkClick={() => setMobileOpen(false)} />
              )}
            </div>
          );
        })}

        {isPlatformAdmin && (
          <>
            <NavGroup
              label={t('tenant_nav.operations')}
              icon={Boxes}
              links={operationsLinks}
              location={location}
              open={opsOpen}
              setOpen={setOpsOpen}
              groupRef={opsRef}
              onLinkClick={() => setMobileOpen(false)}
            />

            <NavGroup
              label={t('tenant_nav.configure')}
              icon={Wrench}
              links={configureLinks}
              location={location}
              open={configureOpen}
              setOpen={setConfigureOpen}
              groupRef={configureRef}
              onLinkClick={() => setMobileOpen(false)}
            />
          </>
        )}

        <NavLink
          key={settingsLink.to}
          to={settingsLink.to}
          onClick={() => setMobileOpen(false)}
          className={({ isActive }) =>
            clsx(
              'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors mt-1',
              isActive
                ? 'bg-primary-hover text-on-primary'
                : 'text-sidebar-text hover:bg-sidebar-hover hover:text-on-sidebar',
            )
          }
        >
          <settingsLink.icon className="h-4.5 w-4.5 shrink-0" />
          {t(settingsLink.i18nKey)}
        </NavLink>
      </nav>

      <div className="px-3 py-4 border-t border-on-sidebar/10 space-y-1">
        <PortalSwitcher />
        <LanguageSwitcher variant="sidebar" />
        <button
          onClick={toggle}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-sidebar-text hover:bg-sidebar-hover hover:text-on-sidebar w-full transition-colors"
        >
          {dark ? <Sun className="h-4.5 w-4.5" /> : <Moon className="h-4.5 w-4.5" />}
          {dark ? t('theme.light') : t('theme.dark')}
        </button>
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
    <div className="flex h-screen overflow-hidden">
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
        <aside className="h-full w-full">
          {sidebar}
        </aside>
      </Modal>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex items-center justify-between gap-3 px-4 py-2 bg-surface border-b border-border print:hidden">
          <div className="flex items-center gap-2 min-w-0">
            <button className="lg:hidden p-1.5 -ml-1.5" onClick={() => setMobileOpen(true)} aria-label={t('actions.open_menu')}>
              <Menu className="h-5 w-5" />
            </button>
            {/* Mobile-only QVO mark in the top bar (harbor on light header). */}
            <img
              src="/brand/logo-symbol-harbor.png"
              alt={t('brand.name')}
              className="h-6 w-auto block lg:hidden"
              width="80"
              height="80"
            />
          </div>
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-label={t('tenant_nav.command_search', { defaultValue: 'Search and run commands' })}
            className="hidden md:inline-flex items-center gap-2 px-3 py-1.5 text-xs text-text-secondary bg-surface-secondary hover:bg-surface-hover border border-border rounded-lg transition-colors max-w-md flex-1 mx-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            <Search className="h-3.5 w-3.5 text-text-muted" />
            <span className="flex-1 text-left">{t('tenant_nav.command_search', { defaultValue: 'Search & run commands' })}</span>
            <kbd className="hidden lg:inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-mono font-semibold text-text-muted bg-surface border border-border rounded">
              <span aria-hidden="true">⌘</span>K
            </kbd>
          </button>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label="Search"
              className="md:hidden p-2 rounded-lg hover:bg-surface-hover text-text-secondary transition-colors"
            >
              <Search className="h-5 w-5" />
            </button>
            {isPlatformAdmin && <ChangelogBadgeLink />}
            <NotificationsCenter />
          </div>
        </header>

        <div className="bg-surface-secondary print:hidden">
          <TrialBanner />
        </div>

        <main className="flex-1 overflow-y-auto p-4 lg:p-8 print:p-0 print:overflow-visible">
          <div key={location.pathname} className="tenant-page-transition">
            <Outlet />
          </div>
        </main>
        <AppFooter />
      </div>

      <PlatformAssistant />
      <HelpDrawer />

      <div data-tour="help">
        <HelpWidget
          open={helpOpen}
          setOpen={setHelpOpen}
          onOpenShortcuts={() => setShortcutsOpen(true)}
          onStartTour={() => setTourOpen(true)}
        />
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenHelp={() => setHelpOpen(true)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onStartTour={() => setTourOpen(true)}
      />

      <KeyboardShortcuts open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      <ProductTour
        active={tourOpen}
        onClose={() => setTourOpen(false)}
        steps={isPlatformAdmin
          ? dashboardTour
          : dashboardTour.filter((step) => step.selector === '[data-tour="conversations"]' || step.selector === '[data-tour="help"]')}
        tourId="dashboard"
      />
    </div>
  );
}

function ChangelogBadgeLink() {
  const { t } = useTranslation();
  const { data } = useQuery({
    queryKey: ['changelog-unread'],
    queryFn: () => api.get<{ count: number }>('/platform/changelog/unread-count').catch(() => ({ count: 0 })),
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
  const count = data?.count ?? 0;
  return (
    <NavLink
      to="/changelog"
      className="relative p-2 rounded-lg hover:bg-surface-hover text-text-secondary transition-colors"
      aria-label={t('tenant_nav.whats_new')}
      title={t('tenant_nav.whats_new')}
    >
      <Sparkles className="h-5 w-5" />
      {count > 0 && (
        <span className="absolute top-1 right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-primary text-on-primary text-[10px] font-bold flex items-center justify-center">
          {count > 9 ? '9+' : count}
        </span>
      )}
    </NavLink>
  );
}

interface PinnedView {
  id: string;
  name: string;
  count: number | null;
}

function PinnedCallViews({ onLinkClick }: { onLinkClick: () => void }) {
  const { data } = useQuery({
    queryKey: ['call-saved-views', 'pinned'],
    queryFn: () => api.get<{ views: PinnedView[] }>('/call-saved-views/pinned').catch(() => ({ views: [] as PinnedView[] })),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const views = data?.views ?? [];
  if (views.length === 0) return null;
  return (
    <div className="mt-1 ml-3 pl-3 border-l border-on-sidebar/10 space-y-0.5">
      {views.map((view) => (
        <NavLink
          key={view.id}
          to={`/calls?view=${encodeURIComponent(view.id)}`}
          onClick={onLinkClick}
          className={({ isActive }) =>
            clsx(
              'flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
              isActive
                ? 'bg-primary-hover text-on-primary'
                : 'text-sidebar-text hover:bg-sidebar-hover hover:text-on-sidebar',
            )
          }
          title={view.name}
        >
          <span className="flex items-center gap-2 min-w-0">
            <Pin className="h-3 w-3 shrink-0" />
            <span className="truncate">{view.name}</span>
          </span>
          {view.count != null && (
            <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-on-sidebar/10 text-sidebar-text">
              {view.count > 999 ? '999+' : view.count}
            </span>
          )}
        </NavLink>
      ))}
    </div>
  );
}

interface NavGroupProps {
  label: string;
  icon: typeof LayoutDashboard;
  links: NavItem[];
  location: { pathname: string };
  open: boolean;
  setOpen: (v: boolean) => void;
  groupRef: React.RefObject<HTMLDivElement | null>;
  onLinkClick: () => void;
}

function NavGroup({ label, icon: Icon, links, location, open, setOpen, groupRef, onLinkClick }: NavGroupProps) {
  const { t } = useTranslation();
  const isActiveGroup = links.some((l) => location.pathname.startsWith(l.to));
  const panelId = `nav-group-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <div className="pt-2" ref={groupRef}>
      <button
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) {
            setTimeout(() => {
              groupRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
            }, 50);
          }
        }}
        aria-expanded={open}
        aria-controls={panelId}
        className={clsx(
          'flex items-center justify-between w-full px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
          isActiveGroup
            ? 'text-on-sidebar bg-sidebar-active/50'
            : 'text-sidebar-text hover:bg-sidebar-hover hover:text-on-sidebar',
        )}
      >
        <div className="flex items-center gap-3">
          <Icon className="h-4.5 w-4.5 shrink-0" />
          {label}
        </div>
        <ChevronDown
          className={clsx(
            'h-3.5 w-3.5 transition-transform',
            open && 'rotate-180',
          )}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div
          id={panelId}
          role="region"
          aria-label={label}
          className="mt-1 ml-3 pl-3 border-l border-on-sidebar/10 space-y-0.5"
        >
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              onClick={onLinkClick}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary-hover text-on-primary'
                    : 'text-sidebar-text hover:bg-sidebar-hover hover:text-on-sidebar',
                )
              }
            >
              <link.icon className="h-4 w-4 shrink-0" />
              {t(link.i18nKey)}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}
