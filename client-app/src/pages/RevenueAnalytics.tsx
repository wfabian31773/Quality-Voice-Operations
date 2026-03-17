import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useState } from 'react';
import clsx from 'clsx';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  LineChart, Line, PieChart, Pie, Cell, AreaChart, Area,
} from 'recharts';
import {
  DollarSign, Users, PhoneIncoming,
  Target, AlertTriangle, Download,
} from 'lucide-react';

interface RevenueData {
  totalRevenueCents: number;
  totalAppointmentsBooked: number;
  avgTicketValueCents: number;
  revenueByAgent: Array<{
    agentId: string;
    agentName: string;
    appointmentsBooked: number;
    revenueCents: number;
    callsHandled: number;
    bookingRate: number;
  }>;
  missedRevenueCents: number;
  missedOpportunities: number;
  missedCallsPrevented: number;
  dailyRevenue: Array<{
    date: string;
    revenueCents: number;
    appointmentsBooked: number;
  }>;
}

interface SentimentData {
  trends: Array<{
    date: string;
    avgScore: number;
    callCount: number;
    positiveCount: number;
    neutralCount: number;
    negativeCount: number;
  }>;
  agentSentiments: Array<{
    agentId: string;
    agentName: string;
    avgScore: number;
    callCount: number;
    positiveRate: number;
  }>;
}

interface TopicData {
  distribution: Array<{
    topic: string;
    count: number;
    percentage: number;
  }>;
  trends: Array<{
    date: string;
    topic: string;
    count: number;
  }>;
}

interface FunnelData {
  funnel: {
    stages: Array<{
      stage: string;
      count: number;
      dropOffRate: number;
      conversionRate: number;
    }>;
    overallConversionRate: number;
    totalCalls: number;
  };
  trends: Array<{
    date: string;
    stages: Record<string, number>;
  }>;
}

interface AgentRow {
  agentId: string;
  agentName: string;
  totalCalls: number;
  avgDurationSeconds: number;
  completedCalls: number;
  failedCalls: number;
  avgQualityScore: number;
}

const RANGES = ['7d', '30d', '90d'] as const;
const TOPIC_COLORS = [
  '#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444',
  '#06b6d4', '#ec4899', '#84cc16', '#f97316', '#6366f1',
  '#14b8a6', '#a855f7',
];

const STAGE_LABELS: Record<string, string> = {
  call_received: 'Calls Received',
  qualified: 'Qualified Leads',
  appointment_offered: 'Appointments Offered',
  appointment_booked: 'Appointments Booked',
  confirmed: 'Confirmed',
};

function formatCents(cents: number): string {
  if (cents >= 100000) return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  return `$${(cents / 100).toFixed(2)}`;
}

