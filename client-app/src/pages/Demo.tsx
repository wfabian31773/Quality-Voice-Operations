import { useState, useEffect, useCallback } from 'react';
import {
  Phone,
  Activity,
  BarChart3,
  Headphones,
  Stethoscope,
  AlertCircle,
  Calendar,
  Building2,
  Scale,
  HelpCircle,
  DollarSign,
} from 'lucide-react';
import SEO from '../components/SEO';

const API_BASE = '/api';

interface DemoEvent {
  id: string;
  eventType: string;
  agentName: string;
  durationSeconds: number | null;
  timestamp: string;
}

interface DemoAgent {
  id: string;
  name: string;
  description: string;
  template: string;
  voiceId: string;
  phoneNumber: string | null;
  isPlaceholder: boolean;
  icon: string;
  category: string;
  useCases: string[];
}

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  headphones: Headphones,
  stethoscope: Stethoscope,
  calendar: Calendar,
  building: Building2,
  scale: Scale,
  'help-circle': HelpCircle,
  'dollar-sign': DollarSign,
};

const AGENT_COLORS: string[] = [
  'teal',
  'harbor',
  'teal',
  'harbor',
  'teal',
  'harbor',
  'teal',
];

function formatPhoneNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return raw;
}

function formatEventType(type: string): string {
  const map: Record<string, string> = {
    call_started: 'Call Started',
    call_ended: 'Call Ended',
    workflow_triggered: 'Workflow Triggered',
  };
  return map[type] ?? type.replace(/_/g, ' ');
}

function eventColor(type: string): string {
  if (type === 'call_ended') return 'text-calm-green';
  if (type === 'call_started') return 'text-teal';
  if (type === 'workflow_triggered') return 'text-warm-amber';
  return 'text-soft-steel';
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function AgentCard({
  agent,
  colorIndex,
  selected,
  onSelect,
}: {
  agent: DemoAgent;
  colorIndex: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const variant = AGENT_COLORS[colorIndex % AGENT_COLORS.length];
  const IconComponent = ICON_MAP[agent.icon] ?? Headphones;

  const borderClass = selected
    ? variant === 'teal'
      ? 'border-teal ring-2 ring-teal/20'
      : 'border-harbor ring-2 ring-harbor/20'
    : 'border-soft-steel/50 hover:border-teal/30';

  const iconBg = variant === 'teal' ? 'bg-teal/10' : 'bg-harbor/10';
  const iconColor = variant === 'teal' ? 'text-teal' : 'text-harbor-light';
  const categoryColor = variant === 'teal' ? 'text-teal' : 'text-harbor-light';

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`bg-white rounded-2xl border ${borderClass} p-6 text-left transition-all cursor-pointer w-full`}
    >
      <div className="flex items-center gap-3 mb-3">
        <div className={`w-10 h-10 rounded-xl ${iconBg} flex items-center justify-center shrink-0`}>
          <IconComponent className={`h-5 w-5 ${iconColor}`} />
        </div>
        <div className="min-w-0">
          <h3 className="font-display text-lg font-semibold text-harbor truncate">{agent.name}</h3>
          <span className={`text-xs font-medium ${categoryColor}`}>{agent.category}</span>
        </div>
      </div>
      <p className="text-sm text-slate-ink/60 font-body mb-4 leading-relaxed line-clamp-2">
        {agent.description}
      </p>
      <div className="space-y-1">
        {agent.useCases.map((uc) => (
          <div key={uc} className="flex items-center gap-2 text-xs text-slate-ink/50 font-body">
            <span className={`w-1 h-1 rounded-full ${variant === 'teal' ? 'bg-teal' : 'bg-harbor'} shrink-0`} />
            {uc}
          </div>
        ))}
      </div>
    </button>
  );
}

