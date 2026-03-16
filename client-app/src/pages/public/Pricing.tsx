import { Link } from 'react-router-dom';
import { useState } from 'react';
import { CheckCircle2, X as XIcon, ArrowRight, ChevronDown, Star } from 'lucide-react';

interface Feature {
  name: string;
  starter: boolean | string;
  pro: boolean | string;
  enterprise: boolean | string;
}

const features: Feature[] = [
  { name: 'AI minutes included', starter: '500', pro: '2,500', enterprise: '10,000' },
  { name: 'Overage rate', starter: '$0.15/min', pro: '$0.12/min', enterprise: '$0.08/min' },
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
  { name: '14-day free trial', starter: true, pro: true, enterprise: true },
];

const tiers = [
  {
    key: 'starter' as const,
    name: 'Starter',
    price: 99,
    desc: 'For small practices getting started with voice automation.',
    minutes: '500 AI minutes',
    overage: '$0.15/min overage',
  },
  {
    key: 'pro' as const,
    name: 'Pro',
    price: 399,
    desc: 'For growing businesses that need campaigns and integrations.',
    popular: true,
    minutes: '2,500 AI minutes',
    overage: '$0.12/min overage',
  },
  {
    key: 'enterprise' as const,
    name: 'Enterprise',
    price: 999,
    desc: 'For multi-location organizations with high call volume.',
    minutes: '10,000 AI minutes',
    overage: '$0.08/min overage',
  },
];

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
    a: 'You\'ll be billed at your plan\'s overage rate for any minutes beyond your monthly allocation. Starter plans pay $0.15/min, Pro pays $0.12/min, and Enterprise pays $0.08/min.',
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
    return <span className="text-sm font-medium text-harbor">{value}</span>;
  }
  return value ? (
    <CheckCircle2 className="h-4.5 w-4.5 text-calm-green mx-auto" />
  ) : (
    <XIcon className="h-4 w-4 text-soft-steel mx-auto" />
  );
}

