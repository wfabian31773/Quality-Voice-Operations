import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle, AlertCircle, TrendingUp, TrendingDown } from 'lucide-react';
import { api } from '../../../../lib/api';

/**
 * Activation Metrics admin tab — extracted from PlatformAdmin.tsx in
 * Phase 2.4. Includes the activation metric row type, the milestone-
 * progress MilestoneIcon, the MetricItem stat helper, the wizard-style
 * OnboardingFunnelCards (independent query of /platform/onboarding-funnel),
 * and the tab itself.
 */

interface ActivationMetricRow {
  tenant_id: string;
  tenant_name: string;
  tenant_plan: string;
  tenant_status: string;
  tenant_created_at: string;
  agent_created_at: string | null;
  agent_deployed_at: string | null;
  phone_connected_at: string | null;
  tools_connected_at: string | null;
  first_call_at: string | null;
  first_workflow_at: string | null;
  time_to_agent_hours: number | null;
  time_to_call_hours: number | null;
  time_to_workflow_hours: number | null;
  milestones_completed: number;
}

function MetricItem({ label, value, trend }: { label: string; value: string; trend?: 'up' | 'down' | 'neutral' }) {
  return (
    <div>
      <p className="text-xs text-text-muted mb-0.5">{label}</p>
      <div className="flex items-center gap-1">
        <span className="text-sm font-semibold">{value}</span>
        {trend === 'up' && <TrendingUp className="h-3 w-3 text-success" />}
        {trend === 'down' && <TrendingDown className="h-3 w-3 text-danger" />}
      </div>
    </div>
  );
}

function MilestoneIcon({ done }: { done: boolean }) {
  if (done) return <CheckCircle className="h-4 w-4 text-success" />;
  return <AlertCircle className="h-4 w-4 text-text-muted" />;
}

