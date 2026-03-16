import { Link, Navigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import {
  Phone, Clock, BarChart3, Shield, ArrowRight,
  Stethoscope, Scale, Home, HeadphonesIcon, Users,
  Mic, Megaphone, Plug, MessageSquare, Bot,
  Zap, Settings, Lock, TrendingUp, PhoneCall,
  PhoneOff, DollarSign, UserX, Timer,
  CheckCircle2, Star,
} from 'lucide-react';
import { useAuth } from '../../lib/auth';
import SEO from '../../components/SEO';
import { reducedMotion } from '../../hooks/useScrollReveal';
import RevealSection from '../../components/RevealSection';

function AnimatedCounter({ end, suffix = '', duration = 2000 }: { end: number; suffix?: string; duration?: number }) {
  const [count, setCount] = useState(reducedMotion ? end : 0);
  const ref = useRef<HTMLSpanElement>(null);
  const started = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started.current) {
          started.current = true;
          const startTime = performance.now();
          const animate = (now: number) => {
            const elapsed = now - startTime;
            const progress = Math.min(elapsed / duration, 1);
            const eased = 1 - Math.pow(1 - progress, 3);
            setCount(Math.round(eased * end));
            if (progress < 1) requestAnimationFrame(animate);
          };
          requestAnimationFrame(animate);
          observer.unobserve(el);
        }
      },
      { threshold: 0.5 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [end, duration]);

  return <span ref={ref}>{count.toLocaleString()}{suffix}</span>;
}

const socialProofStats = [
  { value: 2400000, suffix: '+', label: 'Calls Handled' },
  { value: 850, suffix: '+', label: 'Agents Deployed' },
  { value: 99, suffix: '.9%', label: 'Uptime' },
  { value: 12, suffix: '+', label: 'Industries Served' },
];

const industryLogos = [
  { name: 'Healthcare', icon: Stethoscope },
  { name: 'Legal', icon: Scale },
  { name: 'Real Estate', icon: Home },
  { name: 'Finance', icon: DollarSign },
  { name: 'Support', icon: HeadphonesIcon },
  { name: 'Insurance', icon: Shield },
];

const painPoints = [
  { icon: PhoneOff, title: 'Missed Calls', desc: '67% of callers won\'t leave a voicemail — every missed call is lost revenue.' },
  { icon: DollarSign, title: 'High Staffing Costs', desc: 'Full-time receptionists cost $35K+/year per location with turnover and training overhead.' },
  { icon: UserX, title: 'Manual Call Centers', desc: 'Outsourced centers lack context about your business and frustrate callers.' },
  { icon: Timer, title: 'Slow Lead Response', desc: 'Leads contacted after 5 minutes are 10x less likely to convert.' },
];

const solutionFeatures = [
  { icon: Bot, title: 'AI Voice Agents', desc: 'Natural-sounding agents that understand context and handle complex conversations.' },
  { icon: Megaphone, title: 'Outbound Campaigns', desc: 'Automated outreach for appointment reminders, follow-ups, and lead nurturing.' },
  { icon: Plug, title: 'CRM Integrations', desc: 'Sync with your existing tools — contacts, appointments, and notes flow automatically.' },
  { icon: PhoneCall, title: '24/7 Call Answering', desc: 'Never miss a call again. Your AI agent works nights, weekends, and holidays.' },
  { icon: MessageSquare, title: 'SMS Follow-ups', desc: 'Automatic text confirmations, reminders, and follow-up messages after every call.' },
  { icon: BarChart3, title: 'Call Analytics', desc: 'Real-time dashboards with call outcomes, sentiment, and conversion tracking.' },
];

