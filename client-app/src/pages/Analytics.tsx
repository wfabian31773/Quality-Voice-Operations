import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { formatCents as formatCentsHelper } from '../lib/formatCurrency';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import RevenueAnalytics from './RevenueAnalytics';
import {
  dashboards,
  getDashboardByKey,
  pickDashboardForIndustry,
  type DashboardKpiMetric,
  type DashboardRange,
  type DashboardSection,
  type VerticalDashboard,
} from './analytics/dashboards';

interface ToolHealthMetric {
  toolName: string;
  totalExecutions: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  retryCount: number;
  avgDurationMs: number;
}

interface ToolHealthResponse {
  tools: ToolHealthMetric[];
  overallSuccessRate: number;
  totalExecutions: number;
  totalFailures: number;
  callCompletionRate: number;
  escalationStats: { pending: number; inProgress: number; total: number };
}

interface CallAnalytics {
  totalCalls: number;
  inboundCalls: number;
  outboundCalls: number;
  avgDurationSeconds: number;
  completedCalls: number;
  failedCalls: number;
  escalatedCalls: number;
  automationRate: number;
  totalCostCents: number;
  costPerCallCents: number;
  dailyBreakdown: Array<{
    date: string;
    calls: number;
    avgDuration: number;
    inbound: number;
    outbound: number;
  }>;
}

interface CampaignRow {
  campaignId: string;
  campaignName: string;
  totalContacts: number;
  completedContacts: number;
  pendingContacts: number;
  failedContacts: number;
  optedOutContacts: number;
  voicemailContacts: number;
  noAnswerContacts: number;
  answeredRate: number;
  voicemailRate: number;
  completionRate: number;
  avgDurationSeconds: number;
  costPerContactCents: number;
}

interface CostAnalytics {
  totalOpenaiCostCents: number;
  totalTwilioCostCents: number;
  totalCostCents: number;
  totalCalls: number;
  costPerCallCents: number;
}

interface TenantMeResponse {
  tenant: {
    id: string;
    settings?: { industry?: string | null } | null;
  };
}

const RANGES: DashboardRange[] = ['7d', '30d', '90d'];

type AnalyticsTab = 'performance' | 'revenue';

