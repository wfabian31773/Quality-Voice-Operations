import { Link } from 'react-router-dom';
import { useEffect } from 'react';
import {
  ArrowRight, Stethoscope, Smile, Wrench, Eye, Scale, Home,
  Bot, Layers, Sparkles, ShieldCheck, CheckCircle2, BookOpen,
  Database, Plug, Settings, Activity, GitBranch, Target,
} from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';
import { trackPageView, trackCTAClick, trackVerticalEngagement } from '../../lib/analytics';

const featuredAgents = [
  {
    slug: 'azul-vision',
    name: 'Azul Vision',
    vertical: 'Ophthalmology',
    icon: Eye,
    accent: 'bg-blue-600',
    accentSoft: 'bg-blue-50',
    accentText: 'text-blue-700',
    summary:
      'A native ophthalmology agent that handles patient calls for cataract, LASIK, retina, and glaucoma practices end-to-end. Built by a clinical team, deployed inside QVO.',
    capabilities: [
      'Eye-condition triage with on-call escalation',
      'Pre/post-op instruction calls and confirmations',
      'Insurance verification with EHR write-back',
      'Multi-location surgery scheduling',
    ],
    verticalLink: '/industries/healthcare',
    source: 'Native QVO agent — runs inside the voice gateway with PHI redaction.',
  },
  {
    slug: 'medical-front-desk',
    name: 'Medical Front Desk',
    vertical: 'Primary care & specialty clinics',
    icon: Stethoscope,
    accent: 'bg-emerald-600',
    accentSoft: 'bg-emerald-50',
    accentText: 'text-emerald-700',
    summary:
      'Patient scheduling, intake, prescription refills, and after-hours triage for primary care, urgent care, and specialty practices.',
    capabilities: [
      'Patient scheduling and rescheduling',
      'Structured intake and insurance capture',
      'Prescription refill triage',
      'After-hours urgency classification',
    ],
    verticalLink: '/industries/healthcare',
    source: 'Template — customize prompts, tools, and routing for your clinic.',
  },
  {
    slug: 'dental-practice',
    name: 'Dental Practice Agent',
    vertical: 'Dental',
    icon: Smile,
    accent: 'bg-cyan-600',
    accentSoft: 'bg-cyan-50',
    accentText: 'text-cyan-700',
    summary:
      'Books cleanings, confirms hygiene appointments, handles insurance verification, and reduces no-shows for general and cosmetic dental practices.',
    capabilities: [
      'Operatory-aware scheduling',
      'Hygienist vs. dentist routing',
      'Insurance benefit verification',
      'No-show recovery callbacks',
    ],
    verticalLink: '/industries/dental',
    source: 'Template — pre-tuned for Dentrix, Open Dental, and Eaglesoft.',
  },
  {
    slug: 'field-service',
    name: 'Field Service Dispatcher',
    vertical: 'HVAC, plumbing, electrical',
    icon: Wrench,
    accent: 'bg-orange-600',
    accentSoft: 'bg-orange-50',
    accentText: 'text-orange-700',
    summary:
      'Answers emergency service calls, prioritizes by urgency, and dispatches technicians with live ETA SMS to the customer.',
    capabilities: [
      'After-hours emergency triage',
      'Technician matching by skill and location',
      'Real-time ETA SMS to customer',
      'Maintenance contract upsell prompts',
    ],
    verticalLink: '/industries/home-services',
    source: 'Template — wires into the QVO dispatch and SMS systems out of the box.',
  },
  {
    slug: 'legal-intake',
    name: 'Legal Intake Agent',
    vertical: 'Law firms',
    icon: Scale,
    accent: 'bg-amber-600',
    accentSoft: 'bg-amber-50',
    accentText: 'text-amber-700',
    summary:
      "Conducts professional case intake — captures facts, runs conflict checks, and books consultations on the right attorney's calendar.",
    capabilities: [
      'Structured case intake',
      'Conflict-of-interest checks',
      'Practice-area routing',
      'Consultation booking with retainer info',
    ],
    verticalLink: '/industries/legal',
    source: 'Template — designed with input from PI, family, and immigration firms.',
  },
  {
    slug: 'real-estate',
    name: 'Real Estate Lead Agent',
    vertical: 'Brokerages and teams',
    icon: Home,
    accent: 'bg-teal-600',
    accentSoft: 'bg-teal-50',
    accentText: 'text-teal-700',
    summary:
      'Responds to inbound buyer and seller leads in seconds, qualifies them by budget and timeline, and books showings on agent calendars.',
    capabilities: [
      'Sub-30s lead response',
      'Budget and pre-approval qualification',
      'MLS lookup for property questions',
      'Showing scheduling with confirmations',
    ],
    verticalLink: '/industries/real-estate',
    source: 'Template — integrates with HubSpot, Follow Up Boss, and major MLS feeds.',
  },
];

