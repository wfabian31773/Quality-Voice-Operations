import { useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BarChart3, TrendingUp, TrendingDown,
  Download as DownloadIcon, Activity, PhoneCall,
} from 'lucide-react';
import clsx from 'clsx';
import { api } from '../../../../lib/api';
import { StatCard } from '../../../../components/ui';
// Phase 2.4 split missed StatusBadge — re-export added in PlatformAdmin.
import { StatusBadge } from '../../../PlatformAdmin';

// Lightweight stat helper used in the per-template detail card.
// Mirrors the same shape as the MetricItem in ActivationMetricsTab so
// both tabs render consistent micro-stats; kept inline because the only
// other consumer (ActivationMetricsTab) also has its own copy and the
// two trend-prop variants differ slightly.
function MetricItem({
  label,
  value,
  trend,
}: {
  label: string;
  value: string | ReactNode;
  trend?: 'up' | 'down' | 'neutral';
}) {
  return (
    <div>
      <p className="text-xs text-text-secondary">{label}</p>
      <p
        className={clsx(
          'font-medium text-sm',
          trend === 'up' && 'text-success',
          trend === 'down' && 'text-danger',
        )}
      >
        {value}
      </p>
    </div>
  );
}

/**
 * Template Analytics admin tab — extracted from PlatformAdmin.tsx in
 * Phase 2.4. Owns the TemplateAnalytics data shape, SortField/SortDir
 * types, the SortableHeader column header, and the BarChart visualization
 * helper. Self-contained after Step C made it own its sort state.
 */

interface TemplateAnalytics {
  id: string;
  slug: string;
  displayName: string;
  currentVersion: string;
  status: string;
  installCount: number;
  activeInstalls: number;
  totalInstalls: number;
  uninstallCount: number;
  upgradeCount: number;
  activationRate: number;
  uninstallRate: number;
  upgradeAdoption: number;
  totalCalls: number;
  callsLast30d: number;
  avgCallDuration: number;
  avgSatisfaction: number;
  totalCampaigns: number;
  completedCampaigns: number;
}

type SortField = 'displayName' | 'totalInstalls' | 'activationRate' | 'callsLast30d' | 'uninstallRate' | 'avgSatisfaction' | 'totalCampaigns' | 'upgradeAdoption';
type SortDir = 'asc' | 'desc';

function SortableHeader({ label, field, currentField, currentDir, onSort }: {
  label: string;
  field: SortField;
  currentField: SortField;
  currentDir: SortDir;
  onSort: (f: SortField) => void;
}) {
  const active = field === currentField;
  return (
    <th
      className="text-right px-4 py-3 font-medium text-text-muted cursor-pointer select-none hover:text-text-primary transition-colors"
      onClick={() => onSort(field)}
    >
      <span className="inline-flex items-center gap-1 justify-end">
        {label}
        {active ? (
          <span className="text-primary text-[10px]">{currentDir === 'asc' ? '\u25B2' : '\u25BC'}</span>
        ) : (
          <span className="text-text-muted/40 text-[10px]">{'\u25BC'}</span>
        )}
      </span>
    </th>
  );
}

