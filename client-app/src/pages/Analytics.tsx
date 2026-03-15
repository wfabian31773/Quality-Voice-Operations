import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useState } from 'react';
import clsx from 'clsx';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from 'recharts';

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

const RANGES = ['7d', '30d', '90d'] as const;

export default function Analytics() {
  const [range, setRange] = useState<string>('30d');

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

  const formatCents = (cents: number) =>
    `$${(cents / 100).toFixed(2)}`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Analytics</h1>
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

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard label="Total Calls" value={callsLoading ? '—' : String(calls?.totalCalls ?? 0)} />
        <KpiCard
          label="Automation Rate"
          value={callsLoading ? '—' : `${((calls?.automationRate ?? 0) * 100).toFixed(1)}%`}
        />
        <KpiCard
          label="Avg Duration"
          value={callsLoading ? '—' : `${Math.round(calls?.avgDurationSeconds ?? 0)}s`}
        />
        <KpiCard
          label="Cost / Call"
          value={
            callsLoading && costsLoading
              ? '—'
              : formatCents(calls?.costPerCallCents ?? costs?.costPerCallCents ?? 0)
          }
        />
      </div>

      <div className="bg-card border border-border rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4">Call Volume Trend</h2>
        {callsLoading ? (
          <div className="h-64 flex items-center justify-center text-muted-foreground">Loading...</div>
        ) : !calls?.dailyBreakdown?.length ? (
          <div className="h-64 flex items-center justify-center text-muted-foreground">No data for this period</div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={calls.dailyBreakdown}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border, #333)" />
              <XAxis
                dataKey="date"
                tickFormatter={(v: string) => v.slice(5)}
                tick={{ fontSize: 11 }}
                stroke="var(--color-muted-foreground, #888)"
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 11 }}
                stroke="var(--color-muted-foreground, #888)"
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--color-card, #1a1a1a)',
                  border: '1px solid var(--color-border, #333)',
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-card border border-border rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-4">Cost Breakdown</h2>
          {costsLoading ? (
            <div className="text-muted-foreground">Loading...</div>
          ) : (
            <div className="space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">OpenAI Inference</span>
                <span className="font-medium">{formatCents(costs?.totalOpenaiCostCents ?? 0)}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Twilio Telephony</span>
                <span className="font-medium">{formatCents(costs?.totalTwilioCostCents ?? 0)}</span>
              </div>
              <div className="border-t border-border pt-2 flex justify-between text-sm font-semibold">
                <span>Total</span>
                <span>{formatCents(costs?.totalCostCents ?? 0)}</span>
              </div>
              <div className="flex justify-between text-sm text-muted-foreground">
                <span>Cost per Call</span>
                <span>{formatCents(costs?.costPerCallCents ?? 0)}</span>
              </div>
            </div>
          )}
        </div>

        <div className="bg-card border border-border rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-4">Call Outcomes</h2>
          {callsLoading ? (
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
        <h2 className="text-lg font-semibold mb-4">Campaign Performance</h2>
        {campaignsLoading ? (
          <div className="text-muted-foreground">Loading...</div>
        ) : !campaignData?.campaigns?.length ? (
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
    </div>
  );
}

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
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
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{count} ({pct.toFixed(1)}%)</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