function formatTopicLabel(topic: string): string {
  return topic
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function sentimentColor(score: number): string {
  if (score > 0.3) return 'text-green-500';
  if (score < -0.3) return 'text-red-500';
  return 'text-yellow-500';
}

export default function RevenueAnalytics() {
  const [range, setRange] = useState<string>('30d');

  const { data: revenue, isLoading: revenueLoading } = useQuery({
    queryKey: ['analytics-revenue', range],
    queryFn: () => api.get<RevenueData>(`/analytics/revenue?range=${range}`),
    refetchInterval: 120_000,
  });

  const { data: sentiment, isLoading: sentimentLoading } = useQuery({
    queryKey: ['analytics-sentiment', range],
    queryFn: () => api.get<SentimentData>(`/analytics/sentiment?range=${range}`),
    refetchInterval: 120_000,
  });

  const { data: topics, isLoading: topicsLoading } = useQuery({
    queryKey: ['analytics-topics', range],
    queryFn: () => api.get<TopicData>(`/analytics/topics?range=${range}`),
    refetchInterval: 120_000,
  });

  const { data: funnelData, isLoading: funnelLoading } = useQuery({
    queryKey: ['analytics-funnel', range],
    queryFn: () => api.get<FunnelData>(`/analytics/funnel?range=${range}`),
    refetchInterval: 120_000,
  });

  const { data: agentsData, isLoading: agentsLoading } = useQuery({
    queryKey: ['analytics-agents', range],
    queryFn: () => api.get<{ agents: AgentRow[] }>(`/analytics/agents?range=${range}`),
    refetchInterval: 120_000,
  });

  const handleExport = () => {
    const data = {
      exportedAt: new Date().toISOString(),
      range,
      revenue,
      sentiment,
      topics,
      funnel: funnelData,
      agents: agentsData,
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `revenue-analytics-${range}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Revenue & Performance</h1>
          <p className="text-sm text-muted-foreground mt-1">Revenue attribution, sentiment, topics, and conversion analytics</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleExport}
            className="flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-md border border-border bg-background hover:bg-muted transition-colors"
          >
            <Download className="w-4 h-4" />
            Export
          </button>
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
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard
          icon={DollarSign}
          label="Total Revenue"
          value={revenueLoading ? '—' : formatCents(revenue?.totalRevenueCents ?? 0)}
          iconColor="text-green-500"
        />
        <KpiCard
          icon={Target}
          label="Appointments Booked"
          value={revenueLoading ? '—' : String(revenue?.totalAppointmentsBooked ?? 0)}
          iconColor="text-blue-500"
        />
        <KpiCard
          icon={AlertTriangle}
          label="Missed Revenue"
          value={revenueLoading ? '—' : formatCents(revenue?.missedRevenueCents ?? 0)}
          iconColor="text-red-500"
          subtitle={revenueLoading ? '' : `${revenue?.missedOpportunities ?? 0} missed opportunities`}
        />
        <KpiCard
          icon={PhoneIncoming}
          label="Missed Calls Prevented"
          value={revenueLoading ? '—' : String(revenue?.missedCallsPrevented ?? 0)}
          iconColor="text-emerald-500"
        />
      </div>

      <div className="bg-card border border-border rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4">Revenue Trend</h2>
        {revenueLoading ? (
          <LoadingPlaceholder />
        ) : !revenue?.dailyRevenue?.length ? (
          <EmptyPlaceholder message="No revenue data for this period" />
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={revenue.dailyRevenue}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border, #333)" />
              <XAxis dataKey="date" tickFormatter={(v: string) => v.slice(5)} tick={{ fontSize: 11 }} stroke="var(--color-muted-foreground, #888)" />
              <YAxis tickFormatter={(v: number) => `$${(v / 100).toFixed(0)}`} tick={{ fontSize: 11 }} stroke="var(--color-muted-foreground, #888)" />
              <Tooltip
                formatter={(value: number | undefined) => [formatCents(value ?? 0), 'Revenue']}
                contentStyle={tooltipStyle}
              />
              <Area type="monotone" dataKey="revenueCents" stroke="#10b981" fill="#10b98133" strokeWidth={2} name="Revenue" />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-card border border-border rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-4">Booking Conversion Funnel</h2>
          {funnelLoading ? (
            <LoadingPlaceholder />
          ) : !funnelData?.funnel?.stages?.length ? (
            <EmptyPlaceholder message="No funnel data available" />
          ) : (
            <div className="space-y-3">
              {funnelData.funnel.stages.map((stage, idx) => {
                const maxCount = funnelData.funnel.stages[0]?.count || 1;
                const width = maxCount > 0 ? (stage.count / maxCount) * 100 : 0;
                return (
                  <div key={stage.stage} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">{STAGE_LABELS[stage.stage] ?? stage.stage}</span>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{stage.count}</span>
                        {idx > 0 && stage.dropOffRate > 0 && (
                          <span className="text-xs text-red-400">
                            -{(stage.dropOffRate * 100).toFixed(0)}%
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full bg-blue-500 transition-all duration-500"
                        style={{ width: `${Math.max(width, 2)}%`, opacity: 1 - idx * 0.15 }}
                      />
                    </div>
                  </div>
                );
              })}
              <div className="pt-2 border-t border-border text-sm">
                <span className="text-muted-foreground">Overall Conversion: </span>
                <span className="font-semibold">{(funnelData.funnel.overallConversionRate * 100).toFixed(1)}%</span>
              </div>
            </div>
          )}
        </div>

        <div className="bg-card border border-border rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-4">Topic Distribution</h2>
          {topicsLoading ? (
            <LoadingPlaceholder />
          ) : !topics?.distribution?.length ? (
            <EmptyPlaceholder message="No topic data available" />
          ) : (
            <div className="flex items-center gap-6">
              <div className="w-1/2">
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie
                      data={topics.distribution}
                      dataKey="count"
                      nameKey="topic"
                      cx="50%"
                      cy="50%"
                      outerRadius={80}
                      innerRadius={40}
                    >
                      {topics.distribution.map((_, idx) => (
                        <Cell key={idx} fill={TOPIC_COLORS[idx % TOPIC_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value: number | undefined, name: string | undefined) => [value ?? 0, formatTopicLabel(name ?? '')]}
                      contentStyle={tooltipStyle}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="w-1/2 space-y-1.5 max-h-[200px] overflow-y-auto">
                {topics.distribution.map((t, idx) => (
                  <div key={t.topic} className="flex items-center gap-2 text-sm">
                    <div
                      className="w-3 h-3 rounded-sm flex-shrink-0"
                      style={{ backgroundColor: TOPIC_COLORS[idx % TOPIC_COLORS.length] }}
                    />
                    <span className="text-muted-foreground truncate flex-1">{formatTopicLabel(t.topic)}</span>
                    <span className="font-medium">{t.count}</span>
                    <span className="text-xs text-muted-foreground">({(t.percentage * 100).toFixed(0)}%)</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4">Customer Sentiment Trend</h2>
        {sentimentLoading ? (
          <LoadingPlaceholder />
        ) : !sentiment?.trends?.length ? (
          <EmptyPlaceholder message="No sentiment data for this period" />
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={sentiment.trends}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border, #333)" />
              <XAxis dataKey="date" tickFormatter={(v: string) => v.slice(5)} tick={{ fontSize: 11 }} stroke="var(--color-muted-foreground, #888)" />
              <YAxis domain={[-1, 1]} tick={{ fontSize: 11 }} stroke="var(--color-muted-foreground, #888)" />
              <Tooltip contentStyle={tooltipStyle} />
              <Line type="monotone" dataKey="avgScore" stroke="#3b82f6" strokeWidth={2} dot={false} name="Avg Sentiment" />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-card border border-border rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-4">Sentiment by Agent</h2>
          {sentimentLoading ? (
            <LoadingPlaceholder />
          ) : !sentiment?.agentSentiments?.length ? (
            <EmptyPlaceholder message="No agent sentiment data" />
          ) : (
            <div className="space-y-3">
              {sentiment.agentSentiments.map((a) => (
                <div key={a.agentId} className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <Users className="w-4 h-4 text-muted-foreground" />
                    <span className="font-medium">{a.agentName}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className={clsx('font-medium', sentimentColor(a.avgScore))}>
                      {a.avgScore > 0 ? '+' : ''}{a.avgScore.toFixed(2)}
                    </span>
                    <span className="text-muted-foreground">{a.callCount} calls</span>
                    <span className="text-green-500 text-xs">{(a.positiveRate * 100).toFixed(0)}% positive</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-card border border-border rounded-xl p-6">
          <h2 className="text-lg font-semibold mb-4">Revenue by Agent</h2>
          {revenueLoading ? (
            <LoadingPlaceholder />
          ) : !revenue?.revenueByAgent?.length ? (
            <EmptyPlaceholder message="No revenue per agent data" />
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={revenue.revenueByAgent.filter((a) => a.callsHandled > 0)} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border, #333)" />
                <XAxis type="number" tickFormatter={(v: number) => `$${(v / 100).toFixed(0)}`} tick={{ fontSize: 11 }} stroke="var(--color-muted-foreground, #888)" />
                <YAxis type="category" dataKey="agentName" width={120} tick={{ fontSize: 11 }} stroke="var(--color-muted-foreground, #888)" />
                <Tooltip
                  formatter={(value: number | undefined) => [formatCents(value ?? 0), 'Revenue']}
                  contentStyle={tooltipStyle}
                />
                <Bar dataKey="revenueCents" fill="#10b981" radius={[0, 4, 4, 0]} name="Revenue" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="bg-card border border-border rounded-xl p-6">
        <h2 className="text-lg font-semibold mb-4">Agent Success Rate Cards</h2>
        {agentsLoading || revenueLoading || sentimentLoading ? (
          <LoadingPlaceholder />
        ) : !agentsData?.agents?.length ? (
          <EmptyPlaceholder message="No agent data available" />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {agentsData.agents.map((agent) => {
              const revenueAgent = revenue?.revenueByAgent?.find((a) => a.agentId === agent.agentId);
              const sentimentAgent = sentiment?.agentSentiments?.find((a) => a.agentId === agent.agentId);
              const bookingRate = revenueAgent?.bookingRate ?? 0;

              return (
                <div key={agent.agentId} className="bg-background border border-border rounded-lg p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center">
                      <Users className="w-4 h-4 text-primary" />
                    </div>
                    <div>
                      <p className="font-semibold text-sm">{agent.agentName}</p>
                      <p className="text-xs text-muted-foreground">{agent.totalCalls} calls handled</p>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <MetricItem label="Booking Rate" value={`${(bookingRate * 100).toFixed(1)}%`} />
                    <MetricItem label="Quality Score" value={agent.avgQualityScore > 0 ? agent.avgQualityScore.toFixed(1) : '—'} />
                    <MetricItem
                      label="Sentiment"
                      value={sentimentAgent ? `${sentimentAgent.avgScore > 0 ? '+' : ''}${sentimentAgent.avgScore.toFixed(2)}` : '—'}
                      valueClass={sentimentAgent ? sentimentColor(sentimentAgent.avgScore) : ''}
                    />
                    <MetricItem label="Revenue" value={revenueAgent ? formatCents(revenueAgent.revenueCents) : '$0.00'} />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

const tooltipStyle = {
  backgroundColor: 'var(--color-card, #1a1a1a)',
  border: '1px solid var(--color-border, #333)',
  borderRadius: 8,
  fontSize: 13,
};

function KpiCard({
  icon: Icon,
  label,
  value,
  iconColor,
  subtitle,
}: {
  icon: typeof DollarSign;
  label: string;
  value: string;
  iconColor: string;
  subtitle?: string;
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-4">
      <div className="flex items-center gap-2 mb-1">
        <Icon className={clsx('w-4 h-4', iconColor)} />
        <p className="text-sm text-muted-foreground">{label}</p>
      </div>
      <p className="text-2xl font-bold">{value}</p>
      {subtitle && <p className="text-xs text-muted-foreground mt-1">{subtitle}</p>}
    </div>
  );
}

function MetricItem({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={clsx('font-medium text-sm', valueClass)}>{value}</p>
    </div>
  );
}

function LoadingPlaceholder() {
  return (
    <div className="h-48 flex items-center justify-center text-muted-foreground">
      Loading...
    </div>
  );
}

function EmptyPlaceholder({ message }: { message: string }) {
  return (
    <div className="h-48 flex items-center justify-center text-muted-foreground">
      {message}
    </div>
  );
}
