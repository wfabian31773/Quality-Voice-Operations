import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Building2, Users, PhoneCall, DollarSign, ShieldAlert, TrendingUp } from 'lucide-react';

import { api } from '../../../lib/api';
import { StatCard, PageHeader } from '../../../components/ui';
import OperationsAlertsBanner from '../../../components/OperationsAlertsBanner';
import {
  PLATFORM_ADMIN_TABS,
  RecommendationBreakdownPanel,
  DiscountBreakdownPanel,
  formatCents,
  type PlatformStats,
  type BouncedRecipientStats,
  type RecommendationStatsShape,
  type DiscountStatsShape,
} from '../../PlatformAdmin';

/**
 * Chrome for the Platform Admin Dashboard nested route tree.
 *
 * Step D of the god-file split (plan §6 item #1). The 10,037-line
 * monolith used to render its own chrome AND switch its own tab body
 * with a useState. After steps A/B/C, every tab is a self-contained
 * component; this layout extracts the chrome (PageHeader, alerts banner,
 * StatCard grid, recommendation/discount detail panels, tab nav) and
 * renders the active tab via React Router's Outlet.
 *
 * Why this matters:
 *   - Each /admin/dashboard/<tab> URL is a real route, deep-linkable
 *     and bookmarkable.
 *   - Inactive tabs' queries (templates, analytics, cost-monitoring,
 *     activation, etc.) genuinely unmount, freeing memory + stopping
 *     their polling intervals. The audit's "8 uncoordinated 60s polls
 *     on a backgrounded tab" goes away naturally.
 *   - The 13 tab bodies are now individually code-split candidates
 *     (their route files can `lazy()` them in a follow-up).
 *
 * Always-on queries (stats, bounced, recommendation, discount) live
 * here because they power the StatCards that render on every tab.
 */
