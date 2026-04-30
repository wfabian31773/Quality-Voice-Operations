import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api } from '../lib/api';
import { formatCents as formatCentsHelper } from '../lib/formatCurrency';
import { useTenantCurrency } from '../hooks/useTenantCurrency';
import {
  PhoneCall, Bot, TrendingUp, AlertTriangle, Wifi, WifiOff,
  ArrowRight, Zap, BarChart3, Phone, Plus, CheckCircle2,
  Stethoscope, Building2, Wrench, Scale, Headphones,
  DollarSign, CalendarCheck, Bell, PhoneIncoming, PhoneOutgoing,
  PhoneOff, Pause,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import OnboardingChecklist from '../components/OnboardingChecklist';
import TrialConversionNudge from '../components/TrialConversionNudge';
import Celebration from '../components/Celebration';
import ConnectorAuthBanner from '../components/ConnectorAuthBanner';
import { PageHeader, StatCard, StatusBadge, StatusDot, type BadgeTone } from '../components/ui';

const CELEBRATION_KEY = 'qvo_first_call_celebrated';

interface CallSession {
  id: string;
  direction: string;
  lifecycle_state: string;
  start_time: string;
  end_time: string | null;
  duration_seconds: number | null;
  agent_id: string;
  agent_name: string | null;
  escalation_target: string | null;
}

interface ActiveCall {
  id: string;
  direction: string;
  lifecycle_state: string;
  start_time: string;
  agent_id: string;
  agent_name: string | null;
  caller_number: string | null;
  escalation_target: string | null;
}

interface AgentInfo {
  id: string;
  name: string;
  type: string;
  status: string;
}

function todayIso(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

function useSSEActiveCalls(onFirstCall?: () => void): { activeCalls: ActiveCall[]; connected: boolean } {
  const [activeCalls, setActiveCalls] = useState<ActiveCall[]>([]);
  const [connected, setConnected] = useState(false);
  const queryClient = useQueryClient();
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource('/api/calls/live', { withCredentials: true });
    esRef.current = es;

    es.addEventListener('active_calls', (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as ActiveCall[];
        setActiveCalls(data);
        setConnected(true);
      } catch {}
    });

    const handleLifecycleEvent = () => {
      setConnected(true);
      queryClient.invalidateQueries({ queryKey: ['calls', 'recent'] });
    };

    const handleCompleted = () => {
      handleLifecycleEvent();
      onFirstCall?.();
    };

    es.addEventListener('call_started', handleLifecycleEvent);
    es.addEventListener('call_connected', handleLifecycleEvent);
    es.addEventListener('call_completed', handleCompleted);
    es.addEventListener('call_failed', handleLifecycleEvent);
    es.addEventListener('call_escalated', handleLifecycleEvent);
    es.addEventListener('call_updated', handleLifecycleEvent);

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [queryClient, onFirstCall]);

  return { activeCalls, connected };
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function stateLabel(state: string, t: TFunction): string {
  const map: Record<string, string> = {
    CALL_CONNECTED: t('dashboard.call_state.connected'),
    CALL_COMPLETED: t('dashboard.call_state.completed'),
    CALL_STARTED: t('dashboard.call_state.ringing'),
    CALL_FAILED: t('dashboard.call_state.failed'),
    CALL_ESCALATED: t('dashboard.call_state.escalated'),
  };
  return map[state] ?? state.replace(/_/g, ' ').toLowerCase();
}

function stateBadgeMeta(state: string, t: TFunction): {
  tone: BadgeTone;
  icon: React.ReactNode;
  tooltip: string;
} {
  const label = stateLabel(state, t);
  if (state === 'CALL_CONNECTED' || state === 'active') {
    return {
      tone: 'success',
      icon: <PhoneCall className="h-3 w-3" aria-hidden="true" />,
      tooltip: t('dashboard.call_state_tooltips.in_progress', { label }),
    };
  }
  if (state === 'CALL_COMPLETED') {
    return {
      tone: 'neutral',
      icon: <CheckCircle2 className="h-3 w-3" aria-hidden="true" />,
      tooltip: t('dashboard.call_state_tooltips.completed', { label }),
    };
  }
  if (state === 'CALL_FAILED') {
    return {
      tone: 'danger',
      icon: <PhoneOff className="h-3 w-3" aria-hidden="true" />,
      tooltip: t('dashboard.call_state_tooltips.failed', { label }),
    };
  }
  if (state === 'CALL_ESCALATED') {
    return {
      tone: 'warning',
      icon: <AlertTriangle className="h-3 w-3" aria-hidden="true" />,
      tooltip: t('dashboard.call_state_tooltips.escalated', { label }),
    };
  }
  return {
    tone: 'info',
    icon: <Phone className="h-3 w-3" aria-hidden="true" />,
    tooltip: t('dashboard.call_state_tooltips.default', { label }),
  };
}

function QuickStartCard({ navigate, agentCount, hasPhoneNumbers, t }: {
  navigate: (path: string) => void;
  agentCount: number;
  hasPhoneNumbers: boolean;
  t: TFunction;
}) {
  const steps = [
    { label: t('dashboard.getting_started.create_agent_label'), done: agentCount > 0, action: '/agents', cta: t('dashboard.getting_started.create_agent_cta') },
    { label: t('dashboard.getting_started.attach_phone_label'), done: hasPhoneNumbers, action: '/phone-numbers', cta: t('dashboard.getting_started.attach_phone_cta') },
    { label: t('dashboard.getting_started.test_call_label'), done: false, action: '/agents', cta: t('dashboard.getting_started.test_call_cta') },
  ];

  const completedCount = steps.filter(s => s.done).length;
  if (completedCount >= steps.length) return null;

  return (
    <div className="bg-gradient-to-br from-[#123047] to-[#1a4a6b] rounded-xl p-6 text-white shadow-lg">
      <div className="flex items-center gap-3 mb-4">
        <div className="p-2 bg-white/10 rounded-lg">
          <Zap className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">{t('dashboard.getting_started.title')}</h2>
          <p className="text-sm text-white/70">{t('dashboard.getting_started.steps_progress', { completed: completedCount, total: steps.length })}</p>
        </div>
      </div>
      <div className="space-y-3">
        {steps.map((step, i) => (
          <div key={i} className="flex items-center gap-3">
            {step.done ? (
              <CheckCircle2 className="h-5 w-5 text-green-400 shrink-0" />
            ) : (
              <div className="h-5 w-5 rounded-full border-2 border-white/30 shrink-0" />
            )}
            <span className={`text-sm flex-1 ${step.done ? 'text-white/50 line-through' : 'text-white'}`}>
              {step.label}
            </span>
            {!step.done && (
              <button
                onClick={() => navigate(step.action)}
                className="text-xs bg-white/20 hover:bg-white/30 px-3 py-1 rounded-lg transition-colors"
              >
                {step.cta}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

const exampleWorkflowDefs = [
  {
    icon: Stethoscope,
    titleKey: 'dashboard.example_workflows.medical_title',
    descriptionKey: 'dashboard.example_workflows.medical_description',
    template: 'medical-after-hours',
    color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  },
  {
    icon: Building2,
    titleKey: 'dashboard.example_workflows.property_title',
    descriptionKey: 'dashboard.example_workflows.property_description',
    template: 'property-management',
    color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  },
  {
    icon: Wrench,
    titleKey: 'dashboard.example_workflows.home_title',
    descriptionKey: 'dashboard.example_workflows.home_description',
    template: 'home-services',
    color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  },
  {
    icon: Scale,
    titleKey: 'dashboard.example_workflows.legal_title',
    descriptionKey: 'dashboard.example_workflows.legal_description',
    template: 'legal',
    color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  },
  {
    icon: Headphones,
    titleKey: 'dashboard.example_workflows.support_title',
    descriptionKey: 'dashboard.example_workflows.support_description',
    template: 'customer-support',
    color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  },
];

function ExampleWorkflowCards({ navigate, t }: { navigate: (path: string) => void; t: TFunction }) {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem('dismissed_workflow_cards') === 'true'; } catch { return false; }
  });
  if (dismissed) return null;

  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-text-primary">{t('dashboard.example_workflows.title')}</h2>
          <p className="text-xs text-text-secondary mt-0.5">{t('dashboard.example_workflows.subtitle')}</p>
        </div>
        <button
          onClick={() => { setDismissed(true); try { localStorage.setItem('dismissed_workflow_cards', 'true'); } catch {} }}
          className="text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          {t('dashboard.example_workflows.dismiss')}
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4 p-5">
        {exampleWorkflowDefs.map((wf) => {
          const Icon = wf.icon;
          return (
            <div
              key={wf.template}
              className="border border-border rounded-lg p-4 hover:bg-surface-hover transition-colors cursor-pointer group"
              onClick={() => navigate('/agents')}
            >
              <div className={`p-2 rounded-lg ${wf.color} inline-flex mb-3`}>
                <Icon className="h-4 w-4" />
              </div>
              <h3 className="text-sm font-semibold text-text-primary mb-1">{t(wf.titleKey)}</h3>
              <p className="text-xs text-text-secondary leading-relaxed">{t(wf.descriptionKey)}</p>
              <span className="inline-flex items-center gap-1 text-xs text-primary font-medium mt-3 group-hover:underline">
                {t('dashboard.example_workflows.use_template')} <ArrowRight className="h-3 w-3" />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { t: tenantT } = useTranslation('tenant');
  const navigate = useNavigate();
  const todaySince = todayIso();
  const [showCelebration, setShowCelebration] = useState(false);

  const triggerFirstCallCelebration = () => {
    try {
      if (localStorage.getItem(CELEBRATION_KEY) === '1') return;
      localStorage.setItem(CELEBRATION_KEY, '1');
    } catch {}
    setShowCelebration(true);
  };

  const { activeCalls: liveActiveCalls, connected: sseConnected } = useSSEActiveCalls(triggerFirstCallCelebration);

  const { data: callsData, isLoading: callsLoading } = useQuery({
    queryKey: ['calls', 'recent'],
    queryFn: () => api.get<{ calls: CallSession[]; total: number }>('/calls?limit=50'),
    refetchInterval: 10000,
  });

  const { data: todayData } = useQuery({
    queryKey: ['calls', 'today-volume', todaySince],
    queryFn: () => api.get<{ calls: CallSession[]; total: number }>(`/calls?limit=1&since=${encodeURIComponent(todaySince)}`),
    refetchInterval: 15000,
  });

  const { data: agentsData } = useQuery({
    queryKey: ['agents', 'list'],
    queryFn: () => api.get<{ agents: AgentInfo[]; total: number }>('/agents'),
  });

  const { data: usageData } = useQuery({
    queryKey: ['billing', 'usage-dashboard'],
    queryFn: () => api.get<{ usage: Record<string, number> }>('/billing/usage'),
    staleTime: 60000,
  });

  const { data: phoneData } = useQuery({
    queryKey: ['phone-numbers', 'count'],
    queryFn: () => api.get<{ phoneNumbers: { id: string }[]; total: number }>('/phone-numbers?limit=1'),
    staleTime: 60000,
  });

  const { data: bookingsData } = useQuery({
    queryKey: ['scheduling', 'bookings-today', todaySince],
    queryFn: () => api.get<{ bookings: { id: string }[]; total: number }>(`/scheduling/bookings?start=${encodeURIComponent(todaySince)}&limit=1`),
    staleTime: 60000,
    retry: false,
  });

  const { data: revenueData } = useQuery({
    queryKey: ['analytics', 'revenue-30d'],
    queryFn: () => api.get<{ totalRevenueCents: number; currency?: string }>('/analytics/revenue?range=30d'),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const currency = useTenantCurrency(revenueData?.currency);

  const calls = callsData?.calls ?? [];
  const agents = agentsData?.agents ?? [];

  useEffect(() => {
    if (calls.some((c) => c.duration_seconds && c.duration_seconds > 0)) {
      try {
        if (!localStorage.getItem(CELEBRATION_KEY)) {
          localStorage.setItem(CELEBRATION_KEY, 'seeded');
        }
      } catch {}
    }
  }, [calls]);
  const activeCallCount = liveActiveCalls.length;
  const totalToday = todayData?.total ?? 0;
  const agentCount = agentsData?.total ?? agents.length;
  const escalations = calls.filter((c) => c.escalation_target).length;
  const hasPhoneNumbers = (phoneData?.total ?? 0) > 0;

  // Reference QuickStartCard so the helper compiles even when not rendered.
  void QuickStartCard;
  void hasPhoneNumbers;

  const completedCalls = calls.filter(c => c.duration_seconds && c.duration_seconds > 0);
  const avgDuration = completedCalls.length > 0
    ? Math.round(completedCalls.reduce((sum, c) => sum + (c.duration_seconds ?? 0), 0) / completedCalls.length)
    : 0;
  void avgDuration;

  const aiMinutesUsed = usageData?.usage?.ai_minutes ?? 0;
  const callsUsed = usageData?.usage?.calls ?? 0;

  const bookingsToday = bookingsData?.total ?? 0;
  const revenueCents = revenueData?.totalRevenueCents ?? 0;
  const revenueDisplay = revenueCents > 0
    ? formatCentsHelper(revenueCents, { currency, minimumFractionDigits: 0, maximumFractionDigits: 0 })
    : formatCentsHelper(0, { currency, minimumFractionDigits: 0, maximumFractionDigits: 0 });

  return (
    <div className="space-y-6">
      <PageHeader
        title={tenantT('dashboard.page_title')}
        description={tenantT('dashboard.page_subtitle')}
        status={
          sseConnected ? (
            <StatusBadge
              tone="success"
              icon={<Wifi className="h-3 w-3" aria-hidden="true" />}
              tooltip={tenantT('dashboard.live_indicator.tooltip_connected')}
            >
              {tenantT('dashboard.live_indicator.live')}
            </StatusBadge>
          ) : (
            <StatusBadge
              tone="neutral"
              icon={<WifiOff className="h-3 w-3" aria-hidden="true" />}
              tooltip={tenantT('dashboard.live_indicator.tooltip_connecting')}
            >
              {tenantT('dashboard.live_indicator.connecting')}
            </StatusBadge>
          )
        }
        actions={
          <button
            onClick={() => navigate('/agents')}
            className="hidden sm:inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            <Plus className="h-4 w-4" /> {tenantT('dashboard.actions.new_agent')}
          </button>
        }
      />

      <ConnectorAuthBanner />

      <OnboardingChecklist />

      <TrialConversionNudge />

      <ExampleWorkflowCards navigate={navigate} t={tenantT} />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard icon={PhoneCall} label={tenantT('dashboard.stats.calls_today_card')} value={totalToday} tone="info" />
        <StatCard icon={CalendarCheck} label={tenantT('dashboard.stats.bookings_today')} value={bookingsToday} sub={bookingsToday === 0 ? tenantT('dashboard.stats.no_bookings') : undefined} tone="primary" />
        <StatCard icon={Bot} label={tenantT('dashboard.stats.active_agents_card')} value={agentCount} tone="accent" />
        <StatCard icon={DollarSign} label={tenantT('dashboard.stats.revenue_30d')} value={revenueDisplay} sub={revenueCents > 0 ? tenantT('dashboard.stats.attributed') : tenantT('dashboard.stats.no_attribution')} tone="success" />
        <StatCard icon={TrendingUp} label={tenantT('dashboard.stats.live_calls')} value={activeCallCount} tone="warning" />
      </div>

      {(escalations > 0 || activeCallCount > 0) && (
        <div className="bg-surface border border-border rounded-xl shadow-[var(--elevation-1)]">
          <div className="px-5 py-4 border-b border-border flex items-center gap-2">
            <Bell className="h-4 w-4 text-warning" />
            <h2 className="text-base font-semibold text-text-primary">{tenantT('dashboard.sections.needs_attention')}</h2>
          </div>
          <div className="divide-y divide-border">
            {escalations > 0 && (
              <div className="px-5 py-3 flex items-center gap-3">
                <div className="p-2 rounded-lg bg-danger-light">
                  <AlertTriangle className="h-4 w-4 text-danger" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary">{tenantT('dashboard.attention.escalated', { count: escalations })}</p>
                  <p className="text-xs text-text-secondary">{tenantT('dashboard.attention.escalated_description')}</p>
                </div>
                <button onClick={() => navigate('/calls')} className="text-xs text-primary hover:text-primary-hover font-medium flex items-center gap-1">
                  {tenantT('dashboard.actions.review')} <ArrowRight className="h-3 w-3" />
                </button>
              </div>
            )}
            {activeCallCount > 0 && (
              <div className="px-5 py-3 flex items-center gap-3">
                <div className="p-2 rounded-lg bg-success-light">
                  <Phone className="h-4 w-4 text-success" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary">{tenantT('dashboard.attention.live', { count: activeCallCount })}</p>
                  <p className="text-xs text-text-secondary">{tenantT('dashboard.attention.live_description')}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {usageData?.usage && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <UsageGauge label={tenantT('dashboard.usage.calls')} used={callsUsed} icon={Phone} t={tenantT} />
          <UsageGauge label={tenantT('dashboard.usage.ai_minutes')} used={aiMinutesUsed} icon={BarChart3} t={tenantT} />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-surface border border-border rounded-xl shadow-sm">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <h2 className="text-base font-semibold text-text-primary">{tenantT('dashboard.sections.recent_conversations')}</h2>
            <button onClick={() => navigate('/calls')} className="text-xs text-primary hover:text-primary-hover font-medium flex items-center gap-1">
              {tenantT('dashboard.actions.view_all')} <ArrowRight className="h-3 w-3" />
            </button>
          </div>
          {callsLoading ? (
            <div className="p-8 space-y-3">
              {[1,2,3,4,5].map(i => (
                <div key={i} className="h-10 bg-surface-secondary rounded animate-pulse" />
              ))}
            </div>
          ) : calls.length === 0 ? (
            <div className="p-12 text-center">
              <Phone className="h-10 w-10 text-text-secondary/30 mx-auto mb-3" />
              <p className="text-text-secondary font-medium">{tenantT('dashboard.recent_conversations.no_calls_title')}</p>
              <p className="text-sm text-text-secondary mt-1">{tenantT('dashboard.recent_conversations.no_calls_description')}</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="px-5 py-3 text-text-secondary font-medium">{tenantT('dashboard.recent_conversations.table_agent')}</th>
                    <th className="px-5 py-3 text-text-secondary font-medium">{tenantT('dashboard.recent_conversations.table_direction')}</th>
                    <th className="px-5 py-3 text-text-secondary font-medium">{tenantT('dashboard.recent_conversations.table_status')}</th>
                    <th className="px-5 py-3 text-text-secondary font-medium">{tenantT('dashboard.recent_conversations.table_duration')}</th>
                    <th className="px-5 py-3 text-text-secondary font-medium">{tenantT('dashboard.recent_conversations.table_time')}</th>
                  </tr>
                </thead>
                <tbody>
                  {calls.slice(0, 8).map((call) => (
                    <tr key={call.id} className="border-b border-border last:border-0 hover:bg-surface-hover transition-colors cursor-pointer" onClick={() => navigate('/calls')}>
                      <td className="px-5 py-3 text-text-primary font-medium">{call.agent_name || tenantT('dashboard.recent_conversations.unknown_agent')}</td>
                      <td className="px-5 py-3">
                        {call.direction === 'inbound' ? (
                          <StatusBadge
                            tone="info"
                            icon={<PhoneIncoming className="h-3 w-3" aria-hidden="true" />}
                            tooltip={tenantT('dashboard.recent_conversations.inbound_tooltip')}
                          >
                            {tenantT('dashboard.recent_conversations.direction_inbound')}
                          </StatusBadge>
                        ) : (
                          <StatusBadge
                            tone="warning"
                            icon={<PhoneOutgoing className="h-3 w-3" aria-hidden="true" />}
                            tooltip={tenantT('dashboard.recent_conversations.outbound_tooltip')}
                          >
                            {tenantT('dashboard.recent_conversations.direction_outbound')}
                          </StatusBadge>
                        )}
                      </td>
                      <td className="px-5 py-3">
                        {(() => {
                          const meta = stateBadgeMeta(call.lifecycle_state, tenantT);
                          return (
                            <StatusBadge tone={meta.tone} icon={meta.icon} tooltip={meta.tooltip}>
                              {stateLabel(call.lifecycle_state, tenantT)}
                            </StatusBadge>
                          );
                        })()}
                      </td>
                      <td className="px-5 py-3 text-text-secondary">{call.duration_seconds ? formatDuration(call.duration_seconds) : '--'}</td>
                      <td className="px-5 py-3 text-text-secondary">
                        {call.start_time ? formatDistanceToNow(new Date(call.start_time), { addSuffix: true }) : '--'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="bg-surface border border-border rounded-xl shadow-sm">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <h2 className="text-base font-semibold text-text-primary">{tenantT('dashboard.sections.your_agents')}</h2>
            <button onClick={() => navigate('/agents')} className="text-xs text-primary hover:text-primary-hover font-medium flex items-center gap-1">
              {tenantT('dashboard.actions.manage')} <ArrowRight className="h-3 w-3" />
            </button>
          </div>
          {agents.length === 0 ? (
            <div className="p-8 text-center">
              <Bot className="h-10 w-10 text-text-secondary/30 mx-auto mb-3" />
              <p className="text-text-secondary font-medium">{tenantT('dashboard.your_agents.no_agents_title')}</p>
              <p className="text-sm text-text-secondary mt-1 mb-4">{tenantT('dashboard.your_agents.no_agents_description')}</p>
              <button
                onClick={() => navigate('/agents')}
                className="inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
              >
                <Plus className="h-4 w-4" /> {tenantT('dashboard.actions.create_agent')}
              </button>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {agents.slice(0, 5).map((agent) => (
                <div key={agent.id} className="px-5 py-3 flex items-center gap-3 hover:bg-surface-hover transition-colors cursor-pointer" onClick={() => navigate('/agents')}>
                  <div className="p-1.5 rounded-lg bg-primary/10">
                    <Bot className="h-4 w-4 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-text-primary truncate">{agent.name}</p>
                    <p className="text-xs text-text-secondary">{agent.type.replace(/-/g, ' ')}</p>
                  </div>
                  <StatusBadge
                    tone={agent.status === 'active' ? 'success' : 'neutral'}
                    icon={
                      agent.status === 'active' ? (
                        <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
                      ) : (
                        <Pause className="h-3 w-3" aria-hidden="true" />
                      )
                    }
                    tooltip={
                      agent.status === 'active'
                        ? tenantT('dashboard.agent_status_tooltips.active')
                        : tenantT('dashboard.agent_status_tooltips.inactive', { status: agent.status })
                    }
                  >
                    {agent.status}
                  </StatusBadge>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {liveActiveCalls.length > 0 && (
        <div className="bg-surface border border-border rounded-xl shadow-[var(--elevation-1)]">
          <div className="px-5 py-4 border-b border-border">
            <h2 className="text-base font-semibold text-text-primary flex items-center gap-2">
              <StatusDot
                label={tenantT('dashboard.live_calls_section.live_dot_label')}
                tone="success"
                size="md"
                pulse
                ping
              />
              {tenantT('dashboard.sections.live_calls')}
            </h2>
          </div>
          <div className="divide-y divide-border">
            {liveActiveCalls.map((call) => (
              <div key={call.id} className="px-5 py-3 flex items-center gap-4">
                <div className="p-2 rounded-lg bg-success-light">
                  <Phone className="h-4 w-4 text-success" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary">{call.agent_name || tenantT('dashboard.live_calls_section.default_agent_label')}</p>
                  <p className="text-xs text-text-secondary">{call.direction} - {stateLabel(call.lifecycle_state, tenantT)}</p>
                </div>
                <span className="text-xs text-text-secondary">
                  {formatDistanceToNow(new Date(call.start_time), { addSuffix: false })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <Celebration show={showCelebration} onClose={() => setShowCelebration(false)} />
    </div>
  );
}

function UsageGauge({ label, used, icon: Icon, t }: { label: string; used: number; icon: React.ComponentType<{ className?: string }>; t: TFunction }) {
  return (
    <div className="bg-surface border border-border rounded-xl p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-2">
        <Icon className="h-4 w-4 text-text-secondary" />
        <span className="text-sm font-medium text-text-secondary">{label}</span>
      </div>
      <p className="text-xl font-bold text-text-primary">{used.toLocaleString()}</p>
      <p className="text-xs text-text-secondary mt-1">{t('dashboard.usage.this_billing_period')}</p>
    </div>
  );
}
