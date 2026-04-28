import { Link } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { CheckCircle2, X as XIcon, ArrowRight, ChevronDown, Star, ShieldCheck } from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';
import ROICalculator from '../../components/ROICalculator';
import MinutesPricingCalculator from '../../components/MinutesPricingCalculator';
import LogosStrip from '../../components/LogosStrip';
import { trackPageView, trackCTAClick, trackConversionEvent, captureUtmOnLoad } from '../../lib/analytics';
import { PLAN_CATALOG, getPlanMonthlyPriceWholeDollars } from '../../../../shared/billing/planCatalog';

function formatOverageRate(ratePerMinute: number): string {
  return `$${ratePerMinute.toFixed(2)}/min`;
}

interface Feature {
  name: string;
  starter: boolean | string;
  pro: boolean | string;
  enterprise: boolean | string;
}

const features: Feature[] = [
  {
    name: 'AI minutes included',
    starter: PLAN_CATALOG.starter.includedMinutes.toLocaleString(),
    pro: PLAN_CATALOG.pro.includedMinutes.toLocaleString(),
    enterprise: PLAN_CATALOG.enterprise.includedMinutes.toLocaleString(),
  },
  {
    name: 'Overage rate',
    starter: formatOverageRate(PLAN_CATALOG.starter.overageRatePerMinute),
    pro: formatOverageRate(PLAN_CATALOG.pro.overageRatePerMinute),
    enterprise: formatOverageRate(PLAN_CATALOG.enterprise.overageRatePerMinute),
  },
  { name: 'Voice agents', starter: 'Unlimited', pro: 'Unlimited', enterprise: 'Unlimited' },
  { name: 'Phone numbers', starter: 'Up to 3', pro: 'Up to 10', enterprise: 'Unlimited' },
  { name: 'Inbound call handling', starter: true, pro: true, enterprise: true },
  { name: 'Outbound campaigns', starter: false, pro: true, enterprise: true },
  { name: 'Call transcripts', starter: true, pro: true, enterprise: true },
  { name: 'Quality scoring', starter: false, pro: true, enterprise: true },
  { name: 'Analytics dashboard', starter: true, pro: true, enterprise: true },
  { name: 'Team members', starter: 'Up to 3', pro: 'Up to 10', enterprise: 'Unlimited' },
  { name: 'Role-based access', starter: false, pro: true, enterprise: true },
  { name: 'API access', starter: false, pro: true, enterprise: true },
  { name: 'CRM integrations', starter: false, pro: true, enterprise: true },
  { name: 'Custom agent templates', starter: false, pro: true, enterprise: true },
  { name: 'Audit logs', starter: false, pro: false, enterprise: true },
  { name: 'Multi-location support', starter: false, pro: false, enterprise: true },
  { name: 'Priority support', starter: false, pro: true, enterprise: true },
  { name: 'Dedicated onboarding', starter: false, pro: false, enterprise: true },
  { name: 'Interactive demo access', starter: true, pro: true, enterprise: true },
  { name: '14-day free trial', starter: true, pro: true, enterprise: true },
];

const TIER_COPY: Record<'starter' | 'pro' | 'enterprise', { desc: string; popular?: boolean }> = {
  starter: {
    desc: 'For small practices getting started with voice automation.',
  },
  pro: {
    desc: 'For growing businesses that need campaigns and integrations.',
    popular: true,
  },
  enterprise: {
    desc: 'For multi-location organizations with high call volume.',
  },
};

const tiers = (['starter', 'pro', 'enterprise'] as const).map((key) => {
  const plan = PLAN_CATALOG[key];
  const copy = TIER_COPY[key];
  return {
    key,
    name: plan.name,
    price: getPlanMonthlyPriceWholeDollars(key),
    desc: copy.desc,
    popular: copy.popular,
    minutes: `${plan.includedMinutes.toLocaleString()} AI minutes`,
    overage: `${formatOverageRate(plan.overageRatePerMinute)} overage`,
  };
});

