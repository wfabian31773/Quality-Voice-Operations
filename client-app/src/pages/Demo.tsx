import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Phone,
  PhoneOff,
  BarChart3,
  Headphones,
  Stethoscope,
  AlertCircle,
  Calendar,
  Building2,
  Scale,
  HelpCircle,
  DollarSign,
  Wrench,
  CheckCircle2,
  ArrowRight,
  Sparkles,
  Clock,
  Zap,
  Shield,
} from 'lucide-react';
import SEO from '../components/SEO';
import ConversationTranscript from '../components/demo/ConversationTranscript';
import ToolExecutionPanel from '../components/demo/ToolExecutionPanel';
import CalendarToolVisual from '../components/demo/CalendarToolVisual';
import SystemActivityFeed from '../components/demo/SystemActivityFeed';
import { useDemoSSE } from '../hooks/useDemoSSE';
import { trackPageView, trackDemoInteraction, trackCTAClick, trackConversionEvent, captureUtmOnLoad } from '../lib/analytics';
import { CTA } from '../lib/analyticsCtas';

const API_BASE = '/api';

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
  wrench: Wrench,
};

const AVATAR_MAP: Record<string, string> = {
  stethoscope: '/assets/avatars/medical.png',
  headphones: '/assets/avatars/answering-service.png',
  calendar: '/assets/avatars/dental.png',
  building: '/assets/avatars/hvac.png',
  scale: '/assets/avatars/legal.png',
  'help-circle': '/assets/avatars/customer-support.png',
  'dollar-sign': '/assets/avatars/collections.png',
  wrench: '/assets/avatars/hvac.png',
};

const AGENT_COLORS: string[] = [
  'teal',
  'harbor',
  'teal',
  'harbor',
  'teal',
  'harbor',
  'teal',
  'harbor',
];

function formatPhoneNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return raw;
}

function VoiceWaveform({ active }: { active: boolean }) {
  return (
    <div className="flex items-center gap-[3px] h-8" aria-hidden="true">
      {Array.from({ length: 12 }).map((_, i) => (
        <div
          key={i}
          className={`w-[3px] rounded-full transition-all duration-300 ${
            active
              ? 'bg-primary demo-waveform-bar'
              : 'bg-border-strong/30 h-1'
          }`}
          style={
            active
              ? {
                  animationDelay: `${i * 0.08}s`,
                  animationDuration: `${0.6 + Math.random() * 0.4}s`,
                }
              : undefined
          }
        />
      ))}
    </div>
  );
}

function CallTimer({ startTime }: { startTime: number }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);
    return () => clearInterval(interval);
  }, [startTime]);

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return (
    <span className="font-mono text-sm text-primary tabular-nums">
      {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
    </span>
  );
}

function DemoCompletionCelebration({ show }: { show: boolean }) {
  const { t } = useTranslation('marketing');
  if (!show) return null;
  return (
    <div className="demo-celebration-overlay">
      <div className="demo-celebration-content">
        <div className="w-16 h-16 rounded-full bg-success/20 flex items-center justify-center mx-auto mb-4 demo-celebration-icon">
          <CheckCircle2 className="h-8 w-8 text-success" />
        </div>
        <p className="font-display text-lg font-semibold text-text-primary">{t('demo.celebration.title')}</p>
        <p className="text-sm text-text-primary/60 font-body mt-1">{t('demo.celebration.subtitle')}</p>
      </div>
    </div>
  );
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
      ? 'border-primary ring-2 ring-primary/20'
      : 'border-sidebar-bg ring-2 ring-sidebar-bg/20'
    : 'border-white/20 hover:border-primary/30';

  const iconBg = variant === 'teal' ? 'bg-primary/10' : 'bg-surface-muted';
  const iconColor = variant === 'teal' ? 'text-primary' : 'text-text-primary';
  const categoryColor = variant === 'teal' ? 'text-primary' : 'text-text-primary';

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`demo-glass-card rounded-2xl border ${borderClass} p-6 text-left transition-all duration-300 cursor-pointer w-full hover:scale-[1.02] hover:shadow-lg`}
    >
      <div className="flex items-center gap-3 mb-3">
        {AVATAR_MAP[agent.icon] ? (
          <div className="w-10 h-10 rounded-xl overflow-hidden shrink-0 border border-border-strong/20">
            <img src={AVATAR_MAP[agent.icon]} alt={`${agent.name} avatar`} className="w-full h-full object-cover" loading="lazy" />
          </div>
        ) : (
          <div className={`w-10 h-10 rounded-xl ${iconBg} flex items-center justify-center shrink-0`}>
            <IconComponent className={`h-5 w-5 ${iconColor}`} />
          </div>
        )}
        <div className="min-w-0">
          <h3 className="font-display text-lg font-semibold text-text-primary truncate">{agent.name}</h3>
          <span className={`text-xs font-medium ${categoryColor}`}>{agent.category}</span>
        </div>
      </div>
      <p className="text-sm text-text-primary/60 font-body mb-4 leading-relaxed line-clamp-2">
        {agent.description}
      </p>
      <div className="space-y-1">
        {agent.useCases.map((uc) => (
          <div key={uc} className="flex items-center gap-2 text-xs text-text-primary/50 font-body">
            <span className={`w-1 h-1 rounded-full ${variant === 'teal' ? 'bg-primary' : 'bg-sidebar-bg'} shrink-0`} />
            {uc}
          </div>
        ))}
      </div>
    </button>
  );
}

