import { Link, Navigate } from 'react-router-dom';
import {
  Phone, Clock, BarChart3, Shield, Calendar, ArrowRight,
  Headphones, Building2, Stethoscope, Scale, Home, Users, Megaphone,
  Plug, MessageSquare, CheckCircle2,
} from 'lucide-react';
import { useAuth } from '../../lib/auth';

const features = [
  {
    icon: Clock,
    title: 'Always-on coverage',
    desc: 'Calls are answered professionally after hours, during lunch, and when your team is at capacity.',
  },
  {
    icon: Phone,
    title: 'Smart routing',
    desc: 'Route calls based on urgency, department, or caller history. Escalate when needed.',
  },
  {
    icon: Calendar,
    title: 'Scheduling continuity',
    desc: 'Book, confirm, and reschedule appointments without dropping the conversation.',
  },
  {
    icon: BarChart3,
    title: 'Operational visibility',
    desc: 'See every call, outcome, and follow-up. Know exactly what happened after the phones rolled over.',
  },
  {
    icon: Shield,
    title: 'Quality assurance',
    desc: 'AI-scored interactions, transcript review, and prompt version tracking for continuous improvement.',
  },
  {
    icon: Building2,
    title: 'Multi-location ready',
    desc: 'One platform for all your sites. Separate agents, numbers, and reporting per location.',
  },
];

const useCases = [
  { icon: Stethoscope, label: 'Medical', color: 'bg-teal/10 text-teal' },
  { icon: Headphones, label: 'Dental', color: 'bg-harbor/10 text-harbor' },
  { icon: Scale, label: 'Legal', color: 'bg-teal/10 text-teal' },
  { icon: Home, label: 'Property Mgmt', color: 'bg-harbor/10 text-harbor' },
  { icon: Users, label: 'Support', color: 'bg-teal/10 text-teal' },
  { icon: Megaphone, label: 'Outbound Sales', color: 'bg-harbor/10 text-harbor' },
];

const pricingTiers = [
  { name: 'Starter', price: 99, minutes: 500, overage: '0.15', plan: 'starter' },
  { name: 'Pro', price: 399, minutes: 2500, overage: '0.12', plan: 'pro', popular: true },
  { name: 'Enterprise', price: 999, minutes: 10000, overage: '0.08', plan: 'enterprise' },
];

const testimonials = [
  {
    quote: 'We stopped losing after-hours patients the week we turned QVO on. The scheduling continuity alone paid for itself.',
    name: 'Dr. Sarah Chen',
    role: 'Practice Owner, Bright Smiles Dental',
  },
  {
    quote: 'Our front desk was overwhelmed during flu season. QVO handled overflow calls so professionally that patients thought they were talking to staff.',
    name: 'Maria Torres',
    role: 'Office Manager, Westside Medical Group',
  },
  {
    quote: 'The visibility into after-hours calls changed how we run our practice. We finally know what happens when the office closes.',
    name: 'James Whitfield',
    role: 'Operations Director, Summit Legal Partners',
  },
];

