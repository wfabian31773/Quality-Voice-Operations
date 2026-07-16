import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  CircleDot,
  Clock3,
  Languages,
  MessageSquareText,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Workflow,
} from 'lucide-react';
import SEO from '../components/SEO';
import HealthcareOutcomeCard from '../components/HealthcareOutcomeCard';
import {
  captureUtmOnLoad,
  trackCTAClick,
  trackConversionEvent,
  trackDemoInteraction,
  trackPageView,
} from '../lib/analytics';
import { CTA } from '../lib/analyticsCtas';
import { CONVERSION_STAGE } from '../lib/analyticsLabels';
import type {
  HealthcareDemoResult,
  HealthcareDemoScenarioKind,
  HealthcareDemoSignal,
} from '../../../shared/demo/healthcareDemo';

const SCENARIOS: Record<HealthcareDemoScenarioKind, {
  title: string;
  description: string;
  proof: string;
}> = {
  appointment_request: {
    title: 'Appointment request',
    description: 'A caller begins in Spanish, interrupts, switches to English, and asks staff to arrange an annual exam.',
    proof: 'Language, turn-taking, memory, tenant time, tool use',
  },
  safe_escalation: {
    title: 'Safe escalation',
    description: 'A caller reports a possible emergency. The agent holds the clinical boundary and creates human follow-up.',
    proof: 'Safety, truthful limits, emergency direction, escalation',
  },
};

const SIGNAL_LABELS: Partial<Record<HealthcareDemoSignal, string>> = {
  language_change: 'Language changed',
  caller_interruption: 'Interruption detected',
  memory_retained: 'Memory retained',
  current_time: 'Current time grounded',
  tool_confirmed: 'Tool confirmed',
  safety_boundary: 'Safety boundary',
  human_escalation: 'Human escalation',
};

function ScenarioButton({
  scenario,
  selected,
  onSelect,
}: {
  scenario: HealthcareDemoScenarioKind;
  selected: boolean;
  onSelect: (scenario: HealthcareDemoScenarioKind) => void;
}) {
  const content = SCENARIOS[scenario];
  const Icon = scenario === 'appointment_request' ? Languages : ShieldCheck;
  return (
    <button
      type="button"
      onClick={() => onSelect(scenario)}
      aria-pressed={selected}
      className={`group w-full rounded-2xl border p-5 text-left transition-all duration-200 ${
        selected
          ? 'border-primary bg-primary-light shadow-sm ring-1 ring-primary/20'
          : 'border-border bg-surface hover:border-primary/40 hover:bg-surface-hover'
      }`}
    >
      <span className="flex items-start gap-4">
        <span className={`rounded-xl p-2.5 ${selected ? 'bg-primary text-white' : 'bg-surface-hover text-text-secondary group-hover:text-primary'}`}>
          <Icon className="h-5 w-5" aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-3">
            <span className="font-display text-base font-semibold text-heading">{content.title}</span>
            <CircleDot className={`h-4 w-4 ${selected ? 'text-primary' : 'text-border-strong'}`} aria-hidden="true" />
          </span>
          <span className="mt-1.5 block text-sm leading-6 text-text-secondary">{content.description}</span>
          <span className="mt-3 block text-xs font-medium uppercase tracking-[0.12em] text-text-muted">{content.proof}</span>
        </span>
      </span>
    </button>
  );
}

