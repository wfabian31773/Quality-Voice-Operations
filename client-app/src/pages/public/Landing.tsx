import { Link, Navigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import {
  Phone, Clock, BarChart3, Shield, ArrowRight,
  Stethoscope, Scale, Home, HeadphonesIcon, Users,
  Mic, Megaphone, Plug, MessageSquare, Bot,
  Zap, Settings, Lock, TrendingUp, PhoneCall,
  PhoneOff, DollarSign, UserX, Timer,
  CheckCircle2, Star, Wrench,
  CalendarCheck, Truck, HelpCircle, ShieldCheck,
} from 'lucide-react';
import {
  VoiceAgentIcon, MegaphoneIcon, IntegrationsIcon, AlwaysOnIcon,
  SmsFollowupIcon, AnalyticsIcon, VoiceEngineIcon, AutomationIcon,
  DashboardIcon, CustomizationIcon, ApiIcon, SecurityIcon,
} from '../../components/illustrations/FeatureIcons';
import { useAuth } from '../../lib/auth';
import SEO from '../../components/SEO';
import { reducedMotion } from '../../hooks/useScrollReveal';
import RevealSection from '../../components/RevealSection';
import ComparisonTable from '../../components/ComparisonTable';
import TestimonialsCarousel from '../../components/TestimonialsCarousel';
import LogosStrip from '../../components/LogosStrip';
import LiveTranscriptMock from '../../components/LiveTranscriptMock';
import IndustryShowcase from '../../components/IndustryShowcase';
import { trackPageView, trackCTAClick, trackConversionEvent, captureUtmOnLoad } from '../../lib/analytics';

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
  { name: 'Home Services', icon: Wrench },
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
  { icon: VoiceAgentIcon, title: 'AI Voice Agents', desc: 'Natural-sounding agents that understand context and handle complex conversations.' },
  { icon: MegaphoneIcon, title: 'Outbound Campaigns', desc: 'Automated outreach for appointment reminders, follow-ups, and lead nurturing.' },
  { icon: IntegrationsIcon, title: 'CRM Integrations', desc: 'Sync with your existing tools — contacts, appointments, and notes flow automatically.' },
  { icon: AlwaysOnIcon, title: '24/7 Call Answering', desc: 'Never miss a call again. Your AI agent works nights, weekends, and holidays.' },
  { icon: SmsFollowupIcon, title: 'SMS Follow-ups', desc: 'Automatic text confirmations, reminders, and follow-up messages after every call.' },
  { icon: AnalyticsIcon, title: 'Call Analytics', desc: 'Real-time dashboards with call outcomes, sentiment, and conversion tracking.' },
];

