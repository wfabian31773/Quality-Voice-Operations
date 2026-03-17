import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import {
  Building2, BarChart3, Store, Brain, CreditCard, Shield,
  LogOut, Moon, Sun, Menu, X, Cpu, Filter, Globe,
} from 'lucide-react';
import { useState } from 'react';
import clsx from 'clsx';
import PlatformAssistant from './PlatformAssistant';

interface NavItem {
  to: string;
  icon: typeof Building2;
  label: string;
}

const adminLinks: NavItem[] = [
  { to: '/admin/dashboard', icon: Building2, label: 'Tenants' },
  { to: '/admin/analytics', icon: BarChart3, label: 'Global Analytics' },
  { to: '/admin/marketplace', icon: Store, label: 'Marketplace Management' },
  { to: '/admin/autopilot', icon: Brain, label: 'Autopilot Governance' },
  { to: '/admin/billing', icon: CreditCard, label: 'Billing & Usage' },
  { to: '/admin/security', icon: Shield, label: 'Security Controls' },
  { to: '/admin/evolution', icon: Cpu, label: 'Evolution Engine' },
  { to: '/admin/conversion', icon: Filter, label: 'Conversion Funnel' },
  { to: '/admin/intelligence', icon: Globe, label: 'Global Intelligence' },
];

export default function AdminLayout() {
  const { user, logout } = useAuth();
  const { dark, toggle } = useTheme();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const sidebar = (
    <div className="flex flex-col h-full">
      <div className="px-6 py-5 border-b border-purple-500/20">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold text-white tracking-tight font-display">QVO</h1>
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 uppercase tracking-wider">Platform Admin</span>
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
                  ? 'bg-purple-600/30 text-white'
                  : 'text-sidebar-text hover:bg-purple-600/10 hover:text-white',
              )
            }
          >
            <link.icon className="h-4.5 w-4.5 shrink-0" />
            {link.label}
          </NavLink>
        ))}
      </nav>

      <div className="px-3 py-4 border-t border-purple-500/20 space-y-1">
        <button
          onClick={() => navigate('/dashboard')}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-sidebar-text hover:bg-purple-600/10 hover:text-white w-full transition-colors"
        >
          <Building2 className="h-4.5 w-4.5" />
          Tenant Portal
        </button>
        <button
          onClick={toggle}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-sidebar-text hover:bg-purple-600/10 hover:text-white w-full transition-colors"
        >
          {dark ? <Sun className="h-4.5 w-4.5" /> : <Moon className="h-4.5 w-4.5" />}
          {dark ? 'Light Mode' : 'Dark Mode'}
        </button>
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-sidebar-text hover:bg-purple-600/10 hover:text-white w-full transition-colors"
        >
          <LogOut className="h-4.5 w-4.5" />
          Sign Out
        </button>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="hidden lg:flex w-64 shrink-0 bg-sidebar-bg flex-col border-r border-purple-500/10">
        {sidebar}
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setMobileOpen(false)} />
          <aside className="relative w-64 h-full bg-sidebar-bg">
            {sidebar}
          </aside>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        <header className="flex items-center justify-between px-4 py-2 bg-purple-900/20 border-b border-purple-500/20">
          <div className="flex items-center gap-3">
            <button className="lg:hidden" onClick={() => setMobileOpen(true)}>
              {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
            <span className="text-xs font-semibold text-purple-400 uppercase tracking-wider">Platform Admin Console</span>
          </div>
          <div className="w-5 lg:hidden" />
        </header>

        <main className="flex-1 overflow-y-auto p-4 lg:p-8">
          <Outlet />
        </main>
      </div>

      <PlatformAssistant />
    </div>
  );
}
