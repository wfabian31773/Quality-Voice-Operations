import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { Inbox } from 'lucide-react';
import { api } from '../lib/api';
import { formatCents as formatCentsHelper } from '../lib/formatCurrency';
import GlobalScopeBanner from '../components/GlobalScopeBanner';
import { EmptyState, Skeleton, SkeletonRows } from '../components/state';

interface PlatformStats {
  active_tenants: string | number;
  total_tenants: string | number;
  total_users: string | number;
  total_calls: string | number;
  calls_last_30d: string | number;
  calls_last_24h: string | number;
  total_revenue_cents: string | number;
  revenue_last_30d_cents: string | number;
}

interface CostMonitoring {
  daily: {
    callMinutes: number;
    aiCostCents: number;
    twilioCostCents: number;
    smsCostCents: number;
    callCount: number;
    toolExecutions: number;
    apiRequests: number;
    totalCostCents: number;
  };
  monthly: {
    callMinutes: number;
    callCount: number;
    totalCostCents: number;
    aiCostCents: number;
    twilioCostCents: number;
    revenueCents: number;
  };
  trials: {
    activeTrials: number;
    paidAccounts: number;
    totalAccounts: number;
    conversionRate: number;
  };
  economics: {
    costPerCallCents: number;
    revenuePerCallCents: number;
    marginPerCallCents: number;
  };
  trend: Array<{ day: string; callMinutes: number; callCount: number; totalCostCents: number }>;
}

interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan: string;
  user_count: string | number;
  total_calls: string | number;
  calls_last_30d: string | number;
  last_call_at: string | null;
}

interface TemplateAnalyticsRow {
  id: string;
  slug: string;
  displayName: string;
  currentVersion: string;
  status: string;
  installCount: number;
  activeInstalls: number;
  totalInstalls: number;
  uninstallCount: number;
  callsLast30d: number;
  avgCallDuration: number;
  avgSatisfaction: number;
}


function toNum(value: string | number | null | undefined): number {
  if (value == null) return 0;
  return typeof value === 'number' ? value : parseInt(value, 10) || 0;
}

function formatCents(cents: number): string {
  return formatCentsHelper(cents);
}

type TenantSortKey = 'plan' | 'status' | 'calls_last_30d' | 'total_calls' | 'last_call_at';
type SortDir = 'asc' | 'desc';

