import { Link } from 'react-router-dom';
import { useEffect } from 'react';
import {
  ArrowRight, Code2, Server, Webhook, ShieldCheck, KeyRound, Activity,
  Layers, Database, BarChart3, Plug, Workflow, RefreshCw, Lock,
  CheckCircle2, GitBranch, AlertTriangle, Zap,
} from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';
import { trackPageView, trackCTAClick, trackFeatureView } from '../../lib/analytics';

const useCases = [
  {
    icon: Server,
    title: 'Run your own voice stack',
    desc: 'You operate a custom voice agent (proprietary STT/TTS, in-house orchestration, on-prem GPU). Post call sessions and events into QVO and inherit the analytics, billing, ticketing, and dispatch layers without rewriting anything.',
  },
  {
    icon: Layers,
    title: 'Bring partner agents under one roof',
    desc: 'Shipping a vertical voice agent to your customers? Forward call data through QVO ingest so each customer sees a unified inbox alongside any other QVO-native agents they run.',
  },
  {
    icon: Workflow,
    title: 'Bridge legacy IVRs into AI',
    desc: 'Stream events from an existing contact-center platform so QVO can score quality, surface evolution suggestions, and roll metrics up to the same dashboards as new AI traffic.',
  },
];

const ingestSteps = [
  {
    icon: KeyRound,
    title: 'Mint a federated API key',
    desc: 'Each external agent gets a tenant-scoped key from the developer portal. Keys are revocable, scoped to /ingest/* only, and rotate on demand.',
  },
  {
    icon: Webhook,
    title: 'POST events to /ingest/*',
    desc: 'Send call sessions, transcripts, tool calls, and outcome metadata. Idempotency keys are derived from (tenant_id, external_id) so retries are safe.',
  },
  {
    icon: Database,
    title: 'Inherit the QVO data model',
    desc: 'Ingested calls flow into the same call_session, transcript, and usage tables as native QVO calls — so analytics, exports, and Stripe metering “just work.”',
  },
  {
    icon: BarChart3,
    title: 'Plug into the rest of the platform',
    desc: 'External calls show up in dashboards, Quality scoring, the ticket system, dispatch handoffs, GIN benchmarks, and the evolution engine alongside native traffic.',
  },
];

const sampleRequest = `POST /ingest/calls HTTP/1.1
Host: api.qvo.ai
Authorization: Bearer qvo_fed_live_***
Content-Type: application/json
Idempotency-Key: ext_call_8f02a7c1

{
  "external_id": "ext_call_8f02a7c1",
  "agent_external_id": "azul-vision-intake-v3",
  "phone_number": "+15551234567",
  "direction": "inbound",
  "started_at": "2026-04-27T15:08:11Z",
  "ended_at":   "2026-04-27T15:11:42Z",
  "outcome": "appointment_booked",
  "transcript": [
    { "role": "assistant", "text": "Thanks for calling Lakeside Eye Care..." },
    { "role": "user",      "text": "I need to reschedule my Friday appointment." }
  ],
  "tool_calls": [
    { "name": "scheduling.reschedule", "args": { "patient_id": "p_4521" }, "ok": true }
  ],
  "metadata": { "vertical": "ophthalmology", "language": "en-US" }
}`;

const platformBenefits = [
  {
    icon: BarChart3,
    title: 'Unified analytics',
    desc: 'External calls roll into the same volume, conversion, and quality charts as native QVO calls. No second dashboard to maintain.',
  },
  {
    icon: Activity,
    title: 'Quality scoring out of the box',
    desc: 'Every ingested transcript is scored by the QVO QA engine. Compare your prompt revisions A/B against your peers in the same vertical.',
  },
  {
    icon: GitBranch,
    title: 'Evolution engine suggestions',
    desc: 'QVO mines ingested transcripts for prompt improvements and surfaces them as proposed changes for your team to accept or reject.',
  },
  {
    icon: Plug,
    title: 'One billing surface',
    desc: 'Federated minutes meter through Stripe alongside native usage. Customers get a single invoice, however the calls were delivered.',
  },
  {
    icon: Zap,
    title: 'Tool execution bridge',
    desc: 'Hand off from your agent to QVO-managed tools (scheduling, ticketing, SMS, dispatch) in mid-call without round-tripping the customer.',
  },
  {
    icon: ShieldCheck,
    title: 'Compliance inheritance',
    desc: 'Tenant RLS, audit log, PHI redaction in transcripts, and DSAR exports cover ingested data the same way they cover native calls.',
  },
];

const security = [
  {
    icon: KeyRound,
    title: 'Tenant-scoped API keys',
    desc: 'Federated keys are bound to a single tenant at issuance and cannot be reused across tenants — even if leaked.',
  },
  {
    icon: RefreshCw,
    title: 'Revocable + rotation reminders',
    desc: 'Keys can be revoked instantly from the developer portal. Rotation reminders surface in the audit log every 90 days.',
  },
  {
    icon: Lock,
    title: 'Idempotency built in',
    desc: 'Idempotency keys on (tenant_id, external_id) make safe retries the default — partial writes never produce duplicate calls.',
  },
  {
    icon: AlertTriangle,
    title: 'Backfill window guardrails',
    desc: 'Events accept an `occurred_at` window so out-of-order or replayed traffic is rejected at the edge instead of silently mutating history.',
  },
];

