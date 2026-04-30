import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Calendar, CheckCircle2, Clock, Users, Shield, ArrowRight, Loader2 } from 'lucide-react';
import SEO from '../../components/SEO';
import { trackPageView, trackCTAClick, trackConversionEvent, captureUtmOnLoad } from '../../lib/analytics';
import { CTA } from '../../lib/analyticsCtas';
import { CONVERSION_STAGE } from '../../lib/analyticsLabels';

const benefits = [
  { icon: Clock, title: '30-minute walkthrough', desc: 'Live tour of the platform tailored to your industry and call volume.' },
  { icon: Users, title: 'Talk to a specialist', desc: 'Speak with someone who has deployed agents in your vertical.' },
  { icon: Shield, title: 'No-pressure conversation', desc: 'We will help you decide if QVO is the right fit — even if it is not.' },
];

const teamSizes = ['1-10', '11-50', '51-200', '201-1,000', '1,000+'];
const timeWindows = [
  'This week',
  'Next week',
  'Within 2 weeks',
  'Flexible',
];

// Build-time defaults from VITE_ env vars are kept ONLY as a fallback for
// the brief window between the page mounting and the runtime
// `/api/book-demo/config` fetch resolving (or for the case where that
// endpoint fails). The authoritative value comes from the admin-controlled
// platform_settings row, which is exposed via `/api/book-demo/config` and
// can be flipped between cal.com and calendly without a redeploy.
const VITE_ENV = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {}) as Record<string, string | undefined>;
const FALLBACK_SCHEDULER_URL = (VITE_ENV.VITE_BOOK_DEMO_SCHEDULER_URL || 'https://cal.com/qvo/30min').trim();
const FALLBACK_SCHEDULER_PROVIDER = (VITE_ENV.VITE_BOOK_DEMO_SCHEDULER_PROVIDER || 'cal.com').trim().toLowerCase();

interface SchedulerConfig {
  provider: string;
  embedUrl: string;
}

function buildSchedulerUrl(
  form: {
    name: string;
    email: string;
    company: string;
    teamSize: string;
    useCase: string;
  },
  leadId: number | null,
  config: SchedulerConfig,
): string {
  const provider = (config.provider || 'cal.com').trim().toLowerCase();
  const baseUrl = (config.embedUrl || FALLBACK_SCHEDULER_URL).trim();
  try {
    const url = new URL(baseUrl);
    const notes = `Company: ${form.company}\nTeam size: ${form.teamSize}${form.useCase ? `\nUse case: ${form.useCase}` : ''}${leadId ? `\nLead ID: ${leadId}` : ''}`;

    if (provider === 'calendly') {
      url.searchParams.set('name', form.name);
      url.searchParams.set('email', form.email);
      url.searchParams.set('a1', form.company);
      if (leadId) url.searchParams.set('utm_content', `lead-${leadId}`);
    } else {
      // Cal.com (default)
      if (!url.searchParams.has('embed')) url.searchParams.set('embed', 'true');
      if (!url.searchParams.has('theme')) url.searchParams.set('theme', 'light');
      url.searchParams.set('name', form.name);
      url.searchParams.set('email', form.email);
      url.searchParams.set('notes', notes);
      if (leadId) url.searchParams.set('metadata[leadId]', String(leadId));
      url.searchParams.set('metadata[company]', form.company);
      url.searchParams.set('metadata[teamSize]', form.teamSize);
    }
    return url.toString();
  } catch {
    return baseUrl;
  }
}