const whatYouGet = [
  {
    icon: BookOpen,
    title: 'Vertical-specific prompts',
    desc: 'Each agent ships with prompts written by people who actually work in that vertical — not a generic “medical receptionist” template applied across specialties.',
  },
  {
    icon: Plug,
    title: 'Pre-wired tools',
    desc: 'Each template comes pre-wired to the right scheduling, EHR, MLS, dispatch, and CRM tools. No tool-by-tool plumbing on day one.',
  },
  {
    icon: Database,
    title: 'Vertical knowledge packs',
    desc: 'Glossaries, intake schemas, and FAQ libraries tuned to the vertical so the agent answers correctly from the first call.',
  },
  {
    icon: ShieldCheck,
    title: 'Compliance defaults',
    desc: 'PHI redaction for healthcare, conflict-check for legal, TCPA quiet-hours for outbound — defaults match the vertical, not just the platform.',
  },
  {
    icon: Activity,
    title: 'Vertical KPIs in your dashboard',
    desc: 'Each template surfaces the metrics that matter for that vertical (no-show rate, lead-to-tour, dispatch acceptance time) instead of generic call counts.',
  },
  {
    icon: GitBranch,
    title: 'Evolution-engine ready',
    desc: 'Every template plugs into the QVO evolution engine and (optionally) the Global Intelligence Network for vertical-aware prompt suggestions.',
  },
];

const deploySteps = [
  {
    icon: Sparkles,
    title: '1. Pick a template',
    desc: 'Browse the catalog above and choose the agent that matches your vertical. Native agents like Azul Vision are turn-key; templates are a starting point you customize.',
  },
  {
    icon: Settings,
    title: '2. Customize in the Agent Builder',
    desc: 'Adjust prompts, add your knowledge documents, wire in your CRM/EHR, and set routing rules — all from the visual Agent Builder.',
  },
  {
    icon: Target,
    title: '3. Test on the live demo',
    desc: 'Call the agent yourself from the demo console, score the conversation, and iterate before pointing real numbers at it.',
  },
  {
    icon: Bot,
    title: '4. Go live and learn',
    desc: 'Route a phone number to the agent. Quality scoring, evolution suggestions, and (opt-in) GIN benchmarks kick in immediately.',
  },
];