const agentTemplates = [
  {
    icon: Stethoscope,
    name: 'Medical Receptionist',
    desc: 'Handles patient intake, appointment scheduling, prescription refill requests, and insurance verification.',
    capabilities: ['Appointment booking', 'Patient triage', 'Insurance checks', 'HIPAA compliant'],
    example: '"I\'d like to schedule a checkup." → Books appointment, sends confirmation SMS',
    color: 'from-primary/20 to-success/10',
    iconBg: 'bg-primary/15 text-primary',
    avatar: '/assets/avatars/medical.png',
  },
  {
    icon: Scale,
    name: 'Legal Intake',
    desc: 'Qualifies potential clients, captures case details, and schedules consultations with the right attorney.',
    capabilities: ['Case qualification', 'Conflict checks', 'Consultation scheduling', 'Document collection'],
    example: '"I need help with a car accident claim." → Captures details, books consultation',
    color: 'from-sidebar-bg/10 to-info-light/20',
    iconBg: 'bg-sidebar-bg/15 text-text-primary',
    avatar: '/assets/avatars/legal.png',
  },
  {
    icon: Home,
    name: 'Real Estate Lead',
    desc: 'Captures buyer/seller leads, answers property questions, and books showings automatically.',
    capabilities: ['Lead capture', 'Property Q&A', 'Showing scheduler', 'CRM sync'],
    example: '"Is the house on Oak St still available?" → Answers questions, schedules showing',
    color: 'from-accent/10 to-accent-light/30',
    iconBg: 'bg-accent/15 text-accent',
    avatar: '/assets/avatars/real-estate.png',
  },
  {
    icon: HeadphonesIcon,
    name: 'Customer Support',
    desc: 'Resolves common inquiries, processes returns, checks order status, and escalates when needed.',
    capabilities: ['Ticket creation', 'Order tracking', 'Returns processing', 'Smart escalation'],
    example: '"Where\'s my order #4521?" → Checks status, provides ETA and tracking link',
    color: 'from-primary/10 to-info-light/15',
    iconBg: 'bg-primary/15 text-primary',
    avatar: '/assets/avatars/customer-support.png',
  },
  {
    icon: DollarSign,
    name: 'Collections',
    desc: 'Professional payment reminder calls with compliant scripts, payment plan setup, and promise-to-pay tracking.',
    capabilities: ['Payment reminders', 'Plan negotiation', 'Compliance scripts', 'Payment links'],
    example: '"Can I set up a payment plan?" → Negotiates terms, sends payment link',
    color: 'from-danger/10 to-accent/10',
    iconBg: 'bg-danger/15 text-danger',
    avatar: '/assets/avatars/collections.png',
  },
  {
    icon: Wrench,
    name: 'HVAC / Home Services',
    desc: 'Handles service calls, triages emergencies, dispatches technicians, and sends customers real-time ETAs via SMS.',
    capabilities: ['Service call intake', 'Emergency triage', 'Tech dispatch', 'SMS ETAs'],
    example: '"My AC stopped working." → Captures details, dispatches tech, sends ETA',
    color: 'from-orange-100/80 to-accent/10',
    iconBg: 'bg-orange-100 text-orange-700',
    avatar: '/assets/avatars/hvac.png',
  },
];

