import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect, useRef } from 'react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import {
  Activity, Users, DollarSign, Brain, HeartPulse, AlertTriangle,
  BarChart3, Server, TrendingUp, Globe, Zap, ChevronRight,
  CheckCircle2, XCircle, Clock, Shield, Wifi, Phone, Bot,
  ArrowUpRight, ArrowDownRight, RefreshCw, Megaphone, Settings2,
  AlertCircle, Eye,
} from 'lucide-react';
import clsx from 'clsx';

interface WorkforceData {
  totalAgents: number;
  activeAgents: number;
  conversationsToday: number;
  tasksCompleted: number;
  activeConversations: number;
  utilization: number;
}

interface RevenueData {
  bookingsToday: number;
  revenueToday: number;
  conversionRate: number;
  missedCallsPrevented: number;
  missedCallRevenue: number;
  outboundConversions: number;
  estimatedAnnualRevenue: number;
  callsCompleted: number;
}

interface AutopilotRec {
  id: string;
  title: string;
  description: string;
  status: string;
  risk_tier: string;
  category: string;
  estimated_impact: Record<string, unknown> | null;
  created_at: string;
}

interface AutopilotFeed {
  recommendations: AutopilotRec[];
  summary: { pending: number; approved: number; rejected: number; dismissed: number };
}

interface HealthSignal {
  tenantId?: string;
  tenantName?: string;
  agentId?: string;
  agentName?: string;
  status?: string;
  callsLast7d: number;
  risk: string;
}

interface RiskAlert {
  id: string;
  type: string;
  severity: string;
  message: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

interface RiskAlertData {
  alerts: RiskAlert[];
  counts: { critical_count: number; high_count: number; medium_count: number; low_count: number };
}

interface VerticalMetric {
  vertical: string;
  totalCalls: number;
  bookings: number;
  bookingRate: number;
  completionRate: number;
  avgDuration: number;
  revenuePerCall: number;
}

interface InfraData {
  systemMetrics: Array<{ metric_name: string; metric_value: number }>;
  callConnectionRate: number;
  callFailureRate: number;
  avgVoiceLatency: number;
  apiHealth: number;
  smsDeliveryRate: number;
}

interface ForecastDay {
  date: string;
  projectedCalls: number;
  projectedBookings: number;
  projectedRevenue: number;
}

interface ForecastData {
  historical: Array<{ day: string; calls: number; bookings: number }>;
  forecast: ForecastDay[];
  avgDailyCalls: number;
  avgDailyBookings: number;
}

interface IntelData {
  benchmarks: {
    industryAvgBookingRate: number;
    industryAvgCompletionRate: number;
    industryAvgDuration: number;
    yourBookingRate: number;
    yourCompletionRate: number;
    yourAvgDuration: number;
  };
  trends: Array<{ trend: string; category: string }>;
  gaps: Array<{ metric: string; gap: number; unit: string }>;
}

type ECCRole = 'platform_admin' | 'executive' | 'operations_manager' | 'customer_success';

function formatCurrency(cents: number): string {
  return '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatNumber(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

function KPICard({ icon: Icon, label, value, subtitle, color, trend }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  subtitle?: string;
  color: string;
  trend?: { value: number; positive: boolean };
}) {
  return (
    <div className="bg-gray-900 border border-gray-700/50 rounded-xl p-5 hover:border-gray-600/50 transition-all">
      <div className="flex items-start justify-between">
        <div className={`p-2.5 rounded-lg ${color}`}>
          <Icon className="h-5 w-5" />
        </div>
        {trend && (
          <div className={clsx('flex items-center gap-1 text-xs font-medium', trend.positive ? 'text-emerald-400' : 'text-red-400')}>
            {trend.positive ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
            {trend.value}%
          </div>
        )}
      </div>
      <p className="text-2xl font-bold text-white mt-3">{value}</p>
      <p className="text-sm text-gray-400 mt-0.5">{label}</p>
      {subtitle && <p className="text-xs text-gray-500 mt-1">{subtitle}</p>}
    </div>
  );
}

function SectionHeader({ icon: Icon, title, badge }: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  badge?: number;
}) {
  return (
    <div className="flex items-center gap-2 mb-4">
      <Icon className="h-5 w-5 text-cyan-400" />
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      {badge !== undefined && badge > 0 && (
        <span className="ml-2 px-2 py-0.5 bg-cyan-500/20 text-cyan-300 text-xs font-medium rounded-full">{badge}</span>
      )}
    </div>
  );
}

function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={clsx('bg-gray-900/80 border border-gray-700/50 rounded-xl p-5', className)}>
      {children}
    </div>
  );
}

