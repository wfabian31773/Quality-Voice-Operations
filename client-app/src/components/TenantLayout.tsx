import { NavLink, Outlet, useNavigate, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { api } from '../lib/api';
import {
  LayoutDashboard, Bot, PhoneCall, Plug, Network,
  LogOut, Moon, Sun, Menu, BarChart3, Settings2,
  Megaphone, BookOpen, Store, ChevronDown, Boxes, Wrench,
  MessageSquare, CalendarClock, ClipboardList, Truck,
} from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import clsx from 'clsx';
import PlatformAssistant from './PlatformAssistant';
import PortalSwitcher from './PortalSwitcher';
import AppFooter from './AppFooter';
import { HelpDrawer } from './HelpDrawer';
import TrialBanner from './TrialBanner';
import NotificationsCenter from './NotificationsCenter';
import { Sparkles } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import CommandPalette from './CommandPalette';
import HelpWidget from './HelpWidget';
import KeyboardShortcuts from './KeyboardShortcuts';
import ProductTour, { getTourCompleted } from './ProductTour';

interface NavItem {
  to: string;
  icon: typeof LayoutDashboard;
  label: string;
}

const tenantLinks: NavItem[] = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/agents', icon: Bot, label: 'Agents' },
  { to: '/calls', icon: PhoneCall, label: 'Conversations' },
  { to: '/campaigns', icon: Megaphone, label: 'Campaigns' },
  { to: '/analytics', icon: BarChart3, label: 'Analytics' },
];

const operationsLinks: NavItem[] = [
  { to: '/sms-inbox', icon: MessageSquare, label: 'SMS Inbox' },
  { to: '/scheduling', icon: CalendarClock, label: 'Scheduling' },
  { to: '/tickets', icon: ClipboardList, label: 'Tickets' },
  { to: '/dispatch', icon: Truck, label: 'Dispatch' },
];

const configureLinks: NavItem[] = [
  { to: '/workflows', icon: Network, label: 'Workflows' },
  { to: '/connectors', icon: Plug, label: 'Integrations' },
  { to: '/knowledge-base', icon: BookOpen, label: 'Knowledge' },
  { to: '/marketplace', icon: Store, label: 'Marketplace' },
];

const settingsLink: NavItem = { to: '/settings', icon: Settings2, label: 'Settings' };

