import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, TrendingUp, ArrowDown, Globe, ExternalLink } from 'lucide-react';

interface FunnelStage {
  stage: string;
  count: number;
  conversionRate: number;
  dropOffRate: number;
}

interface LandingPageMetric {
  landingPage: string;
  visitors: number;
  signups: number;
  paid: number;
  conversionRate: number;
}

interface SourceMetric {
  source: string;
  visitors: number;
  signups: number;
  paid: number;
  conversionRate: number;
}

interface FunnelData {
  stages: FunnelStage[];
  overallConversionRate: number;
  totalVisitors: number;
  byLandingPage: LandingPageMetric[];
  bySource: SourceMetric[];
}

const STAGE_LABELS: Record<string, string> = {
  page_view: 'Page View',
  cta_click: 'CTA Click',
  demo_started: 'Demo Started',
  signup_started: 'Signup Started',
  signup_completed: 'Signup Completed',
  paid: 'Paid Customer',
};

const STAGE_COLORS: Record<string, string> = {
  page_view: 'bg-blue-500',
  cta_click: 'bg-indigo-500',
  demo_started: 'bg-purple-500',
  signup_started: 'bg-amber-500',
  signup_completed: 'bg-emerald-500',
  paid: 'bg-primary',
};

export default function ConversionFunnel() {
  const [range, setRange] = useState<'7d' | '30d' | '90d'>('30d');

  const { data, isLoading } = useQuery<FunnelData>({
    queryKey: ['conversion-funnel', range],
    queryFn: async () => {
      const res = await fetch(`/api/admin/conversion/funnel?range=${range}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to fetch funnel data');
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="animate-spin h-8 w-8 border-2 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  const funnel = data ?? { stages: [], overallConversionRate: 0, totalVisitors: 0, byLandingPage: [], bySource: [] };
  const maxCount = Math.max(...funnel.stages.map((s) => s.count), 1);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-display font-bold text-sidebar-bg">Website Conversion Funnel</h2>
          <p className="text-sm text-text-secondary">Visitor to paid customer journey across all landing pages</p>
        </div>
        <div className="flex gap-1 bg-surface-hover rounded-lg p-1">
          {(['7d', '30d', '90d'] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                range === r ? 'bg-surface text-sidebar-bg shadow-sm' : 'text-text-secondary hover:text-text-primary'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="bg-surface rounded-xl border border-border p-5">
          <div className="text-sm text-text-secondary mb-1">Total Visitors</div>
          <div className="text-2xl font-display font-bold text-sidebar-bg">{funnel.totalVisitors.toLocaleString()}</div>
        </div>
        <div className="bg-surface rounded-xl border border-border p-5">
          <div className="text-sm text-text-secondary mb-1">Overall Conversion</div>
          <div className="text-2xl font-display font-bold text-emerald-600">{(funnel.overallConversionRate * 100).toFixed(2)}%</div>
        </div>
        <div className="bg-surface rounded-xl border border-border p-5">
          <div className="text-sm text-text-secondary mb-1">Paid Customers</div>
          <div className="text-2xl font-display font-bold text-primary">
            {funnel.stages.find((s) => s.stage === 'paid')?.count ?? 0}
          </div>
        </div>
      </div>

      <div className="bg-surface rounded-xl border border-border p-6">
        <h3 className="text-sm font-semibold text-sidebar-bg mb-6">Funnel Stages</h3>
        <div className="space-y-4">
          {funnel.stages.map((stage, idx) => (
            <div key={stage.stage}>
              <div className="flex items-center justify-between mb-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-sidebar-bg">{STAGE_LABELS[stage.stage] ?? stage.stage}</span>
                  <span className="text-xs text-text-muted">{stage.count.toLocaleString()}</span>
                </div>
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-text-secondary">{(stage.conversionRate * 100).toFixed(1)}% of total</span>
                  {idx > 0 && stage.dropOffRate > 0 && (
                    <span className="text-red-500 flex items-center gap-0.5">
                      <ArrowDown className="h-3 w-3" />
                      {(stage.dropOffRate * 100).toFixed(1)}% drop
                    </span>
                  )}
                </div>
              </div>
              <div className="h-6 bg-surface-hover rounded-lg overflow-hidden">
                <div
                  className={`h-full rounded-lg ${STAGE_COLORS[stage.stage] ?? 'bg-slate-400'} transition-all duration-500`}
                  style={{ width: `${Math.max(2, (stage.count / maxCount) * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-surface rounded-xl border border-border p-6">
          <h3 className="text-sm font-semibold text-sidebar-bg mb-4 flex items-center gap-2">
            <Globe className="h-4 w-4" /> By Landing Page
          </h3>
          {funnel.byLandingPage.length === 0 ? (
            <p className="text-sm text-text-muted py-4 text-center">No data yet</p>
          ) : (
            <div className="space-y-3">
              {funnel.byLandingPage.map((lp) => (
                <div key={lp.landingPage} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2 min-w-0">
                    <ExternalLink className="h-3.5 w-3.5 text-text-muted shrink-0" />
                    <span className="truncate text-text-primary">{lp.landingPage}</span>
                  </div>
                  <div className="flex items-center gap-4 shrink-0 ml-4">
                    <span className="text-text-secondary">{lp.visitors} visits</span>
                    <span className="text-text-secondary">{lp.signups} signups</span>
                    <span className="font-medium text-sidebar-bg">{(lp.conversionRate * 100).toFixed(1)}%</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-surface rounded-xl border border-border p-6">
          <h3 className="text-sm font-semibold text-sidebar-bg mb-4 flex items-center gap-2">
            <TrendingUp className="h-4 w-4" /> By Traffic Source
          </h3>
          {funnel.bySource.length === 0 ? (
            <p className="text-sm text-text-muted py-4 text-center">No data yet</p>
          ) : (
            <div className="space-y-3">
              {funnel.bySource.map((src) => (
                <div key={src.source} className="flex items-center justify-between text-sm">
                  <span className="text-text-primary capitalize">{src.source}</span>
                  <div className="flex items-center gap-4 shrink-0">
                    <span className="text-text-secondary">{src.visitors} visits</span>
                    <span className="text-text-secondary">{src.signups} signups</span>
                    <span className="font-medium text-sidebar-bg">{(src.conversionRate * 100).toFixed(1)}%</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
