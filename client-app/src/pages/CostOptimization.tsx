import { useEffect, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { formatCents as formatCentsHelper, dollarsToCents } from '../lib/formatCurrency';
import { useTenantCurrency } from '../hooks/useTenantCurrency';
import { PageHeader, OperationStatusPanel, type OperationStatus } from '../components/ui';
import {
  DollarSign, TrendingDown, Database,
  ArrowDown, ArrowUp, Settings2, Save, Loader2, BarChart3, RefreshCw,
} from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, AreaChart, Area,
} from 'recharts';
import clsx from 'clsx';

type Range = '7d' | '30d' | '90d';

interface DailyBreakdown {
  date: string;
  totalCostCents: number;
  conversationCount: number;
  avgCostCents: number;
  cacheHits: number;
}

interface TierDistribution {
  tier: string;
  count: number;
  percentage: number;
  avgCostCents: number;
}

interface MonthlyCostTrend {
  month: string;
  totalCostCents: number;
  conversationCount: number;
}

interface SavingsBreakdown {
  cacheSavingsCents: number;
  routingSavingsCents: number;
  compressionSavingsCents: number;
  totalSavingsCents: number;
}

interface CostAnalytics {
  totalConversations: number;
  totalCostCents: number;
  avgCostPerConversationCents: number;
  totalSttCostCents: number;
  totalLlmCostCents: number;
  totalTtsCostCents: number;
  totalInfraCostCents: number;
  totalTokensSaved: number;
  totalCacheHits: number;
  totalCacheMisses: number;
  cacheHitRate: number;
  modelEfficiencyRatio: number;
  dailyBreakdown: DailyBreakdown[];
  tierDistribution: TierDistribution[];
  monthlyCostTrend: MonthlyCostTrend[];
  savingsBreakdown: SavingsBreakdown;
}

interface BudgetSettings {
  maxCostPerConversationCents: number;
  alertThresholdPercent: number;
  autoDowngradeModel: boolean;
  autoEndCall: boolean;
  enabled: boolean;
}

interface ConversationCost {
  callSessionId: string;
  sttCostCents: number;
  llmCostCents: number;
  ttsCostCents: number;
  infraCostCents: number;
  totalCostCents: number;
  modelTier: string;
  modelUsed: string;
  inputTokens: number;
  outputTokens: number;
  cacheHits: number;
  createdAt: string;
}

interface ConversationsResponse {
  costs: ConversationCost[];
  total: number;
}

const COLORS = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4'];
const TIER_COLORS: Record<string, string> = {
  economy: '#22c55e',
  standard: '#6366f1',
  premium: '#f59e0b',
};

function makeFormatCents(currency: string): (cents: number) => string {
  return (cents: number) => formatCentsHelper(cents, { currency });
}

function KpiCard({ title, value, subtitle, icon: Icon, trend, color }: {
  title: string;
  value: string;
  subtitle?: string;
  icon: typeof DollarSign;
  trend?: 'up' | 'down' | null;
  color?: string;
}) {
  return (
    <div className="bg-surface border border-border rounded-xl p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-text-secondary">{title}</span>
        <div className={clsx('p-2 rounded-lg', color ?? 'bg-indigo-50 dark:bg-indigo-900/30')}>
          <Icon size={16} className="text-indigo-600 dark:text-indigo-400" />
        </div>
      </div>
      <div className="flex items-end gap-2">
        <span className="text-2xl font-bold text-text-primary">{value}</span>
        {trend && (
          <span className={clsx('flex items-center text-xs font-medium mb-1',
            trend === 'down' ? 'text-green-600' : 'text-red-500'
          )}>
            {trend === 'down' ? <ArrowDown size={12} /> : <ArrowUp size={12} />}
          </span>
        )}
      </div>
      {subtitle && <p className="text-xs text-text-muted mt-1">{subtitle}</p>}
    </div>
  );
}