function BarChart({ data, labelKey, valueKey, secondaryKey, barColor, secondaryColor }: {
  data: TemplateAnalytics[];
  labelKey: keyof TemplateAnalytics;
  valueKey: keyof TemplateAnalytics;
  secondaryKey?: keyof TemplateAnalytics;
  barColor: string;
  secondaryColor?: string;
}) {
  const maxVal = Math.max(...data.map(d => Number(d[valueKey]) || 0), 1);
  return (
    <div className="space-y-2">
      {data.map((d) => {
        const val = Number(d[valueKey]) || 0;
        const secVal = secondaryKey ? (Number(d[secondaryKey]) || 0) : 0;
        const pct = (val / maxVal) * 100;
        const secPct = secondaryKey ? (secVal / maxVal) * 100 : 0;
        return (
          <div key={d.id} className="flex items-center gap-3">
            <div className="w-32 truncate text-xs text-text-muted text-right" title={String(d[labelKey])}>
              {String(d[labelKey])}
            </div>
            <div className="flex-1 flex items-center gap-1">
              <div className="flex-1 h-5 bg-surface-hover rounded overflow-hidden relative">
                {secondaryKey && (
                  <div
                    className={`absolute top-0 left-0 h-full rounded ${secondaryColor ?? 'bg-primary/30'}`}
                    style={{ width: `${secPct}%` }}
                  />
                )}
                <div
                  className={`absolute top-0 left-0 h-full rounded ${barColor}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-xs tabular-nums text-text-muted w-12 text-right">{val.toLocaleString()}</span>
              {secondaryKey && (
                <span className="text-xs tabular-nums text-text-muted/60 w-12 text-right">{secVal.toLocaleString()}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function TemplateAnalyticsTab() {
  const { t: adminT } = useTranslation('admin');
  const { data, isLoading: loading } = useQuery({
    queryKey: ['platform-template-analytics'],
    queryFn: () => api.get<{ templates: TemplateAnalytics[] }>('/platform/template-analytics'),
    refetchInterval: 60_000,
  });
  const [sortField, setSortField] = useState<SortField>('totalInstalls');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const onSort = (field: SortField) => {
    if (field === sortField) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };
  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="animate-spin h-8 w-8 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!data?.templates?.length) {
    return (
      <div className="bg-surface border border-border rounded-xl p-12 text-center">
        <BarChart3 className="h-10 w-10 text-text-muted mx-auto mb-3" />
        <p className="text-text-muted">{adminT('platform_admin.template_analytics.no_data_title')}</p>
        <p className="text-xs text-text-muted mt-1">{adminT('platform_admin.template_analytics.no_data_subtitle')}</p>
      </div>
    );
  }

  const templates = data.templates;
  const sorted = [...templates].sort((a, b) => {
    const aVal = a[sortField];
    const bVal = b[sortField];
    if (typeof aVal === 'string' && typeof bVal === 'string') {
      return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
    }
    return sortDir === 'asc' ? (Number(aVal) - Number(bVal)) : (Number(bVal) - Number(aVal));
  });

  const chartData = [...templates].sort((a, b) => b.totalInstalls - a.totalInstalls).slice(0, 10);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          icon={DownloadIcon}
          label={adminT('platform_admin.template_analytics.total_installs')}
          value={String(templates.reduce((s, t) => s + t.totalInstalls, 0))}
          sub={adminT('platform_admin.template_analytics.active_count', { count: templates.reduce((s, t) => s + t.activeInstalls, 0) })}
        />
        <StatCard
          icon={Activity}
          label={adminT('platform_admin.template_analytics.avg_activation_rate')}
          value={`${templates.length > 0 ? Math.round(templates.reduce((s, t) => s + t.activationRate, 0) / templates.length) : 0}%`}
        />
        <StatCard
          icon={PhoneCall}
          label={adminT('platform_admin.template_analytics.template_calls_30d')}
          value={String(templates.reduce((s, t) => s + t.callsLast30d, 0))}
          sub={adminT('platform_admin.template_analytics.total_count', { count: templates.reduce((s, t) => s + t.totalCalls, 0) })}
        />
        <StatCard
          icon={TrendingUp}
          label={adminT('platform_admin.template_analytics.avg_satisfaction')}
          value={(() => {
            const withScores = templates.filter(t => t.avgSatisfaction > 0);
            return withScores.length > 0
              ? (withScores.reduce((s, t) => s + t.avgSatisfaction, 0) / withScores.length).toFixed(1)
              : '\u2014';
          })()}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-surface border border-border rounded-xl p-5">
          <h3 className="font-semibold text-sm mb-1">{adminT('platform_admin.template_analytics.installs_by_template')}</h3>
          <p className="text-xs text-text-muted mb-4">{adminT('platform_admin.template_analytics.installs_chart_subtitle')}</p>
          <BarChart data={chartData} labelKey="displayName" valueKey="activeInstalls" secondaryKey="totalInstalls" barColor="bg-primary" secondaryColor="bg-primary/25" />
        </div>
        <div className="bg-surface border border-border rounded-xl p-5">
          <h3 className="font-semibold text-sm mb-1">{adminT('platform_admin.template_analytics.call_volume_by_template')}</h3>
          <p className="text-xs text-text-muted mb-4">{adminT('platform_admin.template_analytics.call_volume_subtitle')}</p>
          <BarChart data={[...templates].sort((a, b) => b.callsLast30d - a.callsLast30d).slice(0, 10)} labelKey="displayName" valueKey="callsLast30d" barColor="bg-success" />
        </div>
      </div>

      <div className="bg-surface border border-border rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h2 className="font-semibold">{adminT('platform_admin.template_analytics.template_performance')}</h2>
          <p className="text-xs text-text-muted mt-0.5">{adminT('platform_admin.template_analytics.performance_subtitle')}</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-secondary">
                <th className="text-left px-4 py-3 font-medium text-text-muted cursor-pointer select-none hover:text-text-primary" onClick={() => onSort('displayName')}>
                  <span className="inline-flex items-center gap-1">
                    {adminT('platform_admin.template_analytics.header_template')}
                    {sortField === 'displayName' ? <span className="text-primary text-[10px]">{sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span> : <span className="text-text-muted/40 text-[10px]">{'\u25BC'}</span>}
                  </span>
                </th>
                <SortableHeader label={adminT('platform_admin.template_analytics.header_installs')} field="totalInstalls" currentField={sortField} currentDir={sortDir} onSort={onSort} />
                <th className="text-right px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.template_analytics.header_active')}</th>
                <SortableHeader label={adminT('platform_admin.template_analytics.header_activation')} field="activationRate" currentField={sortField} currentDir={sortDir} onSort={onSort} />
                <SortableHeader label={adminT('platform_admin.template_analytics.header_upgrade_adoption')} field="upgradeAdoption" currentField={sortField} currentDir={sortDir} onSort={onSort} />
                <SortableHeader label={adminT('platform_admin.template_analytics.header_uninstalls')} field="uninstallRate" currentField={sortField} currentDir={sortDir} onSort={onSort} />
                <SortableHeader label={adminT('platform_admin.template_analytics.header_calls_30d')} field="callsLast30d" currentField={sortField} currentDir={sortDir} onSort={onSort} />
                <SortableHeader label={adminT('platform_admin.template_analytics.header_campaigns')} field="totalCampaigns" currentField={sortField} currentDir={sortDir} onSort={onSort} />
                <th className="text-right px-4 py-3 font-medium text-text-muted">{adminT('platform_admin.template_analytics.header_avg_duration')}</th>
                <SortableHeader label={adminT('platform_admin.template_analytics.header_csat')} field="avgSatisfaction" currentField={sortField} currentDir={sortDir} onSort={onSort} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((t) => (
                <tr key={t.id} className="border-b border-border last:border-0 hover:bg-surface-secondary/50">
                  <td className="px-4 py-3">
                    <div className="font-medium">{t.displayName}</div>
                    <div className="text-xs text-text-muted font-mono">{adminT('platform_admin.template_analytics.slug_version', { slug: t.slug, version: t.currentVersion })}</div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.totalInstalls}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.activeInstalls}</td>
                  <td className="px-4 py-3 text-right">
                    <span className={`inline-flex items-center gap-1 ${t.activationRate >= 70 ? 'text-success' : t.activationRate >= 40 ? 'text-warning' : 'text-danger'}`}>
                      {t.activationRate >= 70 ? <TrendingUp className="h-3 w-3" /> : t.activationRate < 40 ? <TrendingDown className="h-3 w-3" /> : null}
                      {t.activationRate}%
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    <span className={`inline-flex items-center gap-1 ${t.upgradeAdoption >= 50 ? 'text-success' : t.upgradeAdoption >= 20 ? 'text-warning' : 'text-text-muted'}`}>
                      {t.upgradeAdoption}%
                      <span className="text-text-muted/60">({t.upgradeCount})</span>
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    <span className={t.uninstallRate > 30 ? 'text-danger' : ''}>{adminT('platform_admin.template_analytics.uninstall_inline', { count: t.uninstallCount, rate: t.uninstallRate })}</span>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.callsLast30d.toLocaleString()}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.totalCampaigns > 0 ? adminT('platform_admin.template_analytics.campaigns_inline', { completed: t.completedCampaigns, total: t.totalCampaigns }) : adminT('platform_admin.common.em_dash')}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.avgCallDuration > 0 ? adminT('platform_admin.template_analytics.duration_minutes_seconds', { minutes: Math.floor(t.avgCallDuration / 60), seconds: t.avgCallDuration % 60 }) : adminT('platform_admin.common.em_dash')}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{t.avgSatisfaction > 0 ? t.avgSatisfaction.toFixed(1) : adminT('platform_admin.common.em_dash')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {templates.map((t) => (
          <div key={t.id} className="bg-surface border border-border rounded-xl p-5">
            <div className="flex items-start justify-between mb-3">
              <div>
                <h3 className="font-semibold text-sm">{t.displayName}</h3>
                <p className="text-xs text-text-muted">{adminT('platform_admin.template_analytics.version_label', { version: t.currentVersion })}</p>
              </div>
              <StatusBadge status={t.status} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <MetricItem label={adminT('platform_admin.template_analytics.conversion_rate')} value={`${t.activationRate}%`} trend={t.activationRate >= 50 ? 'up' : t.activationRate >= 20 ? 'neutral' : 'down'} />
              <MetricItem label={adminT('platform_admin.template_analytics.avg_call_duration')} value={t.avgCallDuration > 0 ? adminT('platform_admin.template_analytics.duration_minutes_seconds', { minutes: Math.floor(t.avgCallDuration / 60), seconds: t.avgCallDuration % 60 }) : adminT('platform_admin.common.em_dash')} />
              <MetricItem label={adminT('platform_admin.template_analytics.csat_score')} value={t.avgSatisfaction > 0 ? t.avgSatisfaction.toFixed(1) : adminT('platform_admin.common.em_dash')} trend={t.avgSatisfaction >= 4 ? 'up' : t.avgSatisfaction >= 3 ? 'neutral' : t.avgSatisfaction > 0 ? 'down' : undefined} />
              <MetricItem label={adminT('platform_admin.template_analytics.calls_30d_card')} value={t.callsLast30d.toLocaleString()} />
              <MetricItem label={adminT('platform_admin.template_analytics.upgrade_adoption_card')} value={`${t.upgradeAdoption}%`} trend={t.upgradeAdoption >= 50 ? 'up' : t.upgradeAdoption >= 20 ? 'neutral' : 'down'} />
              <MetricItem label={adminT('platform_admin.template_analytics.uninstall_rate_card')} value={`${t.uninstallRate}%`} trend={t.uninstallRate <= 10 ? 'up' : t.uninstallRate <= 30 ? 'neutral' : 'down'} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default TemplateAnalyticsTab;