function OnboardingFunnelCards() {
  const { t: adminT } = useTranslation('admin');
  const [days, setDays] = useState(30);
  const { data, isLoading } = useQuery({
    queryKey: ['platform-onboarding-funnel', days],
    queryFn: () =>
      api.get<{ days: number; funnel: OnboardingFunnel }>(
        `/platform/onboarding-funnel?days=${days}`,
      ),
    refetchInterval: 60_000,
  });
  const funnel = data?.funnel;
  // Percent-of-total helper. Returns "—" when the total is 0 so the card
  // doesn't render a bogus "0%" the moment the platform is freshly
  // bootstrapped.
  const pct = (n: number | undefined): string => {
    if (!funnel || !funnel.total) return adminT('platform_admin.common.em_dash');
    const v = n ?? 0;
    return `${Math.round((v / funnel.total) * 100)}%`;
  };
  return (
    <div className="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="font-semibold">{adminT('platform_admin.onboarding_funnel.title')}</h2>
          <p className="text-xs text-text-muted">
            {adminT('platform_admin.onboarding_funnel.subtitle')}
          </p>
        </div>
        <select
          aria-label={adminT('platform_admin.onboarding_funnel.window_aria')}
          value={days}
          onChange={(e) => setDays(parseInt(e.target.value, 10))}
          className="text-sm border border-border rounded-lg px-2 py-1 bg-surface focus:outline-none focus:ring-2 focus:ring-primary/50"
        >
          <option value={7}>{adminT('platform_admin.onboarding_funnel.last_7_days')}</option>
          <option value={30}>{adminT('platform_admin.onboarding_funnel.last_30_days')}</option>
          <option value={90}>{adminT('platform_admin.onboarding_funnel.last_90_days')}</option>
        </select>
      </div>
      {isLoading ? (
        <div className="text-sm text-text-muted">{adminT('platform_admin.onboarding_funnel.loading')}</div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <div className="border border-border rounded-lg p-3">
            <div className="text-xs text-text-muted">{adminT('platform_admin.onboarding_funnel.new_owners')}</div>
            <div className="text-2xl font-bold">{funnel?.total ?? 0}</div>
            <div className="text-xs text-text-muted mt-1">{adminT('platform_admin.onboarding_funnel.in_window')}</div>
          </div>
          <div className="border border-border rounded-lg p-3">
            <div className="text-xs text-text-muted">{adminT('platform_admin.onboarding_funnel.step_1_provisioning')}</div>
            <div className="text-2xl font-bold text-warning">
              {funnel?.step_1 ?? 0}
            </div>
            <div className="text-xs text-text-muted mt-1">
              {adminT('platform_admin.onboarding_funnel.pct_of_new', { pct: pct(funnel?.step_1) })}
            </div>
          </div>
          <div className="border border-border rounded-lg p-3">
            <div className="text-xs text-text-muted">{adminT('platform_admin.onboarding_funnel.step_2_template')}</div>
            <div className="text-2xl font-bold text-warning">
              {funnel?.step_2 ?? 0}
            </div>
            <div className="text-xs text-text-muted mt-1">
              {adminT('platform_admin.onboarding_funnel.pct_of_new', { pct: pct(funnel?.step_2) })}
            </div>
          </div>
          <div className="border border-border rounded-lg p-3">
            <div className="text-xs text-text-muted">{adminT('platform_admin.onboarding_funnel.step_3_phone')}</div>
            <div className="text-2xl font-bold text-warning">
              {funnel?.step_3 ?? 0}
            </div>
            <div className="text-xs text-text-muted mt-1">
              {adminT('platform_admin.onboarding_funnel.pct_of_new', { pct: pct(funnel?.step_3) })}
            </div>
          </div>
          <div className="border border-border rounded-lg p-3">
            <div className="text-xs text-text-muted">{adminT('platform_admin.onboarding_funnel.completed')}</div>
            <div className="text-2xl font-bold text-success">
              {funnel?.completed ?? 0}
            </div>
            <div className="text-xs text-text-muted mt-1">
              {adminT('platform_admin.onboarding_funnel.pct_of_new', { pct: pct(funnel?.completed) })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function ActivationMetricsTab() {
  const { t: adminT } = useTranslation('admin');
  const { data, isLoading: loading } = useQuery({
    queryKey: ['platform-activation-metrics'],
    queryFn: () => api.get<{ metrics: ActivationMetricRow[] }>('/platform/activation-metrics'),
    refetchInterval: 60_000,
  });
  // Render the wizard funnel even if the per-tenant activation table is
  // still loading or empty — the two are independent queries and product
  // cares about the funnel even on a fresh platform with no completed
  // activations yet.
  if (loading) {
    return (
      <div className="space-y-6">
        <OnboardingFunnelCards />
        <div className="text-center py-12 text-text-muted">{adminT('platform_admin.activation_metrics.loading')}</div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="space-y-6">
        <OnboardingFunnelCards />
        <div className="text-center py-12 text-text-muted">{adminT('platform_admin.activation_metrics.no_data')}</div>
      </div>
    );
  }

  const metrics = data.metrics;
  const totalTenants = metrics.length;
  const withAgent = metrics.filter((m) => m.agent_created_at).length;
  const withCall = metrics.filter((m) => m.first_call_at).length;
  const withWorkflow = metrics.filter((m) => m.first_workflow_at).length;
  const stuckTenants = metrics.filter((m) => m.milestones_completed < 2 && m.milestones_completed > 0);

  const TOTAL_MILESTONES = 6;
  const avgTimeToAgent = metrics
    .filter((m) => m.time_to_agent_hours !== null)
    .reduce((sum, m, _, arr) => sum + (m.time_to_agent_hours ?? 0) / arr.length, 0);
  const avgTimeToCall = metrics
    .filter((m) => m.time_to_call_hours !== null)
    .reduce((sum, m, _, arr) => sum + (m.time_to_call_hours ?? 0) / arr.length, 0);
  const avgTimeToWorkflow = metrics
    .filter((m) => m.time_to_workflow_hours !== null)
    .reduce((sum, m, _, arr) => sum + (m.time_to_workflow_hours ?? 0) / arr.length, 0);

  return (
    <div className="space-y-6">
      <OnboardingFunnelCards />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="text-sm text-text-muted mb-1">{adminT('platform_admin.activation_metrics.agent_created')}</div>
          <div className="text-2xl font-bold">{withAgent} <span className="text-sm text-text-muted font-normal">/ {totalTenants}</span></div>
          <div className="text-xs text-text-muted mt-1">{adminT('platform_admin.activation_metrics.avg_time', { value: formatHours(avgTimeToAgent, adminT) })}</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="text-sm text-text-muted mb-1">{adminT('platform_admin.activation_metrics.first_call')}</div>
          <div className="text-2xl font-bold">{withCall} <span className="text-sm text-text-muted font-normal">/ {totalTenants}</span></div>
          <div className="text-xs text-text-muted mt-1">{adminT('platform_admin.activation_metrics.avg_time', { value: formatHours(avgTimeToCall, adminT) })}</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="text-sm text-text-muted mb-1">{adminT('platform_admin.activation_metrics.first_workflow')}</div>
          <div className="text-2xl font-bold">{withWorkflow} <span className="text-sm text-text-muted font-normal">/ {totalTenants}</span></div>
          <div className="text-xs text-text-muted mt-1">{adminT('platform_admin.activation_metrics.avg_time', { value: formatHours(avgTimeToWorkflow, adminT) })}</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="text-sm text-text-muted mb-1">{adminT('platform_admin.activation_metrics.stuck_tenants')}</div>
          <div className="text-2xl font-bold text-warning">{stuckTenants.length}</div>
          <div className="text-xs text-text-muted mt-1">{adminT('platform_admin.activation_metrics.stuck_subtitle')}</div>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="font-semibold">{adminT('platform_admin.activation_metrics.tenant_progress')}</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.activation_metrics.header_tenant')}</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.activation_metrics.header_plan')}</th>
                <th className="text-center px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.activation_metrics.header_agent')}</th>
                <th className="text-center px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.activation_metrics.header_deploy')}</th>
                <th className="text-center px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.activation_metrics.header_phone')}</th>
                <th className="text-center px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.activation_metrics.header_tools')}</th>
                <th className="text-center px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.activation_metrics.header_first_call')}</th>
                <th className="text-center px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.activation_metrics.header_workflow')}</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.activation_metrics.header_time_to_agent')}</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.activation_metrics.header_time_to_call')}</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.activation_metrics.header_time_to_workflow')}</th>
                <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.activation_metrics.header_progress')}</th>
              </tr>
            </thead>
            <tbody>
              {metrics.map((m) => (
                <tr key={m.tenant_id} className="border-b border-border last:border-0 hover:bg-surface-secondary/50">
                  <td className="px-4 py-3">
                    <div className="font-medium">{m.tenant_name}</div>
                    <div className="text-xs text-text-muted">{new Date(m.tenant_created_at).toLocaleDateString()}</div>
                  </td>
                  <td className="px-4 py-3"><PlanBadge plan={m.tenant_plan} /></td>
                  <td className="px-4 py-3 text-center"><MilestoneIcon done={!!m.agent_created_at} /></td>
                  <td className="px-4 py-3 text-center"><MilestoneIcon done={!!m.agent_deployed_at} /></td>
                  <td className="px-4 py-3 text-center"><MilestoneIcon done={!!m.phone_connected_at} /></td>
                  <td className="px-4 py-3 text-center"><MilestoneIcon done={!!m.tools_connected_at} /></td>
                  <td className="px-4 py-3 text-center"><MilestoneIcon done={!!m.first_call_at} /></td>
                  <td className="px-4 py-3 text-center"><MilestoneIcon done={!!m.first_workflow_at} /></td>
                  <td className="px-4 py-3 text-text-muted">{formatHours(m.time_to_agent_hours, adminT)}</td>
                  <td className="px-4 py-3 text-text-muted">{formatHours(m.time_to_call_hours, adminT)}</td>
                  <td className="px-4 py-3 text-text-muted">{formatHours(m.time_to_workflow_hours, adminT)}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="w-16 bg-surface-hover rounded-full h-2">
                        <div
                          className={`h-2 rounded-full ${
                            m.milestones_completed >= 5 ? 'bg-success' :
                            m.milestones_completed >= 3 ? 'bg-info' :
                            m.milestones_completed >= 1 ? 'bg-warning' : 'bg-text-text-muted/40'
                          }`}
                          style={{ width: `${Math.round((m.milestones_completed / TOTAL_MILESTONES) * 100)}%` }}
                        />
                      </div>
                      <span className="text-xs text-text-muted">{adminT('platform_admin.activation_metrics.milestones_progress', { done: m.milestones_completed, total: TOTAL_MILESTONES })}</span>
                    </div>
                  </td>
                </tr>
              ))}
              {metrics.length === 0 && (
                <tr><td colSpan={12} className="text-center py-12 text-text-muted">{adminT('platform_admin.activation_metrics.no_tenant_data')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default ActivationMetricsTab;