const agentTemplates = [
  {
    icon: Stethoscope,
    name: 'Medical Receptionist',
    desc: 'Handles patient intake, appointment scheduling, prescription refill requests, and insurance verification.',
    capabilities: ['Appointment booking', 'Patient triage', 'Insurance checks', 'HIPAA compliant'],
    example: '"I\'d like to schedule a checkup." → Books appointment, sends confirmation SMS',
    color: 'from-teal/20 to-calm-green/10',
    iconBg: 'bg-teal/15 text-teal',
  },
  {
    icon: Scale,
    name: 'Legal Intake',
    desc: 'Qualifies potential clients, captures case details, and schedules consultations with the right attorney.',
    capabilities: ['Case qualification', 'Conflict checks', 'Consultation scheduling', 'Document collection'],
    example: '"I need help with a car accident claim." → Captures details, books consultation',
    color: 'from-harbor/10 to-frost-blue/20',
    iconBg: 'bg-harbor/15 text-harbor',
  },
  {
    icon: Home,
    name: 'Real Estate Lead',
    desc: 'Captures buyer/seller leads, answers property questions, and books showings automatically.',
    capabilities: ['Lead capture', 'Property Q&A', 'Showing scheduler', 'CRM sync'],
    example: '"Is the house on Oak St still available?" → Answers questions, schedules showing',
    color: 'from-warm-amber/10 to-mineral-sand/30',
    iconBg: 'bg-warm-amber/15 text-warm-amber',
  },
  {
    icon: HeadphonesIcon,
    name: 'Customer Support',
    desc: 'Resolves common inquiries, processes returns, checks order status, and escalates when needed.',
    capabilities: ['Ticket creation', 'Order tracking', 'Returns processing', 'Smart escalation'],
    example: '"Where\'s my order #4521?" → Checks status, provides ETA and tracking link',
    color: 'from-teal/10 to-frost-blue/15',
    iconBg: 'bg-teal/15 text-teal',
  },
  {
    icon: DollarSign,
    name: 'Collections',
    desc: 'Professional payment reminder calls with compliant scripts, payment plan setup, and promise-to-pay tracking.',
    capabilities: ['Payment reminders', 'Plan negotiation', 'Compliance scripts', 'Payment links'],
    example: '"Can I set up a payment plan?" → Negotiates terms, sends payment link',
    color: 'from-controlled-red/10 to-warm-amber/10',
    iconBg: 'bg-controlled-red/15 text-controlled-red',
  },
];

const featureGrid = [
  { icon: Mic, title: 'Voice AI Engine', desc: 'Natural language understanding with real-time speech synthesis and emotion detection.' },
  { icon: Zap, title: 'Campaign Automation', desc: 'Schedule and launch outbound calling campaigns with dynamic scripts and branching logic.' },
  { icon: TrendingUp, title: 'Analytics Dashboard', desc: 'Track call volume, outcomes, agent performance, and ROI in real-time dashboards.' },
  { icon: Settings, title: 'Agent Customization', desc: 'Fine-tune voice, personality, scripts, and escalation rules for each agent.' },
  { icon: Plug, title: 'API Integrations', desc: 'Connect to 50+ tools including Salesforce, HubSpot, Calendly, and custom webhooks.' },
  { icon: Lock, title: 'Enterprise Security', desc: 'SOC 2 compliant, encrypted calls, role-based access, and audit logging.' },
];

const customerResults = [
  {
    metric: '400%',
    metricLabel: 'Faster Lead Response',
    industry: 'Real Estate',
    quote: 'QVO answers every inquiry within seconds. Our agents went from chasing leads to closing deals. Response time dropped from 4 hours to under a minute.',
    name: 'Marcus Rivera',
    role: 'Broker, Summit Realty Group',
    icon: Home,
  },
  {
    metric: '40%',
    metricLabel: 'Fewer Missed Calls',
    industry: 'Medical',
    quote: 'During flu season, our front desk was drowning. QVO handled overflow so seamlessly that patients thought they were speaking to our staff.',
    name: 'Dr. Sarah Chen',
    role: 'Practice Owner, Bright Smiles Dental',
    icon: Stethoscope,
  },
  {
    metric: '2x',
    metricLabel: 'Conversion Rate',
    industry: 'Legal',
    quote: 'We doubled our consultation bookings by capturing after-hours intake calls. Every potential client gets a professional first impression now.',
    name: 'James Whitfield',
    role: 'Managing Partner, Summit Legal',
    icon: Scale,
  },
];