export default function CostOptimization() {
  const [range, setRange] = useState<Range>('30d');
  const queryClient = useQueryClient();

  const {
    data: analytics,
    isLoading,
    isFetching,
    isError,
    error: analyticsError,
    dataUpdatedAt,
    refetch,
  } = useQuery({
    queryKey: ['cost-optimization-analytics', range],
    queryFn: () => api.get<CostAnalytics & { currency?: string }>(`/cost-optimization/analytics?range=${range}`),
  });

  const currency = useTenantCurrency(analytics?.currency);
  const formatCents = makeFormatCents(currency);

  // Track when the current recompute kicked off so the panel can show
  // elapsed time and so we can display a stable "ran in Xs" once it
  // settles. We can't get this from react-query alone — `dataUpdatedAt`
  // is the *finish* time, not the start.
  const [recomputeStartedAt, setRecomputeStartedAt] = useState<number | null>(null);
  const wasFetchingRef = useRef(false);
  useEffect(() => {
    if (isFetching && !wasFetchingRef.current) {
      setRecomputeStartedAt(Date.now());
    }
    wasFetchingRef.current = isFetching;
  }, [isFetching]);

  // Tick once per second while the recompute is in flight so the
  // OperationStatusPanel's elapsed timer updates without re-fetching.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!isFetching) return;
    const t = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [isFetching]);

  const { data: budget } = useQuery({
    queryKey: ['cost-optimization-budget'],
    queryFn: () => api.get<BudgetSettings>('/cost-optimization/budget'),
  });

  const [budgetForm, setBudgetForm] = useState<BudgetSettings | null>(null);

  const currentBudget: BudgetSettings = budgetForm ?? budget ?? {
    maxCostPerConversationCents: 500,
    alertThresholdPercent: 80,
    autoDowngradeModel: true,
    autoEndCall: false,
    enabled: false,
  };

  const saveBudget = useMutation({
    mutationFn: (data: BudgetSettings) =>
      api.put<BudgetSettings>('/cost-optimization/budget', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['cost-optimization-budget'] });
      setBudgetForm(null);
    },
  });

  const { data: conversations } = useQuery({
    queryKey: ['cost-optimization-conversations', range],
    queryFn: () => api.get<ConversationsResponse>(`/cost-optimization/conversations?range=${range}&limit=20`),
  });

  const a = analytics ?? {
    totalConversations: 0,
    totalCostCents: 0,
    avgCostPerConversationCents: 0,
    totalSttCostCents: 0,
    totalLlmCostCents: 0,
    totalTtsCostCents: 0,
    totalInfraCostCents: 0,
    totalTokensSaved: 0,
    totalCacheHits: 0,
    cacheHitRate: 0,
    modelEfficiencyRatio: 0,
    dailyBreakdown: [],
    tierDistribution: [],
    monthlyCostTrend: [],
    savingsBreakdown: { cacheSavingsCents: 0, routingSavingsCents: 0, compressionSavingsCents: 0, totalSavingsCents: 0 },
  };

  const costBreakdownData = [
    { name: 'STT', value: a.totalSttCostCents, color: '#6366f1' },
    { name: 'LLM', value: a.totalLlmCostCents, color: '#22c55e' },
    { name: 'TTS', value: a.totalTtsCostCents, color: '#f59e0b' },
    { name: 'Infra', value: a.totalInfraCostCents, color: '#ef4444' },
  ].filter(d => d.value > 0);

  const savingsData = [
    { name: 'Cache Savings', value: a.savingsBreakdown.cacheSavingsCents },
    { name: 'Routing Savings', value: a.savingsBreakdown.routingSavingsCents },
    { name: 'Compression Savings', value: a.savingsBreakdown.compressionSavingsCents },
  ].filter(d => d.value > 0);

  // Map react-query state into the OperationStatusPanel vocabulary so the
  // ops console shows a consistent "running / failed / completed" pill for
  // the recompute, instead of the bare spinner that used to gate the page.
  const opStatus: OperationStatus = isFetching
    ? 'running'
    : isError
      ? 'failed'
      : analytics
        ? 'success'
        : 'idle';
  const recomputeFinishedAt = !isFetching && dataUpdatedAt > 0 ? dataUpdatedAt : null;
  const elapsedMs = recomputeStartedAt
    ? (recomputeFinishedAt ?? Date.now()) - recomputeStartedAt
    : null;
  const errorMessage = isError
    ? (analyticsError instanceof Error ? analyticsError.message : 'Failed to recompute cost analytics.')
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Cost Optimization"
        description="Track, analyze, and reduce AI conversation costs"
        actions={
          <div className="flex items-center gap-2">
            <div className="flex gap-1 bg-surface-hover rounded-lg p-1">
              {(['7d', '30d', '90d'] as Range[]).map(r => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  className={clsx(
                    'px-3 py-1.5 text-sm rounded-md transition-colors',
                    range === r
                      ? 'bg-surface text-text-primary shadow-sm'
                      : 'text-text-secondary hover:text-text-primary'
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => refetch()}
              disabled={isFetching}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border text-text-secondary text-sm font-medium hover:bg-surface-hover transition-colors disabled:opacity-50"
            >
              <RefreshCw className={clsx('h-3.5 w-3.5', isFetching && 'animate-spin')} />
              Recompute
            </button>
          </div>
        }
      />

      <OperationStatusPanel
        title="Cost recompute"
        description={
          isFetching
            ? `Aggregating ${range} of conversation costs from the billing pipeline.`
            : isError
              ? 'The most recent cost recompute failed. Use Recompute to retry.'
              : analytics
                ? `Latest recompute aggregated ${analytics.totalConversations.toLocaleString()} conversation${analytics.totalConversations === 1 ? '' : 's'} across the last ${range}.`
                : 'No cost analytics have been computed yet.'
        }
        status={opStatus}
        progress={isFetching ? undefined : analytics ? 1 : undefined}
        eta={isFetching && elapsedMs !== null ? `Elapsed ${formatElapsedSeconds(elapsedMs)}` : undefined}
        meta={analytics ? [
          { label: 'Range', value: range },
          { label: 'Conversations', value: analytics.totalConversations.toLocaleString() },
          { label: 'Total cost', value: formatCents(analytics.totalCostCents) },
          {
            label: isFetching ? 'Started' : 'Last finished',
            value: isFetching && recomputeStartedAt
              ? new Date(recomputeStartedAt).toLocaleTimeString()
              : dataUpdatedAt > 0
                ? new Date(dataUpdatedAt).toLocaleTimeString()
                : '—',
          },
        ] : undefined}
        actions={
          !isFetching && (isError || (analytics && elapsedMs !== null)) ? (
            <button
              type="button"
              onClick={() => refetch()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-primary/40 bg-primary-light text-primary text-xs font-medium hover:bg-primary/10 transition-colors"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Run again
            </button>
          ) : undefined
        }
        error={errorMessage}
        updatedAt={
          !isFetching && dataUpdatedAt > 0
            ? `${new Date(dataUpdatedAt).toLocaleTimeString()}${elapsedMs !== null ? ` · took ${formatElapsedSeconds(elapsedMs)}` : ''}`
            : undefined
        }
        testId="cost-recompute-panel"
      />

      {isLoading && !analytics && (
        <div className="flex items-center justify-center h-40 bg-surface border border-border rounded-xl">
          <Loader2 className="animate-spin text-text-muted" size={32} />
        </div>
      )}

      {!isLoading && (
      <>
      <div
        className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4"
        data-testid="cost-kpi-grid"
      >
        <KpiCard
          title="Total Cost"
          value={formatCents(a.totalCostCents)}
          subtitle={`${a.totalConversations} conversations`}
          icon={DollarSign}
        />
        <KpiCard
          title="Avg Cost / Conversation"
          value={formatCents(a.avgCostPerConversationCents)}
          icon={BarChart3}
          color="bg-emerald-50 dark:bg-emerald-900/30"
        />
        <KpiCard
          title="Cache Hit Rate"
          value={`${a.cacheHitRate}%`}
          subtitle={`${a.totalCacheHits} hits`}
          icon={Database}
          color="bg-amber-50 dark:bg-amber-900/30"
        />
        <KpiCard
          title="Total Savings"
          value={formatCents(a.savingsBreakdown.totalSavingsCents)}
          subtitle="From caching, routing & compression"
          icon={TrendingDown}
          trend="down"
          color="bg-green-50 dark:bg-green-900/30"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-surface border border-border rounded-xl p-5">
          <h3 className="text-sm font-semibold text-text-primary mb-4">Daily Cost Trend</h3>
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={a.dailyBreakdown}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} stroke="#71717a" />
              <YAxis
                tick={{ fontSize: 11 }}
                stroke="#71717a"
                tickFormatter={(v: number) => formatCentsHelper(v, { currency, minimumFractionDigits: 0, maximumFractionDigits: 0 })}
              />
              <Tooltip
                formatter={(value: unknown) => [formatCents(Number(value)), 'Cost']}
                contentStyle={{ backgroundColor: '#18181b', border: '1px solid #3f3f46', borderRadius: '8px' }}
                labelStyle={{ color: '#a1a1aa' }}
              />
              <Area type="monotone" dataKey="totalCostCents" stroke="#6366f1" fill="#6366f1" fillOpacity={0.1} name="Total Cost" />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-surface border border-border rounded-xl p-5">
          <h3 className="text-sm font-semibold text-text-primary mb-4">Cost Breakdown by Component</h3>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie
                data={costBreakdownData}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={100}
                paddingAngle={2}
                dataKey="value"
                label={((props: Record<string, unknown>) => `${props.name}: ${formatCents(Number(props.value))}`) as never}
              >
                {costBreakdownData.map((entry, i) => (
                  <Cell key={i} fill={entry.color} />
                ))}
              </Pie>
              <Tooltip formatter={(value: unknown) => formatCents(Number(value))} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-surface border border-border rounded-xl p-5">
          <h3 className="text-sm font-semibold text-text-primary mb-4">Model Tier Distribution</h3>
          {a.tierDistribution.length === 0 ? (
            <p className="text-sm text-text-muted text-center py-8">No routing data yet</p>
          ) : (
            <div className="space-y-3">
              {a.tierDistribution.map((tier: TierDistribution) => (
                <div key={tier.tier}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="capitalize text-text-primary">{tier.tier}</span>
                    <span className="text-text-secondary">{tier.percentage}% ({tier.count})</span>
                  </div>
                  <div className="w-full bg-surface-hover rounded-full h-2">
                    <div
                      className="h-2 rounded-full transition-all"
                      style={{
                        width: `${tier.percentage}%`,
                        backgroundColor: TIER_COLORS[tier.tier] ?? '#6366f1',
                      }}
                    />
                  </div>
                  <p className="text-xs text-text-muted mt-0.5">Avg: {formatCents(tier.avgCostCents)}/call</p>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-surface border border-border rounded-xl p-5">
          <h3 className="text-sm font-semibold text-text-primary mb-4">Monthly Cost Trend</h3>
          {a.monthlyCostTrend.length === 0 ? (
            <p className="text-sm text-text-muted text-center py-8">Not enough data yet</p>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={a.monthlyCostTrend}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis dataKey="month" tick={{ fontSize: 10 }} stroke="#71717a" />
                <YAxis
                  tick={{ fontSize: 10 }}
                  stroke="#71717a"
                  tickFormatter={(v: number) => formatCentsHelper(v, { currency, minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                />
                <Tooltip formatter={(value: unknown) => formatCents(Number(value))} />
                <Bar dataKey="totalCostCents" fill="#6366f1" radius={[4, 4, 0, 0]} name="Total Cost" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="bg-surface border border-border rounded-xl p-5">
          <h3 className="text-sm font-semibold text-text-primary mb-4">Savings Breakdown</h3>
          {savingsData.length === 0 ? (
            <p className="text-sm text-text-muted text-center py-8">No savings recorded yet</p>
          ) : (
            <div className="space-y-4">
              {savingsData.map((item, i) => (
                <div key={item.name} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-3 h-3 rounded-full" style={{ backgroundColor: COLORS[i] }} />
                    <span className="text-sm text-text-primary">{item.name}</span>
                  </div>
                  <span className="text-sm font-medium text-green-600">{formatCents(item.value)}</span>
                </div>
              ))}
              <div className="border-t border-border pt-3 flex justify-between">
                <span className="text-sm font-semibold text-text-primary">Total Saved</span>
                <span className="text-sm font-bold text-green-600">
                  {formatCents(a.savingsBreakdown.totalSavingsCents)}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl p-5">
        <div className="flex items-center gap-2 mb-4">
          <Settings2 size={16} className="text-text-secondary" />
          <h3 className="text-sm font-semibold text-text-primary">Per-Conversation Cost Budget</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <div>
            <label className="block text-xs text-text-secondary mb-1">Max Cost Per Conversation</label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-text-muted">$</span>
              <input
                type="number"
                step="0.01"
                min="0"
                // eslint-disable-next-line local/no-cents-divided-by-100 -- HTML number input needs a primitive dollar value, not a formatCurrency() string
                value={(currentBudget.maxCostPerConversationCents / 100).toFixed(2)}
                /* numeric input value: dollars with 2 decimals, never displayed as currency */
                onChange={(e) =>
                  setBudgetForm({
                    ...currentBudget,
                    maxCostPerConversationCents: dollarsToCents(e.target.value),
                  })
                }
                className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-sm text-text-primary"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-text-secondary mb-1">Alert Threshold (%)</label>
            <input
              type="number"
              min="0"
              max="100"
              value={currentBudget.alertThresholdPercent}
              onChange={(e) =>
                setBudgetForm({
                  ...currentBudget,
                  alertThresholdPercent: parseInt(e.target.value || '80', 10),
                })
              }
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-sm text-text-primary"
            />
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-text-primary">
              <input
                type="checkbox"
                checked={currentBudget.enabled}
                onChange={(e) =>
                  setBudgetForm({ ...currentBudget, enabled: e.target.checked })
                }
                className="rounded"
              />
              Enable Budget Cap
            </label>
            <label className="flex items-center gap-2 text-sm text-text-primary">
              <input
                type="checkbox"
                checked={currentBudget.autoDowngradeModel}
                onChange={(e) =>
                  setBudgetForm({ ...currentBudget, autoDowngradeModel: e.target.checked })
                }
                className="rounded"
              />
              Auto-downgrade model at threshold
            </label>
            <label className="flex items-center gap-2 text-sm text-text-primary">
              <input
                type="checkbox"
                checked={currentBudget.autoEndCall}
                onChange={(e) =>
                  setBudgetForm({ ...currentBudget, autoEndCall: e.target.checked })
                }
                className="rounded"
              />
              End call at budget cap
            </label>
          </div>
        </div>
        {budgetForm && (
          <div className="mt-4 flex justify-end">
            <button
              onClick={() => saveBudget.mutate(budgetForm)}
              disabled={saveBudget.isPending}
              className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50"
            >
              {saveBudget.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save Budget Settings
            </button>
          </div>
        )}
      </div>

      <div className="bg-surface border border-border rounded-xl p-5">
        <h3 className="text-sm font-semibold text-text-primary mb-4">Recent Conversation Costs</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 px-3 text-text-secondary font-medium">Session</th>
                <th className="text-right py-2 px-3 text-text-secondary font-medium">STT</th>
                <th className="text-right py-2 px-3 text-text-secondary font-medium">LLM</th>
                <th className="text-right py-2 px-3 text-text-secondary font-medium">TTS</th>
                <th className="text-right py-2 px-3 text-text-secondary font-medium">Infra</th>
                <th className="text-right py-2 px-3 text-text-secondary font-medium">Total</th>
                <th className="text-center py-2 px-3 text-text-secondary font-medium">Model</th>
                <th className="text-right py-2 px-3 text-text-secondary font-medium">Cache Hits</th>
              </tr>
            </thead>
            <tbody>
              {conversations?.costs?.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center py-8 text-text-muted">
                    No conversation cost data yet
                  </td>
                </tr>
              )}
              {conversations?.costs?.map((c: ConversationCost) => (
                <tr key={c.callSessionId} className="border-b border-border/50 hover:bg-surface-hover">
                  <td className="py-2 px-3 text-text-primary font-mono text-xs">
                    {c.callSessionId.substring(0, 12)}...
                  </td>
                  <td className="text-right py-2 px-3 text-text-secondary">{formatCents(c.sttCostCents)}</td>
                  <td className="text-right py-2 px-3 text-text-secondary">{formatCents(c.llmCostCents)}</td>
                  <td className="text-right py-2 px-3 text-text-secondary">{formatCents(c.ttsCostCents)}</td>
                  <td className="text-right py-2 px-3 text-text-secondary">{formatCents(c.infraCostCents)}</td>
                  <td className="text-right py-2 px-3 font-medium text-text-primary">{formatCents(c.totalCostCents)}</td>
                  <td className="text-center py-2 px-3">
                    <span className={clsx(
                      'inline-flex px-2 py-0.5 rounded-full text-xs font-medium',
                      c.modelTier === 'economy' && 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
                      c.modelTier === 'standard' && 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
                      c.modelTier === 'premium' && 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
                    )}>
                      {c.modelTier}
                    </span>
                  </td>
                  <td className="text-right py-2 px-3 text-text-secondary">{c.cacheHits}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      </>
      )}
    </div>
  );
}

function formatElapsedSeconds(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}s`;
  return `${m}m ${s.toString().padStart(2, '0')}s`;
}
