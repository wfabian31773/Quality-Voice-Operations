import '../styles/tw-app.css';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import {
  Radio, Bug, Plug2, Coins, ShieldCheck,
  LogOut, Moon, Sun, Menu, X, Cpu, Repeat,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import clsx from 'clsx';
import PlatformAssistant from './PlatformAssistant';
import PortalSwitcher from './PortalSwitcher';
import AppFooter from './AppFooter';
import NotificationsCenter from './NotificationsCenter';
import Modal from './Modal';

interface NavItem {
  to: string;
  icon: typeof Radio;
  label: string;
}

const opsLinks: NavItem[] = [
  { to: '/ops/monitor', icon: Radio, label: 'Live Monitor' },
  { to: '/ops/reliability', icon: ShieldCheck, label: 'Reliability' },
  { to: '/ops/backfill-calls', icon: Repeat, label: 'Backfill calls' },
  { to: '/ops/call-debug', icon: Bug, label: 'Debugger' },
  { to: '/ops/integration-diagnostics', icon: Plug2, label: 'Diagnostics' },
  { to: '/ops/cost', icon: Coins, label: 'Cost' },
  { to: '/ops/digital-twin', icon: Cpu, label: 'Digital Twin' },
];

export default function OpsLayout() {
  const { user, logout } = useAuth();
  const { dark, toggle } = useTheme();
  const navigate = useNavigate();
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
      <div className="px-6 py-5 border-b border-on-sidebar/10">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold text-on-sidebar tracking-tight font-display">QVO</h1>
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-success/30 text-on-sidebar uppercase tracking-wider">Operations</span>
        </div>
        <p className="text-xs text-sidebar-text mt-0.5 truncate">{user?.email}</p>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {opsLinks.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.to === '/ops/monitor'}
            onClick={() => setMobileOpen(false)}
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
            {link.label}
          </NavLink>
        ))}
      </nav>

      <div className="px-3 py-4 border-t border-on-sidebar/10 space-y-1">
        <PortalSwitcher />
        <button
          onClick={toggle}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-sidebar-text hover:bg-sidebar-hover hover:text-on-sidebar w-full transition-colors"
        >
          {dark ? <Sun className="h-4.5 w-4.5" /> : <Moon className="h-4.5 w-4.5" />}
          {dark ? 'Light Mode' : 'Dark Mode'}
        </button>
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-sidebar-text hover:bg-sidebar-hover hover:text-on-sidebar w-full transition-colors"
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

      <Modal
        open={mobileOpen}
        onClose={() => setMobileOpen(false)}
        ariaLabel="Open navigation menu"
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
              aria-label="Open navigation menu"
              aria-expanded={mobileOpen}
            >
              {mobileOpen ? <X className="h-5 w-5" aria-hidden="true" /> : <Menu className="h-5 w-5" aria-hidden="true" />}
            </button>
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-primary">
              <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
              Operations Console
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
