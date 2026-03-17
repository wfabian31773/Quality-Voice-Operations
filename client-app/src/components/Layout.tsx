import { NavLink, Outlet, useNavigate, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useTheme } from '../lib/theme';
import { api } from '../lib/api';
import {
  LayoutDashboard, Bot, Phone, PhoneCall, Plug, Users, Network,
  LogOut, Moon, Sun, Menu, X, Activity, BarChart3, Star, Settings2,
  Shield, ShieldCheck, Building2, Megaphone, CreditCard, BookOpen, MessageSquare, ArrowUpCircle, Store, Radio, Code2, TrendingUp, Sparkles, FlaskConical, Lightbulb, Brain, Cpu, Monitor, Globe, Coins, Bug, Filter,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import clsx from 'clsx';
import PlatformAssistant from './PlatformAssistant';

interface NavItem {
  to: string;
  icon: typeof LayoutDashboard;
  label: string;
  adminOnly?: boolean;
  platformAdminOnly?: boolean;
  allowedRoles?: string[];
}

const links: NavItem[] = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/command-center', icon: Monitor, label: 'Command Center' },
  { to: '/operations', icon: Radio, label: 'Operations' },
  { to: '/agents', icon: Bot, label: 'Agents' },
  { to: '/workflows', icon: Activity, label: 'Workflows', allowedRoles: ['tenant_owner', 'operations_manager'] },
  { to: '/workforce', icon: Network, label: 'AI Workforce' },
  { to: '/phone-numbers', icon: Phone, label: 'Phone Numbers' },
  { to: '/calls', icon: PhoneCall, label: 'Call History' },
  { to: '/call-debug', icon: Bug, label: 'Call Debugging' },
  { to: '/connectors', icon: Plug, label: 'Connectors' },
  { to: '/users', icon: Users, label: 'Users' },
  { to: '/campaigns', icon: Megaphone, label: 'Campaigns' },
  { to: '/billing', icon: CreditCard, label: 'Billing' },
  { to: '/knowledge-base', icon: BookOpen, label: 'Knowledge Base' },
  { to: '/cost-optimization', icon: Coins, label: 'Cost Optimization' },
  { to: '/analytics', icon: BarChart3, label: 'Analytics' },
  { to: '/revenue-analytics', icon: TrendingUp, label: 'Revenue & Performance' },
  { to: '/conversion-funnel', icon: Filter, label: 'Conversion Funnel', platformAdminOnly: true },
  { to: '/observability', icon: Activity, label: 'Observability' },
  { to: '/reliability', icon: ShieldCheck, label: 'Reliability' },
  { to: '/quality', icon: Star, label: 'Quality' },
  { to: '/insights', icon: Sparkles, label: 'Intelligence' },
  { to: '/autopilot', icon: Brain, label: 'Autopilot' },
  { to: '/global-intelligence', icon: Globe, label: 'Global Intelligence' },
  { to: '/simulation-lab', icon: FlaskConical, label: 'Simulation Lab' },
  { to: '/improvements', icon: Lightbulb, label: 'Improvements' },
  { to: '/digital-twin', icon: Cpu, label: 'Digital Twin' },
  { to: '/widget', icon: MessageSquare, label: 'Widget' },
  { to: '/marketplace', icon: Store, label: 'Marketplace' },
  { to: '/marketplace/updates', icon: ArrowUpCircle, label: 'Updates' },
  { to: '/developer', icon: Code2, label: 'Developer Portal' },
  { to: '/settings', icon: Settings2, label: 'Settings' },
  { to: '/compliance', icon: Shield, label: 'Security & Compliance', adminOnly: true },
  { to: '/audit-log', icon: Shield, label: 'Audit Log', adminOnly: true },
  { to: '/evolution', icon: Cpu, label: 'Evolution Engine', platformAdminOnly: true },
  { to: '/platform-admin', icon: Building2, label: 'Platform Admin', platformAdminOnly: true },
];

export default function Layout() {
  const { user, logout } = useAuth();
  const { dark, toggle } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [needsOnboarding, setNeedsOnboarding] = useState<boolean | null>(null);

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
        <h1 className="text-lg font-bold text-white tracking-tight font-display">QVO</h1>
        <p className="text-xs text-sidebar-text mt-0.5 truncate">{user?.email}</p>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
        {links
          .filter((link) => {
            if (link.platformAdminOnly && !user?.isPlatformAdmin) return false;
            if (link.allowedRoles) {
              const r = user?.role ?? '';
              if (!link.allowedRoles.includes(r)) return false;
            }
            if (link.adminOnly) {
              const r = user?.role ?? '';
              const isAdmin = ['tenant_owner', 'operations_manager', 'billing_admin', 'agent_developer'].includes(r);
              if (!isAdmin) return false;
            }
            return true;
          })
          .map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            end={link.to === '/dashboard'}
            onClick={() => setMobileOpen(false)}
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
        ))}
      </nav>

      <div className="px-3 py-4 border-t border-white/10 space-y-1">
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
      <aside className="hidden lg:flex w-64 shrink-0 bg-sidebar-bg flex-col">
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
        <header className="lg:hidden flex items-center justify-between px-4 py-3 bg-surface border-b border-border">
          <button onClick={() => setMobileOpen(true)}>
            {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
          <span className="font-semibold text-sm font-display">QVO</span>
          <div className="w-5" />
        </header>

        <main className="flex-1 overflow-y-auto p-4 lg:p-8">
          <Outlet />
        </main>
      </div>

      <PlatformAssistant />
    </div>
  );
}