function WorkforceModule() {
  const { data } = useQuery<WorkforceData>({
    queryKey: ['ecc', 'workforce'],
    queryFn: () => api.get('/command-center/workforce'),
    refetchInterval: 15000,
  });

  if (!data) return <Panel><div className="animate-pulse h-32 bg-gray-800 rounded-lg" /></Panel>;

  return (
    <Panel>
      <SectionHeader icon={Users} title="AI Workforce Overview" />
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
        <KPICard icon={Bot} label="Active Agents" value={data.activeAgents} subtitle={`of ${data.totalAgents} total`} color="bg-blue-500/20 text-blue-400" />
        <KPICard icon={Phone} label="Conversations Today" value={data.conversationsToday} color="bg-emerald-500/20 text-emerald-400" />
        <KPICard icon={CheckCircle2} label="Tasks Completed" value={data.tasksCompleted} color="bg-purple-500/20 text-purple-400" />
        <KPICard icon={Activity} label="Active Now" value={data.activeConversations} color="bg-amber-500/20 text-amber-400" />
        <KPICard icon={Zap} label="Utilization" value={`${data.utilization}%`} color="bg-cyan-500/20 text-cyan-400" />
      </div>
    </Panel>
  );
}

function RevenueModule() {
  const { data } = useQuery<RevenueData>({
    queryKey: ['ecc', 'revenue'],
    queryFn: () => api.get('/command-center/revenue'),
    refetchInterval: 30000,
  });

  if (!data) return <Panel><div className="animate-pulse h-32 bg-gray-800 rounded-lg" /></Panel>;

  return (
    <Panel>
      <SectionHeader icon={DollarSign} title="Revenue Impact Dashboard" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard icon={DollarSign} label="Revenue Today" value={formatCurrency(data.revenueToday)} color="bg-emerald-500/20 text-emerald-400" />
        <KPICard icon={CheckCircle2} label="Bookings Today" value={data.bookingsToday} subtitle={`${data.conversionRate}% conversion`} color="bg-blue-500/20 text-blue-400" />
        <KPICard icon={Phone} label="Missed Calls Prevented" value={data.missedCallsPrevented} subtitle={formatCurrency(data.missedCallRevenue) + ' saved'} color="bg-purple-500/20 text-purple-400" />
        <KPICard icon={TrendingUp} label="Est. Annual Revenue" value={formatCurrency(data.estimatedAnnualRevenue)} color="bg-amber-500/20 text-amber-400" />
      </div>
    </Panel>
  );
}