export default function AdminAnalytics() {
  const navigate = useNavigate();
  const [tenantSearch, setTenantSearch] = useState('');
  const [tenantSortKey, setTenantSortKey] = useState<TenantSortKey>('last_call_at');
  const [tenantSortDir, setTenantSortDir] = useState<SortDir>('desc');

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['admin-platform-stats'],
    queryFn: () => api.get<{ stats: PlatformStats }>('/platform/stats'),
    refetchInterval: 120_000,
  });

  const { data: monitoring, isLoading: monitoringLoading } = useQuery({
    queryKey: ['admin-cost-monitoring'],
    queryFn: () => api.get<{ monitoring: CostMonitoring }>('/platform/cost-monitoring'),
    refetchInterval: 120_000,
  });

  const { data: tenantsData, isLoading: tenantsLoading } = useQuery({
    queryKey: ['admin-platform-tenants'],
    queryFn: () => api.get<{ tenants: TenantSummary[] }>('/platform/tenants'),
  });

  const { data: templateAnalytics, isLoading: templatesLoading } = useQuery({
    queryKey: ['admin-template-analytics'],
    queryFn: () => api.get<{ templates: TemplateAnalyticsRow[] }>('/platform/template-analytics'),
  });

  const platformStats = stats?.stats;
  const mon = monitoring?.monitoring;
  const tenants = tenantsData?.tenants ?? [];

  const filteredSortedTenants = useMemo(() => {
    const q = tenantSearch.trim().toLowerCase();
    const filtered = q
      ? tenants.filter(
          (t) =>
            t.name.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q),
        )
      : tenants.slice();

    const dir = tenantSortDir === 'asc' ? 1 : -1;
    const key = tenantSortKey;

    filtered.sort((a, b) => {
      let av: number | string;
      let bv: number | string;
      if (key === 'plan' || key === 'status') {
        av = (a[key] ?? '').toString().toLowerCase();
        bv = (b[key] ?? '').toString().toLowerCase();
      } else if (key === 'last_call_at') {
        av = a.last_call_at ? new Date(a.last_call_at).getTime() : 0;
        bv = b.last_call_at ? new Date(b.last_call_at).getTime() : 0;
      } else {
        av = toNum(a[key]);
        bv = toNum(b[key]);
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });

    return filtered;
  }, [tenants, tenantSearch, tenantSortKey, tenantSortDir]);

  const toggleTenantSort = (key: TenantSortKey) => {
    if (tenantSortKey === key) {
      setTenantSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setTenantSortKey(key);
      setTenantSortDir(key === 'plan' || key === 'status' ? 'asc' : 'desc');
    }
  };
  const templates = templateAnalytics?.templates ?? [];

  const trendData = (mon?.trend ?? [])
    .slice()
    .reverse()
    .map((row) => ({
      date: typeof row.day === 'string' ? row.day.slice(0, 10) : String(row.day).slice(0, 10),
      calls: row.callCount,
      costCents: row.totalCostCents,
    }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Global Analytics</h1>
          <p className="text-sm text-purple-200/70 mt-1">
            Platform-wide metrics aggregated across every tenant.
          </p>
        </div>
        <div className="text-xs text-purple-200/70 bg-white/5 border border-white/10 rounded-lg px-3 py-1.5">
          Window: last 30 days
        </div>
      </div>

      <GlobalScopeBanner />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard
          label="Active Tenants"
          value={statsLoading ? '—' : `${toNum(platformStats?.active_tenants)} / ${toNum(platformStats?.total_tenants)}`}
          sublabel="active / total"
        />
        <KpiCard
          label="Total Users"
          value={statsLoading ? '—' : toNum(platformStats?.total_users).toLocaleString()}
          sublabel="across all tenants"
        />
        <KpiCard
          label="Calls (30d)"
          value={statsLoading ? '—' : toNum(platformStats?.calls_last_30d).toLocaleString()}
          sublabel={`${toNum(platformStats?.calls_last_24h).toLocaleString()} in last 24h`}
        />
        <KpiCard
          label="Platform Revenue (30d)"
          value={statsLoading ? '—' : formatCents(toNum(platformStats?.revenue_last_30d_cents))}
          sublabel="all tenants combined"
        />
      </div>

      <div className="bg-card border border-border rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4 text-text-primary">
          Platform Call Volume <span className="text-xs font-normal text-text-secondary ml-2">all tenants &middot; last 30 days</span>
        </h2>
        {monitoringLoading ? (
          <Skeleton className="h-64 w-full" rounded="lg" />
        ) : !trendData.length ? (
          <div className="h-64 flex items-center justify-center"><EmptyState icon={Inbox} title="No data yet" variant="compact" /></div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={trendData}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border, #333)" />
              <XAxis dataKey="date" tickFormatter={(v: string) => v.slice(5)} tick={{ fontSize: 11 }} stroke="var(--color-muted-foreground, #888)" />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} stroke="var(--color-muted-foreground, #888)" />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--color-card, #1a1a1a)',
                  border: '1px solid var(--color-border, #333)',
                  borderRadius: 8,
                  fontSize: 13,
                }}
              />
              <Bar dataKey="calls" fill="#a855f7" name="Total Calls" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-card border border-border rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-4 text-text-primary">
            Platform Economics <span className="text-xs font-normal text-text-secondary ml-2">monthly &middot; all tenants</span>
          </h2>
          {monitoringLoading ? (
            <SkeletonRows count={7} rowClassName="h-5" gap="sm" />
          ) : !mon ? (
            <EmptyState icon={Inbox} title="No data yet" variant="compact" />
          ) : (
            <div className="space-y-3">
              <Row label="Monthly Revenue" value={formatCents(mon.monthly.revenueCents)} bold />
              <Row label="Total Cost" value={formatCents(mon.monthly.totalCostCents)} />
              <Row label="OpenAI Cost" value={formatCents(mon.monthly.aiCostCents)} muted />
              <Row label="Twilio Cost" value={formatCents(mon.monthly.twilioCostCents)} muted />
              <div className="border-t border-border pt-3 mt-3 space-y-3">
                <Row label="Cost / Call" value={formatCents(mon.economics.costPerCallCents)} />
                <Row label="Revenue / Call" value={formatCents(mon.economics.revenuePerCallCents)} />
                <Row label="Margin / Call" value={formatCents(mon.economics.marginPerCallCents)} bold />
              </div>
            </div>
          )}
        </div>

        <div className="bg-card border border-border rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-4 text-text-primary">
            Trial Conversion <span className="text-xs font-normal text-text-secondary ml-2">all accounts</span>
          </h2>
          {monitoringLoading ? (
            <SkeletonRows count={4} rowClassName="h-5" gap="sm" />
          ) : !mon ? (
            <EmptyState icon={Inbox} title="No data yet" variant="compact" />
          ) : (
            <div className="space-y-3">
              <Row label="Active Trials" value={mon.trials.activeTrials.toLocaleString()} />
              <Row label="Paid Accounts" value={mon.trials.paidAccounts.toLocaleString()} />
              <Row label="Total Accounts" value={mon.trials.totalAccounts.toLocaleString()} muted />
              <div className="border-t border-border pt-3 mt-3">
                <Row label="Conversion Rate" value={`${mon.trials.conversionRate}%`} bold />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl p-6">
        <div className="flex items-center justify-between mb-4 gap-4 flex-wrap">
          <h2 className="text-lg font-semibold text-text-primary">
            Tenant-by-Tenant Breakdown
          </h2>
          <div className="flex items-center gap-3 flex-wrap">
            <input
              type="search"
              value={tenantSearch}
              onChange={(e) => setTenantSearch(e.target.value)}
              placeholder="Search by name or slug..."
              aria-label="Search tenants"
              className="px-3 py-1.5 rounded-lg bg-white/5 border border-white/10 text-sm text-text-primary placeholder:text-text-secondary focus:outline-none focus:ring-1 focus:ring-purple-400 w-64"
            />
            <span className="text-xs text-text-secondary">
              {filteredSortedTenants.length} of {tenants.length} tenants
            </span>
          </div>
        </div>
        {tenantsLoading ? (
          <SkeletonRows count={6} rowClassName="h-10" />
        ) : !tenants.length ? (
          <div className="text-muted-foreground">No tenants on the platform</div>
        ) : !filteredSortedTenants.length ? (
          <div className="text-muted-foreground">No tenants match "{tenantSearch}"</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="pb-2 font-medium">Tenant</th>
                  <SortableTh label="Plan" sortKey="plan" currentKey={tenantSortKey} dir={tenantSortDir} onSort={toggleTenantSort} />
                  <SortableTh label="Status" sortKey="status" currentKey={tenantSortKey} dir={tenantSortDir} onSort={toggleTenantSort} />
                  <th className="pb-2 font-medium text-right">Users</th>
                  <SortableTh label="Calls (30d)" sortKey="calls_last_30d" currentKey={tenantSortKey} dir={tenantSortDir} onSort={toggleTenantSort} align="right" />
                  <SortableTh label="Total Calls" sortKey="total_calls" currentKey={tenantSortKey} dir={tenantSortDir} onSort={toggleTenantSort} align="right" />
                  <SortableTh label="Last Activity" sortKey="last_call_at" currentKey={tenantSortKey} dir={tenantSortDir} onSort={toggleTenantSort} align="right" />
                  <th className="pb-2 font-medium text-right">&nbsp;</th>
                </tr>
              </thead>
              <tbody>
                {filteredSortedTenants.map((t) => (
                  <tr
                    key={t.id}
                    className="border-b border-border/40 cursor-pointer hover:bg-white/5 focus-within:bg-white/5 transition-colors outline-none"
                    onClick={() => navigate(`/admin/analytics/tenants/${t.id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        navigate(`/admin/analytics/tenants/${t.id}`);
                      }
                    }}
                    role="link"
                    tabIndex={0}
                    aria-label={`Drill into ${t.name}'s analytics`}
                    title={`Drill into ${t.name}'s analytics`}
                  >
                    <td className="py-2.5 font-medium text-text-primary">
                      <div>{t.name}</div>
                      <div className="text-xs text-text-secondary">{t.slug}</div>
                    </td>
                    <td className="py-2.5 capitalize">{t.plan ?? '—'}</td>
                    <td className="py-2.5">
                      <span
                        className={clsx(
                          'inline-flex px-2 py-0.5 rounded text-xs font-medium capitalize',
                          t.status === 'active' && 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
                          t.status === 'pending' && 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
                          t.status === 'suspended' && 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
                        )}
                      >
                        {t.status}
                      </span>
                    </td>
                    <td className="py-2.5 text-right">{toNum(t.user_count).toLocaleString()}</td>
                    <td className="py-2.5 text-right">{toNum(t.calls_last_30d).toLocaleString()}</td>
                    <td className="py-2.5 text-right">{toNum(t.total_calls).toLocaleString()}</td>
                    <td className="py-2.5 text-right text-text-secondary text-xs">
                      {t.last_call_at ? new Date(t.last_call_at).toLocaleDateString() : 'never'}
                    </td>
                    <td className="py-2.5 text-right text-xs text-purple-300">View →</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-card border border-border rounded-xl p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-text-primary">Template Performance (Global)</h2>
          <span className="text-xs text-text-secondary">aggregated install &amp; usage metrics</span>
        </div>
        {templatesLoading ? (
          <SkeletonRows count={5} rowClassName="h-10" />
        ) : !templates.length ? (
          <div className="text-muted-foreground">No templates published</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="pb-2 font-medium">Template</th>
                  <th className="pb-2 font-medium">Status</th>
                  <th className="pb-2 font-medium text-right">Active Installs</th>
                  <th className="pb-2 font-medium text-right">Total Installs</th>
                  <th className="pb-2 font-medium text-right">Calls (30d)</th>
                  <th className="pb-2 font-medium text-right">Avg CSAT</th>
                </tr>
              </thead>
              <tbody>
                {templates.slice(0, 25).map((row) => (
                  <tr key={row.id} className="border-b border-border/40">
                    <td className="py-2.5">
                      <div className="font-medium text-text-primary">{row.displayName}</div>
                      <div className="text-xs text-text-secondary">{row.slug} &middot; v{row.currentVersion}</div>
                    </td>
                    <td className="py-2.5 capitalize">{row.status}</td>
                    <td className="py-2.5 text-right">{row.activeInstalls.toLocaleString()}</td>
                    <td className="py-2.5 text-right">{row.totalInstalls.toLocaleString()}</td>
                    <td className="py-2.5 text-right">{row.callsLast30d.toLocaleString()}</td>
                    <td className="py-2.5 text-right">{row.avgSatisfaction.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function KpiCard({ label, value, sublabel }: { label: string; value: string; sublabel?: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold mt-1 text-text-primary">{value}</p>
      {sublabel && <p className="text-xs text-text-secondary mt-0.5">{sublabel}</p>}
    </div>
  );
}

function SortableTh({
  label,
  sortKey,
  currentKey,
  dir,
  onSort,
  align = 'left',
}: {
  label: string;
  sortKey: TenantSortKey;
  currentKey: TenantSortKey;
  dir: SortDir;
  onSort: (key: TenantSortKey) => void;
  align?: 'left' | 'right';
}) {
  const isActive = currentKey === sortKey;
  const arrow = isActive ? (dir === 'asc' ? '▲' : '▼') : '';
  return (
    <th
      className={clsx('pb-2 font-medium', align === 'right' && 'text-right')}
      aria-sort={isActive ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        aria-label={`Sort by ${label}`}
        className={clsx(
          'inline-flex items-center gap-1 select-none cursor-pointer hover:text-text-primary transition-colors',
          isActive && 'text-text-primary',
        )}
      >
        <span>{label}</span>
        <span className="text-[10px] w-2 inline-block">{arrow}</span>
      </button>
    </th>
  );
}

function Row({ label, value, bold, muted }: { label: string; value: string; bold?: boolean; muted?: boolean }) {
  return (
    <div className={clsx('flex justify-between text-sm', bold && 'font-semibold text-text-primary', muted && 'text-muted-foreground')}>
      <span className={muted ? '' : 'text-muted-foreground'}>{label}</span>
      <span className={bold ? 'text-text-primary' : 'text-text-primary'}>{value}</span>
    </div>
  );
}
