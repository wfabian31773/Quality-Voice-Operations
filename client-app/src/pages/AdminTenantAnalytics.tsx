import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';
import { ArrowLeft } from 'lucide-react';
import { api } from '../lib/api';
import GlobalScopeBanner from '../components/GlobalScopeBanner';

interface TenantInfo {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan: string | null;
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

interface TenantAnalyticsResponse {
  tenant: TenantInfo;
  range: string;
  calls: CallAnalytics;
  campaigns: { campaigns: CampaignRow[] };
  costs: CostAnalytics;
}

const RANGES = ['7d', '30d', '90d'] as const;

function formatCents(cents: number): string {
  return `$${(cents / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function AdminTenantAnalytics() {
  const { tenantId } = useParams<{ tenantId: string }>();
  const navigate = useNavigate();
  const [range, setRange] = useState<string>('30d');

  const { data, isLoading, error } = useQuery({
    queryKey: ['admin-tenant-analytics', tenantId, range],
    queryFn: () => api.get<TenantAnalyticsResponse>(`/platform/tenants/${tenantId}/analytics?range=${range}`),
    enabled: !!tenantId,
    refetchInterval: 120_000,
  });

  const tenant = data?.tenant;
  const calls = data?.calls;
  const campaigns = data?.campaigns?.campaigns ?? [];
  const costs = data?.costs;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/admin/analytics')}
            className="inline-flex items-center gap-1.5 text-sm text-purple-300 hover:text-purple-200"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Global Analytics
          </button>
        </div>
        <div className="flex gap-1 bg-muted rounded-lg p-1">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={clsx(
                'px-3 py-1.5 text-sm font-medium rounded-md transition-colors',
                range === r
                  ? 'bg-background shadow text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h1 className="text-2xl font-bold text-white">
          {tenant ? tenant.name : 'Tenant Analytics'}
        </h1>
        <p className="text-sm text-purple-200/70 mt-1">
          {tenant
            ? `Per-tenant analytics for ${tenant.slug} · plan ${tenant.plan ?? '—'} · status ${tenant.status}`
            : 'Loading tenant context…'}
        </p>
      </div>

      <GlobalScopeBanner
        variant="tenant"
        tenantName={tenant?.name}
        tenantSlug={tenant?.slug}
      />

      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          Failed to load tenant analytics. The tenant may not exist or the request failed.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard
          label="Total Calls"
          value={isLoading ? '—' : String(calls?.totalCalls ?? 0)}
          to={tenantId ? `/admin/analytics/tenants/${tenantId}/calls?range=${range}` : undefined}
          linkLabel="View calls →"
        />
        <KpiCard
          label="Automation Rate"
          value={isLoading ? '—' : `${((calls?.automationRate ?? 0) * 100).toFixed(1)}%`}
        />
        <KpiCard
          label="Avg Duration"
          value={isLoading ? '—' : `${Math.round(calls?.avgDurationSeconds ?? 0)}s`}
        />
        <KpiCard
          label="Cost / Call"
          value={isLoading ? '—' : formatCents(calls?.costPerCallCents ?? costs?.costPerCallCents ?? 0)}
        />
      </div>

      <div className="bg-card border border-border rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4 text-text-primary">
          Call Volume <span className="text-xs font-normal text-text-secondary ml-2">tenant-scoped · last {range}</span>
        </h2>
        {isLoading ? (
          <div className="h-64 flex items-center justify-center text-muted-foreground">Loading...</div>
        ) : !calls?.dailyBreakdown?.length ? (
          <div className="h-64 flex items-center justify-center text-muted-foreground">No data for this period</div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={calls.dailyBreakdown}>
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
              <Bar dataKey="inbound" stackId="calls" fill="#3b82f6" name="Inbound" />
              <Bar dataKey="outbound" stackId="calls" fill="#8b5cf6" name="Outbound" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-card border border-border rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-4 text-text-primary">Cost Breakdown</h2>
          {isLoading ? (
            <div className="text-muted-foreground">Loading...</div>
          ) : (
            <div className="space-y-3 text-sm">
              <Row label="OpenAI Inference" value={formatCents(costs?.totalOpenaiCostCents ?? 0)} />
              <Row label="Twilio Telephony" value={formatCents(costs?.totalTwilioCostCents ?? 0)} />
              <div className="border-t border-border pt-3">
                <Row label="Total" value={formatCents(costs?.totalCostCents ?? 0)} bold />
              </div>
              <Row label="Cost per Call" value={formatCents(costs?.costPerCallCents ?? 0)} muted />
            </div>
          )}
        </div>

        <div className="bg-card border border-border rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-4 text-text-primary">Call Outcomes</h2>
          {isLoading ? (
            <div className="text-muted-foreground">Loading...</div>
          ) : (
            <div className="space-y-3">
              <OutcomeRow label="Completed" count={calls?.completedCalls ?? 0} total={calls?.totalCalls ?? 0} color="bg-green-500" />
              <OutcomeRow label="Escalated" count={calls?.escalatedCalls ?? 0} total={calls?.totalCalls ?? 0} color="bg-yellow-500" />
              <OutcomeRow label="Failed" count={calls?.failedCalls ?? 0} total={calls?.totalCalls ?? 0} color="bg-red-500" />
            </div>
          )}
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4 text-text-primary">Campaign Performance</h2>
        {isLoading ? (
          <div className="text-muted-foreground">Loading...</div>
        ) : !campaigns.length ? (
          <div className="text-muted-foreground">No campaigns in this period</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="pb-2 font-medium">Campaign</th>
                  <th className="pb-2 font-medium text-right">Contacts</th>
                  <th className="pb-2 font-medium text-right">Answered</th>
                  <th className="pb-2 font-medium text-right">Voicemail</th>
                  <th className="pb-2 font-medium text-right">Completion</th>
                  <th className="pb-2 font-medium text-right">Avg Duration</th>
                  <th className="pb-2 font-medium text-right">Cost/Contact</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((c) => (
                  <tr
                    key={c.campaignId}
                    onClick={() => tenantId && navigate(`/admin/analytics/tenants/${tenantId}/campaigns/${c.campaignId}`)}
                    className="border-b border-border/50 cursor-pointer hover:bg-surface-hover transition-colors"
                  >
                    <td className="py-2.5 font-medium text-text-primary">
                      <Link
                        to={tenantId ? `/admin/analytics/tenants/${tenantId}/campaigns/${c.campaignId}` : '#'}
                        className="text-purple-300 hover:text-purple-200 hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {c.campaignName}
                      </Link>
                    </td>
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
    </div>
  );
}

function KpiCard({
  label,
  value,
  to,
  linkLabel,
}: {
  label: string;
  value: string;
  to?: string;
  linkLabel?: string;
}) {
  const inner = (
    <>
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="text-2xl font-bold mt-1 text-text-primary">{value}</p>
      {to && (
        <p className="text-xs text-purple-300 mt-2 group-hover:text-purple-200">
          {linkLabel ?? 'View →'}
        </p>
      )}
    </>
  );
  if (to) {
    return (
      <Link
        to={to}
        className="group block bg-card border border-border rounded-xl p-4 hover:border-purple-400/50 hover:bg-surface-hover transition-colors"
      >
        {inner}
      </Link>
    );
  }
  return <div className="bg-card border border-border rounded-xl p-4">{inner}</div>;
}

function Row({ label, value, bold, muted }: { label: string; value: string; bold?: boolean; muted?: boolean }) {
  return (
    <div className={clsx('flex justify-between text-sm', bold && 'font-semibold text-text-primary', muted && 'text-muted-foreground')}>
      <span className={muted ? '' : 'text-muted-foreground'}>{label}</span>
      <span className="text-text-primary">{value}</span>
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
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium text-text-primary">{count} ({pct.toFixed(1)}%)</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
