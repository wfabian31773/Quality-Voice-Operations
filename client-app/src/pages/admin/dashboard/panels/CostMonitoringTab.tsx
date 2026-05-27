import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Activity, DollarSign, PhoneCall, Users } from 'lucide-react';
import { api } from '../../../../lib/api';
import { formatCents } from '../../../PlatformAdmin';

/**
 * Per-day and per-month cost rollups served by /platform/cost-monitoring.
 * Drives the four StatCard-style tiles, the unit-economics + conversion
 * cards, the monthly summary grid, and the 30-day trend table.
 */
interface CostMonitoringData {
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
  trend: Array<{
    day: string;
    callMinutes: number;
    callCount: number;
    totalCostCents: number;
  }>;
}

// ---------------- PlanChangeDirectionsPanel (rendered inside CostMonitoringTab) ----------------

type CheckoutDirectionTotals = {
  upgrade: number;
  downgrade: number;
  interval_change: number;
  same: number;
  new: number;
  unknown: number;
};
type CheckoutDirectionByDay = { day: string; direction: keyof CheckoutDirectionTotals; count: number };
type CheckoutDirectionTransition = { fromPlan: string | null; toPlan: string | null; count: number };
type CheckoutDirectionsResponse = {
  windowDays: number;
  totals: CheckoutDirectionTotals;
  byDay: CheckoutDirectionByDay[];
  topDowngradeTransitions: CheckoutDirectionTransition[];
};

const DIRECTION_LABELS: Record<keyof CheckoutDirectionTotals, string> = {
  upgrade: 'Upgrades',
  downgrade: 'Downgrades',
  interval_change: 'Interval changes',
  same: 'No-op',
  new: 'New subscriptions',
  unknown: 'Unknown',
};

const DIRECTION_BAR_COLOR: Record<keyof CheckoutDirectionTotals, string> = {
  upgrade: 'bg-success',
  downgrade: 'bg-danger',
  interval_change: 'bg-info',
  same: 'bg-text-secondary/40',
  new: 'bg-primary',
  unknown: 'bg-text-secondary/30',
};

