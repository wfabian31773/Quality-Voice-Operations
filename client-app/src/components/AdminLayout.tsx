import '../styles/tw-app.css';
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';
import {
  BarChart3,
  Store,
  CreditCard,
  Shield,
  Compass,
  Inbox,
  LayoutDashboard,
  Upload,
} from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import GlobalScopeBanner from './GlobalScopeBanner';
import TenantScopePicker from './TenantScopePicker';
import ConsoleShell from './console/ConsoleShell';
import type { NavGroup } from '../lib/roleLabel';

/**
 * Admin sidebar grouped into purposeful sections so the long route list
 * scans cleanly. Each group renders as a small uppercase eyebrow with the
 * routes underneath. New routes added to the admin console should be
 * filed into one of the existing groups (or a new group added here) so
 * the chrome stays consistent across pages.
 */
const ADMIN_GROUPS: NavGroup[] = [
  {
    i18nKey: 'admin_nav.groups.overview',
    items: [
      { to: '/admin/dashboard', icon: LayoutDashboard, i18nKey: 'admin_nav.tenants', exact: true },
      { to: '/admin/analytics', icon: BarChart3, i18nKey: 'admin_nav.analytics' },
    ],
  },
  {
    i18nKey: 'admin_nav.groups.tenants_growth',
    items: [
      { to: '/admin/sales-inbox', icon: Inbox, i18nKey: 'admin_nav.sales_inbox' },
      { to: '/admin/marketplace', icon: Store, i18nKey: 'admin_nav.marketplace' },
      { to: '/admin/billing', icon: CreditCard, i18nKey: 'admin_nav.billing' },
    ],
  },
  {
    i18nKey: 'admin_nav.groups.operations',
    items: [
      { to: '/admin/security', icon: Shield, i18nKey: 'admin_nav.security' },
      { to: '/admin/governance', icon: Compass, i18nKey: 'admin_nav.governance' },
      { to: '/admin/ingest-backfill', icon: Upload, i18nKey: 'admin_nav.ingest_backfill' },
    ],
  },
];

interface TenantSummaryLite {
  id: string;
  name: string;
  slug: string;
}

function tenantIdFromPath(pathname: string): string | null {
  const m = /^\/admin\/analytics\/tenants\/([^/]+)/.exec(pathname);
  return m ? m[1] : null;
}

export default function AdminLayout() {
  const { user } = useAuth();
  const location = useLocation();
  const { t } = useTranslation();

  const scopedTenantId = tenantIdFromPath(location.pathname);

  const { data: tenantsData } = useQuery({
    queryKey: ['scope-picker-tenants'],
    queryFn: () => api.get<{ tenants: TenantSummaryLite[] }>('/platform/tenants'),
    staleTime: 60_000,
    enabled: !!user?.isPlatformAdmin,
  });
  const scopedTenant = useMemo(
    () =>
      scopedTenantId
        ? (tenantsData?.tenants ?? []).find((t) => t.id === scopedTenantId) ?? null
        : null,
    [tenantsData, scopedTenantId],
  );

  const banner = scopedTenantId ? (
    <GlobalScopeBanner
      variant="tenant"
      compact
      tenantName={scopedTenant?.name ?? scopedTenantId}
      tenantSlug={scopedTenant?.slug}
    />
  ) : (
    <GlobalScopeBanner variant="global" compact />
  );

  return (
    <ConsoleShell
      badge={{
        label: 'admin_nav.badge',
        accentClass: 'bg-accent/30',
        dotClass: 'bg-accent',
        pillClass: 'border border-accent/40 bg-accent-light text-accent',
      }}
      navGroups={ADMIN_GROUPS}
      navAriaLabel={t('admin_nav.console')}
      headerTitle={t('admin_nav.console')}
      headerTitleShort={t('admin_nav.badge')}
      headerActionsBefore={<TenantScopePicker />}
      belowHeaderBanner={banner}
    />
  );
}