export default function Landing() {
  const { user, initialized } = useAuth();

  if (initialized && user) {
    return <Navigate to="/dashboard" replace />;
  }

  const organizationSchema = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'QVO',
    url: window.location.origin,
    description: 'Quality Voice Operations — the voice operations hub for small businesses.',
    logo: `${window.location.origin}/og-default.png`,
    contactPoint: {
      '@type': 'ContactPoint',
      contactType: 'sales',
      url: `${window.location.origin}/contact`,
    },
  };

  return (
    <div className="overflow-hidden">
      <SEO
        title="QVO — AI Voice Agents for Small Business"
        description="QVO is the voice operations hub for small businesses. AI-powered call handling, scheduling, routing, and analytics — never miss a call again."
        canonicalPath="/"
        structuredData={organizationSchema}
      />
      <section className="relative bg-harbor text-white overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-harbor via-harbor-light/30 to-harbor" />
        <div className="absolute inset-0 opacity-10">
          <div className="absolute top-20 left-10 w-72 h-72 bg-teal rounded-full blur-[128px]" />
          <div className="absolute bottom-10 right-20 w-96 h-96 bg-teal rounded-full blur-[160px]" />
        </div>
        <div className="relative max-w-7xl mx-auto px-6 lg:px-8 py-24 lg:py-36">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div>
              <div className="inline-flex items-center gap-2 bg-teal/15 border border-teal/25 rounded-full px-4 py-1.5 mb-6">
                <span className="w-2 h-2 rounded-full bg-teal animate-pulse" />
                <span className="text-teal text-sm font-medium">AI-Powered Voice Platform</span>
              </div>
              <h1 className="font-display text-4xl md:text-5xl lg:text-6xl font-bold leading-[1.1] mb-6">
                <span className="hero-gradient-text">AI Voice Agents</span> That Answer Calls, Run Campaigns, And Automate Your Business
              </h1>
              <p className="text-lg lg:text-xl text-white/65 leading-relaxed mb-10 max-w-xl font-body">
                Deploy intelligent voice agents that handle inbound calls, run outbound campaigns, and integrate with your CRM — all while you focus on growing your business.
              </p>
              <div className="flex flex-col sm:flex-row gap-4">
                <Link
                  to="/signup"
                  className="inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-7 py-3.5 rounded-xl transition-all text-sm shadow-lg shadow-teal/25 hover:shadow-teal/40"
                >
                  Start Free Trial
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  to="/demo"
                  className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 backdrop-blur-sm text-white font-semibold px-7 py-3.5 rounded-xl transition-all text-sm border border-white/10"
                >
                  Watch Demo
                </Link>
              </div>
            </div>
            <div className="hidden lg:block">
              <div className="relative">
                <div className="glass-card rounded-2xl p-6 shadow-2xl">
                  <div className="flex items-center gap-3 mb-4">
                    <div className="w-3 h-3 rounded-full bg-controlled-red/70" />
                    <div className="w-3 h-3 rounded-full bg-warm-amber/70" />
                    <div className="w-3 h-3 rounded-full bg-calm-green/70" />
                    <span className="text-xs text-white/40 ml-2 font-mono">QVO Dashboard</span>
                  </div>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between p-3 rounded-lg bg-white/5">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-teal/20 flex items-center justify-center">
                          <Phone className="w-4 h-4 text-teal" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-white/90">Active Calls</p>
                          <p className="text-xs text-white/50">3 agents handling</p>
                        </div>
                      </div>
                      <span className="text-2xl font-bold font-display text-teal">12</span>
                    </div>
                    <div className="flex items-center justify-between p-3 rounded-lg bg-white/5">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-calm-green/20 flex items-center justify-center">
                          <TrendingUp className="w-4 h-4 text-calm-green" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-white/90">Today's Calls</p>
                          <p className="text-xs text-white/50">94% resolution rate</p>
                        </div>
                      </div>
                      <span className="text-2xl font-bold font-display text-calm-green">247</span>
                    </div>
                    <div className="flex items-center justify-between p-3 rounded-lg bg-white/5">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-warm-amber/20 flex items-center justify-center">
                          <Users className="w-4 h-4 text-warm-amber" />
                        </div>
                        <div>
                          <p className="text-sm font-medium text-white/90">Leads Captured</p>
                          <p className="text-xs text-white/50">+18% this week</p>
                        </div>
                      </div>
                      <span className="text-2xl font-bold font-display text-warm-amber">83</span>
                    </div>
                  </div>
                </div>
                <div className="absolute -bottom-4 -right-4 glass-card rounded-xl p-4 shadow-xl">
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-full bg-calm-green/20 flex items-center justify-center">
                      <CheckCircle2 className="w-3.5 h-3.5 text-calm-green" />
                    </div>
                    <div>
                      <p className="text-xs font-medium text-white/90">Call Completed</p>
                      <p className="text-[10px] text-white/50">Appointment booked — 2m 34s</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="bg-harbor/95 border-t border-white/5">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 py-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-8">
            {socialProofStats.map((stat) => (
              <div key={stat.label} className="text-center">
                <p className="font-display text-2xl md:text-3xl font-bold text-white">
                  <AnimatedCounter end={stat.value} suffix={stat.suffix} />
                </p>
                <p className="text-xs md:text-sm text-white/50 font-body mt-1">{stat.label}</p>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-center gap-6 mt-6 pt-6 border-t border-white/5">
            <span className="text-xs text-white/30 uppercase tracking-wider font-medium">Trusted by</span>
            {industryLogos.map((logo) => (
              <div key={logo.name} className="flex items-center gap-1.5 opacity-40 hover:opacity-60 transition-opacity">
                <logo.icon className="h-4 w-4 text-white" />
                <span className="text-xs font-medium text-white">{logo.name}</span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-mist">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-16">
              <span className="inline-block text-sm font-semibold text-controlled-red bg-controlled-red/10 px-4 py-1.5 rounded-full mb-4">The Problem</span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
                Every Missed Call Is a Missed Opportunity
              </h2>
              <p className="text-lg text-slate-ink/60 font-body max-w-2xl mx-auto">
                Small businesses lose thousands in revenue every month to unanswered calls, slow response times, and overwhelmed front desks.
              </p>
            </div>
          </RevealSection>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 mb-16">
            {painPoints.map((point, i) => (
              <RevealSection key={point.title} delay={`scroll-delay-${i + 1}`}>
                <div className="bg-white rounded-2xl border border-controlled-red/10 p-6 hover:shadow-lg transition-shadow h-full">
                  <div className="w-11 h-11 rounded-xl bg-controlled-red/10 flex items-center justify-center mb-4">
                    <point.icon className="h-5 w-5 text-controlled-red" />
                  </div>
                  <h3 className="font-display text-lg font-semibold text-harbor mb-2">{point.title}</h3>
                  <p className="text-sm text-slate-ink/60 leading-relaxed font-body">{point.desc}</p>
                </div>
              </RevealSection>
            ))}
          </div>

          <RevealSection>
            <div className="text-center mb-12">
              <span className="inline-block text-sm font-semibold text-teal bg-teal/10 px-4 py-1.5 rounded-full mb-4">The Solution</span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
                QVO Handles It All
              </h2>
              <p className="text-lg text-slate-ink/60 font-body max-w-2xl mx-auto">
                One platform to answer calls, run campaigns, and automate your entire voice operations.
              </p>
            </div>
          </RevealSection>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {solutionFeatures.map((f, i) => (
              <RevealSection key={f.title} delay={`scroll-delay-${(i % 3) + 1}`}>
                <div className="glass-card-light rounded-2xl p-7 hover:shadow-lg transition-all border border-teal/10 hover:border-teal/25 h-full">
                  <div className="w-11 h-11 rounded-xl bg-teal/10 flex items-center justify-center mb-4">
                    <f.icon className="h-5 w-5 text-teal" />
                  </div>
                  <h3 className="font-display text-lg font-semibold text-harbor mb-2">{f.title}</h3>
                  <p className="text-sm text-slate-ink/60 leading-relaxed font-body">{f.desc}</p>
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
              <span className="inline-block text-sm font-semibold text-harbor bg-harbor/10 px-4 py-1.5 rounded-full mb-4">Agent Marketplace</span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
                Pre-Built Agents, Ready to Deploy
              </h2>
              <p className="text-lg text-slate-ink/60 font-body max-w-2xl mx-auto">
                Choose from industry-specific agent templates. Customize scripts, personality, and integrations — then go live in minutes.
              </p>
            </div>
          </RevealSection>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-10">
            {agentTemplates.map((agent, i) => (
              <RevealSection key={agent.name} delay={`scroll-delay-${(i % 3) + 1}`}>
                <div className={`relative rounded-2xl p-7 bg-gradient-to-br ${agent.color} border border-soft-steel/30 hover:shadow-lg transition-all h-full group`}>
                  <div className={`w-12 h-12 rounded-xl ${agent.iconBg} flex items-center justify-center mb-4`}>
                    <agent.icon className="h-6 w-6" />
                  </div>
                  <h3 className="font-display text-lg font-semibold text-harbor mb-2">{agent.name}</h3>
                  <p className="text-sm text-slate-ink/60 leading-relaxed font-body mb-3">{agent.desc}</p>
                  <div className="bg-white/50 rounded-lg p-3 mb-4 border border-soft-steel/15">
                    <p className="text-xs text-slate-ink/70 font-body italic leading-relaxed">{agent.example}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {agent.capabilities.map((cap) => (
                      <span key={cap} className="text-xs font-medium bg-white/70 text-harbor/80 px-2.5 py-1 rounded-full border border-soft-steel/20">
                        {cap}
                      </span>
                    ))}
                  </div>
                </div>
              </RevealSection>
            ))}
          </div>

          <RevealSection>
            <div className="text-center">
              <Link
                to="/agents"
                className="inline-flex items-center gap-2 text-sm font-semibold text-teal hover:text-teal-hover transition-colors"
              >
                Explore Marketplace
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </RevealSection>
        </div>
      </section>

      <section className="py-20 lg:py-28 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-mist via-frost-blue/30 to-mist" />
        <div className="relative max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <span className="inline-block text-sm font-semibold text-teal bg-teal/10 px-4 py-1.5 rounded-full mb-4">Platform Capabilities</span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
                Everything You Need to Automate Voice Operations
              </h2>
              <p className="text-lg text-slate-ink/60 font-body max-w-2xl mx-auto">
                A complete toolkit for managing AI voice agents, campaigns, and analytics in one place.
              </p>
            </div>
          </RevealSection>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {featureGrid.map((f, i) => (
              <RevealSection key={f.title} delay={`scroll-delay-${(i % 3) + 1}`}>
                <div className="bg-white rounded-2xl p-7 border border-soft-steel/30 hover:border-teal/25 hover:shadow-lg transition-all h-full">
                  <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-teal/15 to-harbor/10 flex items-center justify-center mb-4">
                    <f.icon className="h-5 w-5 text-teal" />
                  </div>
                  <h3 className="font-display text-lg font-semibold text-harbor mb-2">{f.title}</h3>
                  <p className="text-sm text-slate-ink/60 leading-relaxed font-body">{f.desc}</p>
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
              <span className="inline-block text-sm font-semibold text-calm-green bg-calm-green/10 px-4 py-1.5 rounded-full mb-4">Customer Results</span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
                Real Businesses, Real Results
              </h2>
              <p className="text-lg text-slate-ink/60 font-body max-w-2xl mx-auto">
                See how businesses across industries are transforming their operations with QVO.
              </p>
            </div>
          </RevealSection>

          <div className="grid md:grid-cols-3 gap-8">
            {customerResults.map((result, i) => (
              <RevealSection key={result.industry} delay={`scroll-delay-${i + 1}`}>
                <div className="relative bg-mist rounded-2xl p-8 border border-soft-steel/30 hover:shadow-lg transition-all h-full">
                  <div className="flex items-center gap-3 mb-5">
                    <div className="w-10 h-10 rounded-xl bg-teal/10 flex items-center justify-center">
                      <result.icon className="h-5 w-5 text-teal" />
                    </div>
                    <span className="text-xs font-semibold uppercase tracking-wider text-slate-ink/40">{result.industry}</span>
                  </div>
                  <div className="mb-5">
                    <span className="font-display text-4xl font-bold text-teal">{result.metric}</span>
                    <span className="block text-sm font-semibold text-harbor mt-1">{result.metricLabel}</span>
                  </div>
                  <p className="text-sm text-slate-ink/60 font-body leading-relaxed mb-6 italic">
                    "{result.quote}"
                  </p>
                  <div className="flex items-center gap-1 mb-3">
                    {[...Array(5)].map((_, j) => (
                      <Star key={j} className="w-3.5 h-3.5 fill-warm-amber text-warm-amber" />
                    ))}
                  </div>
                  <div>
                    <p className="font-display text-sm font-semibold text-harbor">{result.name}</p>
                    <p className="text-xs text-slate-ink/50 font-body mt-0.5">{result.role}</p>
                  </div>
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
              Deploy Your First AI Voice Agent Today
            </h2>
            <p className="text-lg text-white/60 font-body mb-10 max-w-xl mx-auto">
              Join hundreds of businesses using QVO to automate calls, capture leads, and grow revenue. No contracts, cancel anytime.
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                to="/signup"
                className="inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-8 py-3.5 rounded-xl transition-all text-sm shadow-lg shadow-teal/30 hover:shadow-teal/50"
              >
                Start Free Trial
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/contact"
                className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 backdrop-blur-sm text-white font-semibold px-8 py-3.5 rounded-xl transition-all text-sm border border-white/10"
              >
                Book a Demo
              </Link>
            </div>
          </div>
        </RevealSection>
      </section>
    </div>
  );
}
