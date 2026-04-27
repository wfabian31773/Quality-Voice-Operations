import { Link } from 'react-router-dom';
import { useEffect } from 'react';
import {
  ArrowRight, Globe, BarChart3, ShieldCheck, Lock, EyeOff,
  TrendingUp, Users, Target, Sparkles, CheckCircle2, ToggleRight,
  Layers, Activity, GitBranch, Database, Award,
} from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';
import { trackPageView, trackCTAClick, trackFeatureView } from '../../lib/analytics';

const benchmarkExamples = [
  {
    vertical: 'Healthcare',
    metric: 'After-hours answer rate',
    you: '92%',
    median: '78%',
    topQuartile: '94%',
  },
  {
    vertical: 'Dental',
    metric: 'Booking conversion',
    you: '63%',
    median: '54%',
    topQuartile: '71%',
  },
  {
    vertical: 'Field service',
    metric: 'Dispatch acceptance time',
    you: '4m 12s',
    median: '7m 30s',
    topQuartile: '3m 10s',
  },
  {
    vertical: 'Real estate',
    metric: 'Lead-to-tour rate',
    you: '38%',
    median: '29%',
    topQuartile: '46%',
  },
];

const valueProps = [
  {
    icon: Globe,
    title: 'See where you stand',
    desc: 'Compare your agents’ answer rate, conversion, dispatch latency, no-show rate, and quality scores against an anonymized cohort of QVO tenants in the same vertical and size band.',
  },
  {
    icon: TrendingUp,
    title: 'Learn from the top quartile',
    desc: 'When peer top performers crush a metric you struggle on, GIN surfaces concrete prompt and configuration patterns the cohort uses — never their identities.',
  },
  {
    icon: Sparkles,
    title: 'Power the evolution engine',
    desc: 'GIN feeds the closed-loop prompt evolver: it proposes prompt changes that have measurably moved the needle elsewhere in your vertical, then A/B tests them on your traffic before promoting.',
  },
];

const howItWorks = [
  {
    icon: ToggleRight,
    title: 'Opt in per workspace',
    desc: 'GIN is opt-in by default. Toggle it on from Governance → Global Intelligence. You can opt out at any time and your data is removed from future cohorts.',
  },
  {
    icon: EyeOff,
    title: 'k-anonymous aggregation',
    desc: 'Metrics are bucketed by vertical and tenant size. Cohorts always contain at least k tenants — your numbers are never identifiable, even by inference.',
  },
  {
    icon: Lock,
    title: 'No transcripts ever leave',
    desc: 'Only numeric metrics, structured tags, and prompt-shape fingerprints contribute to GIN. Raw transcripts, PHI, and customer identifiers stay inside your tenant.',
  },
  {
    icon: Activity,
    title: 'Refreshed on a rolling window',
    desc: 'Cohort baselines update on a daily rolling window so the benchmark you compare against reflects current behavior, not last quarter.',
  },
];

const benefits = [
  { icon: BarChart3, label: 'Vertical-aware benchmarks', desc: 'Healthcare, dental, legal, real estate, home services, hospitality.' },
  { icon: Award, label: 'Quartile rankings', desc: 'Where do you sit on each metric — bottom, middle, top?' },
  { icon: Target, label: 'Improvement targets', desc: 'See how much lift would move you up a quartile, with effort estimates.' },
  { icon: GitBranch, label: 'Prompt-pattern hints', desc: 'Patterns top quartile peers use, never their wording or identity.' },
  { icon: Users, label: 'Cohort matching', desc: 'Compared against tenants in your vertical and call-volume tier — not the whole network.' },
  { icon: Database, label: 'Source-of-truth metrics', desc: 'Pulled from the same warehouse that powers your tenant analytics — no duplicate definitions.' },
];

const privacyControls = [
  'Opt-in only — disabled by default for new workspaces.',
  'Opt out at any time; your data is excluded from the next refresh and dropped from cached cohorts within 24 hours.',
  'Per-vertical, per-size cohorts must contain at least k tenants before a benchmark renders. Below k, the chart is suppressed.',
  'Only aggregate metrics, prompt-shape fingerprints, and tagged outcomes contribute. Raw transcripts and identifiers never leave your tenant.',
  'Audit log records every GIN read, every opt-in/opt-out, and every prompt suggestion accepted from a peer cohort.',
  'GIN data is excluded from your DSAR exports because it never contained personal data — but the audit log entries are included.',
];

