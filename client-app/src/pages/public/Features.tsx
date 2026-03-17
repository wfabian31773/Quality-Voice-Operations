import { Link } from 'react-router-dom';
import {
  Mic, Settings, Zap, LayoutDashboard, BookOpen, Plug,
  Calendar, Ticket, MessageSquare, Truck, Users, ArrowRight,
  CheckCircle2, Bot, Cpu, Wrench, Database, Shield,
} from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';
import { useEffect } from 'react';
import { trackPageView, trackFeatureView, trackCTAClick } from '../../lib/analytics';

const platformCapabilities = [
  {
    icon: Mic,
    title: 'Voice AI Runtime',
    desc: 'Real-time speech-to-text and text-to-speech engine with natural language understanding, emotion detection, and multi-turn conversation management.',
    details: [
      'Sub-200ms response latency',
      'Multi-language support',
      'Speaker diarization',
      'Emotion and sentiment analysis',
      'Noise cancellation and echo removal',
    ],
  },
  {
    icon: Settings,
    title: 'Agent Builder',
    desc: 'Visual configuration tool for creating AI voice agents. Choose industry templates, customize scripts, set routing rules, and define escalation triggers without writing code.',
    details: [
      'Industry-specific templates',
      'Drag-and-drop prompt editor',
      'Voice personality tuning',
      'Conditional routing logic',
      'Version-controlled prompts',
    ],
  },
  {
    icon: Zap,
    title: 'Tool Execution Engine',
    desc: 'Agents take actions during calls in real time — booking appointments, creating tickets, looking up records, and dispatching technicians through connected integrations.',
    details: [
      'Real-time tool invocation during calls',
      'Parallel tool execution',
      'Error handling and retry logic',
      'Audit logging for every action',
      'Custom tool definitions via API',
    ],
  },
  {
    icon: LayoutDashboard,
    title: 'Live Operations Dashboard',
    desc: 'Monitor every call, agent, and campaign from a single pane. Real-time metrics on call volume, resolution rates, quality scores, and conversion tracking.',
    details: [
      'Real-time call monitoring',
      'Agent performance scorecards',
      'Campaign ROI tracking',
      'Quality assurance scoring',
      'Custom report builder',
    ],
  },
  {
    icon: BookOpen,
    title: 'Knowledge + RAG System',
    desc: 'Upload documents, FAQs, and product catalogs. Agents use retrieval-augmented generation to answer caller questions accurately with sourced information.',
    details: [
      'Document ingestion (PDF, DOCX, CSV)',
      'Automatic chunking and indexing',
      'Source attribution in responses',
      'Knowledge base versioning',
      'Per-agent knowledge scoping',
    ],
  },
  {
    icon: Plug,
    title: 'Integration Framework',
    desc: 'Connect QVO to your existing tools with pre-built connectors and a flexible webhook/API system. Push call data, trigger workflows, and sync records automatically.',
    details: [
      'Pre-built CRM connectors',
      'Calendar system integration',
      'Webhook delivery with retries',
      'REST API with full CRUD',
      'Zapier and Make support',
    ],
  },
];

const miniSystems = [
  {
    icon: Calendar,
    title: 'Scheduling System',
    desc: 'Built-in appointment scheduling with availability checks, conflict detection, and automatic confirmations. Syncs with Google Calendar and practice management systems.',
  },
  {
    icon: Ticket,
    title: 'Ticketing System',
    desc: 'Create, route, and track service tickets directly from call conversations. Priority classification, assignment rules, and SLA tracking included.',
  },
  {
    icon: MessageSquare,
    title: 'SMS Messaging',
    desc: 'Send appointment confirmations, follow-up messages, and ETA updates via SMS. Two-way messaging for callback coordination and reminders.',
  },
  {
    icon: Truck,
    title: 'Dispatch System',
    desc: 'Assign and dispatch field technicians based on availability, location, and skill set. Automated SMS notifications with real-time ETA updates.',
  },
  {
    icon: Users,
    title: 'Customer Tracking',
    desc: 'Maintain caller profiles with interaction history, preferences, and notes. Build a complete picture of every customer relationship over time.',
  },
];

const architectureBlocks = [
  { icon: Cpu, label: 'Voice AI Runtime', color: 'bg-teal/15 text-teal' },
  { icon: Bot, label: 'Agent Builder', color: 'bg-harbor/15 text-harbor' },
  { icon: Zap, label: 'Tool Engine', color: 'bg-warm-amber/15 text-warm-amber' },
  { icon: Database, label: 'Knowledge RAG', color: 'bg-calm-green/15 text-calm-green' },
  { icon: Plug, label: 'Integrations', color: 'bg-teal/15 text-teal' },
  { icon: Shield, label: 'Security Layer', color: 'bg-controlled-red/15 text-controlled-red' },
];

