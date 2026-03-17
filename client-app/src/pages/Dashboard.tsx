import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
import {
  PhoneCall, Bot, Clock, TrendingUp, AlertTriangle, Wifi, WifiOff,
  ArrowRight, Zap, BarChart3, Phone, Plus, CheckCircle2,
  Stethoscope, Building2, Wrench, Scale, Headphones,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import OnboardingChecklist from '../components/OnboardingChecklist';
import TrialConversionNudge from '../components/TrialConversionNudge';

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

function StatCard({ icon: Icon, label, value, trend, color }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  trend?: string;
  color: string;
}) {
  return (
    <div className="bg-surface border border-border rounded-xl p-5 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-center gap-3">
        <div className={`p-2.5 rounded-lg ${color}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-text-secondary truncate">{label}</p>
          <div className="flex items-baseline gap-2">
            <p className="text-2xl font-bold text-text-primary">{value}</p>
            {trend && <span className="text-xs text-text-secondary">{trend}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function todayIso(): string {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
}

function useSSEActiveCalls(): { activeCalls: ActiveCall[]; connected: boolean } {
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

    es.addEventListener('call_started', handleLifecycleEvent);
    es.addEventListener('call_connected', handleLifecycleEvent);
    es.addEventListener('call_completed', handleLifecycleEvent);
    es.addEventListener('call_failed', handleLifecycleEvent);
    es.addEventListener('call_escalated', handleLifecycleEvent);
    es.addEventListener('call_updated', handleLifecycleEvent);

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [queryClient]);

  return { activeCalls, connected };
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s > 0 ? `${m}m ${s}s` : `${m}m`;
}

function stateLabel(state: string): string {
  const map: Record<string, string> = {
    CALL_CONNECTED: 'Connected',
    CALL_COMPLETED: 'Completed',
    CALL_STARTED: 'Ringing',
    CALL_FAILED: 'Failed',
    CALL_ESCALATED: 'Escalated',
  };
  return map[state] ?? state.replace(/_/g, ' ').toLowerCase();
}

function stateColor(state: string): string {
  if (state === 'CALL_CONNECTED' || state === 'active') return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
  if (state === 'CALL_COMPLETED') return 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400';
  if (state === 'CALL_FAILED') return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
  if (state === 'CALL_ESCALATED') return 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400';
  return 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400';
}

function QuickStartCard({ navigate, agentCount, hasPhoneNumbers }: {
  navigate: (path: string) => void;
  agentCount: number;
  hasPhoneNumbers: boolean;
}) {
  const steps = [
    { label: 'Create your first agent', done: agentCount > 0, action: '/agents', cta: 'Create Agent' },
    { label: 'Attach a phone number', done: hasPhoneNumbers, action: '/phone-numbers', cta: 'Add Number' },
    { label: 'Make a test call', done: false, action: '/agents', cta: 'Test Call' },
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
          <h2 className="text-lg font-semibold">Getting Started</h2>
          <p className="text-sm text-white/70">{completedCount} of {steps.length} steps complete</p>
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

const exampleWorkflows = [
  {
    icon: Stethoscope,
    title: 'Medical After-Hours',
    description: 'Handle patient calls after hours with appointment scheduling, triage, and on-call doctor routing.',
    template: 'medical-after-hours',
    color: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  },
  {
    icon: Building2,
    title: 'Property Management',
    description: 'Manage tenant inquiries, maintenance requests, and showing schedules for property managers.',
    template: 'property-management',
    color: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  },
  {
    icon: Wrench,
    title: 'Home Services',
    description: 'Book HVAC, plumbing, or electrical appointments with smart scheduling and dispatch.',
    template: 'home-services',
    color: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  },
  {
    icon: Scale,
    title: 'Legal Intake',
    description: 'Capture new client details, route by practice area, and schedule consultations automatically.',
    template: 'legal',
    color: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  },
  {
    icon: Headphones,
    title: 'Customer Support',
    description: 'Handle support tickets, FAQs, and escalations with knowledge-base-backed AI responses.',
    template: 'customer-support',
    color: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  },
];

function ExampleWorkflowCards({ navigate }: { navigate: (path: string) => void }) {
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem('dismissed_workflow_cards') === 'true'; } catch { return false; }
  });
  if (dismissed) return null;

  return (
    <div className="bg-surface border border-border rounded-xl shadow-sm">
      <div className="px-5 py-4 border-b border-border flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-text-primary">Example Workflows</h2>
          <p className="text-xs text-text-secondary mt-0.5">Start from a proven template for your industry</p>
        </div>
        <button
          onClick={() => { setDismissed(true); try { localStorage.setItem('dismissed_workflow_cards', 'true'); } catch {} }}
          className="text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          Dismiss
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4 p-5">
        {exampleWorkflows.map((wf) => {
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
              <h3 className="text-sm font-semibold text-text-primary mb-1">{wf.title}</h3>
              <p className="text-xs text-text-secondary leading-relaxed">{wf.description}</p>
              <span className="inline-flex items-center gap-1 text-xs text-primary font-medium mt-3 group-hover:underline">
                Use Template <ArrowRight className="h-3 w-3" />
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const todaySince = todayIso();
  const { activeCalls: liveActiveCalls, connected: sseConnected } = useSSEActiveCalls();

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

  const calls = callsData?.calls ?? [];
  const agents = agentsData?.agents ?? [];
  const activeCallCount = liveActiveCalls.length;
  const totalToday = todayData?.total ?? 0;
  const agentCount = agentsData?.total ?? agents.length;
  const escalations = calls.filter((c) => c.escalation_target).length;
  const hasPhoneNumbers = (phoneData?.total ?? 0) > 0;

  const completedCalls = calls.filter(c => c.duration_seconds && c.duration_seconds > 0);
  const avgDuration = completedCalls.length > 0
    ? Math.round(completedCalls.reduce((sum, c) => sum + (c.duration_seconds ?? 0), 0) / completedCalls.length)
    : 0;

  const aiMinutesUsed = usageData?.usage?.ai_minutes ?? 0;
  const callsUsed = usageData?.usage?.calls ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary">Dashboard</h1>
          <p className="text-sm text-text-secondary mt-1">Real-time overview of your voice operations</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/agents')}
            className="hidden sm:flex items-center gap-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
          >
            <Plus className="h-4 w-4" /> New Agent
          </button>
          <div className="flex items-center gap-1.5 text-xs">
            {sseConnected ? (
              <><Wifi className="h-3.5 w-3.5 text-green-500" /><span className="text-green-600 dark:text-green-400">Live</span></>
            ) : (
              <><WifiOff className="h-3.5 w-3.5 text-gray-400" /><span className="text-text-secondary">Connecting...</span></>
            )}
          </div>
        </div>
      </div>

      <OnboardingChecklist />

      <TrialConversionNudge />

      <ExampleWorkflowCards navigate={navigate} />

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        <StatCard icon={PhoneCall} label="Active Calls" value={activeCallCount} color="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" />
        <StatCard icon={TrendingUp} label="Today's Volume" value={totalToday} color="bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" />
        <StatCard icon={AlertTriangle} label="Escalations" value={escalations} color="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" />
        <StatCard icon={Bot} label="Active Agents" value={agentCount} color="bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400" />
        <StatCard icon={Clock} label="Avg Duration" value={avgDuration > 0 ? formatDuration(avgDuration) : '--'} color="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" />
      </div>

      {usageData?.usage && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <UsageGauge label="Calls" used={callsUsed} icon={Phone} />
          <UsageGauge label="AI Minutes" used={aiMinutesUsed} icon={BarChart3} />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-surface border border-border rounded-xl shadow-sm">
          <div className="px-5 py-4 border-b border-border flex items-center justify-between">
            <h2 className="text-base font-semibold text-text-primary">Recent Calls</h2>
            <button onClick={() => navigate('/calls')} className="text-xs text-primary hover:text-primary-hover font-medium flex items-center gap-1">
              View All <ArrowRight className="h-3 w-3" />
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
              <p className="text-text-secondary font-medium">No calls yet</p>
              <p className="text-sm text-text-secondary mt-1">Calls will appear here once your agents start handling them</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left">
                    <th className="px-5 py-3 text-text-secondary font-medium">Agent</th>
                    <th className="px-5 py-3 text-text-secondary font-medium">Direction</th>
                    <th className="px-5 py-3 text-text-secondary font-medium">Status</th>
                    <th className="px-5 py-3 text-text-secondary font-medium">Duration</th>
                    <th className="px-5 py-3 text-text-secondary font-medium">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {calls.slice(0, 8).map((call) => (
                    <tr key={call.id} className="border-b border-border last:border-0 hover:bg-surface-hover transition-colors cursor-pointer" onClick={() => navigate('/calls')}>
                      <td className="px-5 py-3 text-text-primary font-medium">{call.agent_name || 'Unknown Agent'}</td>
                      <td className="px-5 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${call.direction === 'inbound' ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'}`}>
                          {call.direction}
                        </span>
                      </td>
                      <td className="px-5 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${stateColor(call.lifecycle_state)}`}>
                          {stateLabel(call.lifecycle_state)}
                        </span>
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
            <h2 className="text-base font-semibold text-text-primary">Your Agents</h2>
            <button onClick={() => navigate('/agents')} className="text-xs text-primary hover:text-primary-hover font-medium flex items-center gap-1">
              Manage <ArrowRight className="h-3 w-3" />
            </button>
          </div>
          {agents.length === 0 ? (
            <div className="p-8 text-center">
              <Bot className="h-10 w-10 text-text-secondary/30 mx-auto mb-3" />
              <p className="text-text-secondary font-medium">No agents yet</p>
              <p className="text-sm text-text-secondary mt-1 mb-4">Create your first AI voice agent to get started</p>
              <button
                onClick={() => navigate('/agents')}
                className="inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-white text-sm font-medium px-4 py-2 rounded-lg transition-colors"
              >
                <Plus className="h-4 w-4" /> Create Agent
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
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                    agent.status === 'active'
                      ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                      : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                  }`}>
                    {agent.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {liveActiveCalls.length > 0 && (
        <div className="bg-surface border border-border rounded-xl shadow-sm">
          <div className="px-5 py-4 border-b border-border">
            <h2 className="text-base font-semibold text-text-primary flex items-center gap-2">
              <span className="relative flex h-2.5 w-2.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
              </span>
              Live Calls
            </h2>
          </div>
          <div className="divide-y divide-border">
            {liveActiveCalls.map((call) => (
              <div key={call.id} className="px-5 py-3 flex items-center gap-4">
                <div className="p-2 rounded-lg bg-green-100 dark:bg-green-900/30">
                  <Phone className="h-4 w-4 text-green-700 dark:text-green-400" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text-primary">{call.agent_name || 'Agent'}</p>
                  <p className="text-xs text-text-secondary">{call.direction} - {stateLabel(call.lifecycle_state)}</p>
                </div>
                <span className="text-xs text-text-secondary">
                  {formatDistanceToNow(new Date(call.start_time), { addSuffix: false })}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function UsageGauge({ label, used, icon: Icon }: { label: string; used: number; icon: React.ComponentType<{ className?: string }> }) {
  return (
    <div className="bg-surface border border-border rounded-xl p-4 shadow-sm">
      <div className="flex items-center gap-2 mb-2">
        <Icon className="h-4 w-4 text-text-secondary" />
        <span className="text-sm font-medium text-text-secondary">{label}</span>
      </div>
      <p className="text-xl font-bold text-text-primary">{used.toLocaleString()}</p>
      <p className="text-xs text-text-secondary mt-1">this billing period</p>
    </div>
  );
}