export default function FederatedIngest() {
  useEffect(() => {
    trackPageView('/product/federated-ingest');
  }, []);

  return (
    <div>
      <SEO
        title="Federated Ingest — Bring Your Own Voice Agent"
        description="Federated Ingest lets external voice agents post calls, transcripts, and tool events into QVO over a simple HTTPS API — and inherit analytics, quality scoring, billing, and tool execution."
        canonicalPath="/product/federated-ingest"
      />

      <section className="bg-harbor text-white py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-4">
              For developers and platform partners
            </p>
            <h1 className="font-display text-4xl lg:text-5xl font-bold leading-tight mb-6">
              Federated Ingest. Bring your own voice agent — keep one operations surface.
            </h1>
            <p className="text-lg text-white/70 leading-relaxed font-body max-w-2xl mb-8">
              Run any voice agent — proprietary, partner-built, or a legacy IVR — and forward its
              calls into QVO over a simple HTTPS API. Inherit analytics, quality scoring, billing,
              the tool execution engine, and the rest of the platform, without rebuilding anything
              you already shipped.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link
                to="/docs/api-overview"
                className="inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-7 py-3.5 rounded-xl transition-all text-sm shadow-lg shadow-teal/25"
                onClick={() => trackCTAClick('Read the API docs', '/product/federated-ingest', 'hero')}
              >
                Read the API docs
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/contact"
                className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 backdrop-blur-sm text-white font-semibold px-7 py-3.5 rounded-xl transition-all text-sm border border-white/10"
                onClick={() => trackCTAClick('Talk to a platform engineer', '/product/federated-ingest', 'hero')}
              >
                Talk to a platform engineer
              </Link>
            </div>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-white/60">
              <span className="inline-flex items-center gap-2"><Code2 className="h-4 w-4 text-teal" />Single HTTPS endpoint</span>
              <span className="inline-flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-teal" />Tenant-scoped API keys</span>
              <span className="inline-flex items-center gap-2"><RefreshCw className="h-4 w-4 text-teal" />Idempotent retries</span>
            </div>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-mist">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
                Three reasons teams use Federated Ingest
              </h2>
              <p className="text-lg text-slate-ink/60 font-body max-w-2xl mx-auto">
                You already built a voice agent — or bought one — and the last thing you want is to
                rip it out. Ingest plugs your existing stack into the QVO operations layer.
              </p>
            </div>
          </RevealSection>
          <div className="grid md:grid-cols-3 gap-6 max-w-6xl mx-auto">
            {useCases.map((useCase, i) => (
              <RevealSection key={useCase.title} delay={`scroll-delay-${(i % 3) + 1}`}>
                <div
                  className="bg-white rounded-2xl border border-soft-steel/30 p-7 h-full hover:shadow-lg transition-shadow"
                  onMouseEnter={() => trackFeatureView(`federated-ingest:${useCase.title}`)}
                >
                  <div className="w-11 h-11 rounded-xl bg-teal/10 flex items-center justify-center mb-4">
                    <useCase.icon className="h-5 w-5 text-teal" />
                  </div>
                  <h3 className="font-display text-lg font-semibold text-harbor mb-2">{useCase.title}</h3>
                  <p className="text-sm text-slate-ink/60 leading-relaxed font-body">{useCase.desc}</p>
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
              <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-3">
                How it works
              </p>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
                Four steps from external call to unified operations
              </h2>
            </div>
          </RevealSection>

          <div className="grid lg:grid-cols-2 gap-12 items-start max-w-6xl mx-auto">
            <div className="space-y-6">
              {ingestSteps.map((step, i) => (
                <RevealSection key={step.title} delay={`scroll-delay-${(i % 3) + 1}`}>
                  <div className="bg-mist rounded-2xl border border-soft-steel/30 p-6 flex gap-4">
                    <div className="w-10 h-10 rounded-lg bg-harbor/10 flex items-center justify-center shrink-0">
                      <step.icon className="h-5 w-5 text-harbor" />
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-teal mb-1">Step {i + 1}</p>
                      <h3 className="font-display text-lg font-semibold text-harbor mb-1.5">{step.title}</h3>
                      <p className="text-sm text-slate-ink/65 leading-relaxed font-body">{step.desc}</p>
                    </div>
                  </div>
                </RevealSection>
              ))}
            </div>

            <RevealSection>
              <div className="bg-harbor rounded-2xl border border-harbor-light/40 overflow-hidden shadow-lg">
                <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
                  <div className="flex items-center gap-2 text-white/60 text-xs font-mono">
                    <Code2 className="h-3.5 w-3.5" />
                    POST /ingest/calls
                  </div>
                  <div className="flex gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-white/20" />
                    <span className="w-2.5 h-2.5 rounded-full bg-white/20" />
                    <span className="w-2.5 h-2.5 rounded-full bg-white/20" />
                  </div>
                </div>
                <pre className="px-5 py-5 text-xs leading-relaxed text-white/85 font-mono overflow-x-auto">
{sampleRequest}
                </pre>
              </div>
              <p className="text-xs text-slate-ink/50 mt-3 font-body text-center">
                One POST per call. Idempotency keys make retries safe by default.
              </p>
            </RevealSection>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-mist">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <span className="inline-block text-sm font-semibold text-teal bg-teal/10 px-4 py-1.5 rounded-full mb-4">
                What you inherit
              </span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
                The whole QVO platform — without writing a second integration
              </h2>
              <p className="text-lg text-slate-ink/60 font-body max-w-2xl mx-auto">
                Federated calls become first-class citizens. Every product surface treats them
                exactly like a call routed through QVO's voice gateway.
              </p>
            </div>
          </RevealSection>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-6xl mx-auto">
            {platformBenefits.map((benefit, i) => (
              <RevealSection key={benefit.title} delay={`scroll-delay-${(i % 3) + 1}`}>
                <div className="bg-white rounded-2xl border border-soft-steel/30 p-6 h-full hover:shadow-lg transition-shadow">
                  <div className="w-10 h-10 rounded-lg bg-teal/10 flex items-center justify-center mb-4">
                    <benefit.icon className="h-5 w-5 text-teal" />
                  </div>
                  <h3 className="font-display text-base font-semibold text-harbor mb-1.5">{benefit.title}</h3>
                  <p className="text-sm text-slate-ink/65 leading-relaxed font-body">{benefit.desc}</p>
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
              <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-3">
                Built for serious traffic
              </p>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
                Security, idempotency, and rotation built into the protocol
              </h2>
            </div>
          </RevealSection>
          <div className="grid md:grid-cols-2 gap-6 max-w-5xl mx-auto">
            {security.map((item) => (
              <RevealSection key={item.title}>
                <div className="bg-mist rounded-2xl border border-soft-steel/30 p-6 flex gap-4 h-full">
                  <div className="w-10 h-10 rounded-lg bg-controlled-red/10 flex items-center justify-center shrink-0">
                    <item.icon className="h-5 w-5 text-controlled-red" />
                  </div>
                  <div>
                    <h3 className="font-display text-base font-semibold text-harbor mb-1.5">{item.title}</h3>
                    <p className="text-sm text-slate-ink/65 leading-relaxed font-body">{item.desc}</p>
                  </div>
                </div>
              </RevealSection>
            ))}
          </div>

          <RevealSection>
            <div className="max-w-4xl mx-auto mt-12 bg-harbor rounded-2xl p-8 lg:p-10 text-white">
              <div className="flex items-center gap-3 mb-3">
                <CheckCircle2 className="h-5 w-5 text-teal" />
                <p className="font-display text-sm font-semibold tracking-wide uppercase text-teal">
                  Compliance status
                </p>
              </div>
              <p className="font-display text-xl text-white/90 leading-relaxed mb-2">
                Federated ingest inherits the same SOC 2 controls, audit log coverage, RLS
                isolation, and DSAR exports as native QVO traffic.
              </p>
              <p className="text-sm text-white/60 font-body">
                Have additional vertical requirements (HIPAA BAA, regional residency)? Our security
                team will scope it during onboarding.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Link
                  to="/security"
                  className="inline-flex items-center gap-2 bg-white/10 hover:bg-white/15 text-white font-semibold px-5 py-2.5 rounded-lg text-sm border border-white/10"
                >
                  Security overview
                </Link>
                <Link
                  to="/security/posture"
                  className="inline-flex items-center gap-2 bg-white/10 hover:bg-white/15 text-white font-semibold px-5 py-2.5 rounded-lg text-sm border border-white/10"
                >
                  Live security posture
                </Link>
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
              Ready to wire your agent into QVO?
            </h2>
            <p className="text-lg text-white/65 font-body mb-10 max-w-xl mx-auto">
              Mint a federated key, post your first call, and watch it land in the same dashboards
              as the rest of your operations — usually in under an afternoon.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                to="/docs/api-overview"
                className="inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-8 py-3.5 rounded-xl transition-all text-sm shadow-lg shadow-teal/30"
                onClick={() => trackCTAClick('Read the API docs', '/product/federated-ingest', 'bottom-cta')}
              >
                Read the API docs
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/book-demo"
                className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 backdrop-blur-sm text-white font-semibold px-8 py-3.5 rounded-xl transition-all text-sm border border-white/10"
                onClick={() => trackCTAClick('Book a platform demo', '/product/federated-ingest', 'bottom-cta')}
              >
                Book a platform demo
              </Link>
            </div>
          </div>
        </RevealSection>
      </section>
    </div>
  );
}