export default function VerticalAgents() {
  useEffect(() => {
    trackPageView('/industries/vertical-agents');
  }, []);

  return (
    <div>
      <SEO
        title="Vertical Agents — Pre-built AI Voice Agents by Industry"
        description="QVO's catalog of vertical AI voice agents — from native ophthalmology agents like Azul Vision to medical, dental, field-service, legal, and real-estate templates. Pick a template, customize it, ship it."
        canonicalPath="/industries/vertical-agents"
      />

      <section className="bg-harbor text-white py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-4">
              Vertical Agents
            </p>
            <h1 className="font-display text-4xl lg:text-5xl font-bold leading-tight mb-6">
              Pre-built voice agents for the verticals you actually work in.
            </h1>
            <p className="text-lg text-white/70 leading-relaxed font-body max-w-2xl mb-8">
              QVO ships native and template agents tuned to the way real practices and crews
              operate — ophthalmology, primary care, dental, HVAC, plumbing, law, and real estate
              — so you start from a working agent, not a blank prompt.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link
                to="/demo"
                className="inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-7 py-3.5 rounded-xl transition-all text-sm shadow-lg shadow-teal/25"
                onClick={() => trackCTAClick('Try a vertical agent', '/industries/vertical-agents', 'hero')}
              >
                Try a vertical agent
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/book-demo"
                className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 backdrop-blur-sm text-white font-semibold px-7 py-3.5 rounded-xl transition-all text-sm border border-white/10"
                onClick={() => trackCTAClick('Book a demo', '/industries/vertical-agents', 'hero')}
              >
                Book a demo
              </Link>
            </div>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-white/60">
              <span className="inline-flex items-center gap-2"><Layers className="h-4 w-4 text-teal" />6+ verticals covered today</span>
              <span className="inline-flex items-center gap-2"><Bot className="h-4 w-4 text-teal" />Native + partner agents</span>
              <span className="inline-flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-teal" />Compliance defaults per vertical</span>
            </div>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-mist">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
                The current catalog
              </h2>
              <p className="text-lg text-slate-ink/60 font-body max-w-2xl mx-auto">
                Native agents are turn-key. Templates are starting points you customize for your
                practice or crew in the QVO Agent Builder.
              </p>
            </div>
          </RevealSection>

          <div className="grid md:grid-cols-2 gap-6 max-w-6xl mx-auto">
            {featuredAgents.map((agent, i) => (
              <RevealSection key={agent.slug} delay={i % 2 === 0 ? '' : 'scroll-delay-1'}>
                <div
                  className="bg-white rounded-2xl border border-soft-steel/30 overflow-hidden hover:shadow-lg transition-shadow h-full flex flex-col"
                  onMouseEnter={() => trackVerticalEngagement(agent.slug, 'card_hover')}
                >
                  <div className={`px-7 pt-7 pb-5 ${agent.accentSoft}`}>
                    <div className="flex items-center gap-3 mb-3">
                      <div className={`w-11 h-11 rounded-xl ${agent.accent} flex items-center justify-center`}>
                        <agent.icon className="h-5 w-5 text-white" />
                      </div>
                      <div>
                        <p className={`text-xs font-semibold uppercase tracking-wide ${agent.accentText}`}>{agent.vertical}</p>
                        <h3 className="font-display text-xl font-bold text-harbor">{agent.name}</h3>
                      </div>
                    </div>
                    <p className="text-sm text-slate-ink/70 font-body leading-relaxed">{agent.summary}</p>
                  </div>
                  <div className="px-7 py-6 flex-1 flex flex-col">
                    <ul className="space-y-2 mb-5">
                      {agent.capabilities.map((cap) => (
                        <li key={cap} className="flex items-start gap-2 text-sm text-slate-ink/70 font-body">
                          <CheckCircle2 className="h-4 w-4 text-calm-green shrink-0 mt-0.5" />
                          <span>{cap}</span>
                        </li>
                      ))}
                    </ul>
                    <p className="text-xs text-slate-ink/50 font-body italic mb-5">{agent.source}</p>
                    <div className="mt-auto flex flex-wrap gap-3">
                      <Link
                        to={agent.verticalLink}
                        className="inline-flex items-center gap-1.5 text-sm font-semibold text-teal hover:text-teal-hover"
                        onClick={() => trackVerticalEngagement(agent.slug, 'see_industry')}
                      >
                        Industry overview
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                      <Link
                        to="/demo"
                        className="inline-flex items-center gap-1.5 text-sm font-semibold text-harbor hover:text-harbor-light"
                        onClick={() => trackVerticalEngagement(agent.slug, 'try_demo')}
                      >
                        Try the demo
                        <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
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
                What's in every vertical agent
              </span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
                Six things you don't have to build yourself
              </h2>
            </div>
          </RevealSection>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-6xl mx-auto">
            {whatYouGet.map((item, i) => (
              <RevealSection key={item.title} delay={`scroll-delay-${(i % 3) + 1}`}>
                <div className="bg-mist rounded-2xl border border-soft-steel/30 p-6 h-full hover:shadow-lg transition-shadow">
                  <div className="w-10 h-10 rounded-lg bg-teal/10 flex items-center justify-center mb-4">
                    <item.icon className="h-5 w-5 text-teal" />
                  </div>
                  <h3 className="font-display text-base font-semibold text-harbor mb-1.5">{item.title}</h3>
                  <p className="text-sm text-slate-ink/65 leading-relaxed font-body">{item.desc}</p>
                </div>
              </RevealSection>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-mist">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-3">
                Get a vertical agent live
              </p>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
                Four steps from catalog to first live call
              </h2>
            </div>
          </RevealSection>
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-5 max-w-6xl mx-auto">
            {deploySteps.map((step) => (
              <RevealSection key={step.title}>
                <div className="bg-white rounded-2xl border border-soft-steel/30 p-6 h-full">
                  <div className="w-10 h-10 rounded-lg bg-harbor/10 flex items-center justify-center mb-4">
                    <step.icon className="h-5 w-5 text-harbor" />
                  </div>
                  <h3 className="font-display text-base font-semibold text-harbor mb-1.5">{step.title}</h3>
                  <p className="text-sm text-slate-ink/65 leading-relaxed font-body">{step.desc}</p>
                </div>
              </RevealSection>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-white">
        <div className="max-w-5xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="bg-harbor text-white rounded-2xl p-8 lg:p-12">
              <div className="flex flex-col lg:flex-row gap-8 items-start">
                <div className="lg:w-1/2">
                  <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-3">
                    Spotlight
                  </p>
                  <h2 className="font-display text-2xl lg:text-3xl font-bold mb-4">
                    Azul Vision: a native, vertical-deep agent
                  </h2>
                  <p className="text-base text-white/75 font-body leading-relaxed mb-5">
                    Azul Vision is an ophthalmology agent built by clinicians and ported to run
                    inside the QVO voice gateway — not a third-party agent forwarding events.
                    That means the QVO Voice AI runtime, tool engine, and PHI redaction apply
                    end-to-end to every call.
                  </p>
                  <ul className="space-y-2 text-sm text-white/85 font-body">
                    <li className="flex items-start gap-2"><CheckCircle2 className="h-4 w-4 text-teal shrink-0 mt-0.5" />Pre-op and post-op patient education calls</li>
                    <li className="flex items-start gap-2"><CheckCircle2 className="h-4 w-4 text-teal shrink-0 mt-0.5" />Surgical scheduling across multi-location ASCs</li>
                    <li className="flex items-start gap-2"><CheckCircle2 className="h-4 w-4 text-teal shrink-0 mt-0.5" />Triage for retina, glaucoma, and post-op concerns</li>
                  </ul>
                </div>
                <div className="lg:w-1/2 lg:pl-8 lg:border-l lg:border-white/10">
                  <h3 className="font-display text-base font-semibold text-white mb-4">Want a vertical-deep agent for your specialty?</h3>
                  <p className="text-sm text-white/70 font-body leading-relaxed mb-5">
                    QVO partners with vertical experts to ship native agents for new specialties.
                    If your team has the clinical or operational expertise and we have the
                    runtime, we can co-build a Vertical Agent for your domain.
                  </p>
                  <div className="flex flex-col sm:flex-row gap-3">
                    <Link
                      to="/contact"
                      className="inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-5 py-2.5 rounded-lg text-sm"
                      onClick={() => trackCTAClick('Partner with QVO', '/industries/vertical-agents', 'spotlight')}
                    >
                      Partner with QVO
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                    <Link
                      to="/product/federated-ingest"
                      className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 text-white font-semibold px-5 py-2.5 rounded-lg text-sm border border-white/10"
                    >
                      Or use Federated Ingest
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </RevealSection>
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
              Skip the blank prompt. Start with a vertical agent.
            </h2>
            <p className="text-lg text-white/65 font-body mb-10 max-w-xl mx-auto">
              Spin up an agent that already knows your vertical. Customize what's specific to your
              practice, leave the rest as defaults, and go live in days, not months.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                to="/signup"
                className="inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-8 py-3.5 rounded-xl transition-all text-sm shadow-lg shadow-teal/30"
                onClick={() => trackCTAClick('Start free trial', '/industries/vertical-agents', 'bottom-cta')}
              >
                Start free trial
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/use-cases"
                className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 backdrop-blur-sm text-white font-semibold px-8 py-3.5 rounded-xl transition-all text-sm border border-white/10"
                onClick={() => trackCTAClick('See use cases', '/industries/vertical-agents', 'bottom-cta')}
              >
                See use cases
              </Link>
            </div>
          </div>
        </RevealSection>
      </section>
    </div>
  );
}