function AgentPhoneDisplay({ agent }: { agent: DemoAgent }) {
  if (!agent.phoneNumber) {
    return (
      <div className="flex items-center gap-3 bg-warm-amber/10 border border-warm-amber/20 rounded-xl px-5 py-4">
        <AlertCircle className="h-5 w-5 text-warm-amber shrink-0" />
        <div>
          <p className="text-xs text-warm-amber mb-0.5">Demo line</p>
          <p className="text-sm text-slate-ink/50">Not configured</p>
        </div>
      </div>
    );
  }

  if (agent.isPlaceholder) {
    return (
      <div className="flex items-center gap-3 bg-teal/10 border border-teal/20 rounded-xl px-5 py-4">
        <Phone className="h-5 w-5 text-teal shrink-0" />
        <div>
          <p className="text-xs text-teal mb-0.5">Demo line — awaiting real number</p>
          <p className="text-sm text-slate-ink/50">Contact your administrator to provision a Twilio number</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 bg-teal/10 border border-teal/20 rounded-xl px-5 py-4">
      <Phone className="h-5 w-5 text-teal shrink-0" />
      <div>
        <p className="text-xs text-teal mb-0.5">Call to try it</p>
        <p className="text-lg font-mono font-bold text-harbor">{formatPhoneNumber(agent.phoneNumber)}</p>
      </div>
    </div>
  );
}

export default function Demo() {
  const [events, setEvents] = useState<DemoEvent[]>([]);
  const [totalCalls, setTotalCalls] = useState(0);
  const [agents, setAgents] = useState<DemoAgent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [demoConfigured, setDemoConfigured] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchActivity = useCallback(async () => {
    try {
      const [activityRes, statsRes] = await Promise.all([
        fetch(`${API_BASE}/demo/activity`),
        fetch(`${API_BASE}/demo/stats`),
      ]);
      if (activityRes.ok) {
        const data = await activityRes.json();
        setEvents(data.events ?? []);
      }
      if (statsRes.ok) {
        const data = await statsRes.json();
        setTotalCalls(data.totalCalls ?? 0);
      }
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    Promise.all([
      fetch(`${API_BASE}/demo/agents`)
        .then((r) => r.json())
        .then((data) => {
          const agentList = data.agents ?? [];
          setAgents(agentList);
          if (agentList.length > 0 && !selectedAgent) {
            setSelectedAgent(agentList[0].id);
          }
        }),
      fetch(`${API_BASE}/demo/phones`)
        .then((r) => r.json())
        .then((data) => {
          setDemoConfigured(data.configured ?? false);
        }),
    ]).catch(() => {
      setDemoConfigured(false);
    });
  }, []);

  useEffect(() => {
    fetchActivity();
    const interval = setInterval(fetchActivity, 5000);
    return () => clearInterval(interval);
  }, [fetchActivity]);

  const activeAgent = agents.find((a) => a.id === selectedAgent) ?? null;

  return (
    <div>
      <SEO
        title="Live Demo — See QVO AI Voice Agents in Action"
        description="Experience QVO's AI voice agents live. Watch real-time call handling, see how conversations flow, and explore the analytics dashboard."
        canonicalPath="/demo"
      />
      <section className="bg-harbor text-white py-16 lg:py-24">
        <div className="max-w-6xl mx-auto px-6 lg:px-8 text-center">
          <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-4">
            Live Demo
          </p>
          <h1 className="font-display text-4xl lg:text-5xl font-bold mb-4">
            Experience QVO live.
          </h1>
          <p className="text-lg text-white/70 font-body max-w-2xl mx-auto">
            Choose an agent below and call to hear what professional voice operations sound like. No signup required.
          </p>
        </div>
      </section>

      <section className="py-12 lg:py-16">
        <div className="max-w-6xl mx-auto px-6 lg:px-8">
          {demoConfigured === false && (
            <div className="mb-8 p-4 bg-warm-amber/10 border border-warm-amber/30 rounded-xl text-center text-warm-amber text-sm font-body">
              Demo phone lines are not yet provisioned. The demo system is ready but requires phone numbers to accept calls.
            </div>
          )}

          <div className="mb-8">
            <h2 className="font-display text-2xl font-bold text-harbor mb-2">Choose a Demo Agent</h2>
            <p className="text-sm text-slate-ink/60 font-body">
              Select an agent to see its details and try it out.
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mb-8">
            {agents.map((agent, idx) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                colorIndex={idx}
                selected={selectedAgent === agent.id}
                onSelect={() => setSelectedAgent(agent.id)}
              />
            ))}
            {agents.length === 0 && !loading && (
              <div className="sm:col-span-2 lg:col-span-3 xl:col-span-4 text-center py-12 text-slate-ink/40 font-body">
                <p>No demo agents configured yet.</p>
              </div>
            )}
          </div>

          {activeAgent && (
            <div className="bg-white rounded-2xl border border-soft-steel/50 p-8 mb-8">
              <div className="flex items-center gap-3 mb-4">
                {(() => {
                  const IconComponent = ICON_MAP[activeAgent.icon] ?? Headphones;
                  return (
                    <div className="w-12 h-12 rounded-xl bg-teal/10 flex items-center justify-center">
                      <IconComponent className="h-6 w-6 text-teal" />
                    </div>
                  );
                })()}
                <div>
                  <h3 className="font-display text-xl font-semibold text-harbor">{activeAgent.name}</h3>
                  <span className="text-xs font-medium text-teal">{activeAgent.category}</span>
                </div>
              </div>
              <p className="text-sm text-slate-ink/60 font-body mb-6 leading-relaxed">
                {activeAgent.description}
              </p>
              <AgentPhoneDisplay agent={activeAgent} />
            </div>
          )}

          <div className="grid md:grid-cols-3 gap-6 mb-12">
            <div className="md:col-span-1 bg-white rounded-2xl border border-soft-steel/50 p-6">
              <div className="flex items-center gap-2 mb-4">
                <BarChart3 className="h-5 w-5 text-calm-green" />
                <h3 className="font-display font-semibold text-harbor">Demo Stats</h3>
              </div>
              <div className="text-center py-6">
                <p className="text-5xl font-display font-bold text-teal">
                  {loading ? '...' : totalCalls.toLocaleString()}
                </p>
                <p className="text-sm text-slate-ink/50 font-body mt-2">Total Demo Calls</p>
              </div>
              <p className="text-xs text-slate-ink/40 font-body text-center">
                Rate limited to 5 calls per hour per caller
              </p>
            </div>

            <div className="md:col-span-2 bg-white rounded-2xl border border-soft-steel/50 p-6">
              <div className="flex items-center gap-2 mb-4">
                <Activity className="h-5 w-5 text-teal" />
                <h3 className="font-display font-semibold text-harbor">Live Activity Feed</h3>
                <span className="ml-auto text-xs text-slate-ink/40 font-body">Updates every 5s</span>
              </div>
              {loading ? (
                <div className="flex items-center justify-center py-12">
                  <div className="animate-spin h-6 w-6 border-2 border-teal border-t-transparent rounded-full" />
                </div>
              ) : events.length === 0 ? (
                <div className="text-center py-12 text-slate-ink/40 font-body">
                  <p>No demo calls yet. Be the first to try it!</p>
                </div>
              ) : (
                <div className="space-y-2.5 max-h-80 overflow-y-auto">
                  {events.map((event) => (
                    <div
                      key={event.id}
                      className="flex items-center justify-between px-4 py-3 bg-mist rounded-lg"
                    >
                      <div className="flex items-center gap-3">
                        <span className={`text-xs font-medium font-body ${eventColor(event.eventType)}`}>
                          {formatEventType(event.eventType)}
                        </span>
                        <span className="text-sm text-slate-ink/70 font-body">{event.agentName}</span>
                      </div>
                      <div className="flex items-center gap-4 text-xs text-slate-ink/40 font-body">
                        {event.durationSeconds != null && (
                          <span>{event.durationSeconds}s</span>
                        )}
                        <span>{timeAgo(event.timestamp)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="text-center text-sm text-slate-ink/50 font-body space-y-2">
            <p>
              Demo calls are handled by the same system used in production.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