export default function Features() {
  useEffect(() => {
    trackPageView('/features');
  }, []);

  return (
    <div>
      <SEO
        title="Features — AI Voice Agent Platform Capabilities"
        description="Explore QVO's platform features: Voice AI Runtime, Agent Builder, Tool Execution Engine, Live Operations Dashboard, Knowledge RAG System, and Integration Framework."
        canonicalPath="/features"
      />

      <section className="bg-harbor text-white py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-4">
              Platform Features
            </p>
            <h1 className="font-display text-4xl lg:text-5xl font-bold leading-tight mb-6">
              Everything you need to automate voice operations.
            </h1>
            <p className="text-lg text-white/70 leading-relaxed font-body max-w-2xl mb-8">
              Six core platform capabilities and five mini systems that work together to handle calls, execute actions, and give you complete operational visibility.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link
                to="/demo"
                className="inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-7 py-3.5 rounded-xl transition-all text-sm shadow-lg shadow-teal/25"
                onClick={() => trackCTAClick('Try Live Demo', '/features', 'hero')}
              >
                Try Live Demo
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/use-cases"
                className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 backdrop-blur-sm text-white font-semibold px-7 py-3.5 rounded-xl transition-all text-sm border border-white/10"
                onClick={() => trackCTAClick('See Use Cases', '/features', 'hero')}
              >
                See Use Cases
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-mist">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
                Platform Architecture
              </h2>
              <p className="text-lg text-slate-ink/60 font-body max-w-2xl mx-auto">
                A modular architecture where each subsystem handles a specific responsibility, working together to deliver end-to-end voice automation.
              </p>
            </div>
          </RevealSection>

          <RevealSection>
            <div className="max-w-4xl mx-auto mb-16">
              <div className="bg-white rounded-2xl border border-soft-steel/30 p-8 lg:p-10">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  {architectureBlocks.map((block) => (
                    <div
                      key={block.label}
                      className="flex items-center gap-3 p-4 rounded-xl border border-soft-steel/20 hover:shadow-md transition-all"
                    >
                      <div className={`w-10 h-10 rounded-lg ${block.color} flex items-center justify-center shrink-0`}>
                        <block.icon className="h-5 w-5" />
                      </div>
                      <span className="font-display text-sm font-semibold text-harbor">{block.label}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-6 pt-6 border-t border-soft-steel/20 text-center">
                  <p className="text-xs text-slate-ink/40 font-body">
                    All subsystems communicate through event-driven APIs with full audit logging
                  </p>
                </div>
              </div>
            </div>
          </RevealSection>

          <div className="space-y-12">
            {platformCapabilities.map((cap, i) => (
              <RevealSection key={cap.title} delay={i % 2 === 0 ? '' : 'scroll-delay-1'}>
                <div
                  className="bg-white rounded-2xl border border-soft-steel/30 overflow-hidden hover:shadow-lg transition-shadow"
                  onMouseEnter={() => trackFeatureView(cap.title)}
                >
                  <div className="p-8 lg:p-10">
                    <div className="flex items-start gap-4 mb-6">
                      <div className="w-12 h-12 rounded-xl bg-teal/10 flex items-center justify-center shrink-0">
                        <cap.icon className="h-6 w-6 text-teal" />
                      </div>
                      <div>
                        <h3 className="font-display text-2xl font-bold text-harbor">{cap.title}</h3>
                      </div>
                    </div>
                    <p className="text-slate-ink/70 font-body leading-relaxed mb-6 max-w-3xl">
                      {cap.desc}
                    </p>
                    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {cap.details.map((detail) => (
                        <div key={detail} className="flex items-center gap-2 text-sm text-slate-ink/70 font-body">
                          <CheckCircle2 className="h-4 w-4 text-calm-green shrink-0" />
                          {detail}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </RevealSection>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-white">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <span className="inline-block text-sm font-semibold text-teal bg-teal/10 px-4 py-1.5 rounded-full mb-4">
                Built-In Mini Systems
              </span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
                Integrated systems that power your agents.
              </h2>
              <p className="text-lg text-slate-ink/60 font-body max-w-2xl mx-auto">
                Every QVO agent has access to these built-in systems — no external tools required for core operations.
              </p>
            </div>
          </RevealSection>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-5xl mx-auto">
            {miniSystems.map((sys, i) => (
              <RevealSection key={sys.title} delay={`scroll-delay-${(i % 3) + 1}`}>
                <div className="bg-gradient-to-br from-mist to-frost-blue/30 rounded-2xl border border-soft-steel/30 p-7 hover:shadow-lg transition-all h-full">
                  <div className="w-11 h-11 rounded-xl bg-teal/10 flex items-center justify-center mb-4">
                    <sys.icon className="h-5 w-5 text-teal" />
                  </div>
                  <h3 className="font-display text-lg font-semibold text-harbor mb-2">{sys.title}</h3>
                  <p className="text-sm text-slate-ink/60 leading-relaxed font-body">{sys.desc}</p>
                </div>
              </RevealSection>
            ))}
          </div>
        </div>
      </section>

      <section className="relative py-20 lg:py-24 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-harbor via-harbor-light/40 to-harbor" />
        <div className="absolute inset-0 opacity-15">
          <div className="absolute top-0 left-1/4 w-64 h-64 bg-teal rounded-full blur-[100px]" />
          <div className="absolute bottom-0 right-1/4 w-80 h-80 bg-teal rounded-full blur-[120px]" />
        </div>
        <RevealSection>
          <div className="relative max-w-3xl mx-auto px-6 lg:px-8 text-center">
            <h2 className="font-display text-3xl lg:text-4xl font-bold text-white mb-4">
              Build Your First Agent Today
            </h2>
            <p className="text-lg text-white/60 font-body mb-10 max-w-xl mx-auto">
              Start with a pre-built template or create a custom agent from scratch. Deploy in minutes, not weeks.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                to="/signup"
                className="inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-8 py-3.5 rounded-xl transition-all text-sm shadow-lg shadow-teal/30 hover:shadow-teal/50"
                onClick={() => trackCTAClick('Start Free Trial', '/features', 'bottom-cta')}
              >
                Start Free Trial
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/demo"
                className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 backdrop-blur-sm text-white font-semibold px-8 py-3.5 rounded-xl transition-all text-sm border border-white/10"
                onClick={() => trackCTAClick('Try Live Demo', '/features', 'bottom-cta')}
              >
                Try Live Demo
              </Link>
            </div>
          </div>
        </RevealSection>
      </section>
    </div>
  );
}