export default function Analytics() {
  const { data: tenantMe } = useQuery({
    queryKey: ['tenants-me'],
    queryFn: () => api.get<TenantMeResponse>('/tenants/me'),
    staleTime: 5 * 60_000,
  });

  const tenantIndustry = tenantMe?.tenant?.settings?.industry ?? null;
  const defaultDashboard = useMemo(
    () => pickDashboardForIndustry(tenantIndustry),
    [tenantIndustry],
  );

  const [dashboardKey, setDashboardKey] = useState<string | null>(null);
  const dashboard: VerticalDashboard =
    dashboardKey != null ? getDashboardByKey(dashboardKey) : defaultDashboard;

  const [range, setRange] = useState<DashboardRange>(defaultDashboard.defaultRange);
  const [tab, setTab] = useState<AnalyticsTab>('performance');

  // Keep `range` synchronized with the active dashboard's preferred default —
  // this covers two cases the architect flagged:
  //   1. /tenants/me resolves after first render and changes the default
  //      dashboard (e.g. restaurant → 7d), so the initial range value
  //      (general → 30d) would otherwise be stale.
  //   2. The user picks a different dashboard from the dropdown; each vertical
  //      curates its own default window and we honor that on switch.
  // The user can still override the range afterwards via the range buttons.
  useEffect(() => {
    setRange(dashboard.defaultRange);
  }, [dashboard.key, dashboard.defaultRange]);

  const { data: calls, isLoading: callsLoading } = useQuery({
    queryKey: ['analytics-calls', range],
    queryFn: () => api.get<CallAnalytics>(`/analytics/calls?range=${range}`),
    refetchInterval: 120_000,
  });

  const { data: campaignData, isLoading: campaignsLoading } = useQuery({
    queryKey: ['analytics-campaigns', range],
    queryFn: () => api.get<{ campaigns: CampaignRow[] }>(`/analytics/campaigns?range=${range}`),
    refetchInterval: 120_000,
  });

  const { data: costs, isLoading: costsLoading } = useQuery({
    queryKey: ['analytics-costs', range],
    queryFn: () => api.get<CostAnalytics>(`/analytics/costs?range=${range}`),
    refetchInterval: 120_000,
  });

  const { data: toolHealth, isLoading: healthLoading } = useQuery({
    queryKey: ['tool-health-summary', range],
    queryFn: () => api.get<ToolHealthResponse>(`/tool-health/metrics?window=${range}`),
    refetchInterval: 120_000,
  });

  const navigate = useNavigate();

  const formatCents = (cents: number) => formatCentsHelper(cents);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-2xl" aria-hidden="true">{dashboard.emoji}</span>
            <h1 className="text-2xl font-bold">Analytics</h1>
            {dashboard.key !== 'general' && (
              <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                {dashboard.label}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {dashboard.description} Scoped to your tenant only — platform-wide metrics live in the Admin Console.
          </p>
        </div>
        {tab === 'performance' && (
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="vertical-dashboard-select">Dashboard</label>
            <select
              id="vertical-dashboard-select"
              data-testid="vertical-dashboard-select"
              value={dashboard.key}
              onChange={(e) => setDashboardKey(e.target.value)}
              className="bg-surface border border-border text-text-primary text-sm rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-primary"
            >
              {dashboards.map((d) => (
                <option key={d.key} value={d.key}>
                  {d.emoji} {d.label}
                </option>
              ))}
            </select>
            <div className="flex gap-1 bg-surface-hover rounded-lg p-1">
              {RANGES.map((r) => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  className={clsx(
                    'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                    range === r
                      ? 'bg-surface shadow text-text-primary'
                      : 'text-text-secondary hover:text-text-primary',
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="border-b border-border">
        <div className="flex gap-0">
          {([
            { key: 'performance', label: 'Performance' },
            { key: 'revenue', label: 'Revenue & Sentiment' },
          ] as const).map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={clsx(
                'px-4 py-2.5 text-sm font-medium border-b-2 transition-colors',
                tab === t.key
                  ? 'border-primary text-text-primary'
                  : 'border-transparent text-text-secondary hover:text-text-primary',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {tab === 'revenue' && <RevenueAnalytics embedded />}
      {tab === 'performance' && (
        <PerformanceTab
          dashboard={dashboard}
          calls={calls}
          callsLoading={callsLoading}
          campaignData={campaignData}
          campaignsLoading={campaignsLoading}
          costs={costs}
          costsLoading={costsLoading}
          toolHealth={toolHealth}
          healthLoading={healthLoading}
          formatCents={formatCents}
          navigate={navigate}
        />
      )}
    </div>
  );
}

interface PerformanceTabProps {
  dashboard: VerticalDashboard;
  calls: CallAnalytics | undefined;
  callsLoading: boolean;
  campaignData: { campaigns: CampaignRow[] } | undefined;
  campaignsLoading: boolean;
  costs: CostAnalytics | undefined;
  costsLoading: boolean;
  toolHealth: ToolHealthResponse | undefined;
  healthLoading: boolean;
  formatCents: (cents: number) => string;
  navigate: (path: string) => void;
}

function kpiValue(
  metric: DashboardKpiMetric,
  calls: CallAnalytics | undefined,
  costs: CostAnalytics | undefined,
  callsLoading: boolean,
  costsLoading: boolean,
  formatCents: (cents: number) => string,
): string {
  switch (metric) {
    case 'totalCalls':
      return callsLoading ? '—' : String(calls?.totalCalls ?? 0);
    case 'automationRate':
      return callsLoading ? '—' : `${((calls?.automationRate ?? 0) * 100).toFixed(1)}%`;
    case 'avgDuration':
      return callsLoading ? '—' : `${Math.round(calls?.avgDurationSeconds ?? 0)}s`;
    case 'costPerCall':
      return callsLoading && costsLoading
        ? '—'
        : formatCents(calls?.costPerCallCents ?? costs?.costPerCallCents ?? 0);
    default:
      return '—';
  }
}

function PerformanceTab({
  dashboard, calls, callsLoading, campaignData, campaignsLoading, costs, costsLoading,
  toolHealth, healthLoading, formatCents, navigate,
}: PerformanceTabProps) {
  const sectionRenderers: Record<DashboardSection, () => ReactElement> = {
    callVolume: () => (
      <div key="callVolume" className="bg-surface border border-border rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4">{dashboard.callsLabel} — Volume Trend</h2>
        {callsLoading ? (
          <div className="h-64 flex items-center justify-center text-text-secondary">Loading...</div>
        ) : !calls?.dailyBreakdown?.length ? (
          <div className="h-64 flex items-center justify-center text-text-secondary">No data for this period</div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={calls.dailyBreakdown}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
              <XAxis
                dataKey="date"
                tickFormatter={(v: string) => v.slice(5)}
                tick={{ fontSize: 11 }}
                stroke="var(--color-text-secondary)"
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 11 }}
                stroke="var(--color-text-secondary)"
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--color-surface)',
                  border: '1px solid var(--color-border)',
                  borderRadius: 8,
                  fontSize: 13,
                }}
              />
              <Bar dataKey="inbound" stackId="calls" fill="#3b82f6" name="Inbound" radius={[0, 0, 0, 0]} />
              <Bar dataKey="outbound" stackId="calls" fill="#8b5cf6" name="Outbound" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    ),
    callOutcomes: () => (
      <div key="callOutcomes" className="bg-surface border border-border rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4">{dashboard.callsLabel} — Outcomes</h2>
        {callsLoading ? (
          <div className="text-text-secondary">Loading...</div>
        ) : (
          <div className="space-y-3">
            <OutcomeRow label="Completed" count={calls?.completedCalls ?? 0} total={calls?.totalCalls ?? 0} color="bg-green-500" />
            <OutcomeRow label="Escalated" count={calls?.escalatedCalls ?? 0} total={calls?.totalCalls ?? 0} color="bg-yellow-500" />
            <OutcomeRow label="Failed" count={calls?.failedCalls ?? 0} total={calls?.totalCalls ?? 0} color="bg-red-500" />
          </div>
        )}
      </div>
    ),
    costBreakdown: () => (
      <div key="costBreakdown" className="bg-surface border border-border rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4">Cost Breakdown</h2>
        {costsLoading ? (
          <div className="text-text-secondary">Loading...</div>
        ) : (
          <div className="space-y-3">
            <div className="flex justify-between text-sm">
              <span className="text-text-secondary">OpenAI Inference</span>
              <span className="font-medium">{formatCents(costs?.totalOpenaiCostCents ?? 0)}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-text-secondary">Twilio Telephony</span>
              <span className="font-medium">{formatCents(costs?.totalTwilioCostCents ?? 0)}</span>
            </div>
            <div className="border-t border-border pt-2 flex justify-between text-sm font-semibold">
              <span>Total</span>
              <span>{formatCents(costs?.totalCostCents ?? 0)}</span>
            </div>
            <div className="flex justify-between text-sm text-text-secondary">
              <span>Cost per {dashboard.contactLabel}</span>
              <span>{formatCents(costs?.costPerCallCents ?? 0)}</span>
            </div>
          </div>
        )}
      </div>
    ),
    toolReliability: () => (
      <div key="toolReliability" className="bg-surface border border-border rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Tool Reliability</h2>
          <button
            onClick={() => navigate('/ops/reliability')}
            className="text-xs text-primary hover:underline"
          >
            View Details →
          </button>
        </div>
        {healthLoading ? (
          <div className="text-text-secondary">Loading...</div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-text-secondary">Tool Success Rate</p>
              <p className="text-xl font-bold">
                {toolHealth?.overallSuccessRate != null
                  ? `${toolHealth.overallSuccessRate.toFixed(1)}%`
                  : '—'}
              </p>
            </div>
            <div>
              <p className="text-xs text-text-secondary">Total Retries</p>
              <p className="text-xl font-bold">
                {toolHealth?.tools?.reduce((a, m) => a + m.retryCount, 0) ?? 0}
              </p>
            </div>
            <div>
              <p className="text-xs text-text-secondary">Pending Escalations</p>
              <p className="text-xl font-bold">{toolHealth?.escalationStats?.pending ?? 0}</p>
            </div>
            <div>
              <p className="text-xs text-text-secondary">Call Completion</p>
              <p className="text-xl font-bold">
                {toolHealth?.callCompletionRate != null
                  ? `${toolHealth.callCompletionRate.toFixed(1)}%`
                  : '—'}
              </p>
            </div>
          </div>
        )}
      </div>
    ),
    campaigns: () => (
      <div key="campaigns" className="bg-surface border border-border rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4">Campaign Performance</h2>
        {campaignsLoading ? (
          <div className="text-text-secondary">Loading...</div>
        ) : !campaignData?.campaigns?.length ? (
          <div className="text-text-secondary">No campaigns in this period</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-text-secondary">
                  <th className="pb-2 font-medium">Campaign</th>
                  <th className="pb-2 font-medium text-right">{dashboard.contactLabel}s</th>
                  <th className="pb-2 font-medium text-right">Answered</th>
                  <th className="pb-2 font-medium text-right">Voicemail</th>
                  <th className="pb-2 font-medium text-right">Completion</th>
                  <th className="pb-2 font-medium text-right">Avg Duration</th>
                  <th className="pb-2 font-medium text-right">Cost / {dashboard.contactLabel}</th>
                </tr>
              </thead>
              <tbody>
                {campaignData.campaigns.map((c) => (
                  <tr key={c.campaignId} className="border-b border-border/50">
                    <td className="py-2.5 font-medium">{c.campaignName}</td>
                    <td className="py-2.5 text-right">{c.totalContacts}</td>
                    <td className="py-2.5 text-right">{(c.answeredRate * 100).toFixed(1)}%</td>
                    <td className="py-2.5 text-right">{(c.voicemailRate * 100).toFixed(1)}%</td>
                    <td className="py-2.5 text-right">{(c.completionRate * 100).toFixed(1)}%</td>
                    <td className="py-2.5 text-right">{Math.round(c.avgDurationSeconds)}s</td>
                    <td className="py-2.5 text-right">{formatCents(c.costPerContactCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    ),
  };

  // Group cost+outcomes side-by-side if both present and adjacent.
  const sections = dashboard.sections;

  return (
    <div className="space-y-6" data-testid="performance-tab" data-dashboard-key={dashboard.key}>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {dashboard.kpis.map((kpi) => (
          <KpiCard
            key={kpi.metric}
            label={kpi.label}
            value={kpiValue(kpi.metric, calls, costs, callsLoading, costsLoading, formatCents)}
          />
        ))}
      </div>

      {sections.map((section) => sectionRenderers[section]())}
    </div>
  );
}

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface border border-border rounded-xl p-4">
      <p className="text-sm text-text-secondary">{label}</p>
      <p className="text-2xl font-bold mt-1">{value}</p>
    </div>
  );
}

function OutcomeRow({
  label,
  count,
  total,
  color,
}: {
  label: string;
  count: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-sm">
        <span className="text-text-secondary">{label}</span>
        <span className="font-medium">{count} ({pct.toFixed(1)}%)</span>
      </div>
      <div className="h-1.5 bg-surface-hover rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