function AgentPhoneDisplay({ agent }: { agent: DemoAgent }) {
  const { t } = useTranslation('marketing');
  if (!agent.phoneNumber) {
    return (
      <div className="flex items-center gap-3 bg-accent/10 border border-accent/20 rounded-xl px-5 py-4">
        <AlertCircle className="h-5 w-5 text-accent shrink-0" />
        <div>
          <p className="text-xs text-accent mb-0.5">{t('demo.phone_card.demo_line')}</p>
          <p className="text-sm text-text-primary/50">{t('demo.phone_card.not_configured')}</p>
        </div>
      </div>
    );
  }

  if (agent.isPlaceholder) {
    return (
      <div className="flex items-center gap-3 bg-primary/10 border border-primary/20 rounded-xl px-5 py-4">
        <Phone className="h-5 w-5 text-primary shrink-0" />
        <div>
          <p className="text-xs text-primary mb-0.5">{t('demo.phone_card.awaiting_real')}</p>
          <p className="text-sm text-text-primary/50">{t('demo.phone_card.ask_admin')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 bg-primary/10 border border-primary/20 rounded-xl px-5 py-4">
      <Phone className="h-5 w-5 text-primary shrink-0" />
      <div>
        <p className="text-xs text-primary mb-0.5">{t('demo.phone_card.call_to_try')}</p>
        <p className="text-lg font-mono font-bold text-text-primary">{formatPhoneNumber(agent.phoneNumber)}</p>
      </div>
    </div>
  );
}

function ConversionCTA({ visible, activeAgentRef }: { visible: boolean; activeAgentRef?: string }) {
  const { t } = useTranslation('marketing');
  if (!visible) return null;

  return (
    <section className="demo-cta-section py-16 lg:py-24">
      <div className="max-w-4xl mx-auto px-6 lg:px-8 text-center">
        <div className="inline-flex items-center gap-2 bg-primary/10 text-primary text-sm font-medium px-4 py-1.5 rounded-full mb-6">
          <Sparkles className="h-4 w-4" />
          {t('demo.conversion.experienced')}
        </div>
        <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
          {t('demo.conversion.title')}
        </h2>
        <p className="text-lg text-text-primary/60 font-body max-w-2xl mx-auto mb-8">
          {t('demo.conversion.subtitle')}
        </p>

        <div className="grid sm:grid-cols-3 gap-6 mb-10 text-left max-w-2xl mx-auto">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
              <Zap className="h-4 w-4 text-primary" />
            </div>
            <div>
              <p className="font-display text-sm font-semibold text-text-primary">{t('demo.conversion.feat1_title')}</p>
              <p className="text-xs text-text-primary/50 font-body">{t('demo.conversion.feat1_desc')}</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
              <Shield className="h-4 w-4 text-primary" />
            </div>
            <div>
              <p className="font-display text-sm font-semibold text-text-primary">{t('demo.conversion.feat2_title')}</p>
              <p className="text-xs text-text-primary/50 font-body">{t('demo.conversion.feat2_desc')}</p>
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
              <Clock className="h-4 w-4 text-primary" />
            </div>
            <div>
              <p className="font-display text-sm font-semibold text-text-primary">{t('demo.conversion.feat3_title')}</p>
              <p className="text-xs text-text-primary/50 font-body">{t('demo.conversion.feat3_desc')}</p>
            </div>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link
            to="/signup"
            className="inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-white font-display font-semibold px-8 py-3.5 rounded-xl transition-all duration-200 shadow-lg shadow-primary/20 hover:shadow-xl hover:shadow-primary/30 text-base"
            onClick={() => trackDemoCTA(CTA.START_FREE_TRIAL, activeAgentRef)}
          >
            {t('common.start_free_trial')}
            <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            to="/contact"
            className="inline-flex items-center gap-2 bg-white border border-border-strong/50 hover:border-primary/30 text-text-primary font-display font-semibold px-8 py-3.5 rounded-xl transition-all duration-200 text-base"
            onClick={() => trackDemoCTA(CTA.BOOK_DEMO, activeAgentRef)}
          >
            {t('common.book_demo')}
          </Link>
        </div>
      </div>
    </section>
  );
}

function trackDemoCTA(ctaType: string, agentType?: string) {
  trackCTAClick(ctaType, 'demo', agentType);
  try {
    fetch(`${API_BASE}/demo/track-cta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ctaType, agentType }),
    }).catch(() => {});
  } catch {}
}

export default function Demo() {
  const { t } = useTranslation('marketing');
  const [totalCalls, setTotalCalls] = useState(0);
  const [agents, setAgents] = useState<DemoAgent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [demoConfigured, setDemoConfigured] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);
  const [callStartTime, setCallStartTime] = useState<number | null>(null);
  const [showCTA, setShowCTA] = useState(false);
  const [showCelebration, setShowCelebration] = useState(false);
  const prevCallStatus = useRef<string>('idle');

  const {
    callStatus,
    agentName,
    duration,
    transcript,
    tools,
    activityEvents,
    connected: sseConnected,
    reconnecting: sseReconnecting,
  } = useDemoSSE();

  const isActive = callStatus === 'ringing' || callStatus === 'connected';
  const hasCalendarTool = tools.some(
    (t) => t.tool === 'checkAvailability' || t.tool === 'scheduleAppointment' ||
           t.tool === 'bookServiceAppointment' || t.tool === 'checkTechnicianAvailability',
  );

  useEffect(() => {
    trackPageView('/demo');
    captureUtmOnLoad();
    trackConversionEvent('demo_started', '/demo');
  }, []);

  useEffect(() => {
    const prev = prevCallStatus.current;
    if (callStatus !== prev) {
      if (callStatus === 'connected' || callStatus === 'ringing') {
        setCallStartTime(Date.now());
        setShowCTA(false);
        setShowCelebration(false);
        trackDemoInteraction('call_started', activeAgent?.name ?? 'unknown');
      } else if (callStatus === 'ended' && (prev === 'connected' || prev === 'ringing')) {
        const callDuration = callStartTime ? Math.round((Date.now() - callStartTime) / 1000) : 0;
        trackDemoInteraction('call_completed', activeAgent?.name ?? 'unknown', callDuration);
        trackConversionEvent('demo_completed', '/demo', { agent: activeAgent?.name });
        setCallStartTime(null);
        setShowCelebration(true);
        setTimeout(() => {
          setShowCelebration(false);
          setShowCTA(true);
        }, 2500);
      }
      prevCallStatus.current = callStatus;
    }
  }, [callStatus]);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/demo/stats`);
      if (res.ok) {
        const data = await res.json();
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
    fetchStats();
    const interval = setInterval(fetchStats, 15000);
    return () => clearInterval(interval);
  }, [fetchStats]);

  const activeAgent = agents.find((a) => a.id === selectedAgent) ?? null;

  return (
    <div>
      <SEO
        title={t('demo.seo_title')}
        description={t('demo.seo_description')}
        canonicalPath="/demo"
      />

      <DemoCompletionCelebration show={showCelebration} />

      <section className="bg-sidebar-bg text-white py-16 lg:py-24 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-sidebar-bg via-sidebar-bg to-sidebar-hover opacity-80" />
        <div className="absolute inset-0 demo-grid-pattern opacity-5" />
        <div className="max-w-6xl mx-auto px-6 lg:px-8 text-center relative z-10">
          <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-4">
            {t('demo.hero.eyebrow')}
          </p>
          <h1 className="font-display text-4xl lg:text-5xl font-bold mb-4">
            {t('demo.hero.title')}
          </h1>
          <p className="text-lg text-white/70 font-body max-w-2xl mx-auto mb-8">
            {t('demo.hero.description')}
          </p>
          <div className="flex items-center justify-center">
            <VoiceWaveform active={isActive} />
          </div>
        </div>
      </section>

      <section className="py-12 lg:py-16">
        <div className="max-w-6xl mx-auto px-6 lg:px-8">
          {demoConfigured === false && (
            <div className="mb-8 p-4 bg-accent/10 border border-accent/30 rounded-xl text-center text-accent text-sm font-body">
              {t('demo.config_warning')}
            </div>
          )}

          <div className="mb-8">
            <h2 className="font-display text-2xl font-bold text-text-primary mb-2">{t('demo.agent_picker.title')}</h2>
            <p className="text-sm text-text-primary/60 font-body">
              {t('demo.agent_picker.subtitle')}
            </p>
          </div>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 mb-10">
            {agents.map((agent, idx) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                colorIndex={idx}
                selected={selectedAgent === agent.id}
                onSelect={() => { setSelectedAgent(agent.id); trackDemoInteraction('agent_selected', agent.name); }}
              />
            ))}
            {agents.length === 0 && !loading && (
              <div className="sm:col-span-2 lg:col-span-3 xl:col-span-4 text-center py-12 text-text-primary/40 font-body">
                <p>{t('demo.agent_picker.empty')}</p>
              </div>
            )}
          </div>

          {activeAgent && (
            <div className={`demo-glass-card rounded-2xl border p-8 mb-10 transition-all duration-500 ${
              isActive
                ? 'border-primary/40 shadow-lg shadow-primary/10'
                : 'border-white/20'
            }`}>
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
                <div className="flex items-center gap-3">
                  {AVATAR_MAP[activeAgent.icon] ? (
                    <div className="w-12 h-12 rounded-xl overflow-hidden border border-border-strong/20">
                      <img src={AVATAR_MAP[activeAgent.icon]} alt={`${activeAgent.name} avatar`} className="w-full h-full object-cover" loading="lazy" />
                    </div>
                  ) : (() => {
                    const IconComponent = ICON_MAP[activeAgent.icon] ?? Headphones;
                    return (
                      <div className={`w-12 h-12 rounded-xl flex items-center justify-center transition-colors duration-300 ${
                        isActive ? 'bg-primary/20' : 'bg-primary/10'
                      }`}>
                        <IconComponent className="h-6 w-6 text-primary" />
                      </div>
                    );
                  })()}
                  <div>
                    <h3 className="font-display text-xl font-semibold text-text-primary">{activeAgent.name}</h3>
                    <span className="text-xs font-medium text-primary">{activeAgent.category}</span>
                  </div>
                </div>

                <div className={`demo-call-status-bar ${
                  isActive ? 'demo-call-status-active' : 'demo-call-status-idle'
                }`}>
                  {isActive ? (
                    sseReconnecting || !sseConnected ? (
                      <>
                        <div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
                        <Phone className="h-4 w-4 text-accent" />
                        <span className="text-sm font-medium text-accent">{t('demo.status.reconnecting')}</span>
                        {callStartTime && <CallTimer startTime={callStartTime} />}
                      </>
                    ) : (
                      <>
                        <div className="w-2 h-2 rounded-full bg-success animate-pulse" />
                        <Phone className="h-4 w-4 text-success" />
                        <span className="text-sm font-medium text-success">{t('demo.status.active')}</span>
                        {callStartTime && <CallTimer startTime={callStartTime} />}
                      </>
                    )
                  ) : (
                    <>
                      <div className="w-2 h-2 rounded-full bg-border-strong/40" />
                      <PhoneOff className="h-4 w-4 text-text-primary/40" />
                      <span className="text-sm text-text-primary/40">{t('demo.status.idle')}</span>
                    </>
                  )}
                </div>
              </div>

              <p className="text-sm text-text-primary/60 font-body mb-6 leading-relaxed">
                {activeAgent.description}
              </p>

              <div className="flex items-center gap-4 mb-4">
                <VoiceWaveform active={isActive} />
                {isActive && (
                  <span className="text-xs text-primary font-body animate-pulse">{t('demo.status.listening')}</span>
                )}
              </div>

              <AgentPhoneDisplay agent={activeAgent} />
            </div>
          )}

          <div className="grid lg:grid-cols-2 gap-6 mb-8">
            <ConversationTranscript messages={transcript} isActive={isActive} />

            <div className="space-y-6">
              <ToolExecutionPanel tools={tools} isActive={isActive} />
              {hasCalendarTool && <CalendarToolVisual visible={true} />}
            </div>
          </div>

          <div className="grid md:grid-cols-3 gap-6 mb-12">
            <div className="md:col-span-1 demo-glass-card rounded-2xl border border-white/20 p-6">
              <div className="flex items-center gap-2 mb-4">
                <BarChart3 className="h-5 w-5 text-success" />
                <h3 className="font-display font-semibold text-text-primary">{t('demo.stats_card.title')}</h3>
              </div>
              <div className="text-center py-6">
                <p className="text-5xl font-display font-bold text-primary">
                  {loading ? '...' : totalCalls.toLocaleString()}
                </p>
                <p className="text-sm text-text-primary/50 font-body mt-2">{t('demo.stats_card.label')}</p>
              </div>
              <p className="text-xs text-text-primary/40 font-body text-center">
                {t('demo.stats_card.rate_limit')}
              </p>
            </div>

            <div className="md:col-span-2">
              <SystemActivityFeed events={activityEvents} isActive={isActive} />
            </div>
          </div>

          <div className="text-center text-sm text-text-primary/50 font-body space-y-2">
            <p>
              {t('demo.footer_note')}
            </p>
          </div>
        </div>
      </section>

      <ConversionCTA visible={showCTA} activeAgentRef={activeAgent?.template} />
    </div>
  );
}
