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
import { DemoOrchestrationHub, PLACEHOLDER_DEMO_TIMELINE } from '../components/marketing/DemoHub';
import ConversationTranscript from '../components/demo/ConversationTranscript';
import ToolExecutionPanel from '../components/demo/ToolExecutionPanel';
import CalendarToolVisual from '../components/demo/CalendarToolVisual';
import SystemActivityFeed from '../components/demo/SystemActivityFeed';
import { useDemoSSE } from '../hooks/useDemoSSE';
import { trackPageView, trackDemoInteraction, trackCTAClick, trackConversionEvent, captureUtmOnLoad } from '../lib/analytics';
import { CTA } from '../lib/analyticsCtas';
import { CONVERSION_STAGE } from '../lib/analyticsLabels';

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

  const categoryColor = variant === 'teal' ? 'text-primary' : 'text-text-primary';

  // Pure-icon avatar: a unified Deep Harbor circle holding the Lucide icon
  // in Signal Teal (or white on a teal circle for the alt color). We dropped
  // the prior PNG-thumbnail branch entirely — those were the "funny
  // characters" Wayne flagged. Pure SVG icons stay sharp at any size, are
  // perfectly symmetrical across all 8 agents by construction, and have no
  // AI-face uncanny-valley problem.
  const avatarTile =
    variant === 'teal'
      ? 'bg-primary text-on-primary'
      : 'bg-sidebar-bg text-on-sidebar';

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`demo-glass-card rounded-2xl border ${borderClass} p-5 text-left transition-all duration-300 cursor-pointer w-full hover:scale-[1.02] hover:shadow-lg`}
    >
      <div className="flex items-center gap-3 mb-3">
        <div className={`w-12 h-12 rounded-full flex items-center justify-center shrink-0 ${avatarTile}`}>
          <IconComponent className="h-6 w-6" />
        </div>
        <div className="min-w-0">
          <h3 className="font-display text-base font-semibold text-text-primary truncate leading-tight">{agent.name}</h3>
          <span className={`text-xs font-medium ${categoryColor}`}>{agent.category}</span>
        </div>
      </div>
      <p className="text-sm text-text-primary/60 font-body mb-3 leading-relaxed line-clamp-2">
        {agent.description}
      </p>
      <div className="space-y-1">
        {agent.useCases.slice(0, 3).map((uc) => (
          <div key={uc} className="flex items-center gap-2 text-xs text-text-primary/55 font-body">
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
    <a
      href={`tel:${agent.phoneNumber}`}
      className="block bg-primary/10 hover:bg-primary/15 border-2 border-primary/30 hover:border-primary/50 rounded-2xl px-6 py-5 transition-colors focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      data-testid="agent-phone-display"
    >
      <div className="flex items-center gap-3 mb-1">
        <div className="w-8 h-8 rounded-full bg-primary flex items-center justify-center shrink-0">
          <Phone className="h-4 w-4 text-on-primary" />
        </div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-primary">
          {t('demo.phone_card.call_to_try')}
        </p>
      </div>
      <p className="text-2xl lg:text-3xl font-mono font-bold text-text-primary tracking-tight">
        {formatPhoneNumber(agent.phoneNumber)}
      </p>
      <p className="mt-1 text-xs text-text-primary/55 font-body">
        Tap to call from your phone, or dial from any line.
      </p>
    </a>
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
    trackConversionEvent(CONVERSION_STAGE.DEMO_STARTED, '/demo');
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
        trackConversionEvent(CONVERSION_STAGE.DEMO_COMPLETED, '/demo', { agent: activeAgent?.name });
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

      <section className="bg-sidebar-bg text-white pt-10 pb-8 lg:pt-14 lg:pb-10 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-sidebar-bg via-sidebar-bg to-sidebar-hover opacity-80" />
        <div className="max-w-screen-2xl mx-auto px-4 lg:px-8 text-center relative z-10">
          <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-3">
            {t('demo.hero.eyebrow')}
          </p>
          {/* Explicit text-white so the QVO base h1 color rule (which
              defaults to a light-theme dark token on this dark surface)
              doesn't render the headline invisible. */}
          <h1 className="font-display text-white text-4xl lg:text-6xl font-bold mb-4 tracking-tight">
            {t('demo.hero.title')}
          </h1>
          <p className="text-lg text-white/70 font-body max-w-2xl mx-auto mb-8">
            {t('demo.hero.description')}
          </p>
          {/* Orchestration hub centerpiece — see DemoOrchestrationHub.tsx.
              Filling the wider screen-2xl container so the Seedance video
              dominates the viewport instead of floating in dead space.
              The "Agent live / Standby" indicator that used to sit below
              this is gone — DemoOrchestrationHub already renders the
              active-tool label in the same vertical slot, which makes the
              prior badge redundant. */}
          <DemoOrchestrationHub
            mode="scripted"
            timeline={PLACEHOLDER_DEMO_TIMELINE}
          />
        </div>
      </section>

      <section className="pt-6 pb-12 lg:pt-8 lg:pb-16">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
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

          {/*
            Side-by-side layout:
              - Left (lg:col-span-7): the agent picker grid, now a 2-col grid
                so 8 cards stack 2 wide × 4 tall and the eye can scan the
                full list without scrolling.
              - Right (lg:col-span-5): the selected-agent detail panel,
                STICKY at top:24 so the phone number stays visible as the
                user reads the cards. This was Wayne's biggest gripe — old
                layout buried the number 600px below the grid.

            Mobile (<lg): collapses to single column. The detail panel
            renders below the grid because there's no sticky-rail real
            estate on small screens; the in-card selection highlight is
            the visual feedback there.
          */}
          <div className="grid lg:grid-cols-12 gap-6 lg:gap-8 mb-10">
            <div className="lg:col-span-7">
              <div className="grid sm:grid-cols-2 gap-4">
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
                  <div className="sm:col-span-2 text-center py-12 text-text-primary/40 font-body">
                    <p>{t('demo.agent_picker.empty')}</p>
                  </div>
                )}
              </div>
            </div>

            <div className="lg:col-span-5">
              <div className="lg:sticky lg:top-24">
                {activeAgent ? (
                  <div className={`demo-glass-card rounded-2xl border p-6 transition-all duration-500 ${
                    isActive
                      ? 'border-primary/40 shadow-lg shadow-primary/10'
                      : 'border-white/20'
                  }`}>
                    {/* Phone number FIRST — this is the moment-of-action element.
                        Wayne's screenshot showed it buried at the bottom of this
                        panel, requiring a scroll. Top-of-panel placement means
                        the call number is the first thing the eye lands on the
                        second a user clicks any card. */}
                    <AgentPhoneDisplay agent={activeAgent} />

                    {/* Live-call status pill — below the number so the call
                        action remains the visual hero. */}
                    <div className="mt-4">
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

                    {/* Agent identity — name + category — below the action so
                        the user always knows what they're about to call. */}
                    <div className="mt-5 pt-5 border-t border-border-strong/20 flex items-center gap-3">
                      {(() => {
                        const IconComponent = ICON_MAP[activeAgent.icon] ?? Headphones;
                        return (
                          <div className="w-12 h-12 rounded-full bg-primary flex items-center justify-center shrink-0">
                            <IconComponent className="h-6 w-6 text-on-primary" />
                          </div>
                        );
                      })()}
                      <div className="min-w-0">
                        <h3 className="font-display text-lg font-semibold text-text-primary leading-tight">{activeAgent.name}</h3>
                        <span className="text-xs font-medium text-primary">{activeAgent.category}</span>
                      </div>
                    </div>

                    <p className="mt-4 text-sm text-text-primary/65 font-body leading-relaxed">
                      {activeAgent.description}
                    </p>

                    {isActive && (
                      <div className="mt-5 flex items-center gap-3">
                        <VoiceWaveform active={isActive} />
                        <span className="text-xs text-primary font-body animate-pulse">{t('demo.status.listening')}</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="rounded-2xl border border-dashed border-border-strong/40 bg-surface/50 p-8 text-center">
                    <div className="w-14 h-14 mx-auto rounded-full bg-primary/10 flex items-center justify-center mb-4">
                      <Headphones className="h-7 w-7 text-primary/60" />
                    </div>
                    <h3 className="font-display text-base font-semibold text-text-primary mb-1">
                      Pick an agent to call
                    </h3>
                    <p className="text-sm text-text-primary/55 font-body">
                      Choose any agent on the left and the phone number to try them appears here.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* "What happens when you call" preview section —
              The four panels below (Transcript / Tool Executions / Stats /
              System Activity) are mostly empty until a real call is in
              progress. Without this heading they read as broken/dead;
              with it they read as "preview of what you'll see when you
              dial," which is what they actually are. */}
          <div className="mb-6 pt-6 border-t border-border-strong/30">
            <h2 className="font-display text-2xl font-bold text-text-primary mb-1">
              What happens when you call
            </h2>
            <p className="text-sm text-text-primary/60 font-body">
              When a demo call connects, these panels stream live — the
              conversation, the tools the agent invokes, and the system
              events behind every action.
            </p>
          </div>

          <div className="grid lg:grid-cols-2 gap-6 mb-8">
            <ConversationTranscript messages={transcript} isActive={isActive} />

            <div className="space-y-6">
              <ToolExecutionPanel tools={tools} isActive={isActive} />
              {hasCalendarTool && <CalendarToolVisual visible={true} />}
            </div>
          </div>

          <div className="grid md:grid-cols-3 gap-6 mb-10">
            <div className="md:col-span-1 demo-glass-card rounded-2xl border border-white/20 p-6">
              <div className="flex items-center gap-2 mb-4">
                {/* Brand-teal panel header to match all the other demo
                    panels. The big number below uses text-primary too —
                    no need for a competing success-green here. */}
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                  <BarChart3 className="h-4 w-4 text-primary" />
                </div>
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

          <div className="text-center text-sm text-text-primary/50 font-body">
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