export default function Landing() {
  const { user, initialized } = useAuth();

  if (initialized && user) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div>
      <section className="bg-harbor text-white">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 py-20 lg:py-32">
          <div className="max-w-3xl">
            <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-4">
              Voice Operations Hub
            </p>
            <h1 className="font-display text-4xl lg:text-6xl font-bold leading-tight mb-6">
              After-hours voice operations, handled with control.
            </h1>
            <p className="text-lg lg:text-xl text-white/70 leading-relaxed mb-10 max-w-2xl font-body">
              QVO answers, routes, and schedules with the consistency your front desk expects and the visibility your operators need.
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link
                to="/login?mode=signup"
                className="inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-6 py-3.5 rounded-lg transition-colors text-sm"
              >
                Start free trial
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/demo"
                className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 text-white font-semibold px-6 py-3.5 rounded-lg transition-colors text-sm"
              >
                Try the live demo
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-2xl mb-14">
            <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
              Your front desk, extended.
            </h2>
            <p className="text-lg text-slate-ink/60 font-body leading-relaxed">
              Never wonder what happened after the phones rolled over. QVO gives your team a structured voice operations layer that keeps scheduling and intake moving.
            </p>
          </div>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {features.map((f) => (
              <div
                key={f.title}
                className="bg-white rounded-2xl border border-soft-steel/50 p-7 hover:border-teal/30 transition-colors"
              >
                <div className="w-10 h-10 rounded-xl bg-teal/10 flex items-center justify-center mb-4">
                  <f.icon className="h-5 w-5 text-teal" />
                </div>
                <h3 className="font-display text-lg font-semibold text-harbor mb-2">{f.title}</h3>
                <p className="text-sm text-slate-ink/60 leading-relaxed font-body">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-white py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="text-center mb-14">
            <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
              Built for the industries that can't miss a call.
            </h2>
            <p className="text-lg text-slate-ink/60 font-body max-w-2xl mx-auto">
              Preconfigured agent templates for the verticals that depend on responsive voice operations.
            </p>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            {useCases.map((uc) => (
              <Link
                key={uc.label}
                to="/use-cases"
                className="flex flex-col items-center gap-3 p-6 rounded-2xl bg-mist hover:bg-frost-blue/50 border border-transparent hover:border-teal/20 transition-all"
              >
                <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${uc.color}`}>
                  <uc.icon className="h-6 w-6" />
                </div>
                <span className="font-display text-sm font-semibold text-harbor text-center">{uc.label}</span>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="text-center mb-14">
            <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
              Simple, transparent pricing.
            </h2>
            <p className="text-lg text-slate-ink/60 font-body max-w-2xl mx-auto">
              Choose the plan that fits your call volume. Scale up anytime.
            </p>
          </div>
          <div className="grid md:grid-cols-3 gap-6 max-w-4xl mx-auto">
            {pricingTiers.map((tier) => (
              <div
                key={tier.name}
                className={`relative bg-white rounded-2xl border p-8 ${
                  tier.popular
                    ? 'border-teal ring-2 ring-teal/20'
                    : 'border-soft-steel/50'
                }`}
              >
                {tier.popular && (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-teal text-white text-xs font-semibold px-3 py-1 rounded-full">
                    Most popular
                  </span>
                )}
                <h3 className="font-display text-xl font-bold text-harbor mb-1">{tier.name}</h3>
                <div className="mb-4">
                  <span className="font-display text-4xl font-bold text-harbor">${tier.price}</span>
                  <span className="text-sm text-slate-ink/50 font-body">/month</span>
                </div>
                <ul className="space-y-2.5 mb-8 text-sm font-body text-slate-ink/70">
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-calm-green shrink-0" />
                    {tier.minutes.toLocaleString()} AI minutes included
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-calm-green shrink-0" />
                    ${tier.overage}/min overage
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-calm-green shrink-0" />
                    Unlimited agents
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-calm-green shrink-0" />
                    Full analytics
                  </li>
                </ul>
                <Link
                  to={`/login?mode=signup&plan=${tier.plan}`}
                  className={`block text-center font-semibold py-2.5 px-4 rounded-lg text-sm transition-colors ${
                    tier.popular
                      ? 'bg-teal hover:bg-teal-hover text-white'
                      : 'bg-harbor/5 hover:bg-harbor/10 text-harbor'
                  }`}
                >
                  Get started
                </Link>
              </div>
            ))}
          </div>
          <p className="text-center mt-8">
            <Link to="/pricing" className="text-sm font-medium text-teal hover:text-teal-hover transition-colors">
              Compare all plan features &rarr;
            </Link>
          </p>
        </div>
      </section>

      <section className="bg-white py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="text-center mb-14">
            <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
              Trusted by operations teams.
            </h2>
          </div>
          <div className="grid md:grid-cols-3 gap-8">
            {testimonials.map((t, i) => (
              <div key={i} className="bg-mist rounded-2xl p-8 border border-soft-steel/30">
                <p className="text-slate-ink/70 font-body leading-relaxed mb-6 text-sm italic">
                  "{t.quote}"
                </p>
                <div>
                  <p className="font-display text-sm font-semibold text-harbor">{t.name}</p>
                  <p className="text-xs text-slate-ink/50 font-body mt-0.5">{t.role}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-harbor text-white py-20 lg:py-24">
        <div className="max-w-3xl mx-auto px-6 lg:px-8 text-center">
          <h2 className="font-display text-3xl lg:text-4xl font-bold mb-4">
            Ready to stop missing calls?
          </h2>
          <p className="text-lg text-white/60 font-body mb-10">
            Set up your voice operations hub in minutes. No contracts, cancel anytime.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              to="/login?mode=signup"
              className="inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-8 py-3.5 rounded-lg transition-colors text-sm"
            >
              Start free trial
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to="/contact"
              className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 text-white font-semibold px-8 py-3.5 rounded-lg transition-colors text-sm"
            >
              Talk to sales
            </Link>
          </div>
        </div>
      </section>

      <section className="py-16">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="flex flex-wrap items-center justify-center gap-8 opacity-40">
            {['CRM', 'Scheduling', 'Ticketing', 'SMS', 'Email', 'Webhooks'].map((name) => (
              <div key={name} className="flex items-center gap-2">
                <Plug className="h-4 w-4" />
                <span className="font-display text-sm font-semibold text-harbor">{name}</span>
              </div>
            ))}
          </div>
          <p className="text-center mt-4">
            <Link to="/integrations" className="text-xs font-medium text-teal hover:text-teal-hover transition-colors">
              View all integrations &rarr;
            </Link>
          </p>
        </div>
      </section>
    </div>
  );
}