function WorkflowResult({ result }: { result: HealthcareDemoResult }) {
  const isAppointment = result.scenario === 'appointment_request';
  return (
    <div className="mt-10 space-y-6" aria-live="polite">
      <div className="grid gap-6">
        <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-sidebar-bg px-5 py-4 text-white">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Conversation trace</p>
              <h2 className="mt-1 font-display text-lg font-semibold">{isAppointment ? 'Spanish → English' : 'Safety-first English'}</h2>
            </div>
            <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs text-white/75">Deterministic replay</span>
          </div>
          <ol className="divide-y divide-border px-5">
            {result.transcript.map((line) => (
              <li key={line.id} className="grid gap-2 py-4 sm:grid-cols-[7.5rem_minmax(0,1fr)]">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-text-muted">
                  <span className={`h-2 w-2 rounded-full ${line.speaker === 'assistant' ? 'bg-primary' : 'bg-harbor'}`} />
                  {line.speaker === 'assistant' ? 'Receptionist' : 'Caller'} · {line.language.toUpperCase()}
                </div>
                <div>
                  <p className="text-sm leading-6 text-text-primary">{line.text}</p>
                  {line.signal && SIGNAL_LABELS[line.signal] && (
                    <span className="mt-2 inline-flex rounded-full bg-surface-hover px-2.5 py-1 text-[11px] font-medium text-text-secondary">
                      {SIGNAL_LABELS[line.signal]}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="rounded-2xl border border-border bg-[#f6f4ee] p-5 shadow-sm">
          <div className="flex items-center gap-3">
            <span className="rounded-xl bg-heading p-2.5 text-white"><Workflow className="h-5 w-5" aria-hidden="true" /></span>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-text-muted">Execution evidence</p>
              <h2 className="font-display text-lg font-semibold text-heading">One core, one production path</h2>
            </div>
          </div>
          <ol className="relative mt-6 space-y-5 border-l border-border-strong/40 pl-6">
            {result.timeline.map((step) => (
              <li key={step.id} className="relative">
                <span className="absolute -left-[1.91rem] top-0.5 grid h-4 w-4 place-items-center rounded-full bg-primary text-white ring-4 ring-[#f6f4ee]">
                  <Check className="h-2.5 w-2.5" aria-hidden="true" />
                </span>
                <p className="text-sm font-semibold text-heading">{step.label}</p>
                <p className="mt-1 text-sm leading-5 text-text-secondary">{step.detail}</p>
              </li>
            ))}
          </ol>
          <div className="mt-6 rounded-xl border border-primary/20 bg-white p-4">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary">Production tool contract confirmed</p>
            <p className="mt-1 font-mono text-sm text-heading">createServiceTicket → success</p>
            <p className="mt-2 text-xs leading-5 text-text-secondary">{result.tool.confirmationMessage}</p>
          </div>
        </section>
      </div>

      <HealthcareOutcomeCard projection={result.projection} showTicketLink={false} />
    </div>
  );
}

export default function Demo() {
  const [scenario, setScenario] = useState<HealthcareDemoScenarioKind>('appointment_request');
  const [result, setResult] = useState<HealthcareDemoResult | null>(null);
  const [status, setStatus] = useState<'idle' | 'running' | 'error'>('idle');

  useEffect(() => {
    captureUtmOnLoad();
    trackPageView('/demo');
    trackConversionEvent(CONVERSION_STAGE.DEMO_STARTED, '/demo');
  }, []);

  const selectScenario = (next: HealthcareDemoScenarioKind) => {
    setScenario(next);
    setResult(null);
    setStatus('idle');
    trackDemoInteraction('scenario_selected', next);
  };

  const runScenario = async () => {
    setStatus('running');
    setResult(null);
    trackDemoInteraction('workflow_started', scenario);
    try {
      const response = await fetch('/api/demo/healthcare/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario }),
      });
      if (!response.ok) throw new Error('Guided workflow unavailable');
      const workflowResult = await response.json() as HealthcareDemoResult;
      setResult(workflowResult);
      setStatus('idle');
      trackConversionEvent(CONVERSION_STAGE.DEMO_COMPLETED, '/demo', { scenario });
    } catch {
      setStatus('error');
    }
  };

  const reset = () => {
    setResult(null);
    setStatus('idle');
    trackDemoInteraction('workflow_reset', scenario);
  };

  const runLabel = scenario === 'appointment_request'
    ? 'Run appointment workflow'
    : 'Run safe escalation';

  return (
    <div className="min-h-screen bg-background">
      <SEO
        title="Healthcare AI Receptionist Demo | Quality Voice Operations"
        description="Follow one bounded healthcare receptionist workflow from multilingual conversation to a staff-ready outcome."
        canonicalPath="/demo"
      />

      <section className="relative overflow-hidden bg-sidebar-bg text-white">
        <div className="absolute inset-0 opacity-30" aria-hidden="true">
          <div className="absolute -right-24 -top-32 h-[30rem] w-[30rem] rounded-full bg-primary/30 blur-3xl" />
          <div className="absolute -bottom-40 left-1/4 h-[26rem] w-[26rem] rounded-full bg-harbor/20 blur-3xl" />
          <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.025)_1px,transparent_1px)] bg-[size:48px_48px]" />
        </div>
        <div className="relative mx-auto grid max-w-7xl gap-10 px-6 py-16 lg:grid-cols-[minmax(0,1fr)_25rem] lg:px-8 lg:py-24">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/30 bg-primary/10 px-3 py-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" /> Guided healthcare proof
            </div>
            <h1 className="mt-7 max-w-4xl font-display text-4xl font-semibold tracking-[-0.035em] text-white sm:text-5xl lg:text-6xl">
              One call. One staff-ready outcome.
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-white/70">
              Watch the locked Master Voice Agent take turns, change languages, retain context, use clinic-local time, and invoke a real production tool contract—then see exactly what staff receive.
            </p>
            <div className="mt-8 flex flex-wrap gap-2">
              <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/75">Master Voice Agent 1.0.0</span>
              <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/75">Healthcare Receptionist 1.0.0</span>
              <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/75">Production tool contract</span>
            </div>
          </div>

          <aside className="self-end rounded-2xl border border-white/10 bg-white/[0.055] p-5 backdrop-blur-sm">
            <div className="flex items-center gap-3">
              <span className="rounded-xl bg-primary/15 p-2.5 text-primary"><MessageSquareText className="h-5 w-5" aria-hidden="true" /></span>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-white/45">Evidence boundary</p>
                <p className="mt-0.5 font-display font-semibold">Guided, truthful, inspectable</p>
              </div>
            </div>
            <p className="mt-4 text-sm leading-6 text-white/65">
              Guided workflow using production contracts—not a live phone call. Real credentialed audio and carrier proof remain a separate launch gate.
            </p>
          </aside>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-6 py-12 lg:px-8 lg:py-16">
        <div className="grid gap-8 lg:grid-cols-[22rem_minmax(0,1fr)]">
          <section>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Choose the proof</p>
            <h2 className="mt-2 font-display text-2xl font-semibold tracking-tight text-heading">Same agent. Different operational pressure.</h2>
            <p className="mt-3 text-sm leading-6 text-text-secondary">The prompt and scenario change. The Master Voice Agent core does not.</p>
            <div className="mt-6 space-y-3">
              {(Object.keys(SCENARIOS) as HealthcareDemoScenarioKind[]).map((key) => (
                <ScenarioButton key={key} scenario={key} selected={scenario === key} onSelect={selectScenario} />
              ))}
            </div>
          </section>

          <section className="rounded-3xl border border-border bg-surface p-6 shadow-sm sm:p-8">
            <div className="flex flex-wrap items-start justify-between gap-6">
              <div className="max-w-xl">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-text-muted">
                  {scenario === 'appointment_request' ? <Languages className="h-4 w-4" aria-hidden="true" /> : <Stethoscope className="h-4 w-4" aria-hidden="true" />}
                  {SCENARIOS[scenario].title}
                </div>
                <h2 className="mt-3 font-display text-2xl font-semibold text-heading">Run the production-shaped path</h2>
                <p className="mt-2 text-sm leading-6 text-text-secondary">{SCENARIOS[scenario].description}</p>
              </div>
              <div className="flex items-center gap-2 rounded-full bg-surface-hover px-3 py-2 text-xs font-medium text-text-secondary">
                <Clock3 className="h-4 w-4 text-primary" aria-hidden="true" /> About 30 seconds
              </div>
            </div>

            <div className="mt-8 flex flex-wrap items-center gap-3 border-t border-border pt-6">
              <button
                type="button"
                onClick={runScenario}
                disabled={status === 'running'}
                className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-primary px-5 py-3 font-display text-sm font-semibold text-white shadow-lg shadow-primary/15 transition hover:bg-primary-hover disabled:cursor-wait disabled:opacity-70"
              >
                {status === 'running' ? <RotateCcw className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ArrowRight className="h-4 w-4" aria-hidden="true" />}
                {status === 'running' ? 'Running workflow…' : runLabel}
              </button>
              {result && (
                <button type="button" onClick={reset} className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-border-strong bg-white px-4 py-3 text-sm font-semibold text-text-primary hover:bg-surface-hover">
                  <RotateCcw className="h-4 w-4" aria-hidden="true" /> Reset demo
                </button>
              )}
              <p className="text-xs text-text-muted">No form entry. No personal data collected.</p>
            </div>

            {status === 'error' && (
              <div className="mt-6 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-danger/25 bg-danger-light p-4" role="alert">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 h-5 w-5 text-danger" aria-hidden="true" />
                  <div><p className="text-sm font-semibold text-heading">We couldn't run the guided workflow.</p><p className="mt-1 text-xs text-text-secondary">Nothing was submitted. Try the deterministic scenario again.</p></div>
                </div>
                <button type="button" onClick={runScenario} className="rounded-lg bg-sidebar-bg px-4 py-2 text-sm font-semibold text-white">Try again</button>
              </div>
            )}

            {result && <WorkflowResult result={result} />}
          </section>
        </div>
      </section>

      <section className="border-t border-border bg-[#f4f1e9]">
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-6 px-6 py-12 sm:flex-row sm:items-center lg:px-8">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">Make it yours</p>
            <h2 className="mt-2 font-display text-2xl font-semibold text-heading">See this operating model against your call flow.</h2>
            <p className="mt-2 text-sm text-text-secondary">We configure the role around your approved policies, tools, and escalation boundaries.</p>
          </div>
          <Link
            to="/book-demo"
            onClick={() => {
              trackCTAClick(CTA.BOOK_DEMO, 'demo', result ? 'completed_workflow' : 'page_footer');
              fetch('/api/demo/track-cta', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ctaType: 'book_demo', agentType: 'healthcare-receptionist' }),
              }).catch(() => {});
            }}
            className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-xl bg-sidebar-bg px-5 py-3 font-display text-sm font-semibold text-white shadow-sm transition hover:bg-sidebar-hover"
          >
            Book a healthcare demo <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </Link>
        </div>
      </section>
    </div>
  );
}