export default function BookDemo() {
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leadId, setLeadId] = useState<number | null>(null);
  const [schedulerConfig, setSchedulerConfig] = useState<SchedulerConfig>({
    provider: FALLBACK_SCHEDULER_PROVIDER,
    embedUrl: FALLBACK_SCHEDULER_URL,
  });
  const [form, setForm] = useState({
    name: '',
    email: '',
    company: '',
    phone: '',
    teamSize: teamSizes[1],
    useCase: '',
    preferredTime: timeWindows[0],
  });

  useEffect(() => {
    trackPageView('/book-demo');
    captureUtmOnLoad();
    trackConversionEvent(CONVERSION_STAGE.PAGE_VIEW, '/book-demo');
  }, []);

  // Pull the live scheduler config from the admin-controlled
  // `/api/book-demo/config` endpoint so an operator can switch the embed
  // between Cal.com and Calendly without a redeploy. Failures keep the
  // build-time fallback values (so the page stays functional).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/book-demo/config');
        if (!res.ok) return;
        const data = (await res.json().catch(() => null)) as SchedulerConfig | null;
        if (cancelled || !data || typeof data.provider !== 'string' || typeof data.embedUrl !== 'string') return;
        setSchedulerConfig({ provider: data.provider, embedUrl: data.embedUrl });
      } catch {
        // Keep the build-time fallback — the form still renders correctly.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/book-demo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Unable to submit. Please try again.');
      }
      if (typeof data?.leadId === 'number') {
        setLeadId(data.leadId);
      }
      trackCTAClick(CTA.BOOK_DEMO_SUBMIT, '/book-demo', 'form');
      trackConversionEvent(CONVERSION_STAGE.DEMO_REQUESTED, '/book-demo', { teamSize: form.teamSize });
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-surface-secondary">
      <SEO
        title="Book a Demo — Talk to a QVO Specialist"
        description="See QVO in action with a 30-minute live walkthrough tailored to your business. Schedule a personalized demo with our team."
        canonicalPath="/book-demo"
      />
      <section className="bg-sidebar-bg text-white py-16 lg:py-20">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 text-center">
          <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-3">Book a Demo</p>
          <h1 className="font-display text-3xl lg:text-5xl font-bold mb-4">See QVO in your business in 30 minutes.</h1>
          <p className="text-lg text-white/70 max-w-2xl mx-auto">
            Get a personalized walkthrough from someone who has deployed AI voice agents in your industry.
          </p>
        </div>
      </section>

      <section className="py-12 lg:py-16">
        <div className="max-w-6xl mx-auto px-6 lg:px-8 grid lg:grid-cols-5 gap-8">
          <aside className="lg:col-span-2 space-y-6">
            <div className="bg-surface rounded-2xl border border-border/30 p-6">
              <h2 className="font-display text-lg font-bold text-text-primary mb-4">What to expect</h2>
              <ul className="space-y-4">
                {benefits.map((b) => (
                  <li key={b.title} className="flex items-start gap-3">
                    <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                      <b.icon className="h-4 w-4 text-primary" />
                    </div>
                    <div>
                      <p className="font-display text-sm font-semibold text-text-primary">{b.title}</p>
                      <p className="text-xs text-text-primary/60 font-body leading-relaxed mt-0.5">{b.desc}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
            <div className="bg-surface rounded-2xl border border-border/30 p-6">
              <p className="text-xs uppercase tracking-wider font-semibold text-text-primary/50 mb-3">Prefer self-serve?</p>
              <p className="text-sm text-text-primary/70 font-body mb-4">
                Skip the demo and start your 14-day free trial — no credit card required.
              </p>
              <Link
                to="/signup"
                className="inline-flex items-center gap-2 text-primary hover:text-primary-hover text-sm font-semibold"
                onClick={() => trackCTAClick(CTA.START_FREE_TRIAL_FROM_BOOK_DEMO, '/book-demo', 'sidebar')}
              >
                Start free trial <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          </aside>

          <div className="lg:col-span-3">
            {submitted ? (
              <div className="space-y-5">
                <div className="bg-surface rounded-2xl border border-success/30 p-6 lg:p-8">
                  <div className="flex items-start gap-3 mb-3">
                    <div className="w-10 h-10 rounded-full bg-success/15 flex items-center justify-center shrink-0">
                      <CheckCircle2 className="h-5 w-5 text-success" />
                    </div>
                    <div>
                      <h2 className="font-display text-xl font-bold text-text-primary mb-1">Thanks, {form.name.split(' ')[0]}.</h2>
                      <p className="text-text-primary/70 font-body text-sm">
                        Pick a time below that works for you — we will confirm by email immediately. A specialist will also reach out within one business day if you would prefer a different time.
                      </p>
                    </div>
                  </div>
                </div>
                <div className="bg-surface rounded-2xl border border-border/30 overflow-hidden">
                  <div className="px-5 py-3 border-b border-border/30 flex items-center gap-2">
                    <Calendar className="h-4 w-4 text-primary" />
                    <p className="text-sm font-display font-semibold text-text-primary">Choose a time</p>
                  </div>
                  <iframe
                    title="Schedule a QVO demo"
                    src={buildSchedulerUrl(form, leadId, schedulerConfig)}
                    className="w-full"
                    style={{ height: '720px', border: 0 }}
                    loading="lazy"
                  />
                  <div className="px-5 py-3 border-t border-border/30 text-xs text-text-primary/60 font-body">
                    Calendar trouble? Email <a href="mailto:sales@qvo.ai" className="text-primary hover:underline">sales@qvo.ai</a> and we will follow up within one business day.
                  </div>
                </div>
                <div className="flex flex-col sm:flex-row gap-3">
                  <Link
                    to="/demo"
                    className="flex-1 inline-flex items-center justify-center gap-2 bg-surface-secondary hover:bg-surface-hover text-text-primary font-semibold px-6 py-3 rounded-xl text-sm transition-colors"
                  >
                    Try the live demo
                  </Link>
                  <Link
                    to="/case-studies"
                    className="flex-1 inline-flex items-center justify-center gap-2 bg-surface-secondary hover:bg-surface-hover text-text-primary font-semibold px-6 py-3 rounded-xl text-sm transition-colors"
                  >
                    Read customer stories
                  </Link>
                </div>
              </div>
            ) : (
              <form
                onSubmit={handleSubmit}
                className="bg-surface rounded-2xl border border-border/30 p-6 lg:p-8 space-y-5"
              >
                <div className="flex items-center gap-2 mb-2">
                  <Calendar className="h-5 w-5 text-primary" />
                  <h2 className="font-display text-lg font-bold text-text-primary">Tell us about your business</h2>
                </div>
                <div className="grid sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="book-demo-name" className="block text-xs font-semibold text-text-primary mb-1.5">Full name *</label>
                    <input
                      id="book-demo-name"
                      required
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      className="w-full px-3 py-2.5 rounded-lg border border-border/40 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary"
                    />
                  </div>
                  <div>
                    <label htmlFor="book-demo-email" className="block text-xs font-semibold text-text-primary mb-1.5">Work email *</label>
                    <input
                      id="book-demo-email"
                      required
                      type="email"
                      value={form.email}
                      onChange={(e) => setForm({ ...form, email: e.target.value })}
                      className="w-full px-3 py-2.5 rounded-lg border border-border/40 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary"
                    />
                  </div>
                  <div>
                    <label htmlFor="book-demo-company" className="block text-xs font-semibold text-text-primary mb-1.5">Company *</label>
                    <input
                      id="book-demo-company"
                      required
                      value={form.company}
                      onChange={(e) => setForm({ ...form, company: e.target.value })}
                      className="w-full px-3 py-2.5 rounded-lg border border-border/40 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary"
                    />
                  </div>
                  <div>
                    <label htmlFor="book-demo-phone" className="block text-xs font-semibold text-text-primary mb-1.5">Phone</label>
                    <input
                      id="book-demo-phone"
                      type="tel"
                      value={form.phone}
                      onChange={(e) => setForm({ ...form, phone: e.target.value })}
                      className="w-full px-3 py-2.5 rounded-lg border border-border/40 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary"
                    />
                  </div>
                  <div>
                    <label htmlFor="book-demo-team-size" className="block text-xs font-semibold text-text-primary mb-1.5">Team size</label>
                    <select
                      id="book-demo-team-size"
                      value={form.teamSize}
                      onChange={(e) => setForm({ ...form, teamSize: e.target.value })}
                      className="w-full px-3 py-2.5 rounded-lg border border-border/40 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary bg-surface"
                    >
                      {teamSizes.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="book-demo-preferred-time" className="block text-xs font-semibold text-text-primary mb-1.5">Preferred timing</label>
                    <select
                      id="book-demo-preferred-time"
                      value={form.preferredTime}
                      onChange={(e) => setForm({ ...form, preferredTime: e.target.value })}
                      className="w-full px-3 py-2.5 rounded-lg border border-border/40 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary bg-surface"
                    >
                      {timeWindows.map((t) => <option key={t} value={t}>{t}</option>)}
                    </select>
                  </div>
                </div>
                <div>
                  <label htmlFor="book-demo-use-case" className="block text-xs font-semibold text-text-primary mb-1.5">What are you trying to solve?</label>
                  <textarea
                    id="book-demo-use-case"
                    rows={4}
                    value={form.useCase}
                    onChange={(e) => setForm({ ...form, useCase: e.target.value })}
                    placeholder="e.g. After-hours coverage for our HVAC dispatch team, or replacing our overflow answering service."
                    className="w-full px-3 py-2.5 rounded-lg border border-border/40 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary"
                  />
                </div>

                {error && (
                  <div className="text-sm text-danger bg-danger/10 border border-danger/20 rounded-lg px-3 py-2">
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={submitting}
                  className="w-full inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover disabled:bg-primary/60 text-white font-semibold px-6 py-3 rounded-xl text-sm transition-colors"
                >
                  {submitting ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" /> Sending…
                    </>
                  ) : (
                    <>
                      Request demo <ArrowRight className="h-4 w-4" />
                    </>
                  )}
                </button>
                <p className="text-[11px] text-text-primary/50 text-center font-body">
                  By submitting, you agree to be contacted by QVO about your demo request. We will not share your information.
                </p>
              </form>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
