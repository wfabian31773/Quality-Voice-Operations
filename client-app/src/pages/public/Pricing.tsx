import { Link } from 'react-router-dom';
import { CheckCircle2, X as XIcon, ArrowRight } from 'lucide-react';

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
  { key: 'starter' as const, name: 'Starter', price: 99, desc: 'For small practices getting started with voice automation.' },
  { key: 'pro' as const, name: 'Pro', price: 399, desc: 'For growing businesses that need campaigns and integrations.', popular: true },
  { key: 'enterprise' as const, name: 'Enterprise', price: 999, desc: 'For multi-location organizations with high call volume.' },
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
          <div className="grid md:grid-cols-3 gap-6 max-w-4xl mx-auto mb-20">
            {tiers.map((tier) => (
              <div
                key={tier.key}
                className={`relative bg-white rounded-2xl border p-8 ${
                  tier.popular ? 'border-teal ring-2 ring-teal/20' : 'border-soft-steel/50'
                }`}
              >
                {tier.popular && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-teal text-white text-xs font-semibold px-3 py-1 rounded-full">
                    Most popular
                  </span>
                )}
                <h3 className="font-display text-xl font-bold text-harbor mb-1">{tier.name}</h3>
                <p className="text-sm text-slate-ink/50 font-body mb-4">{tier.desc}</p>
                <div className="mb-6">
                  <span className="font-display text-4xl font-bold text-harbor">${tier.price}</span>
                  <span className="text-sm text-slate-ink/50 font-body">/month</span>
                </div>
                <Link
                  to={`/signup?plan=${tier.key}`}
                  className={`block text-center font-semibold py-3 px-4 rounded-lg text-sm transition-colors ${
                    tier.popular
                      ? 'bg-teal hover:bg-teal-hover text-white'
                      : 'bg-harbor/5 hover:bg-harbor/10 text-harbor'
                  }`}
                >
                  Start free trial
                </Link>
              </div>
            ))}
          </div>

          <div className="max-w-5xl mx-auto">
            <h2 className="font-display text-2xl font-bold text-harbor mb-8 text-center">
              Compare all features
            </h2>
            <div className="bg-white rounded-2xl border border-soft-steel/50 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-soft-steel/30">
                      <th className="text-left py-4 px-6 font-display text-sm font-semibold text-harbor">Feature</th>
                      {tiers.map((t) => (
                        <th key={t.key} className="text-center py-4 px-4 font-display text-sm font-semibold text-harbor w-32">{t.name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {features.map((f, i) => (
                      <tr key={f.name} className={i % 2 === 0 ? 'bg-mist/50' : ''}>
                        <td className="py-3.5 px-6 text-sm text-slate-ink/70 font-body">{f.name}</td>
                        <td className="py-3.5 px-4 text-center"><FeatureCell value={f.starter} /></td>
                        <td className="py-3.5 px-4 text-center"><FeatureCell value={f.pro} /></td>
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

      <section className="bg-harbor text-white py-16">
        <div className="max-w-3xl mx-auto px-6 lg:px-8 text-center">
          <h2 className="font-display text-2xl font-bold mb-4">
            Questions about pricing?
          </h2>
          <p className="text-white/60 font-body mb-8">
            Talk to our team to find the right plan for your practice.
          </p>
          <Link
            to="/contact"
            className="inline-flex items-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors"
          >
            Contact sales
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>
    </div>
  );
}