export default function PlatformAdminLayout() {
  const { t: adminT } = useTranslation('admin');
  const navigate = useNavigate();
  const [showRecommendationDetails, setShowRecommendationDetails] = useState(false);
  const [showDiscountDetails, setShowDiscountDetails] = useState(false);

  const { data: statsData, isLoading: statsLoading } = useQuery({
    queryKey: ['platform-stats'],
    queryFn: () => api.get<{ stats: PlatformStats }>('/platform/stats'),
    refetchInterval: 60_000,
  });

  // Hard-bounce dedup counter — same cadence as the rest of the
  // dashboard cards. Failures here must not hide the rest of the
  // chrome, so the card shows "—" if the query errors and the rest
  // of the page renders unaffected.
  const { data: bouncedStats, isLoading: bouncedStatsLoading } = useQuery({
    queryKey: ['support-bounced-recipient-stats'],
    queryFn: () =>
      api.get<BouncedRecipientStats>('/support/replies/bounced-recipients/stats'),
    refetchInterval: 60_000,
  });

  // 30d funnel for the BillingEstimator recommendation banner.
  const { data: recommendationStats, isLoading: recommendationStatsLoading } =
    useQuery({
      queryKey: ['platform-billing-recommendations'],
      queryFn: () =>
        api.get<RecommendationStatsShape>('/platform/billing-recommendations'),
      refetchInterval: 60_000,
    });

  // 30d discount-badge funnel rolled up by (couponId, promotionCode).
  const { data: discountStats, isLoading: discountStatsLoading } = useQuery({
    queryKey: ['platform-billing-discount-events'],
    queryFn: () =>
      api.get<DiscountStatsShape>('/platform/billing-discount-events'),
    refetchInterval: 60_000,
  });

  const stats = statsData?.stats;

  return (
    <div className="space-y-6">
      <PageHeader
        title={adminT('platform_admin.page_title')}
        description={adminT('platform_admin.page_subtitle')}
        icon={<Building2 className="h-5 w-5" />}
        className="mb-0"
      />

      <OperationsAlertsBanner />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatCard
          icon={Building2}
          label={adminT('platform_admin.stats.active_tenants')}
          value={statsLoading ? '...' : `${stats?.active_tenants ?? 0} / ${stats?.total_tenants ?? 0}`}
        />
        <StatCard
          icon={Users}
          label={adminT('platform_admin.stats.total_users')}
          value={statsLoading ? '...' : String(stats?.total_users ?? 0)}
        />
        <StatCard
          icon={PhoneCall}
          label={adminT('platform_admin.stats.calls_30d')}
          value={statsLoading ? '...' : `${stats?.calls_last_30d ?? 0}`}
          sub={statsLoading ? '' : adminT('platform_admin.stats.calls_24h_sub', { count: stats?.calls_last_24h ?? 0 })}
        />
        <StatCard
          icon={DollarSign}
          label={adminT('platform_admin.stats.revenue_30d')}
          value={statsLoading ? '...' : formatCents(stats?.revenue_last_30d_cents ?? '0')}
          sub={statsLoading ? '' : adminT('platform_admin.stats.revenue_total_sub', { amount: formatCents(stats?.total_revenue_cents ?? '0') })}
        />
        {/* Click jumps to the Support tab and scrolls to the
            BouncedRecipientsPanel. Hash navigation handles the scroll —
            the route is responsible for honoring `#bounced-recipients-panel`
            on mount. Cleaner than the old setTimeout-after-setActiveTab
            dance because the URL itself carries the intent. */}
        <StatCard
          icon={ShieldAlert}
          label={adminT('platform_admin.stats.bounced_label')}
          value={
            bouncedStatsLoading ? '...' : String(bouncedStats?.total ?? 0)
          }
          sub={
            bouncedStatsLoading
              ? ''
              : adminT('platform_admin.stats.bounced_sub', { week: bouncedStats?.last_7d ?? 0, month: bouncedStats?.last_30d ?? 0 })
          }
          tone={
            !bouncedStatsLoading && (bouncedStats?.last_7d ?? 0) > 0
              ? 'warning'
              : undefined
          }
          onClick={() => navigate('/admin/dashboard/support#bounced-recipients-panel')}
        />
        <StatCard
          icon={TrendingUp}
          label={adminT('platform_admin.stats.recommendation_label')}
          value={
            recommendationStatsLoading
              ? '...'
              : String(recommendationStats?.completedSwitches ?? 0)
          }
          sub={
            recommendationStatsLoading
              ? ''
              : adminT('platform_admin.stats.recommendation_sub', {
                  impressions: recommendationStats?.impressions ?? 0,
                  clicks: recommendationStats?.clicks ?? 0,
                  savings: formatCents(
                    recommendationStats?.totalMonthlySavingsCents ?? 0,
                  ),
                })
          }
          onClick={() => setShowRecommendationDetails((v) => !v)}
        />
        <StatCard
          icon={DollarSign}
          label={adminT('platform_admin.stats.discount_label')}
          value={
            discountStatsLoading
              ? '...'
              : String(discountStats?.completedSwitches ?? 0)
          }
          sub={
            discountStatsLoading
              ? ''
              : adminT('platform_admin.stats.discount_sub', {
                  impressions: discountStats?.impressions ?? 0,
                  clicks: discountStats?.clicks ?? 0,
                })
          }
          onClick={() => setShowDiscountDetails((v) => !v)}
        />
      </div>

      {showRecommendationDetails && (
        <RecommendationBreakdownPanel
          stats={recommendationStats}
          loading={recommendationStatsLoading}
          onClose={() => setShowRecommendationDetails(false)}
        />
      )}

      {showDiscountDetails && (
        <DiscountBreakdownPanel
          stats={discountStats}
          loading={discountStatsLoading}
          onClose={() => setShowDiscountDetails(false)}
        />
      )}

      <div
        role="tablist"
        aria-label={adminT('platform_admin.aria_tablist')}
        className="flex flex-wrap gap-1 border-b border-border overflow-x-auto"
      >
        {PLATFORM_ADMIN_TABS.map((t) => {
          const Icon = t.icon;
          return (
            <NavLink
              key={t.key}
              to={t.key}
              role="tab"
              className={({ isActive }) =>
                `inline-flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
                  isActive
                    ? 'border-primary text-primary'
                    : 'border-transparent text-text-muted hover:text-text-primary'
                }`
              }
              aria-selected={undefined /* NavLink owns aria-current; aria-selected on tabs would conflict */}
            >
              <Icon className="h-4 w-4" />
              {adminT(t.labelKey)}
            </NavLink>
          );
        })}
      </div>

      <Outlet />
    </div>
  );
}