export default function TenantLayout() {
  const { user, logout } = useAuth();
  const { dark, toggle } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const opsRef = useRef<HTMLDivElement>(null);
  const configureRef = useRef<HTMLDivElement>(null);
  const [opsOpen, setOpsOpen] = useState(() =>
    operationsLinks.some((l) => location.pathname.startsWith(l.to)),
  );
  const [configureOpen, setConfigureOpen] = useState(() =>
    configureLinks.some((l) => location.pathname.startsWith(l.to)),
  );
  const [needsOnboarding, setNeedsOnboarding] = useState<boolean | null>(null);
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
          setShortcutsOpen(true);
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

  useEffect(() => {
    if (needsOnboarding === false && !getTourCompleted()) {
      const t = setTimeout(() => setTourOpen(true), 1500);
      return () => clearTimeout(t);
    }
  }, [needsOnboarding]);

  useEffect(() => {
    if (user?.isPlatformAdmin) {
      setNeedsOnboarding(false);
      return;
    }
    let cancelled = false;
    api
      .get<{ status: string; phoneNumberCount: number; tenantCreatedAt: string | null }>(
        '/tenants/me/provisioning-status',
      )
      .then((data) => {
        if (cancelled) return;
        if (data.status !== 'ready') {
          setNeedsOnboarding(true);
          return;
        }
        if (data.phoneNumberCount === 0 && data.tenantCreatedAt) {
          const createdAt = new Date(data.tenantCreatedAt).getTime();
          const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
          if (createdAt > oneDayAgo) {
            setNeedsOnboarding(true);
            return;
          }
        }
        setNeedsOnboarding(false);
      })
      .catch(() => {
        if (!cancelled) setNeedsOnboarding(false);
      });
    return () => { cancelled = true; };
  }, [location.pathname, user?.isPlatformAdmin]);

  if (needsOnboarding === null) {
    return (
      <div className="flex items-center justify-center h-screen bg-surface-secondary">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  const onboardingAllowedPaths = ['/onboarding', '/phone-numbers', '/agents', '/marketplace'];
  const isOnboardingAllowedPath = onboardingAllowedPaths.some(
    (p) => location.pathname === p || location.pathname.startsWith(p + '/'),
  );

  if (needsOnboarding && !isOnboardingAllowedPath) {
    return <Navigate to="/onboarding" replace />;
  }

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const sidebar = (
    <div className="flex flex-col h-full">
      <div className="px-6 py-5 border-b border-white/10">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold text-white tracking-tight font-display">QVO</h1>
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300 uppercase tracking-wider">Tenant</span>
        </div>
        <p className="text-xs text-sidebar-text mt-0.5 truncate">{user?.email}</p>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {tenantLinks.map((link) => {
          const tourKey = link.to === '/dashboard' ? 'dashboard'
            : link.to === '/agents' ? 'agents'
            : link.to === '/calls' ? 'conversations'
            : link.to === '/campaigns' ? 'campaigns'
            : link.to === '/analytics' ? 'analytics'
            : undefined;
          return (
            <NavLink
              key={link.to}
              to={link.to}
              end={link.to === '/dashboard'}
              onClick={() => setMobileOpen(false)}
              data-tour={tourKey}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-sidebar-active text-white'
                    : 'text-sidebar-text hover:bg-sidebar-hover hover:text-white',
                )
              }
            >
              <link.icon className="h-4.5 w-4.5 shrink-0" />
              {link.label}
            </NavLink>
          );
        })}

        <NavGroup
          label="Operations"
          icon={Boxes}
          links={operationsLinks}
          location={location}
          open={opsOpen}
          setOpen={setOpsOpen}
          groupRef={opsRef}
          onLinkClick={() => setMobileOpen(false)}
        />

        <NavGroup
          label="Configure"
          icon={Wrench}
          links={configureLinks}
          location={location}
          open={configureOpen}
          setOpen={setConfigureOpen}
          groupRef={configureRef}
          onLinkClick={() => setMobileOpen(false)}
        />

        <NavLink
          key={settingsLink.to}
          to={settingsLink.to}
          onClick={() => setMobileOpen(false)}
          className={({ isActive }) =>
            clsx(
              'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors mt-1',
              isActive
                ? 'bg-sidebar-active text-white'
                : 'text-sidebar-text hover:bg-sidebar-hover hover:text-white',
            )
          }
        >
          <settingsLink.icon className="h-4.5 w-4.5 shrink-0" />
          {settingsLink.label}
        </NavLink>
      </nav>

      <div className="px-3 py-4 border-t border-white/10 space-y-1">
        <PortalSwitcher />
        <button
          onClick={toggle}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-sidebar-text hover:bg-sidebar-hover hover:text-white w-full transition-colors"
        >
          {dark ? <Sun className="h-4.5 w-4.5" /> : <Moon className="h-4.5 w-4.5" />}
          {dark ? 'Light Mode' : 'Dark Mode'}
        </button>
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-sidebar-text hover:bg-sidebar-hover hover:text-white w-full transition-colors"
        >
          <LogOut className="h-4.5 w-4.5" />
          Sign Out
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="hidden lg:flex w-64 shrink-0 bg-sidebar-bg flex-col print:hidden">
        {sidebar}
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden print:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
          <aside className="relative w-64 h-full bg-sidebar-bg">
            {sidebar}
          </aside>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        <TrialBanner />
        <header className="flex items-center justify-between px-4 py-2 bg-surface border-b border-border print:hidden">
          <div className="flex items-center gap-2">
            <button className="lg:hidden p-1.5 -ml-1.5" onClick={() => setMobileOpen(true)} aria-label="Open menu">
              <Menu className="h-5 w-5" />
            </button>
            <span className="font-semibold text-sm font-display lg:hidden">QVO</span>
          </div>
          <div className="flex items-center gap-1">
            <ChangelogBadgeLink />
            <NotificationsCenter />
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 lg:p-8 print:p-0 print:overflow-visible">
          <Outlet />
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

      <ProductTour active={tourOpen} onClose={() => setTourOpen(false)} />
    </div>
  );
}

function ChangelogBadgeLink() {
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
      aria-label="What's new"
      title="What's new"
    >
      <Sparkles className="h-5 w-5" />
      {count > 0 && (
        <span className="absolute top-1 right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-primary text-white text-[10px] font-bold flex items-center justify-center">
          {count > 9 ? '9+' : count}
        </span>
      )}
    </NavLink>
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
  const isActiveGroup = links.some((l) => location.pathname.startsWith(l.to));
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
        className={clsx(
          'flex items-center justify-between w-full px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
          isActiveGroup
            ? 'text-white bg-sidebar-active/50'
            : 'text-sidebar-text hover:bg-sidebar-hover hover:text-white',
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
        />
      </button>

      {open && (
        <div className="mt-1 ml-3 pl-3 border-l border-white/10 space-y-0.5">
          {links.map((link) => (
            <NavLink
              key={link.to}
              to={link.to}
              onClick={onLinkClick}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-sidebar-active text-white'
                    : 'text-sidebar-text hover:bg-sidebar-hover hover:text-white',
                )
              }
            >
              <link.icon className="h-4 w-4 shrink-0" />
              {link.label}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );
}