function PlanChangeDirectionsPanel() {
  const [days, setDays] = useState<number>(30);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['platform-checkout-directions', days],
    queryFn: () =>
      api.get<CheckoutDirectionsResponse>(`/platform/checkout-directions?days=${days}`),
    refetchInterval: 60_000,
  });

  const dayMap = new Map<string, Partial<Record<keyof CheckoutDirectionTotals, number>>>();
  for (const row of data?.byDay ?? []) {
    const existing = dayMap.get(row.day) ?? {};
    existing[row.direction] = (existing[row.direction] ?? 0) + row.count;
    dayMap.set(row.day, existing);
  }
  const dailyRows = Array.from(dayMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, counts]) => {
      const total = Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);
      return { day, counts, total };
    });
  const maxDailyTotal = dailyRows.reduce((max, r) => Math.max(max, r.total), 0) || 1;

  const totals = data?.totals;
  const grandTotal = totals
    ? totals.upgrade + totals.downgrade + totals.interval_change + totals.same + totals.new + totals.unknown
    : 0;

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h3 className="font-semibold">Checkout-session direction</h3>
          <p className="text-xs text-text-muted mt-0.5">
            Breakdown of /billing/checkout sessions by upgrade / downgrade / interval-only over time. Downgrades counted at checkout-rejection time; subsequent scheduled-downgrade audits are not double-counted here.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-text-muted" htmlFor="plan-change-window">Window</label>
          <select
            id="plan-change-window"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="text-sm px-2 py-1.5 rounded border border-border bg-surface"
          >
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={180}>180 days</option>
            <option value={365}>365 days</option>
          </select>
        </div>
      </div>

      <div className="p-4 space-y-6">
        {isLoading ? (
          <div className="text-center py-8 text-text-muted">Loading plan-change data...</div>
        ) : isError ? (
          <div className="text-center py-8 text-danger">Failed to load plan-change data.</div>
        ) : !data || grandTotal === 0 ? (
          <div className="text-center py-8 text-text-muted">
            No checkouts recorded in the last {data?.windowDays ?? days} days.
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {(Object.keys(DIRECTION_LABELS) as Array<keyof CheckoutDirectionTotals>).map((dir) => {
                const count = totals?.[dir] ?? 0;
                const pct = grandTotal > 0 ? Math.round((count / grandTotal) * 100) : 0;
                return (
                  <div key={dir} className="bg-surface-secondary border border-border rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className={`inline-block h-2.5 w-2.5 rounded-full ${DIRECTION_BAR_COLOR[dir]}`} />
                      <span className="text-xs text-text-muted">{DIRECTION_LABELS[dir]}</span>
                    </div>
                    <div className="text-lg font-bold tabular-nums">{count.toLocaleString()}</div>
                    <div className="text-[11px] text-text-muted">{pct}% of total</div>
                  </div>
                );
              })}
            </div>

            {dailyRows.length > 0 && (
              <div>
                <div className="text-xs text-text-muted mb-2">Daily checkouts (stacked by direction)</div>
                <div className="space-y-1">
                  {dailyRows.map((row) => (
                    <div key={row.day} className="flex items-center gap-2 text-xs">
                      <div className="w-24 shrink-0 text-text-muted tabular-nums">
                        {row.day}
                      </div>
                      <div className="flex-1 h-4 bg-surface-secondary rounded overflow-hidden flex">
                        {(Object.keys(DIRECTION_LABELS) as Array<keyof CheckoutDirectionTotals>).map((dir) => {
                          const c = row.counts[dir] ?? 0;
                          if (c === 0) return null;
                          const widthPct = (c / maxDailyTotal) * 100;
                          return (
                            <div
                              key={dir}
                              className={DIRECTION_BAR_COLOR[dir]}
                              style={{ width: `${widthPct}%` }}
                              title={`${DIRECTION_LABELS[dir]}: ${c}`}
                            />
                          );
                        })}
                      </div>
                      <div className="w-10 shrink-0 text-right tabular-nums text-text-muted">
                        {row.total}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {data.topDowngradeTransitions.length > 0 && (
              <div>
                <div className="text-xs text-text-muted mb-2">Top downgrade transitions</div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-surface-secondary">
                      <th className="text-left px-3 py-2 font-medium text-text-muted">From</th>
                      <th className="text-left px-3 py-2 font-medium text-text-muted">To</th>
                      <th className="text-right px-3 py-2 font-medium text-text-muted">Count</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.topDowngradeTransitions.map((row, idx) => (
                      <tr key={`${row.fromPlan ?? 'null'}-${row.toPlan ?? 'null'}-${idx}`} className="border-b border-border last:border-0">
                        <td className="px-3 py-2 capitalize">{row.fromPlan ?? '—'}</td>
                        <td className="px-3 py-2 capitalize">{row.toPlan ?? '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.count.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------- CostMonitoringTab (the route entry point) ----------------

/**
 * Self-contained as of step C — the cost-monitoring query lives with
 * the markup, so the parent no longer has to keep it alive when other
 * tabs are showing. Extracted to its own file in Phase 2 along with
 * the PlanChangeDirectionsPanel it renders, since the two ship together.
 */
export function CostMonitoringTab() {
  const { t: adminT } = useTranslation('admin');
  const { data, isLoading: loading } = useQuery({
    queryKey: ['platform-cost-monitoring'],
    queryFn: () => api.get<{ monitoring: CostMonitoringData }>('/platform/cost-monitoring'),
    refetchInterval: 30_000,
  });
  if (loading) return <div className="text-center py-12 text-text-muted">{adminT('platform_admin.cost_monitoring.loading')}</div>;
  if (!data) return <div className="text-center py-12 text-text-muted">{adminT('platform_admin.cost_monitoring.no_data')}</div>;

  const m = data.monitoring;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Activity className="h-4 w-4 text-text-muted" />
            <span className="text-sm text-text-muted">{adminT('platform_admin.cost_monitoring.daily_call_minutes')}</span>
          </div>
          <div className="text-2xl font-bold">{m.daily.callMinutes.toLocaleString()}</div>
          <div className="text-xs text-text-muted mt-1">{adminT('platform_admin.cost_monitoring.calls_today', { count: m.daily.callCount })}</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <DollarSign className="h-4 w-4 text-text-muted" />
            <span className="text-sm text-text-muted">{adminT('platform_admin.cost_monitoring.daily_ai_cost')}</span>
          </div>
          <div className="text-2xl font-bold">{formatCents(String(m.daily.aiCostCents))}</div>
          <div className="text-xs text-text-muted mt-1">{adminT('platform_admin.cost_monitoring.total_cost', { amount: formatCents(String(m.daily.totalCostCents)) })}</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <PhoneCall className="h-4 w-4 text-text-muted" />
            <span className="text-sm text-text-muted">{adminT('platform_admin.cost_monitoring.daily_twilio_spend')}</span>
          </div>
          <div className="text-2xl font-bold">{formatCents(String(m.daily.twilioCostCents))}</div>
          <div className="text-xs text-text-muted mt-1">{adminT('platform_admin.cost_monitoring.sms_amount', { amount: formatCents(String(m.daily.smsCostCents)) })}</div>
        </div>
        <div className="bg-surface border border-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-2">
            <Users className="h-4 w-4 text-text-muted" />
            <span className="text-sm text-text-muted">{adminT('platform_admin.cost_monitoring.active_trials')}</span>
          </div>
          <div className="text-2xl font-bold">{m.trials.activeTrials}</div>
          <div className="text-xs text-text-muted mt-1">{adminT('platform_admin.cost_monitoring.paid_accounts', { count: m.trials.paidAccounts })}</div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-surface border border-border rounded-xl p-6">
          <h3 className="font-semibold mb-4">{adminT('platform_admin.cost_monitoring.trial_to_paid_conversion')}</h3>
          <div className="flex items-center gap-4">
            <div className="text-4xl font-bold text-primary">{m.trials.conversionRate}%</div>
            <div className="text-sm text-text-muted">
              <div>{adminT('platform_admin.cost_monitoring.paid_total', { paid: m.trials.paidAccounts, total: m.trials.totalAccounts })}</div>
              <div>{adminT('platform_admin.cost_monitoring.active_trials_inline', { count: m.trials.activeTrials })}</div>
            </div>
          </div>
        </div>

        <div className="bg-surface border border-border rounded-xl p-6">
          <h3 className="font-semibold mb-4">{adminT('platform_admin.cost_monitoring.unit_economics')}</h3>
          <div className="grid grid-cols-3 gap-4 text-center">
            <div>
              <div className="text-xs text-text-muted mb-1">{adminT('platform_admin.cost_monitoring.cost_per_call')}</div>
              <div className="text-lg font-bold">{formatCents(String(m.economics.costPerCallCents))}</div>
            </div>
            <div>
              <div className="text-xs text-text-muted mb-1">{adminT('platform_admin.cost_monitoring.revenue_per_call')}</div>
              <div className="text-lg font-bold text-success">{formatCents(String(m.economics.revenuePerCallCents))}</div>
            </div>
            <div>
              <div className="text-xs text-text-muted mb-1">{adminT('platform_admin.cost_monitoring.margin_per_call')}</div>
              <div className={`text-lg font-bold ${m.economics.marginPerCallCents >= 0 ? 'text-success' : 'text-danger'}`}>
                {formatCents(String(m.economics.marginPerCallCents))}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl p-6">
        <h3 className="font-semibold mb-4">{adminT('platform_admin.cost_monitoring.monthly_summary')}</h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
          <div>
            <div className="text-xs text-text-muted mb-1">{adminT('platform_admin.cost_monitoring.call_minutes')}</div>
            <div className="text-lg font-bold">{m.monthly.callMinutes.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">{adminT('platform_admin.cost_monitoring.total_calls')}</div>
            <div className="text-lg font-bold">{m.monthly.callCount.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">{adminT('platform_admin.cost_monitoring.ai_cost')}</div>
            <div className="text-lg font-bold">{formatCents(String(m.monthly.aiCostCents))}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">{adminT('platform_admin.cost_monitoring.twilio_cost')}</div>
            <div className="text-lg font-bold">{formatCents(String(m.monthly.twilioCostCents))}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">{adminT('platform_admin.cost_monitoring.total_cost_label')}</div>
            <div className="text-lg font-bold">{formatCents(String(m.monthly.totalCostCents))}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">{adminT('platform_admin.cost_monitoring.revenue')}</div>
            <div className="text-lg font-bold text-success">{formatCents(String(m.monthly.revenueCents))}</div>
          </div>
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl p-6">
        <h3 className="font-semibold mb-4">{adminT('platform_admin.cost_monitoring.daily_usage')}</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-xs text-text-muted mb-1">{adminT('platform_admin.cost_monitoring.tool_executions_today')}</div>
            <div className="text-lg font-bold">{m.daily.toolExecutions.toLocaleString()}</div>
          </div>
          <div>
            <div className="text-xs text-text-muted mb-1">{adminT('platform_admin.cost_monitoring.api_requests_today')}</div>
            <div className="text-lg font-bold">{m.daily.apiRequests.toLocaleString()}</div>
          </div>
        </div>
      </div>

      <PlanChangeDirectionsPanel />

      {m.trend.length > 0 && (
        <div className="bg-surface border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-border">
            <h3 className="font-semibold">{adminT('platform_admin.cost_monitoring.trend_30d')}</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-secondary">
                  <th className="text-left px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.cost_monitoring.trend_header_date')}</th>
                  <th className="text-right px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.cost_monitoring.trend_header_calls')}</th>
                  <th className="text-right px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.cost_monitoring.trend_header_minutes')}</th>
                  <th className="text-right px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.cost_monitoring.trend_header_cost')}</th>
                </tr>
              </thead>
              <tbody>
                {m.trend.map((day) => (
                  <tr key={day.day} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 text-text-muted">{new Date(day.day).toLocaleDateString()}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{day.callCount}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{day.callMinutes}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{formatCents(String(day.totalCostCents))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export default CostMonitoringTab;
