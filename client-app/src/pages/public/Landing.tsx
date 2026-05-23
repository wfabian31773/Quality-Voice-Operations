import { Link, Navigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { CTA } from '../../lib/analyticsCtas';
import { CONVERSION_STAGE } from '../../lib/analyticsLabels';

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

export default function Landing() {
  const { user, initialized } = useAuth();
  const { t } = useTranslation('marketing');

  useEffect(() => {
    trackPageView('/');
    captureUtmOnLoad();
    trackConversionEvent(CONVERSION_STAGE.PAGE_VIEW, '/');
  }, []);

  if (initialized && user) {
    return <Navigate to="/dashboard" replace />;
  }

  const socialProofStats = [
    { value: 2400000, suffix: '+', label: t('landing.stats.calls_handled') },
    { value: 850, suffix: '+', label: t('landing.stats.agents_deployed') },
    { value: 99, suffix: '.9%', label: t('landing.stats.uptime') },
    { value: 12, suffix: '+', label: t('landing.stats.industries_served') },
  ];

  const industryLogos = [
    { name: t('landing.industries.healthcare'), icon: Stethoscope },
    { name: t('landing.industries.legal'), icon: Scale },
    { name: t('landing.industries.real_estate'), icon: Home },
    { name: t('landing.industries.home_services'), icon: Wrench },
    { name: t('landing.industries.finance'), icon: DollarSign },
    { name: t('landing.industries.support'), icon: HeadphonesIcon },
    { name: t('landing.industries.insurance'), icon: Shield },
  ];

  const painPoints = [
    { icon: PhoneOff, title: t('landing.problem.missed_calls_title'), desc: t('landing.problem.missed_calls_desc') },
    { icon: DollarSign, title: t('landing.problem.staffing_title'), desc: t('landing.problem.staffing_desc') },
    { icon: UserX, title: t('landing.problem.manual_title'), desc: t('landing.problem.manual_desc') },
    { icon: Timer, title: t('landing.problem.slow_lead_title'), desc: t('landing.problem.slow_lead_desc') },
  ];

  const solutionFeatures = [
    { icon: VoiceAgentIcon, title: t('landing.solution.voice_agents_title'), desc: t('landing.solution.voice_agents_desc') },
    { icon: MegaphoneIcon, title: t('landing.solution.outbound_title'), desc: t('landing.solution.outbound_desc') },
    { icon: IntegrationsIcon, title: t('landing.solution.crm_title'), desc: t('landing.solution.crm_desc') },
    { icon: AlwaysOnIcon, title: t('landing.solution.always_on_title'), desc: t('landing.solution.always_on_desc') },
    { icon: SmsFollowupIcon, title: t('landing.solution.sms_title'), desc: t('landing.solution.sms_desc') },
    { icon: AnalyticsIcon, title: t('landing.solution.analytics_title'), desc: t('landing.solution.analytics_desc') },
  ];

  const agentTemplates = [
    {
      icon: Stethoscope,
      name: t('landing.marketplace.medical.name'),
      desc: t('landing.marketplace.medical.desc'),
      capabilities: [
        t('landing.marketplace.medical.cap_appointment'),
        t('landing.marketplace.medical.cap_triage'),
        t('landing.marketplace.medical.cap_insurance'),
        t('landing.marketplace.medical.cap_hipaa'),
      ],
      example: t('landing.marketplace.medical.example'),
      color: 'from-primary/20 to-success/10',
      iconBg: 'bg-primary/15 text-primary',
      avatar: '/assets/avatars/medical.png',
    },
    {
      icon: Scale,
      name: t('landing.marketplace.legal.name'),
      desc: t('landing.marketplace.legal.desc'),
      capabilities: [
        t('landing.marketplace.legal.cap_qualification'),
        t('landing.marketplace.legal.cap_conflict'),
        t('landing.marketplace.legal.cap_consultation'),
        t('landing.marketplace.legal.cap_documents'),
      ],
      example: t('landing.marketplace.legal.example'),
      color: 'from-sidebar-bg/10 to-info-light/20',
      iconBg: 'bg-surface-muted text-text-primary',
      avatar: '/assets/avatars/legal.png',
    },
    {
      icon: Home,
      name: t('landing.marketplace.real_estate.name'),
      desc: t('landing.marketplace.real_estate.desc'),
      capabilities: [
        t('landing.marketplace.real_estate.cap_lead'),
        t('landing.marketplace.real_estate.cap_qa'),
        t('landing.marketplace.real_estate.cap_showing'),
        t('landing.marketplace.real_estate.cap_crm'),
      ],
      example: t('landing.marketplace.real_estate.example'),
      color: 'from-accent/10 to-accent-light/30',
      iconBg: 'bg-accent/15 text-accent',
      avatar: '/assets/avatars/real-estate.png',
    },
    {
      icon: HeadphonesIcon,
      name: t('landing.marketplace.support.name'),
      desc: t('landing.marketplace.support.desc'),
      capabilities: [
        t('landing.marketplace.support.cap_ticket'),
        t('landing.marketplace.support.cap_order'),
        t('landing.marketplace.support.cap_returns'),
        t('landing.marketplace.support.cap_escalation'),
      ],
      example: t('landing.marketplace.support.example'),
      color: 'from-primary/10 to-info-light/15',
      iconBg: 'bg-primary/15 text-primary',
      avatar: '/assets/avatars/customer-support.png',
    },
    {
      icon: DollarSign,
      name: t('landing.marketplace.collections.name'),
      desc: t('landing.marketplace.collections.desc'),
      capabilities: [
        t('landing.marketplace.collections.cap_reminder'),
        t('landing.marketplace.collections.cap_plan'),
        t('landing.marketplace.collections.cap_compliance'),
        t('landing.marketplace.collections.cap_payment'),
      ],
      example: t('landing.marketplace.collections.example'),
      color: 'from-danger/10 to-accent/10',
      iconBg: 'bg-danger/15 text-danger',
      avatar: '/assets/avatars/collections.png',
    },
    {
      icon: Wrench,
      name: t('landing.marketplace.hvac.name'),
      desc: t('landing.marketplace.hvac.desc'),
      capabilities: [
        t('landing.marketplace.hvac.cap_intake'),
        t('landing.marketplace.hvac.cap_emergency'),
        t('landing.marketplace.hvac.cap_dispatch'),
        t('landing.marketplace.hvac.cap_eta'),
      ],
      example: t('landing.marketplace.hvac.example'),
      color: 'from-orange-100/80 to-accent/10',
      iconBg: 'bg-orange-100 dark:bg-orange-500/15 text-orange-700 dark:text-orange-300',
      avatar: '/assets/avatars/hvac.png',
    },
  ];

  const featureGrid = [
    { icon: VoiceEngineIcon, title: t('landing.platform_capabilities.voice_engine_title'), desc: t('landing.platform_capabilities.voice_engine_desc') },
    { icon: AutomationIcon, title: t('landing.platform_capabilities.campaign_title'), desc: t('landing.platform_capabilities.campaign_desc') },
    { icon: DashboardIcon, title: t('landing.platform_capabilities.analytics_title'), desc: t('landing.platform_capabilities.analytics_desc') },
    { icon: CustomizationIcon, title: t('landing.platform_capabilities.customization_title'), desc: t('landing.platform_capabilities.customization_desc') },
    { icon: ApiIcon, title: t('landing.platform_capabilities.api_title'), desc: t('landing.platform_capabilities.api_desc') },
    { icon: SecurityIcon, title: t('landing.platform_capabilities.security_title'), desc: t('landing.platform_capabilities.security_desc') },
  ];

  const customerResults = [
    {
      metric: t('landing.results.real_estate.metric'),
      metricLabel: t('landing.results.real_estate.metric_label'),
      industry: t('landing.results.real_estate.industry'),
      quote: t('landing.results.real_estate.quote'),
      name: t('landing.results.real_estate.name'),
      role: t('landing.results.real_estate.role'),
      icon: Home,
    },
    {
      metric: t('landing.results.medical.metric'),
      metricLabel: t('landing.results.medical.metric_label'),
      industry: t('landing.results.medical.industry'),
      quote: t('landing.results.medical.quote'),
      name: t('landing.results.medical.name'),
      role: t('landing.results.medical.role'),
      icon: Stethoscope,
    },
    {
      metric: t('landing.results.legal.metric'),
      metricLabel: t('landing.results.legal.metric_label'),
      industry: t('landing.results.legal.industry'),
      quote: t('landing.results.legal.quote'),
      name: t('landing.results.legal.name'),
      role: t('landing.results.legal.role'),
      icon: Scale,
    },
  ];

  const keyBenefits = [
    { icon: PhoneCall, text: t('landing.hero.benefits.never_miss_call') },
    { icon: CalendarCheck, text: t('landing.hero.benefits.book_appointments') },
    { icon: Truck, text: t('landing.hero.benefits.dispatch_technicians') },
    { icon: HelpCircle, text: t('landing.hero.benefits.answer_questions') },
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
        title={t('landing.seo_title')}
        description={t('landing.seo_description')}
        canonicalPath="/"
        structuredData={organizationSchema}
      />
      <section className="relative overflow-hidden text-text-primary dark:text-white">
        {/* Light-mode hero: soft harbor wash so the hero blends into the
            page below it. Dark-mode hero: original deep navy gradient. */}
        <div className="absolute inset-0 bg-gradient-to-br from-surface via-surface-secondary to-surface dark:from-sidebar-bg dark:via-sidebar-hover/30 dark:to-sidebar-bg" />
        <div className="absolute inset-0 opacity-15 dark:opacity-10">
          <div className="absolute top-20 left-10 w-72 h-72 bg-primary rounded-full blur-[128px]" />
          <div className="absolute bottom-10 right-20 w-96 h-96 bg-primary rounded-full blur-[160px]" />
        </div>
        <div className="relative max-w-7xl mx-auto px-6 lg:px-8 py-24 lg:py-36">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <div>
              <div className="inline-flex items-center gap-2 bg-primary/15 border border-primary/25 rounded-full px-4 py-1.5 mb-6">
                <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                <span className="text-primary text-sm font-medium">{t('landing.hero.badge')}</span>
              </div>
              <h1 className="font-display text-4xl md:text-5xl lg:text-6xl font-bold leading-[1.1] mb-6">
                <span className="text-primary">{t('landing.hero.title_highlight')}</span>{t('landing.hero.title_rest')}
              </h1>
              <p className="text-lg lg:text-xl text-text-secondary dark:text-white/65 leading-relaxed mb-8 max-w-xl font-body">
                {t('landing.hero.description')}
              </p>
              <div className="grid grid-cols-2 gap-3 mb-8">
                {keyBenefits.map((benefit) => (
                  <div key={benefit.text} className="flex items-center gap-2 text-sm text-text-primary dark:text-white/80">
                    <benefit.icon className="h-4 w-4 text-primary shrink-0" />
                    <span className="font-body">{benefit.text}</span>
                  </div>
                ))}
              </div>
              <div className="flex flex-col sm:flex-row gap-4">
                <Link
                  to="/demo"
                  className="btn-primary-glow inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-on-primary font-semibold px-7 py-3.5 rounded-xl transition-colors duration-[var(--motion-base)] text-sm min-h-[44px]"
                  onClick={() => trackCTAClick(CTA.TRY_LIVE_DEMO, '/', 'hero')}
                >
                  {t('common.try_live_demo')}
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  to="/product"
                  className="inline-flex items-center justify-center gap-2 bg-surface-muted dark:bg-white/10 hover:bg-surface-hover dark:hover:bg-white/15 backdrop-blur-sm text-text-primary dark:text-white font-semibold px-7 py-3.5 rounded-xl transition-colors duration-[var(--motion-base)] text-sm border border-border dark:border-white/15 hover:border-border-strong dark:hover:border-white/25 min-h-[44px]"
                  onClick={() => trackCTAClick(CTA.SEE_HOW_IT_WORKS, '/', 'hero')}
                >
                  {t('common.see_how_it_works')}
                </Link>
              </div>
            </div>
            <div className="hidden lg:block">
              <LiveTranscriptMock />
            </div>
          </div>
        </div>
      </section>

      <section className="bg-surface dark:bg-sidebar-bg border-t border-border dark:border-white/5">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 py-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6 md:gap-8">
            {socialProofStats.map((stat) => (
              <div key={stat.label} className="text-center">
                <p className="font-display text-2xl md:text-3xl font-bold text-text-primary dark:text-white">
                  <AnimatedCounter end={stat.value} suffix={stat.suffix} />
                </p>
                <p className="text-xs md:text-sm text-text-secondary dark:text-white/50 font-body mt-1">{stat.label}</p>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-center gap-6 mt-6 pt-6 border-t border-border dark:border-white/5">
            <span className="text-xs text-text-secondary dark:text-white/30 uppercase tracking-wider font-medium">{t('common.trusted_by')}</span>
            {industryLogos.map((logo) => (
              <div key={logo.name} className="flex items-center gap-1.5 opacity-70 dark:opacity-40 hover:opacity-100 dark:hover:opacity-60 transition-opacity">
                <logo.icon className="h-4 w-4 text-text-primary dark:text-white" />
                <span className="text-xs font-medium text-text-primary dark:text-white">{logo.name}</span>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap items-center justify-center gap-3 mt-6">
            <Link to="/security" className="inline-flex items-center gap-1.5 text-[11px] text-text-secondary dark:text-white/55 hover:text-text-primary dark:hover:text-white border border-border dark:border-white/15 hover:border-border-strong dark:hover:border-white/30 rounded-full px-3 py-1 transition-colors">
              <ShieldCheck className="h-3 w-3 text-primary" /> {t('landing.stats.soc2_in_progress')}
            </Link>
            <Link to="/security" className="inline-flex items-center gap-1.5 text-[11px] text-text-secondary dark:text-white/55 hover:text-text-primary dark:hover:text-white border border-border dark:border-white/15 hover:border-border-strong dark:hover:border-white/30 rounded-full px-3 py-1 transition-colors">
              <ShieldCheck className="h-3 w-3 text-primary" /> {t('landing.stats.hipaa_ready')}
            </Link>
            <Link to="/security" className="inline-flex items-center gap-1.5 text-[11px] text-text-secondary dark:text-white/55 hover:text-text-primary dark:hover:text-white border border-border dark:border-white/15 hover:border-border-strong dark:hover:border-white/30 rounded-full px-3 py-1 transition-colors">
              <ShieldCheck className="h-3 w-3 text-primary" /> {t('landing.stats.gdpr_compliant')}
            </Link>
            <Link to="/security" className="inline-flex items-center gap-1.5 text-[11px] text-text-secondary dark:text-white/55 hover:text-text-primary dark:hover:text-white border border-border dark:border-white/15 hover:border-border-strong dark:hover:border-white/30 rounded-full px-3 py-1 transition-colors">
              <ShieldCheck className="h-3 w-3 text-primary" /> {t('landing.stats.aes_encryption')}
            </Link>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-surface-secondary">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-16">
              <span className="inline-block text-sm font-semibold text-danger bg-danger/10 px-4 py-1.5 rounded-full mb-4">{t('landing.problem.eyebrow')}</span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                {t('landing.problem.title')}
              </h2>
              <p className="text-lg text-text-secondary font-body max-w-2xl mx-auto">
                {t('landing.problem.subtitle')}
              </p>
            </div>
          </RevealSection>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 mb-16">
            {painPoints.map((point, i) => (
              <RevealSection key={point.title} delay={`scroll-delay-${i + 1}`}>
                <div className="bg-surface rounded-2xl border border-danger/10 p-6 hover:shadow-lg transition-shadow h-full">
                  <div className="w-11 h-11 rounded-xl bg-danger/10 flex items-center justify-center mb-4">
                    <point.icon className="h-5 w-5 text-danger" />
                  </div>
                  <h3 className="font-display text-lg font-semibold text-text-primary mb-2">{point.title}</h3>
                  <p className="text-sm text-text-secondary leading-relaxed font-body">{point.desc}</p>
                </div>
              </RevealSection>
            ))}
          </div>

          <RevealSection>
            <div className="text-center mb-12">
              <span className="inline-block text-sm font-semibold text-primary bg-primary/10 px-4 py-1.5 rounded-full mb-4">{t('landing.solution.eyebrow')}</span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                {t('landing.solution.title')}
              </h2>
              <p className="text-lg text-text-secondary font-body max-w-2xl mx-auto">
                {t('landing.solution.subtitle')}
              </p>
            </div>
          </RevealSection>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6" data-testid="solution-cards-grid">
            {solutionFeatures.map((f, i) => (
              <RevealSection key={f.title} delay={`scroll-delay-${(i % 3) + 1}`}>
                <div className="bg-surface rounded-2xl p-7 hover:shadow-lg transition-all border border-border hover:border-primary/40 h-full" data-testid="solution-card">
                  <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                    <f.icon className="h-5 w-5 text-primary" />
                  </div>
                  <h3 className="font-display text-lg font-semibold text-text-primary mb-2">{f.title}</h3>
                  <p className="text-sm text-text-secondary leading-relaxed font-body">{f.desc}</p>
                </div>
              </RevealSection>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-surface">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <span className="inline-block text-sm font-semibold text-text-primary bg-surface-muted px-4 py-1.5 rounded-full mb-4">{t('landing.marketplace.badge')}</span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                {t('landing.marketplace.title')}
              </h2>
              <p className="text-lg text-text-secondary font-body max-w-2xl mx-auto">
                {t('landing.marketplace.subtitle')}
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
                  <p className="text-sm text-text-secondary leading-relaxed font-body mb-3">{agent.desc}</p>
                  <div className="bg-surface-secondary rounded-lg p-3 mb-4 border border-border/15">
                    <p className="text-xs text-text-primary/70 font-body italic leading-relaxed">{agent.example}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {agent.capabilities.map((cap) => (
                      <span key={cap} className="text-xs font-medium bg-surface text-text-primary/80 px-2.5 py-1 rounded-full border border-border/20">
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
                {t('common.explore_marketplace')}
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </RevealSection>
        </div>
      </section>

      <section className="relative py-20 lg:py-28 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-surface via-surface-secondary to-info-light/20" />
        <div className="relative max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="grid lg:grid-cols-[1fr,2fr] gap-10 lg:gap-14 items-end mb-14">
              <div>
                <span className="inline-block text-sm font-semibold text-primary bg-primary/10 px-4 py-1.5 rounded-full mb-4">{t('landing.industry_section.badge')}</span>
                <h2 className="font-display text-3xl lg:text-5xl font-bold text-text-primary leading-[1.05] mb-4">
                  {t('landing.industry_section.title_pre')}<span className="text-primary">{t('landing.industry_section.title_emph')}</span>{t('landing.industry_section.title_post')}
                </h2>
              </div>
              <p className="text-lg text-text-secondary font-body leading-relaxed max-w-xl lg:pb-2">
                {t('landing.industry_section.description')}
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
              <span className="inline-block text-sm font-semibold text-primary bg-primary/10 px-4 py-1.5 rounded-full mb-4">{t('landing.platform_capabilities.badge')}</span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                {t('landing.platform_capabilities.title')}
              </h2>
              <p className="text-lg text-text-secondary font-body max-w-2xl mx-auto">
                {t('landing.platform_capabilities.subtitle')}
              </p>
            </div>
          </RevealSection>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
            {featureGrid.map((f, i) => (
              <RevealSection key={f.title} delay={`scroll-delay-${(i % 3) + 1}`}>
                <div className="bg-surface rounded-2xl p-7 border border-border/30 hover:border-primary/25 hover:shadow-lg transition-all h-full">
                  <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-primary/15 to-sidebar-bg/10 flex items-center justify-center mb-4">
                    <f.icon className="h-5 w-5 text-primary" />
                  </div>
                  <h3 className="font-display text-lg font-semibold text-text-primary mb-2">{f.title}</h3>
                  <p className="text-sm text-text-secondary leading-relaxed font-body">{f.desc}</p>
                </div>
              </RevealSection>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-surface">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <span className="inline-block text-sm font-semibold text-success bg-success/10 px-4 py-1.5 rounded-full mb-4">{t('landing.results.badge')}</span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                {t('landing.results.title')}
              </h2>
              <p className="text-lg text-text-secondary font-body max-w-2xl mx-auto">
                {t('landing.results.subtitle')}
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
                    <span className="text-xs font-semibold uppercase tracking-wider text-text-secondary">{result.industry}</span>
                  </div>
                  <div className="mb-5">
                    <span className="font-display text-4xl font-bold text-primary">{result.metric}</span>
                    <span className="block text-sm font-semibold text-text-primary mt-1">{result.metricLabel}</span>
                  </div>
                  <p className="text-sm text-text-secondary font-body leading-relaxed mb-6 italic">
                    "{result.quote}"
                  </p>
                  <div className="flex items-center gap-1 mb-3">
                    {[...Array(5)].map((_, j) => (
                      <Star key={j} className="w-3.5 h-3.5 fill-accent text-accent" />
                    ))}
                  </div>
                  <div>
                    <p className="font-display text-sm font-semibold text-text-primary">{result.name}</p>
                    <p className="text-xs text-text-secondary font-body mt-0.5">{result.role}</p>
                  </div>
                </div>
              </RevealSection>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-surface border-t border-border/20">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-12">
              <span className="inline-block text-sm font-semibold text-primary bg-primary/10 px-4 py-1.5 rounded-full mb-4">{t('landing.testimonials.badge')}</span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                {t('landing.testimonials.title')}
              </h2>
              <p className="text-lg text-text-secondary font-body max-w-2xl mx-auto">
                {t('landing.testimonials.subtitle')}
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
              <span className="inline-block text-sm font-semibold text-text-primary bg-surface-muted px-4 py-1.5 rounded-full mb-4">{t('landing.comparison.badge')}</span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                {t('landing.comparison.title')}
              </h2>
              <p className="text-lg text-text-secondary font-body max-w-2xl mx-auto">
                {t('landing.comparison.subtitle')}
              </p>
            </div>
          </RevealSection>
          <RevealSection>
            <ComparisonTable />
          </RevealSection>
        </div>
      </section>

      <section className="py-16 lg:py-20 bg-surface">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-10">
              <span className="inline-block text-sm font-semibold text-text-primary bg-surface-muted px-4 py-1.5 rounded-full mb-4">{t('landing.security.badge')}</span>
              <h2 className="font-display text-2xl lg:text-3xl font-bold text-text-primary mb-3">
                {t('landing.security.title')}
              </h2>
              <p className="text-text-secondary font-body max-w-xl mx-auto">
                {t('landing.security.subtitle')}
              </p>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 max-w-4xl mx-auto">
              {[
                { icon: ShieldCheck, label: t('landing.security.hipaa_ready') },
                { icon: Lock, label: t('landing.security.soc2') },
                { icon: Shield, label: t('landing.security.aes') },
                { icon: BarChart3, label: t('landing.security.audit_logs') },
              ].map((badge) => (
                <div key={badge.label} className="flex flex-col items-center text-center bg-surface rounded-xl border border-border/30 p-5">
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
              {t('landing.bottom_cta.title')}
            </h2>
            <p className="text-lg text-white/60 font-body mb-10 max-w-xl mx-auto">
              {t('landing.bottom_cta.subtitle')}
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center">
              <Link
                to="/signup"
                className="btn-primary-glow inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-on-primary font-semibold px-8 py-3.5 rounded-xl transition-colors duration-[var(--motion-base)] text-sm min-h-[44px]"
                onClick={() => trackCTAClick(CTA.START_FREE_TRIAL, '/', 'bottom-cta')}
              >
                {t('common.start_free_trial')}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/book-demo"
                className="inline-flex items-center justify-center gap-2 bg-white/10 dark:bg-white/10 hover:bg-white/15 dark:hover:bg-white/15 backdrop-blur-sm text-white font-semibold px-8 py-3.5 rounded-xl transition-colors duration-[var(--motion-base)] text-sm border border-white/15 dark:border-white/15 hover:border-white/25 dark:hover:border-white/25 min-h-[44px]"
                onClick={() => trackCTAClick(CTA.BOOK_DEMO, '/', 'bottom-cta')}
              >
                {t('common.book_a_demo')}
              </Link>
              <Link
                to="/demo"
                className="inline-flex items-center justify-center gap-2 text-white/80 hover:text-white font-semibold px-6 py-3.5 rounded-xl transition-colors duration-[var(--motion-fast)] text-sm min-h-[44px]"
                onClick={() => trackCTAClick(CTA.TRY_LIVE_DEMO, '/', 'bottom-cta')}
              >
                {t('landing.bottom_cta.try_live')}
              </Link>
            </div>
          </div>
        </RevealSection>
      </section>
    </div>
  );
}