const featureGrid = [
  { icon: VoiceEngineIcon, title: 'Voice AI Engine', desc: 'Natural language understanding with real-time speech synthesis and emotion detection.' },
  { icon: AutomationIcon, title: 'Campaign Automation', desc: 'Schedule and launch outbound calling campaigns with dynamic scripts and branching logic.' },
  { icon: DashboardIcon, title: 'Analytics Dashboard', desc: 'Track call volume, outcomes, agent performance, and ROI in real-time dashboards.' },
  { icon: CustomizationIcon, title: 'Agent Customization', desc: 'Fine-tune voice, personality, scripts, and escalation rules for each agent.' },
  { icon: ApiIcon, title: 'API Integrations', desc: 'Connect to 50+ tools including Salesforce, HubSpot, Calendly, and custom webhooks.' },
  { icon: SecurityIcon, title: 'Enterprise Security', desc: 'SOC 2 compliant, encrypted calls, role-based access, and audit logging.' },
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

  useEffect(() => {
    trackPageView('/');
    captureUtmOnLoad();
    trackConversionEvent('page_view', '/');
  }, []);

  if (initialized && user) {
    return <Navigate to="/dashboard" replace />;
  }

  const keyBenefits = [
    { icon: PhoneCall, text: 'Never Miss a Call' },
    { icon: CalendarCheck, text: 'Book Appointments Automatically' },
    { icon: Truck, text: 'Dispatch Technicians Instantly' },
    { icon: HelpCircle, text: 'Answer Questions 24/7' },
  ];

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
        title="QVO — AI Voice Agents That Run Your Business"
        description="AI voice agents for call answering, appointment scheduling, and business automation. AI receptionist and call automation for HVAC, medical offices, dental, legal, and more."
        canonicalPath="/"
        structuredData={organizationSchema}
      />
      <section className="relative bg-sidebar-bg text-white overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-sidebar-bg via-sidebar-hover/30 to-sidebar-bg" />
        <div className="absolute inset-0 opacity-10">
          <div className="absolute top-20 left-10 w-72 h-72 bg-primary rounded-full blur-[128px]" />
          <div className="absolute bottom-10 right-20 w-96 h-96 bg-primary rounded-full blur-[160px]" />
        </div>
        <div className="relative max-w-7xl mx-auto px-6 lg:px-8 py-24 lg:py-36">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div>
              <div className="inline-flex items-center gap-2 bg-primary/15 border border-primary/25 rounded-full px-4 py-1.5 mb-6">
                <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                <span className="text-primary text-sm font-medium">AI-Powered Voice Platform</span>
              </div>
              <h1 className="font-display text-4xl md:text-5xl lg:text-6xl font-bold leading-[1.1] mb-6">
                <span className="hero-gradient-text">AI Voice Agents</span> That Run Your Business
              </h1>
              <p className="text-lg lg:text-xl text-white/65 leading-relaxed mb-8 max-w-xl font-body">
                Deploy intelligent voice agents that answer calls, book appointments, dispatch technicians, and answer customer questions — 24/7, on autopilot.
              </p>
              <div className="grid grid-cols-2 gap-3 mb-8">
                {keyBenefits.map((benefit) => (
                  <div key={benefit.text} className="flex items-center gap-2 text-sm text-white/80">
                    <benefit.icon className="h-4 w-4 text-primary shrink-0" />
                    <span className="font-body">{benefit.text}</span>
                  </div>
                ))}
              </div>
              <div className="flex flex-col sm:flex-row gap-4">
                <Link
                  to="/demo"
                  className="btn-primary-glow inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-on-primary font-semibold px-7 py-3.5 rounded-xl transition-colors duration-[var(--motion-base)] text-sm min-h-[44px]"
                  onClick={() => trackCTAClick('Try Live Demo', '/', 'hero')}
                >
                  Try Live Demo
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  to="/product"
                  className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 backdrop-blur-sm text-white font-semibold px-7 py-3.5 rounded-xl transition-colors duration-[var(--motion-base)] text-sm border border-white/15 hover:border-white/25 min-h-[44px]"
                  onClick={() => trackCTAClick('See How It Works', '/', 'hero')}
                >
                  See How It Works
                </Link>
              </div>
            </div>
            <div className="hidden lg:block">
              <LiveTranscriptMock />
            </div>
          </div>
        </div>
      </section>

      <section className="bg-sidebar-bg/95 border-t border-white/5">
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
          <div className="flex flex-wrap items-center justify-center gap-3 mt-6">
            <Link to="/security" className="inline-flex items-center gap-1.5 text-[11px] text-white/55 hover:text-white border border-white/15 hover:border-white/30 rounded-full px-3 py-1 transition-colors">
              <ShieldCheck className="h-3 w-3 text-primary" /> SOC 2 in progress
            </Link>
            <Link to="/security" className="inline-flex items-center gap-1.5 text-[11px] text-white/55 hover:text-white border border-white/15 hover:border-white/30 rounded-full px-3 py-1 transition-colors">
              <ShieldCheck className="h-3 w-3 text-primary" /> HIPAA-ready
            </Link>
            <Link to="/security" className="inline-flex items-center gap-1.5 text-[11px] text-white/55 hover:text-white border border-white/15 hover:border-white/30 rounded-full px-3 py-1 transition-colors">
              <ShieldCheck className="h-3 w-3 text-primary" /> GDPR compliant
            </Link>
            <Link to="/security" className="inline-flex items-center gap-1.5 text-[11px] text-white/55 hover:text-white border border-white/15 hover:border-white/30 rounded-full px-3 py-1 transition-colors">
              <ShieldCheck className="h-3 w-3 text-primary" /> AES-256 encryption
            </Link>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-surface-secondary">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-16">
              <span className="inline-block text-sm font-semibold text-danger bg-danger/10 px-4 py-1.5 rounded-full mb-4">The Problem</span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                Every Missed Call Is a Missed Opportunity
              </h2>
              <p className="text-lg text-text-primary/60 font-body max-w-2xl mx-auto">
                Small businesses lose thousands in revenue every month to unanswered calls, slow response times, and overwhelmed front desks.
              </p>
            </div>
          </RevealSection>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 mb-16">
            {painPoints.map((point, i) => (
              <RevealSection key={point.title} delay={`scroll-delay-${i + 1}`}>
                <div className="bg-white rounded-2xl border border-danger/10 p-6 hover:shadow-lg transition-shadow h-full">
                  <div className="w-11 h-11 rounded-xl bg-danger/10 flex items-center justify-center mb-4">
                    <point.icon className="h-5 w-5 text-danger" />
                  </div>
                  <h3 className="font-display text-lg font-semibold text-text-primary mb-2">{point.title}</h3>
                  <p className="text-sm text-text-primary/60 leading-relaxed font-body">{point.desc}</p>
                </div>
              </RevealSection>
            ))}
          </div>

          <RevealSection>
            <div className="text-center mb-12">
              <span className="inline-block text-sm font-semibold text-primary bg-primary/10 px-4 py-1.5 rounded-full mb-4">The Solution</span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                QVO Handles It All
              </h2>
              <p className="text-lg text-text-primary/60 font-body max-w-2xl mx-auto">
                One platform to answer calls, run campaigns, and automate your entire voice operations.
              </p>
            </div>
          </RevealSection>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {solutionFeatures.map((f, i) => (
              <RevealSection key={f.title} delay={`scroll-delay-${(i % 3) + 1}`}>
                <div className="glass-card-light rounded-2xl p-7 hover:shadow-lg transition-all border border-primary/10 hover:border-primary/25 h-full">
                  <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                    <f.icon className="h-5 w-5 text-primary" />
                  </div>
                  <h3 className="font-display text-lg font-semibold text-text-primary mb-2">{f.title}</h3>
                  <p className="text-sm text-text-primary/60 leading-relaxed font-body">{f.desc}</p>
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
              <span className="inline-block text-sm font-semibold text-text-primary bg-sidebar-bg/10 px-4 py-1.5 rounded-full mb-4">Agent Marketplace</span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                Pre-Built Agents, Ready to Deploy
              </h2>
              <p className="text-lg text-text-primary/60 font-body max-w-2xl mx-auto">
                Choose from industry-specific agent templates. Customize scripts, personality, and integrations — then go live in minutes.
              </p>
            </div>
          </RevealSection>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-10">
            {agentTemplates.map((agent, i) => (
              <RevealSection key={agent.name} delay={`scroll-delay-${(i % 3) + 1}`}>
                <div className={`relative rounded-2xl p-7 bg-gradient-to-br ${agent.color} border border-border/30 hover:shadow-lg transition-all h-full group`}>
                  {agent.avatar ? (
                    <div className="w-12 h-12 rounded-xl overflow-hidden mb-4 border border-border/20">
                      <img src={agent.avatar} alt={`${agent.name} avatar`} className="w-full h-full object-cover" loading="lazy" />
                    </div>
                  ) : (
                    <div className={`w-12 h-12 rounded-xl ${agent.iconBg} flex items-center justify-center mb-4`}>
                      <agent.icon className="h-6 w-6" />
                    </div>
                  )}
                  <h3 className="font-display text-lg font-semibold text-text-primary mb-2">{agent.name}</h3>
                  <p className="text-sm text-text-primary/60 leading-relaxed font-body mb-3">{agent.desc}</p>
                  <div className="bg-white/50 rounded-lg p-3 mb-4 border border-border/15">
                    <p className="text-xs text-text-primary/70 font-body italic leading-relaxed">{agent.example}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {agent.capabilities.map((cap) => (
                      <span key={cap} className="text-xs font-medium bg-white/70 text-text-primary/80 px-2.5 py-1 rounded-full border border-border/20">
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
                to="/ai-agents"
                className="inline-flex items-center gap-2 text-sm font-semibold text-primary hover:text-primary-hover transition-colors"
              >
                Explore Marketplace
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </RevealSection>
        </div>
      </section>

      <section className="relative py-20 lg:py-28 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-white via-surface-secondary to-info-light/20" />
        <div className="relative max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="grid lg:grid-cols-[1fr,2fr] gap-10 lg:gap-14 items-end mb-14">
              <div>
                <span className="inline-block text-sm font-semibold text-primary bg-primary/10 px-4 py-1.5 rounded-full mb-4">Built for your industry</span>
                <h2 className="font-display text-3xl lg:text-5xl font-bold text-text-primary leading-[1.05] mb-4">
                  Purpose-built voice AI for the way <span className="text-primary">your industry</span> actually works.
                </h2>
              </div>
              <p className="text-lg text-text-primary/65 font-body leading-relaxed max-w-xl lg:pb-2">
                Every vertical has its own jargon, compliance rules, and customer expectations. QVO ships pre-trained templates, integrations, and call flows for the industries where voice matters most.
              </p>
            </div>
          </RevealSection>
          <IndustryShowcase />
        </div>
      </section>

      <section className="py-20 lg:py-28 relative overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-surface-secondary via-info-light/30 to-surface-secondary" />
        <div className="relative max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <span className="inline-block text-sm font-semibold text-primary bg-primary/10 px-4 py-1.5 rounded-full mb-4">Platform Capabilities</span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                Everything You Need to Automate Voice Operations
              </h2>
              <p className="text-lg text-text-primary/60 font-body max-w-2xl mx-auto">
                A complete toolkit for managing AI voice agents, campaigns, and analytics in one place.
              </p>
            </div>
          </RevealSection>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {featureGrid.map((f, i) => (
              <RevealSection key={f.title} delay={`scroll-delay-${(i % 3) + 1}`}>
                <div className="bg-white rounded-2xl p-7 border border-border/30 hover:border-primary/25 hover:shadow-lg transition-all h-full">
                  <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-primary/15 to-sidebar-bg/10 flex items-center justify-center mb-4">
                    <f.icon className="h-5 w-5 text-primary" />
                  </div>
                  <h3 className="font-display text-lg font-semibold text-text-primary mb-2">{f.title}</h3>
                  <p className="text-sm text-text-primary/60 leading-relaxed font-body">{f.desc}</p>
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
              <span className="inline-block text-sm font-semibold text-success bg-success/10 px-4 py-1.5 rounded-full mb-4">Customer Results</span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                Real Businesses, Real Results
              </h2>
              <p className="text-lg text-text-primary/60 font-body max-w-2xl mx-auto">
                See how businesses across industries are transforming their operations with QVO.
              </p>
            </div>
          </RevealSection>

          <div className="grid md:grid-cols-3 gap-8">
            {customerResults.map((result, i) => (
              <RevealSection key={result.industry} delay={`scroll-delay-${i + 1}`}>
                <div className="relative bg-surface-secondary rounded-2xl p-8 border border-border/30 hover:shadow-lg transition-all h-full">
                  <div className="flex items-center gap-3 mb-5">
                    <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                      <result.icon className="h-5 w-5 text-primary" />
                    </div>
                    <span className="text-xs font-semibold uppercase tracking-wider text-text-primary/40">{result.industry}</span>
                  </div>
                  <div className="mb-5">
                    <span className="font-display text-4xl font-bold text-primary">{result.metric}</span>
                    <span className="block text-sm font-semibold text-text-primary mt-1">{result.metricLabel}</span>
                  </div>
                  <p className="text-sm text-text-primary/60 font-body leading-relaxed mb-6 italic">
                    "{result.quote}"
                  </p>
                  <div className="flex items-center gap-1 mb-3">
                    {[...Array(5)].map((_, j) => (
                      <Star key={j} className="w-3.5 h-3.5 fill-accent text-accent" />
                    ))}
                  </div>
                  <div>
                    <p className="font-display text-sm font-semibold text-text-primary">{result.name}</p>
                    <p className="text-xs text-text-primary/50 font-body mt-0.5">{result.role}</p>
                  </div>
                </div>
              </RevealSection>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-white border-t border-border/20">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-12">
              <span className="inline-block text-sm font-semibold text-primary bg-primary/10 px-4 py-1.5 rounded-full mb-4">In Their Words</span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                Hear it straight from operators.
              </h2>
              <p className="text-lg text-text-primary/60 font-body max-w-2xl mx-auto">
                Real teams replacing missed calls and overwhelmed front desks with QVO.
              </p>
            </div>
          </RevealSection>
          <RevealSection>
            <TestimonialsCarousel />
          </RevealSection>
          <div className="mt-16 max-w-5xl mx-auto">
            <RevealSection>
              <LogosStrip />
            </RevealSection>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-surface-secondary">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-12">
              <span className="inline-block text-sm font-semibold text-text-primary bg-sidebar-bg/10 px-4 py-1.5 rounded-full mb-4">How We Compare</span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                QVO vs. the alternatives.
              </h2>
              <p className="text-lg text-text-primary/60 font-body max-w-2xl mx-auto">
                A side-by-side look at QVO, voice-AI toolkits, and traditional answering services.
              </p>
            </div>
          </RevealSection>
          <RevealSection>
            <ComparisonTable />
          </RevealSection>
        </div>
      </section>

      <section className="py-16 lg:py-20 bg-white">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-10">
              <span className="inline-block text-sm font-semibold text-text-primary bg-sidebar-bg/10 px-4 py-1.5 rounded-full mb-4">Security & Compliance</span>
              <h2 className="font-display text-2xl lg:text-3xl font-bold text-text-primary mb-3">
                Enterprise-grade security built in.
              </h2>
              <p className="text-text-primary/60 font-body max-w-xl mx-auto">
                Your data and your customers' data are protected at every layer.
              </p>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-4xl mx-auto">
              {[
                { icon: ShieldCheck, label: 'HIPAA Ready' },
                { icon: Lock, label: 'SOC 2 Compliant' },
                { icon: Shield, label: 'AES-256 Encryption' },
                { icon: BarChart3, label: 'Full Audit Logs' },
              ].map((badge) => (
                <div key={badge.label} className="flex flex-col items-center text-center bg-white rounded-xl border border-border/30 p-5">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center mb-3">
                    <badge.icon className="h-5 w-5 text-primary" />
                  </div>
                  <span className="text-sm font-semibold text-text-primary font-display">{badge.label}</span>
                </div>
              ))}
            </div>
          </RevealSection>
        </div>
      </section>

      <section className="relative py-20 lg:py-24 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-sidebar-bg via-sidebar-hover/40 to-sidebar-bg" />
        <div className="absolute inset-0 opacity-15">
          <div className="absolute top-0 left-1/4 w-64 h-64 bg-primary rounded-full blur-[100px]" />
          <div className="absolute bottom-0 right-1/4 w-80 h-80 bg-primary rounded-full blur-[120px]" />
        </div>
        <RevealSection>
          <div className="relative max-w-3xl mx-auto px-6 lg:px-8 text-center">
            <h2 className="font-display text-3xl lg:text-4xl font-bold text-white mb-4">
              Deploy Your First AI Voice Agent Today
            </h2>
            <p className="text-lg text-white/60 font-body mb-10 max-w-xl mx-auto">
              Join hundreds of businesses using QVO to automate calls, capture leads, and grow revenue. No contracts, cancel anytime.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link
                to="/signup"
                className="btn-primary-glow inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-on-primary font-semibold px-8 py-3.5 rounded-xl transition-colors duration-[var(--motion-base)] text-sm min-h-[44px]"
                onClick={() => trackCTAClick('Start Free Trial', '/', 'bottom-cta')}
              >
                Start Free Trial
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/book-demo"
                className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 backdrop-blur-sm text-white font-semibold px-8 py-3.5 rounded-xl transition-colors duration-[var(--motion-base)] text-sm border border-white/15 hover:border-white/25 min-h-[44px]"
                onClick={() => trackCTAClick('Book a Demo', '/', 'bottom-cta')}
              >
                Book a Demo
              </Link>
              <Link
                to="/demo"
                className="inline-flex items-center justify-center gap-2 text-white/80 hover:text-white font-semibold px-6 py-3.5 rounded-xl transition-colors duration-[var(--motion-fast)] text-sm min-h-[44px]"
                onClick={() => trackCTAClick('Try the Live Demo', '/', 'bottom-cta')}
              >
                Try the Live Demo
              </Link>
            </div>
          </div>
        </RevealSection>
      </section>
    </div>
  );
}