function AutopilotModule() {
  const queryClient = useQueryClient();
  const { data } = useQuery<AutopilotFeed>({
    queryKey: ['ecc', 'autopilot'],
    queryFn: () => api.get('/command-center/autopilot-feed'),
    refetchInterval: 20000,
  });

  const handleAction = async (id: string, action: 'approve' | 'dismiss') => {
    try {
      const endpoint = action === 'approve'
        ? `/autopilot/recommendations/${id}/approve`
        : `/autopilot/recommendations/${id}/dismiss`;
      await api.post(endpoint);
      queryClient.invalidateQueries({ queryKey: ['ecc', 'autopilot'] });
    } catch {}
  };

  if (!data) return <Panel><div className="animate-pulse h-32 bg-gray-800 rounded-lg" /></Panel>;

  return (
    <Panel>
      <SectionHeader icon={Brain} title="Autopilot Intelligence Feed" badge={data.summary.pending} />
      <div className="flex gap-4 mb-4 text-xs">
        <span className="text-amber-400">{data.summary.pending} pending</span>
        <span className="text-emerald-400">{data.summary.approved} approved</span>
        <span className="text-red-400">{data.summary.rejected} rejected</span>
      </div>
      <div className="space-y-2 max-h-64 overflow-y-auto">
        {data.recommendations.length === 0 && (
          <p className="text-gray-500 text-sm">No recommendations yet</p>
        )}
        {data.recommendations.map((rec) => (
          <div key={rec.id} className={clsx(
            'p-3 rounded-lg border',
            rec.status === 'pending' ? 'bg-gray-800/50 border-amber-500/30' : 'bg-gray-800/30 border-gray-700/30',
          )}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-white truncate">{rec.title}</p>
                <p className="text-xs text-gray-400 mt-0.5 line-clamp-2">{rec.description}</p>
                <div className="flex items-center gap-2 mt-1.5">
                  <span className={clsx('text-xs px-1.5 py-0.5 rounded', {
                    'bg-red-500/20 text-red-400': rec.risk_tier === 'high',
                    'bg-amber-500/20 text-amber-400': rec.risk_tier === 'medium',
                    'bg-emerald-500/20 text-emerald-400': rec.risk_tier === 'low',
                  })}>{rec.risk_tier}</span>
                  <span className="text-xs text-gray-500">{rec.category}</span>
                </div>
              </div>
              {rec.status === 'pending' && (
                <div className="flex gap-1.5 shrink-0">
                  <button onClick={() => handleAction(rec.id, 'approve')} className="p-1.5 rounded-lg bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors">
                    <CheckCircle2 className="h-4 w-4" />
                  </button>
                  <button onClick={() => handleAction(rec.id, 'dismiss')} className="p-1.5 rounded-lg bg-gray-700/50 text-gray-400 hover:bg-gray-700 transition-colors">
                    <XCircle className="h-4 w-4" />
                  </button>
                </div>
              )}
              {rec.status !== 'pending' && (
                <span className={clsx('text-xs px-2 py-0.5 rounded-full', {
                  'bg-emerald-500/20 text-emerald-400': rec.status === 'approved',
                  'bg-red-500/20 text-red-400': rec.status === 'rejected',
                  'bg-gray-600/20 text-gray-400': rec.status === 'dismissed',
                })}>{rec.status}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function CustomerHealthModule() {
  const { data } = useQuery<{ signals: HealthSignal[]; role: string }>({
    queryKey: ['ecc', 'customer-health'],
    queryFn: () => api.get('/command-center/customer-health'),
    refetchInterval: 60000,
  });

  if (!data) return <Panel><div className="animate-pulse h-32 bg-gray-800 rounded-lg" /></Panel>;

  return (
    <Panel>
      <SectionHeader icon={HeartPulse} title="Customer Health Monitor" />
      <div className="space-y-2 max-h-56 overflow-y-auto">
        {data.signals.length === 0 && (
          <p className="text-gray-500 text-sm">All systems healthy</p>
        )}
        {data.signals.map((s, i) => (
          <div key={i} className="flex items-center justify-between p-2.5 rounded-lg bg-gray-800/50 border border-gray-700/30">
            <div className="flex items-center gap-2 min-w-0">
              <div className={clsx('w-2 h-2 rounded-full shrink-0', {
                'bg-red-400': s.risk === 'high',
                'bg-amber-400': s.risk === 'medium',
                'bg-emerald-400': s.risk === 'low',
              })} />
              <span className="text-sm text-white truncate">{s.tenantName || s.agentName}</span>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className="text-xs text-gray-400">{s.callsLast7d} calls/7d</span>
              <span className={clsx('text-xs px-2 py-0.5 rounded-full', {
                'bg-red-500/20 text-red-400': s.risk === 'high',
                'bg-amber-500/20 text-amber-400': s.risk === 'medium',
                'bg-emerald-500/20 text-emerald-400': s.risk === 'low',
              })}>{s.risk}</span>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function RiskAlertsModule() {
  const { data } = useQuery<RiskAlertData>({
    queryKey: ['ecc', 'risk-alerts'],
    queryFn: () => api.get('/command-center/risk-alerts'),
    refetchInterval: 15000,
  });

  if (!data) return <Panel><div className="animate-pulse h-32 bg-gray-800 rounded-lg" /></Panel>;

  const totalAlerts = data.counts.critical_count + data.counts.high_count + data.counts.medium_count + data.counts.low_count;

  return (
    <Panel>
      <SectionHeader icon={AlertTriangle} title="Operational Risk Alerts" badge={totalAlerts} />
      <div className="flex gap-3 mb-4 text-xs">
        {data.counts.critical_count > 0 && <span className="px-2 py-0.5 bg-red-500/20 text-red-400 rounded-full">{data.counts.critical_count} critical</span>}
        {data.counts.high_count > 0 && <span className="px-2 py-0.5 bg-orange-500/20 text-orange-400 rounded-full">{data.counts.high_count} high</span>}
        {data.counts.medium_count > 0 && <span className="px-2 py-0.5 bg-amber-500/20 text-amber-400 rounded-full">{data.counts.medium_count} medium</span>}
        {data.counts.low_count > 0 && <span className="px-2 py-0.5 bg-blue-500/20 text-blue-400 rounded-full">{data.counts.low_count} low</span>}
      </div>
      <div className="space-y-2 max-h-56 overflow-y-auto">
        {data.alerts.length === 0 && <p className="text-emerald-400 text-sm">No active alerts</p>}
        {data.alerts.map((alert) => (
          <div key={alert.id} className={clsx('p-3 rounded-lg border', {
            'border-red-500/30 bg-red-500/5': alert.severity === 'critical',
            'border-orange-500/30 bg-orange-500/5': alert.severity === 'high',
            'border-amber-500/30 bg-amber-500/5': alert.severity === 'medium',
            'border-gray-600/30 bg-gray-800/30': alert.severity === 'low',
          })}>
            <div className="flex items-start gap-2">
              <AlertCircle className={clsx('h-4 w-4 mt-0.5 shrink-0', {
                'text-red-400': alert.severity === 'critical',
                'text-orange-400': alert.severity === 'high',
                'text-amber-400': alert.severity === 'medium',
                'text-gray-400': alert.severity === 'low',
              })} />
              <div className="min-w-0 flex-1">
                <p className="text-sm text-white">{alert.message}</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-gray-500">{alert.type}</span>
                  <span className="text-xs text-gray-600">{new Date(alert.created_at).toLocaleTimeString()}</span>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function VerticalPerformanceModule() {
  const { data } = useQuery<{ verticals: VerticalMetric[] }>({
    queryKey: ['ecc', 'vertical'],
    queryFn: () => api.get('/command-center/vertical-performance'),
    refetchInterval: 60000,
  });

  if (!data) return <Panel><div className="animate-pulse h-32 bg-gray-800 rounded-lg" /></Panel>;

  const verticalLabels: Record<string, string> = {
    medical: 'Medical',
    dental: 'Dental',
    hvac: 'HVAC',
    property_management: 'Property Mgmt',
    home_services: 'Home Services',
    general: 'General',
    inbound: 'Inbound',
    outbound: 'Outbound',
  };

  return (
    <Panel>
      <SectionHeader icon={BarChart3} title="Vertical Performance Comparison" />
      {data.verticals.length === 0 ? (
        <p className="text-gray-500 text-sm">No vertical data available</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-gray-400 text-xs border-b border-gray-700/50">
                <th className="text-left py-2 pr-4">Vertical</th>
                <th className="text-right py-2 px-2">Calls</th>
                <th className="text-right py-2 px-2">Booking %</th>
                <th className="text-right py-2 px-2">Completion %</th>
                <th className="text-right py-2 px-2">Avg Duration</th>
                <th className="text-right py-2 pl-2">Rev/Call</th>
              </tr>
            </thead>
            <tbody>
              {data.verticals.map((v) => (
                <tr key={v.vertical} className="border-b border-gray-800/50">
                  <td className="py-2 pr-4 text-white font-medium">{verticalLabels[v.vertical] ?? v.vertical}</td>
                  <td className="py-2 px-2 text-right text-gray-300">{v.totalCalls}</td>
                  <td className="py-2 px-2 text-right">
                    <span className={clsx(v.bookingRate >= 20 ? 'text-emerald-400' : v.bookingRate >= 10 ? 'text-amber-400' : 'text-red-400')}>
                      {v.bookingRate}%
                    </span>
                  </td>
                  <td className="py-2 px-2 text-right text-gray-300">{v.completionRate}%</td>
                  <td className="py-2 px-2 text-right text-gray-300">{v.avgDuration}s</td>
                  <td className="py-2 pl-2 text-right text-gray-300">{formatCurrency(v.revenuePerCall)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function InfrastructureModule() {
  const { data } = useQuery<InfraData>({
    queryKey: ['ecc', 'infrastructure'],
    queryFn: () => api.get('/command-center/infrastructure'),
    refetchInterval: 15000,
  });

  if (!data) return <Panel><div className="animate-pulse h-32 bg-gray-800 rounded-lg" /></Panel>;

  const healthItems = [
    { label: 'Call Connection', value: data.callConnectionRate, icon: Phone },
    { label: 'API Health', value: data.apiHealth, icon: Server },
    { label: 'SMS Delivery', value: data.smsDeliveryRate, icon: Wifi },
  ];

  return (
    <Panel>
      <SectionHeader icon={Server} title="Infrastructure Health" />
      <div className="grid grid-cols-3 gap-3 mb-4">
        {healthItems.map((item) => (
          <div key={item.label} className="text-center p-3 rounded-lg bg-gray-800/50">
            <item.icon className={clsx('h-5 w-5 mx-auto mb-1', item.value >= 95 ? 'text-emerald-400' : item.value >= 80 ? 'text-amber-400' : 'text-red-400')} />
            <p className={clsx('text-xl font-bold', item.value >= 95 ? 'text-emerald-400' : item.value >= 80 ? 'text-amber-400' : 'text-red-400')}>{item.value}%</p>
            <p className="text-xs text-gray-400 mt-0.5">{item.label}</p>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between text-xs text-gray-400 border-t border-gray-700/50 pt-3">
        <span>Failure Rate: <span className={data.callFailureRate > 5 ? 'text-red-400' : 'text-emerald-400'}>{data.callFailureRate}%</span></span>
        <span>Avg Latency: {data.avgVoiceLatency}s</span>
      </div>
    </Panel>
  );
}

function ForecastModule() {
  const { data } = useQuery<ForecastData>({
    queryKey: ['ecc', 'forecast'],
    queryFn: () => api.get('/command-center/forecast'),
    refetchInterval: 120000,
  });

  if (!data) return <Panel><div className="animate-pulse h-32 bg-gray-800 rounded-lg" /></Panel>;

  return (
    <Panel>
      <SectionHeader icon={TrendingUp} title="Predictive Forecasting" />
      <div className="grid grid-cols-2 gap-3 mb-4">
        <div className="p-3 rounded-lg bg-gray-800/50 text-center">
          <p className="text-xl font-bold text-cyan-400">{data.avgDailyCalls}</p>
          <p className="text-xs text-gray-400">Avg Daily Calls</p>
        </div>
        <div className="p-3 rounded-lg bg-gray-800/50 text-center">
          <p className="text-xl font-bold text-emerald-400">{data.avgDailyBookings}</p>
          <p className="text-xs text-gray-400">Avg Daily Bookings</p>
        </div>
      </div>
      <div className="space-y-1.5">
        <p className="text-xs text-gray-400 font-medium mb-2">7-Day Forecast</p>
        {data.forecast.map((day) => (
          <div key={day.date} className="flex items-center justify-between text-xs p-2 rounded bg-gray-800/30">
            <span className="text-gray-300">{new Date(day.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}</span>
            <div className="flex gap-4">
              <span className="text-gray-400">{day.projectedCalls} calls</span>
              <span className="text-cyan-400">{day.projectedBookings} bookings</span>
              <span className="text-emerald-400">{formatCurrency(day.projectedRevenue)}</span>
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function GlobalIntelligenceModule() {
  const { data } = useQuery<IntelData>({
    queryKey: ['ecc', 'global-intel'],
    queryFn: () => api.get('/command-center/global-intelligence'),
    refetchInterval: 120000,
  });

  if (!data) return <Panel><div className="animate-pulse h-32 bg-gray-800 rounded-lg" /></Panel>;

  return (
    <Panel>
      <SectionHeader icon={Globe} title="Global Intelligence" />
      <div className="space-y-4">
        <div>
          <p className="text-xs text-gray-400 font-medium mb-2">Your Performance vs Industry</p>
          <div className="space-y-2">
            <BenchmarkBar label="Booking Rate" yours={data.benchmarks.yourBookingRate} industry={data.benchmarks.industryAvgBookingRate} unit="%" />
            <BenchmarkBar label="Completion Rate" yours={data.benchmarks.yourCompletionRate} industry={data.benchmarks.industryAvgCompletionRate} unit="%" />
          </div>
        </div>
        {data.gaps.length > 0 && (
          <div>
            <p className="text-xs text-amber-400 font-medium mb-2">Performance Gaps</p>
            {data.gaps.map((g, i) => (
              <div key={i} className="flex items-center gap-2 text-xs text-gray-300 py-1">
                <AlertTriangle className="h-3 w-3 text-amber-400 shrink-0" />
                {g.metric}: {g.gap}{g.unit} below industry average
              </div>
            ))}
          </div>
        )}
        <div>
          <p className="text-xs text-gray-400 font-medium mb-2">Emerging Trends</p>
          {data.trends.map((t, i) => (
            <div key={i} className="flex items-start gap-2 text-xs text-gray-300 py-1.5">
              <TrendingUp className="h-3 w-3 text-cyan-400 mt-0.5 shrink-0" />
              <span>{t.trend}</span>
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

function BenchmarkBar({ label, yours, industry, unit }: { label: string; yours: number; industry: number; unit: string }) {
  const max = Math.max(yours, industry, 1);
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-gray-400">{label}</span>
        <span className={yours >= industry ? 'text-emerald-400' : 'text-amber-400'}>{yours}{unit} vs {industry}{unit}</span>
      </div>
      <div className="relative h-2 bg-gray-800 rounded-full overflow-hidden">
        <div className="absolute h-full bg-gray-600/50 rounded-full" style={{ width: `${(industry / max) * 100}%` }} />
        <div className={clsx('absolute h-full rounded-full', yours >= industry ? 'bg-emerald-500' : 'bg-amber-500')} style={{ width: `${(yours / max) * 100}%` }} />
      </div>
    </div>
  );
}

function ExecutiveActionPanel() {
  const [actionStatus, setActionStatus] = useState<Record<string, string>>({});

  const actions = [
    { id: 'approve-all', label: 'Approve Safe Recommendations', icon: CheckCircle2, color: 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30' },
    { id: 'launch-campaign', label: 'Launch Outbound Campaign', icon: Megaphone, color: 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30' },
    { id: 'activate-agents', label: 'Activate Additional Agents', icon: Bot, color: 'bg-purple-500/20 text-purple-400 hover:bg-purple-500/30' },
    { id: 'modify-routing', label: 'Modify Routing Rules', icon: Settings2, color: 'bg-cyan-500/20 text-cyan-400 hover:bg-cyan-500/30' },
    { id: 'escalate-alerts', label: 'Escalate Active Alerts', icon: AlertTriangle, color: 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/30' },
  ];

  const handleAction = async (actionId: string) => {
    setActionStatus((prev) => ({ ...prev, [actionId]: 'loading' }));
    try {
      if (actionId === 'approve-all') {
        const feed = await api.get<AutopilotFeed>('/command-center/autopilot-feed');
        const pending = feed.recommendations.filter((r) => r.status === 'pending' && r.risk_tier === 'low');
        for (const rec of pending) {
          await api.post(`/autopilot/recommendations/${rec.id}/approve`);
        }
      }
      setActionStatus((prev) => ({ ...prev, [actionId]: 'done' }));
      setTimeout(() => setActionStatus((prev) => ({ ...prev, [actionId]: '' })), 2000);
    } catch {
      setActionStatus((prev) => ({ ...prev, [actionId]: 'error' }));
      setTimeout(() => setActionStatus((prev) => ({ ...prev, [actionId]: '' })), 2000);
    }
  };

  return (
    <Panel>
      <SectionHeader icon={Zap} title="Executive Action Panel" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {actions.map((action) => (
          <button
            key={action.id}
            onClick={() => handleAction(action.id)}
            disabled={actionStatus[action.id] === 'loading'}
            className={clsx(
              'flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-all',
              action.color,
              actionStatus[action.id] === 'loading' && 'opacity-50',
            )}
          >
            {actionStatus[action.id] === 'loading' ? (
              <RefreshCw className="h-4 w-4 animate-spin" />
            ) : actionStatus[action.id] === 'done' ? (
              <CheckCircle2 className="h-4 w-4" />
            ) : (
              <action.icon className="h-4 w-4" />
            )}
            <span className="truncate">{actionStatus[action.id] === 'done' ? 'Done' : action.label}</span>
          </button>
        ))}
      </div>
    </Panel>
  );
}

function useECCStream() {
  const queryClient = useQueryClient();
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource('/api/command-center/stream', { withCredentials: true });
    esRef.current = es;

    es.addEventListener('active_count', () => {
      queryClient.invalidateQueries({ queryKey: ['ecc', 'workforce'] });
    });

    es.addEventListener('alert_count', () => {
      queryClient.invalidateQueries({ queryKey: ['ecc', 'risk-alerts'] });
    });

    es.addEventListener('new_recommendations', () => {
      queryClient.invalidateQueries({ queryKey: ['ecc', 'autopilot'] });
    });

    es.onerror = () => {
      es.close();
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['ecc'] });
      }, 5000);
    };

    return () => {
      es.close();
    };
  }, [queryClient]);
}

export default function CommandCenter() {
  const { user } = useAuth();
  const { data: roleData } = useQuery<{ role: ECCRole }>({
    queryKey: ['ecc', 'role'],
    queryFn: () => api.get('/command-center/role'),
  });

  useECCStream();

  const eccRole = roleData?.role ?? 'executive';
  const showFullView = eccRole === 'platform_admin' || eccRole === 'executive';
  const showOpsView = eccRole === 'operations_manager';
  const showCsView = eccRole === 'customer_success';

  return (
    <div className="min-h-screen bg-gray-950 -m-4 lg:-m-8 p-4 lg:p-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Executive Command Center</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            Real-time platform intelligence
            {eccRole === 'platform_admin' && ' — All Tenants'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20">
            <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="text-xs text-emerald-400 font-medium">Live</span>
          </div>
          <span className="text-xs text-gray-500 hidden sm:inline">
            {eccRole === 'platform_admin' ? 'Platform Admin' : eccRole === 'executive' ? 'Executive' : eccRole === 'operations_manager' ? 'Operations' : 'Customer Success'}
          </span>
        </div>
      </div>

      <div className="space-y-6">
        {(showFullView || showOpsView) && <WorkforceModule />}
        {(showFullView) && <RevenueModule />}
        
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {(showFullView || showOpsView) && <AutopilotModule />}
          {(showFullView || showCsView) && <CustomerHealthModule />}
        </div>

        {(showFullView || showOpsView) && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <RiskAlertsModule />
            <VerticalPerformanceModule />
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {(showFullView || showOpsView) && <InfrastructureModule />}
          {(showFullView) && <ForecastModule />}
        </div>

        {(showFullView) && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <GlobalIntelligenceModule />
            <ExecutiveActionPanel />
          </div>
        )}

        {showCsView && (
          <>
            <RiskAlertsModule />
            <AutopilotModule />
          </>
        )}

        {showOpsView && !showFullView && (
          <GlobalIntelligenceModule />
        )}
      </div>
    </div>
  );
}