export default function GlobalIntelligenceNetwork() {
  useEffect(() => {
    trackPageView('/product/global-intelligence-network');
  }, []);

  return (
    <div>
      <SEO
        title="Global Intelligence Network — Cross-tenant Voice Benchmarks"
        description="The Global Intelligence Network (GIN) gives QVO tenants opt-in, anonymized benchmarks against vertical peers, and feeds the evolution engine with prompt patterns that demonstrably move the needle."
        canonicalPath="/product/global-intelligence-network"
      />

      <section className="bg-harbor text-white py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-4">
              Global Intelligence Network
            </p>
            <h1 className="font-display text-4xl lg:text-5xl font-bold leading-tight mb-6">
              Benchmark your voice operations against the rest of your industry — without sharing a single transcript.
            </h1>
            <p className="text-lg text-white/70 leading-relaxed font-body max-w-2xl mb-8">
              GIN is QVO's opt-in cross-tenant benchmark layer. See where your answer rate,
              booking conversion, dispatch latency, and quality scores sit against an anonymized
              cohort of peers in your vertical — and pull in the prompt patterns that put the top
              quartile ahead of you.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link
                to="/book-demo"
                className="inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-7 py-3.5 rounded-xl transition-all text-sm shadow-lg shadow-teal/25"
                onClick={() => trackCTAClick('See GIN in a demo', '/product/global-intelligence-network', 'hero')}
              >
                See GIN in a demo
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/security"
                className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 backdrop-blur-sm text-white font-semibold px-7 py-3.5 rounded-xl transition-all text-sm border border-white/10"
                onClick={() => trackCTAClick('Read the privacy model', '/product/global-intelligence-network', 'hero')}
              >
                Read the privacy model
              </Link>
            </div>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-white/60">
              <span className="inline-flex items-center gap-2"><ToggleRight className="h-4 w-4 text-teal" />Opt-in only</span>
              <span className="inline-flex items-center gap-2"><EyeOff className="h-4 w-4 text-teal" />k-anonymous cohorts</span>
              <span className="inline-flex items-center gap-2"><Lock className="h-4 w-4 text-teal" />Transcripts never leave your tenant</span>
            </div>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-mist">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
                What a GIN benchmark looks like
              </h2>
              <p className="text-lg text-slate-ink/60 font-body max-w-2xl mx-auto">
                Sample comparisons from the live network. Numbers update on a daily rolling window
                so you're always comparing against current behavior.
              </p>
            </div>
          </RevealSection>

          <RevealSection>
            <div className="max-w-5xl mx-auto bg-white rounded-2xl border border-soft-steel/30 overflow-hidden shadow-sm">
              <div className="grid grid-cols-12 gap-2 px-6 py-4 border-b border-soft-steel/20 bg-mist/50 text-xs font-semibold uppercase tracking-wide text-slate-ink/55 font-display">
                <div className="col-span-3">Vertical</div>
                <div className="col-span-4">Metric</div>
                <div className="col-span-2 text-right">You</div>
                <div className="col-span-2 text-right">Median</div>
                <div className="col-span-1 text-right">Top 25%</div>
              </div>
              {benchmarkExamples.map((row) => (
                <div key={`${row.vertical}-${row.metric}`} className="grid grid-cols-12 gap-2 px-6 py-4 border-b last:border-b-0 border-soft-steel/20 items-center text-sm font-body">
                  <div className="col-span-3 font-display text-harbor font-semibold">{row.vertical}</div>
                  <div className="col-span-4 text-slate-ink/70">{row.metric}</div>
                  <div className="col-span-2 text-right font-mono font-semibold text-teal">{row.you}</div>
                  <div className="col-span-2 text-right font-mono text-slate-ink/55">{row.median}</div>
                  <div className="col-span-1 text-right font-mono text-calm-green">{row.topQuartile}</div>
                </div>
              ))}
              <div className="px-6 py-3 bg-mist/40 text-xs text-slate-ink/50 font-body italic">
                Cohorts shown only when ≥ k tenants of comparable size are participating.
              </div>
            </div>
          </RevealSection>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-white">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-3">
                Why teams turn it on
              </p>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
                A learning loop, not a leaderboard
              </h2>
            </div>
          </RevealSection>
          <div className="grid md:grid-cols-3 gap-6 max-w-6xl mx-auto">
            {valueProps.map((prop, i) => (
              <RevealSection key={prop.title} delay={`scroll-delay-${(i % 3) + 1}`}>
                <div
                  className="bg-mist rounded-2xl border border-soft-steel/30 p-7 h-full hover:shadow-lg transition-shadow"
                  onMouseEnter={() => trackFeatureView(`gin:${prop.title}`)}
                >
                  <div className="w-11 h-11 rounded-xl bg-teal/10 flex items-center justify-center mb-4">
                    <prop.icon className="h-5 w-5 text-teal" />
                  </div>
                  <h3 className="font-display text-lg font-semibold text-harbor mb-2">{prop.title}</h3>
                  <p className="text-sm text-slate-ink/65 leading-relaxed font-body">{prop.desc}</p>
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
              <span className="inline-block text-sm font-semibold text-teal bg-teal/10 px-4 py-1.5 rounded-full mb-4">
                How it works
              </span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
                Privacy-first by construction
              </h2>
              <p className="text-lg text-slate-ink/60 font-body max-w-2xl mx-auto">
                GIN was designed to make sharing safe so that sharing happens. The defaults err on
                the side of suppression, not exposure.
              </p>
            </div>
          </RevealSection>
          <div className="grid md:grid-cols-2 gap-6 max-w-5xl mx-auto">
            {howItWorks.map((step, i) => (
              <RevealSection key={step.title} delay={`scroll-delay-${(i % 3) + 1}`}>
                <div className="bg-white rounded-2xl border border-soft-steel/30 p-6 flex gap-4 h-full">
                  <div className="w-10 h-10 rounded-lg bg-harbor/10 flex items-center justify-center shrink-0">
                    <step.icon className="h-5 w-5 text-harbor" />
                  </div>
                  <div>
                    <h3 className="font-display text-base font-semibold text-harbor mb-1.5">{step.title}</h3>
                    <p className="text-sm text-slate-ink/65 leading-relaxed font-body">{step.desc}</p>
                  </div>
                </div>
              </RevealSection>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-white">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="grid lg:grid-cols-2 gap-12 items-start max-w-6xl mx-auto">
            <RevealSection>
              <div>
                <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-3">
                  In your control plane
                </p>
                <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-6">
                  Six things you'll see in Governance → Global Intelligence
                </h2>
                <div className="space-y-3">
                  {benefits.map((b) => (
                    <div key={b.label} className="flex items-start gap-3 bg-mist rounded-xl border border-soft-steel/30 px-4 py-3">
                      <div className="w-9 h-9 rounded-lg bg-teal/10 flex items-center justify-center shrink-0">
                        <b.icon className="h-4.5 w-4.5 text-teal" />
                      </div>
                      <div>
                        <h3 className="font-display text-sm font-semibold text-harbor">{b.label}</h3>
                        <p className="text-xs text-slate-ink/60 font-body leading-relaxed">{b.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </RevealSection>

            <RevealSection>
              <div className="bg-harbor rounded-2xl p-8 lg:p-10 text-white">
                <div className="flex items-center gap-3 mb-3">
                  <ShieldCheck className="h-5 w-5 text-teal" />
                  <p className="font-display text-sm font-semibold tracking-wide uppercase text-teal">
                    Privacy controls
                  </p>
                </div>
                <h3 className="font-display text-xl font-bold mb-5">Built for buyers who say "no" to data sharing</h3>
                <ul className="space-y-3">
                  {privacyControls.map((line) => (
                    <li key={line} className="flex items-start gap-2.5 text-sm text-white/80 font-body leading-relaxed">
                      <CheckCircle2 className="h-4 w-4 text-teal shrink-0 mt-0.5" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-6 pt-6 border-t border-white/10 flex flex-wrap gap-3">
                  <Link
                    to="/security"
                    className="inline-flex items-center gap-2 bg-white/10 hover:bg-white/15 text-white font-semibold px-5 py-2.5 rounded-lg text-sm border border-white/10"
                  >
                    Security overview
                  </Link>
                  <Link
                    to="/privacy"
                    className="inline-flex items-center gap-2 bg-white/10 hover:bg-white/15 text-white font-semibold px-5 py-2.5 rounded-lg text-sm border border-white/10"
                  >
                    Privacy policy
                  </Link>
                </div>
              </div>
            </RevealSection>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-mist">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="max-w-4xl mx-auto bg-white rounded-2xl border border-soft-steel/30 p-8 lg:p-12 text-center">
              <Layers className="h-9 w-9 text-teal mx-auto mb-5" />
              <h2 className="font-display text-2xl lg:text-3xl font-bold text-harbor mb-4">
                The evolution engine, but smarter
              </h2>
              <p className="text-base text-slate-ink/65 font-body leading-relaxed mb-6 max-w-2xl mx-auto">
                On its own, the QVO evolution engine A/B tests prompt revisions on your traffic.
                With GIN turned on, it starts those experiments from a candidate set already shown
                to lift conversion or quality elsewhere in your vertical — so you skip the
                exploration step and head straight for the gains.
              </p>
              <Link
                to="/features"
                className="inline-flex items-center gap-2 text-teal hover:text-teal-hover font-semibold text-sm"
                onClick={() => trackCTAClick('Explore the platform', '/product/global-intelligence-network', 'mid-cta')}
              >
                Explore the platform
                <ArrowRight className="h-4 w-4" />
              </Link>
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
              Want to see your numbers in context?
            </h2>
            <p className="text-lg text-white/65 font-body mb-10 max-w-xl mx-auto">
              Book a demo and we'll walk you through a sample GIN benchmark for your vertical — and
              show you exactly what gets shared (and what never does).
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                to="/book-demo"
                className="inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-8 py-3.5 rounded-xl transition-all text-sm shadow-lg shadow-teal/30"
                onClick={() => trackCTAClick('Book a demo', '/product/global-intelligence-network', 'bottom-cta')}
              >
                Book a demo
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/signup"
                className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 backdrop-blur-sm text-white font-semibold px-8 py-3.5 rounded-xl transition-all text-sm border border-white/10"
                onClick={() => trackCTAClick('Start free trial', '/product/global-intelligence-network', 'bottom-cta')}
              >
                Start free trial
              </Link>
            </div>
          </div>
        </RevealSection>
      </section>
    </div>
  );
}