function FAQItem({ q, a, id }: { q: string; a: string; id: string }) {
  const [open, setOpen] = useState(false);
  const panelId = `faq-panel-${id}`;
  const triggerId = `faq-trigger-${id}`;

  return (
    <div className="border-b border-soft-steel/30 last:border-b-0">
      <button
        id={triggerId}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-5 px-1 text-left group focus:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 rounded-lg"
      >
        <span className="font-display text-base font-semibold text-harbor group-hover:text-teal transition-colors pr-4">
          {q}
        </span>
        <ChevronDown
          className={`h-5 w-5 text-slate-ink/40 flex-shrink-0 transition-transform duration-300 ${
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
        <p className="text-sm text-slate-ink/60 font-body leading-relaxed px-1">{a}</p>
      </div>
    </div>
  );
}

export default function Pricing() {
  return (
    <div>
      <section className="bg-harbor text-white py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 text-center">
          <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-4">
            Pricing
          </p>
          <h1 className="font-display text-4xl lg:text-5xl font-bold mb-6">
            Simple plans, honest pricing.
          </h1>
          <p className="text-lg text-white/70 font-body max-w-2xl mx-auto">
            Start with a 14-day free trial on any plan. No contracts, no hidden fees. Scale as your business grows.
          </p>
        </div>
      </section>

      <section className="py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto mb-20">
            {tiers.map((tier) => (
              <div
                key={tier.key}
                className={`relative bg-white rounded-2xl border p-8 transition-all duration-300 hover:-translate-y-1 hover:shadow-xl group ${
                  tier.popular
                    ? 'border-teal ring-2 ring-teal/20 shadow-lg shadow-teal/10'
                    : 'border-soft-steel/50 hover:border-teal/30 hover:shadow-teal/5'
                }`}
              >
                {tier.popular && (
                  <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                    <span className="inline-flex items-center gap-1.5 bg-teal text-white text-xs font-semibold px-4 py-1.5 rounded-full shadow-sm">
                      <Star className="h-3 w-3 fill-current" />
                      Most Popular
                    </span>
                  </div>
                )}
                <h3 className="font-display text-xl font-bold text-harbor mb-1">{tier.name}</h3>
                <p className="text-sm text-slate-ink/50 font-body mb-5">{tier.desc}</p>
                <div className="mb-2">
                  <span className="font-display text-5xl font-bold text-harbor">${tier.price}</span>
                  <span className="text-sm text-slate-ink/50 font-body">/month</span>
                </div>
                <div className="flex flex-col gap-1 mb-6">
                  <span className="text-xs text-teal font-semibold font-body">{tier.minutes} included</span>
                  <span className="text-xs text-slate-ink/40 font-body">{tier.overage}</span>
                </div>
                <Link
                  to={`/signup?plan=${tier.key}`}
                  className={`block text-center font-semibold py-3.5 px-4 rounded-lg text-sm transition-all duration-300 ${
                    tier.popular
                      ? 'bg-teal hover:bg-teal-hover text-white shadow-sm hover:shadow-md'
                      : 'bg-harbor/5 hover:bg-harbor/10 text-harbor group-hover:bg-teal group-hover:text-white'
                  }`}
                >
                  Start free trial
                  <ArrowRight className="h-4 w-4 inline-block ml-2" />
                </Link>
              </div>
            ))}
          </div>

          <div className="max-w-5xl mx-auto">
            <h2 className="font-display text-2xl font-bold text-harbor mb-8 text-center">
              Compare all features
            </h2>
            <div className="bg-white rounded-2xl border border-soft-steel/50 overflow-hidden shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-soft-steel/30 bg-mist/50">
                      <th className="text-left py-4 px-6 font-display text-sm font-semibold text-harbor">Feature</th>
                      {tiers.map((t) => (
                        <th key={t.key} className="text-center py-4 px-4 font-display text-sm font-semibold text-harbor w-36">
                          <span className={t.popular ? 'text-teal' : ''}>{t.name}</span>
                          {t.popular && (
                            <span className="block text-[10px] text-teal font-medium mt-0.5">RECOMMENDED</span>
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {features.map((f, i) => (
                      <tr
                        key={f.name}
                        className={`transition-colors hover:bg-teal/5 ${i % 2 === 0 ? 'bg-mist/30' : ''}`}
                      >
                        <td className="py-3.5 px-6 text-sm text-slate-ink/70 font-body">{f.name}</td>
                        <td className="py-3.5 px-4 text-center"><FeatureCell value={f.starter} /></td>
                        <td className={`py-3.5 px-4 text-center ${tiers[1].popular ? 'bg-teal/[0.02]' : ''}`}>
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
        </div>
      </section>

      <section className="bg-mist py-20 lg:py-28">
        <div className="max-w-3xl mx-auto px-6 lg:px-8">
          <div className="text-center mb-12">
            <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-3">
              FAQ
            </p>
            <h2 className="font-display text-3xl font-bold text-harbor mb-4">
              Common questions about billing.
            </h2>
            <p className="text-slate-ink/60 font-body leading-relaxed">
              Everything you need to know about our plans and pricing.
            </p>
          </div>
          <div className="bg-white rounded-2xl border border-soft-steel/30 px-6 lg:px-8 shadow-sm">
            {faqs.map((faq, i) => (
              <FAQItem key={faq.q} q={faq.q} a={faq.a} id={String(i)} />
            ))}
          </div>
        </div>
      </section>

      <section className="bg-harbor text-white py-16">
        <div className="max-w-3xl mx-auto px-6 lg:px-8 text-center">
          <h2 className="font-display text-2xl font-bold mb-4">
            Questions about pricing?
          </h2>
          <p className="text-white/60 font-body mb-8">
            Talk to our team to find the right plan for your practice.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              to="/contact"
              className="inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors"
            >
              Contact sales
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to="/signup"
              className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors"
            >
              Start free trial
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