const faqs = [
  {
    q: 'How does the 14-day free trial work?',
    a: 'You get full access to all features on your chosen plan for 14 days. No credit card required to start. If you decide not to continue, your account is simply paused — no charges.',
  },
  {
    q: 'What counts as an AI minute?',
    a: 'An AI minute is one minute of active call time handled by your voice agent. Hold time, ringing, and system processing are not counted. Only actual conversation time is billed.',
  },
  {
    q: 'What happens if I exceed my included minutes?',
    a: `You'll be billed at your plan's overage rate for any minutes beyond your monthly allocation. Starter plans pay ${formatOverageRate(PLAN_CATALOG.starter.overageRatePerMinute)}, Pro pays ${formatOverageRate(PLAN_CATALOG.pro.overageRatePerMinute)}, and Enterprise pays ${formatOverageRate(PLAN_CATALOG.enterprise.overageRatePerMinute)}.`,
  },
  {
    q: 'Can I change plans at any time?',
    a: 'Yes. Upgrade or downgrade at any time from your account settings. When upgrading, you get immediate access to the new features. Downgrades take effect at the start of your next billing cycle.',
  },
  {
    q: 'Are there any contracts or commitments?',
    a: 'No. All plans are month-to-month with no long-term contracts. You can cancel at any time and your account will remain active through the end of your current billing period.',
  },
  {
    q: 'Do you offer annual pricing?',
    a: 'Yes. Annual billing saves you 20% compared to monthly pricing. Contact our sales team or select annual billing during signup to get the discounted rate.',
  },
  {
    q: 'Is there a setup fee?',
    a: 'No setup fees on any plan. Starter and Pro plans are entirely self-service. Enterprise plans include dedicated onboarding at no additional cost.',
  },
  {
    q: 'What payment methods do you accept?',
    a: 'We accept all major credit cards (Visa, Mastercard, American Express) and ACH bank transfers for annual Enterprise plans. Invoicing is available for Enterprise customers.',
  },
];

function FeatureCell({ value }: { value: boolean | string }) {
  if (typeof value === 'string') {
    return <span className="text-sm font-medium text-text-primary">{value}</span>;
  }
  return value ? (
    <CheckCircle2 className="h-4.5 w-4.5 text-success mx-auto" />
  ) : (
    <XIcon className="h-4 w-4 text-text-muted mx-auto" />
  );
}

function FAQItem({ q, a, id }: { q: string; a: string; id: string }) {
  const [open, setOpen] = useState(false);
  const panelId = `faq-panel-${id}`;
  const triggerId = `faq-trigger-${id}`;

  return (
    <div className="border-b border-border/30 last:border-b-0">
      <button
        id={triggerId}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-5 px-1 text-left group focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 rounded-lg"
      >
        <span className="font-display text-base font-semibold text-text-primary group-hover:text-primary transition-colors pr-4">
          {q}
        </span>
        <ChevronDown
          className={`h-5 w-5 text-text-primary/40 flex-shrink-0 transition-transform duration-300 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
      <div
        id={panelId}
        role="region"
        aria-labelledby={triggerId}
        className={`overflow-hidden transition-all duration-300 ${
          open ? 'max-h-96 pb-5' : 'max-h-0'
        }`}
      >
        <p className="text-sm text-text-primary/60 font-body leading-relaxed px-1">{a}</p>
      </div>
    </div>
  );
}

export default function Pricing() {
  useEffect(() => {
    trackPageView('/pricing');
    captureUtmOnLoad();
    trackConversionEvent('page_view', '/pricing');
  }, []);

  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: 'How much does QVO cost?',
        acceptedAnswer: { '@type': 'Answer', text: `QVO offers three plans: Starter at $${getPlanMonthlyPriceWholeDollars('starter')}/month, Pro at $${getPlanMonthlyPriceWholeDollars('pro')}/month, and Enterprise at $${getPlanMonthlyPriceWholeDollars('enterprise')}/month. All plans include a 14-day free trial.` },
      },
      {
        '@type': 'Question',
        name: 'What is included in the free trial?',
        acceptedAnswer: { '@type': 'Answer', text: 'Every QVO plan includes a 14-day free trial with full access to all features in your chosen tier. No credit card required to start.' },
      },
      {
        '@type': 'Question',
        name: 'Can I change my plan later?',
        acceptedAnswer: { '@type': 'Answer', text: 'Yes, you can upgrade or downgrade your plan at any time. Changes take effect at the start of your next billing cycle.' },
      },
    ],
  };

  return (
    <div>
      <SEO
        title="Pricing — AI Voice Agent Plans with AI Minutes, Agents & Integrations"
        description={`QVO pricing starts at $${getPlanMonthlyPriceWholeDollars('starter')}/month. Compare Starter, Pro, and Enterprise plans with AI minutes, unlimited agents, CRM integrations, and demo access. 14-day free trial.`}
        canonicalPath="/pricing"
        structuredData={faqSchema}
      />
      <section className="bg-sidebar-bg text-white py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 text-center">
          <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-4">
            Pricing
          </p>
          <h1 className="font-display text-4xl lg:text-5xl font-bold mb-6">
            Simple plans, honest pricing.
          </h1>
          <p className="text-lg text-white/70 font-body max-w-2xl mx-auto mb-6">
            Start with a 14-day free trial on any plan. No contracts, no hidden fees. Scale as your business grows.
          </p>
          <div className="inline-flex items-center gap-2 bg-success/15 border border-success/30 rounded-full px-4 py-1.5 text-success text-sm font-medium">
            <ShieldCheck className="h-4 w-4" />
            30-day money-back guarantee
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
          <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto mb-20">
            {tiers.map((tier) => (
              <div
                key={tier.key}
                className={`relative bg-white rounded-2xl border p-8 transition-all duration-300 hover:-translate-y-1 hover:shadow-xl group ${
                  tier.popular
                    ? 'border-primary ring-2 ring-primary/20 shadow-lg shadow-primary/10'
                    : 'border-border/50 hover:border-primary/30 hover:shadow-primary/5'
                }`}
              >
                {tier.popular && (
                  <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                    <span className="inline-flex items-center gap-1.5 bg-primary text-white text-xs font-semibold px-4 py-1.5 rounded-full shadow-sm">
                      <Star className="h-3 w-3 fill-current" />
                      Most Popular
                    </span>
                  </div>
                )}
                <h3 className="font-display text-xl font-bold text-text-primary mb-1">{tier.name}</h3>
                <p className="text-sm text-text-primary/50 font-body mb-5">{tier.desc}</p>
                <div className="mb-2">
                  <span className="font-display text-5xl font-bold text-text-primary">${tier.price}</span>
                  <span className="text-sm text-text-primary/50 font-body">/month</span>
                </div>
                <div className="flex flex-col gap-1 mb-6">
                  <span className="text-xs text-primary font-semibold font-body">{tier.minutes} included</span>
                  <span className="text-xs text-text-primary/40 font-body">{tier.overage}</span>
                </div>
                <Link
                  to={`/signup?plan=${tier.key}`}
                  className={`block text-center font-semibold py-3.5 px-4 rounded-lg text-sm transition-colors duration-[var(--motion-base)] min-h-[44px] ${
                    tier.popular
                      ? 'btn-primary-glow bg-primary hover:bg-primary-hover text-on-primary'
                      : 'bg-surface-hover hover:bg-primary text-text-primary hover:text-on-primary'
                  }`}
                  onClick={() => trackCTAClick('start_free_trial', 'pricing_card', tier.key)}
                >
                  Start free trial
                  <ArrowRight className="h-4 w-4 inline-block ml-2" />
                </Link>
              </div>
            ))}
          </div>
          </RevealSection>

          <RevealSection>
          <div className="max-w-5xl mx-auto mb-20">
            <div className="text-center mb-8">
              <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-3">
                Per-minute calculator
              </p>
              <h2 className="font-display text-2xl font-bold text-text-primary mb-3">
                See your effective price per minute
              </h2>
              <p className="text-text-primary/60 font-body max-w-2xl mx-auto">
                Drag the slider to match your expected monthly volume. We'll show your estimated bill and effective per-minute rate on every plan, using the same rates billed by your usage meter.
              </p>
            </div>
            <MinutesPricingCalculator />
          </div>
          </RevealSection>

          <RevealSection>
          <div className="max-w-5xl mx-auto">
            <h2 className="font-display text-2xl font-bold text-text-primary mb-8 text-center">
              Compare all features
            </h2>
            <div className="bg-white rounded-2xl border border-border/50 overflow-hidden shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border/30 bg-surface-secondary/50">
                      <th className="text-left py-4 px-6 font-display text-sm font-semibold text-text-primary">Feature</th>
                      {tiers.map((t) => (
                        <th key={t.key} className="text-center py-4 px-4 font-display text-sm font-semibold text-text-primary w-36">
                          <span className={t.popular ? 'text-primary' : ''}>{t.name}</span>
                          {t.popular && (
                            <span className="block text-[10px] text-primary font-medium mt-0.5">RECOMMENDED</span>
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {features.map((f, i) => (
                      <tr
                        key={f.name}
                        className={`transition-colors hover:bg-primary/5 ${i % 2 === 0 ? 'bg-surface-secondary/30' : ''}`}
                      >
                        <td className="py-3.5 px-6 text-sm text-text-primary/70 font-body">{f.name}</td>
                        <td className="py-3.5 px-4 text-center"><FeatureCell value={f.starter} /></td>
                        <td className={`py-3.5 px-4 text-center ${tiers[1].popular ? 'bg-primary/[0.02]' : ''}`}>
                          <FeatureCell value={f.pro} />
                        </td>
                        <td className="py-3.5 px-4 text-center"><FeatureCell value={f.enterprise} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          </RevealSection>
        </div>
      </section>

      <section className="bg-white py-12 border-t border-border/30">
        <div className="max-w-5xl mx-auto px-6 lg:px-8">
          <p className="text-center text-xs font-semibold text-text-primary/40 uppercase tracking-wider mb-6">
            Enterprise-ready compliance
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            {[
              'SOC 2 Type II (in progress)',
              'HIPAA available with BAA',
              'GDPR compliant',
              'CCPA / CPRA',
              'TLS 1.2+ in transit',
              'AES-256 at rest',
            ].map((badge) => (
              <Link
                key={badge}
                to="/security"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-text-primary bg-surface-secondary hover:bg-primary/10 border border-border/40 hover:border-primary/30 rounded-full px-3 py-1.5 transition-colors"
              >
                <ShieldCheck className="h-3.5 w-3.5 text-primary" /> {badge}
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-surface-secondary py-20 lg:py-28">
        <div className="max-w-3xl mx-auto px-6 lg:px-8">
          <div className="text-center mb-12">
            <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-3">
              FAQ
            </p>
            <h2 className="font-display text-3xl font-bold text-text-primary mb-4">
              Common questions about billing.
            </h2>
            <p className="text-text-primary/60 font-body leading-relaxed">
              Everything you need to know about our plans and pricing.
            </p>
          </div>
          <div className="bg-white rounded-2xl border border-border/30 px-6 lg:px-8 shadow-sm">
            {faqs.map((faq, i) => (
              <FAQItem key={faq.q} q={faq.q} a={faq.a} id={String(i)} />
            ))}
          </div>
        </div>
      </section>

      <section className="bg-surface-secondary py-16">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="font-display text-2xl font-bold text-text-primary mb-3">Calculate Your ROI</h2>
            <p className="text-slate-600">See how much your business could save with QVO AI voice agents.</p>
          </div>
          <ROICalculator />
        </div>
      </section>

      <section className="bg-white py-14 border-t border-border/20">
        <div className="max-w-6xl mx-auto px-6 lg:px-8">
          <LogosStrip title="Teams already running on QVO" />
        </div>
      </section>

      <section className="bg-sidebar-bg text-white py-16">
        <div className="max-w-3xl mx-auto px-6 lg:px-8 text-center">
          <h2 className="font-display text-2xl font-bold mb-4">
            Questions about pricing?
          </h2>
          <p className="text-white/60 font-body mb-8">
            Talk to our team to find the right plan for your practice.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              to="/book-demo"
              className="btn-primary-glow inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-on-primary font-semibold px-6 py-3 rounded-lg text-sm transition-colors duration-[var(--motion-base)] min-h-[44px]"
              onClick={() => trackCTAClick('book_demo', 'pricing_bottom')}
            >
              Book a demo
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to="/signup"
              className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors duration-[var(--motion-base)] border border-white/15 hover:border-white/25 min-h-[44px]"
              onClick={() => trackCTAClick('start_free_trial', 'pricing_bottom')}
            >
              Start free trial
            </Link>
            <Link
              to="/contact"
              className="inline-flex items-center justify-center gap-2 text-white/80 hover:text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors"
              onClick={() => trackCTAClick('contact_sales', 'pricing_bottom')}
            >
              Contact sales
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
