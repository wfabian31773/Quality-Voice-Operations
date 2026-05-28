import { Link } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Phone, Clock, Calendar, BarChart3, Shield, ArrowRight,
  Zap, GitBranch, Layers, Bot, Bell, FileText,
  Settings, PhoneCall, Rocket, ChevronRight,
  LayoutDashboard, Activity, Sliders,
  Lock, Eye, Database, ShieldCheck,
  Plug, Link2,
} from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';
import { trackPageView, trackCTAClick } from '../../lib/analytics';
import { CTA } from '../../lib/analyticsCtas';
import {
  DEFAULT_DISPLAY_CURRENCY,
  convertUsd,
  useDisplayCurrency,
} from '../../lib/displayCurrency';
import WorkflowDiagram, {
  genericWorkflowSteps,
  healthcareWorkflow,
  legalWorkflow,
  realEstateWorkflow,
  customerSupportWorkflow,
  hvacWorkflow,
} from '../../components/WorkflowDiagram';

function WorkflowSection() {
  const { t } = useTranslation('marketing');
  const [activeStep, setActiveStep] = useState(0);

  const setupSteps = [
    {
      step: 1,
      icon: Settings,
      title: t('product.workflow.configure_title'),
      desc: t('product.workflow.configure_desc'),
      details: [
        t('product.workflow.configure_d1'),
        t('product.workflow.configure_d2'),
        t('product.workflow.configure_d3'),
      ],
    },
    {
      step: 2,
      icon: PhoneCall,
      title: t('product.workflow.connect_title'),
      desc: t('product.workflow.connect_desc'),
      details: [
        t('product.workflow.connect_d1'),
        t('product.workflow.connect_d2'),
        t('product.workflow.connect_d3'),
      ],
    },
    {
      step: 3,
      icon: Rocket,
      title: t('product.workflow.live_title'),
      desc: t('product.workflow.live_desc'),
      details: [
        t('product.workflow.live_d1'),
        t('product.workflow.live_d2'),
        t('product.workflow.live_d3'),
      ],
    },
  ];

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mq.matches) return;
    const interval = setInterval(() => {
      setActiveStep((prev) => (prev + 1) % 3);
    }, 3500);
    return () => clearInterval(interval);
  }, []);

  return (
    <section className="bg-surface py-20 lg:py-28 overflow-hidden">
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <div className="max-w-3xl mx-auto text-center mb-16">
          <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-3">
            {t('product.workflow.eyebrow')}
          </p>
          <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
            {t('product.workflow.title')}
          </h2>
          <p className="text-text-secondary font-body leading-relaxed">
            {t('product.workflow.subtitle')}
          </p>
        </div>

        <div className="max-w-5xl mx-auto">
          <div className="grid md:grid-cols-3 gap-0 relative">
            <div className="hidden md:block absolute top-12 left-[20%] right-[20%] h-0.5">
              <div className="w-full h-full bg-border-strong/30 rounded-full" />
              <div
                className="absolute top-0 left-0 h-full bg-primary rounded-full transition-all duration-700 ease-out"
                style={{ width: `${activeStep * 50}%` }}
              />
            </div>

            {setupSteps.map((s, i) => {
              const isActive = i === activeStep;
              const isComplete = i < activeStep;
              return (
                <button
                  key={s.step}
                  type="button"
                  aria-label={t('product.workflow.step_label', { n: s.step, title: s.title })}
                  className="relative flex flex-col items-center text-center px-6 cursor-pointer group focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 rounded-xl"
                  onClick={() => setActiveStep(i)}
                >
                  <div
                    className={`relative z-10 w-24 h-24 rounded-2xl flex items-center justify-center mb-6 transition-all duration-500 ${
                      isActive
                        ? 'bg-primary text-white shadow-lg shadow-primary/25 scale-110'
                        : isComplete
                          ? 'bg-primary/15 text-primary'
                          : 'bg-surface-secondary text-text-secondary group-hover:bg-primary/10 group-hover:text-primary/60'
                    }`}
                  >
                    <s.icon className={`transition-all duration-500 ${isActive ? 'h-10 w-10' : 'h-8 w-8'}`} />
                    <span
                      className={`absolute -top-2 -right-2 w-7 h-7 rounded-full font-display text-xs font-bold flex items-center justify-center transition-all duration-500 ${
                        isActive || isComplete
                          ? 'bg-primary text-white'
                          : 'bg-border-strong/50 text-text-secondary'
                      }`}
                    >
                      {s.step}
                    </span>
                  </div>
                  <h3
                    className={`font-display text-lg font-semibold mb-2 transition-colors duration-300 ${
                      isActive ? 'text-primary' : 'text-text-primary'
                    }`}
                  >
                    {s.title}
                  </h3>
                  <p className="text-sm text-text-secondary font-body leading-relaxed mb-4">{s.desc}</p>
                  <ul
                    className={`space-y-1.5 transition-all duration-500 overflow-hidden ${
                      isActive ? 'max-h-40 opacity-100' : 'max-h-0 opacity-0'
                    }`}
                  >
                    {s.details.map((d) => (
                      <li key={d} className="flex items-center gap-2 text-xs text-text-secondary font-body">
                        <ChevronRight className="h-3 w-3 text-primary flex-shrink-0" />
                        {d}
                      </li>
                    ))}
                  </ul>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

function ScreenshotsSection() {
  const { t } = useTranslation('marketing');

  const dashboardScreenshots = [
    { icon: LayoutDashboard, title: t('product.screenshots_section.call_history_title'), desc: t('product.screenshots_section.call_history_desc'), image: '/assets/screenshots/call-history.png' },
    { icon: Activity, title: t('product.screenshots_section.analytics_title'), desc: t('product.screenshots_section.analytics_desc'), image: '/assets/screenshots/analytics-dashboard.png' },
    { icon: Sliders, title: t('product.screenshots_section.config_title'), desc: t('product.screenshots_section.config_desc'), image: '/assets/screenshots/agent-config.png' },
    { icon: Bot, title: t('product.screenshots_section.creation_title'), desc: t('product.screenshots_section.creation_desc'), image: '/assets/screenshots/agent-creation.png' },
    { icon: FileText, title: t('product.screenshots_section.prompt_title'), desc: t('product.screenshots_section.prompt_desc'), image: '/assets/screenshots/prompt-editor.png' },
    { icon: PhoneCall, title: t('product.screenshots_section.transcript_title'), desc: t('product.screenshots_section.transcript_desc'), image: '/assets/screenshots/transcript-view.png' },
  ];

  return (
    <section className="py-20 lg:py-28 bg-surface-secondary">
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <div className="max-w-3xl mx-auto text-center mb-14">
          <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-3">
            {t('product.screenshots_section.eyebrow')}
          </p>
          <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
            {t('product.screenshots_section.title')}
          </h2>
          <p className="text-text-secondary font-body leading-relaxed">
            {t('product.screenshots_section.subtitle')}
          </p>
        </div>
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-6xl mx-auto">
          {dashboardScreenshots.map((s) => (
            <div key={s.title} className="group">
              <div
                className="rounded-2xl border border-border/30 aspect-[4/3] overflow-hidden mb-4 transition-all duration-300 group-hover:shadow-lg group-hover:scale-[1.02]"
              >
                <img
                  src={s.image}
                  alt={`${s.title} — QVO`}
                  loading="lazy"
                  className="w-full h-full object-cover"
                />
              </div>
              <h3 className="font-display text-base font-semibold text-text-primary mb-1">{s.title}</h3>
              <p className="text-sm text-text-secondary font-body leading-relaxed">{s.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function IntegrationsSection() {
  const { t } = useTranslation('marketing');

  const integrations = [
    t('product.integrations_section.ehr'),
    t('product.integrations_section.calendar'),
    t('product.integrations_section.salesforce'),
    t('product.integrations_section.hubspot'),
    t('product.integrations_section.slack'),
    t('product.integrations_section.webhooks'),
    t('product.integrations_section.zapier'),
    t('product.integrations_section.custom_api'),
  ];
  const customApi = t('product.integrations_section.custom_api');

  return (
    <section className="py-20 lg:py-28">
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <div className="max-w-5xl mx-auto flex flex-col lg:flex-row items-center gap-12">
          <div className="lg:w-1/2">
            <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-3">
              {t('product.integrations_section.eyebrow')}
            </p>
            <h2 className="font-display text-3xl font-bold text-text-primary mb-4">
              {t('product.integrations_section.title')}
            </h2>
            <p className="text-text-secondary font-body leading-relaxed mb-6">
              {t('product.integrations_section.subtitle')}
            </p>
            <Link
              to="/integrations"
              className="inline-flex items-center gap-2 text-primary hover:text-primary-hover font-semibold text-sm transition-colors"
            >
              {t('common.view_all_integrations')}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <div className="lg:w-1/2">
            <div className="grid grid-cols-2 gap-3">
              {integrations.map((name) => (
                <div
                  key={name}
                  className="flex items-center gap-3 bg-surface rounded-xl border border-border/30 px-4 py-3.5 hover:border-primary/30 hover:shadow-sm transition-all duration-200"
                >
                  <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0">
                    {name === customApi ? (
                      <Link2 className="h-4 w-4 text-primary" />
                    ) : (
                      <Plug className="h-4 w-4 text-primary" />
                    )}
                  </div>
                  <span className="text-sm font-medium text-text-primary font-body">{name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function SecuritySection() {
  const { t } = useTranslation('marketing');

  const securityBadges = [
    { icon: ShieldCheck, title: t('product.security_section.hipaa_title'), desc: t('product.security_section.hipaa_desc') },
    { icon: Eye, title: t('product.security_section.phi_title'), desc: t('product.security_section.phi_desc') },
    { icon: Lock, title: t('product.security_section.rls_title'), desc: t('product.security_section.rls_desc') },
    { icon: Database, title: t('product.security_section.encryption_title'), desc: t('product.security_section.encryption_desc') },
  ];

  return (
    <section className="py-20 lg:py-28 bg-sidebar-bg text-white">
      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <div className="max-w-3xl mx-auto text-center mb-14">
          <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-3">
            {t('product.security_section.eyebrow')}
          </p>
          {/* Explicit text-white + tracking-tight defensive against the
              QVO base reset rule (h2 → light-theme dark token on dark
              surfaces would render invisible). Same fix applied across
              hero h1s on /demo, /pricing, /features. */}
          <h2 className="font-display text-white text-3xl lg:text-4xl font-bold mb-4 tracking-tight">
            {t('product.security_section.title')}
          </h2>
          <p className="text-white/60 font-body leading-relaxed">
            {t('product.security_section.subtitle')}
          </p>
        </div>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6 max-w-5xl mx-auto">
          {securityBadges.map((b) => (
            <div
              key={b.title}
              className="bg-white/5 dark:bg-white/5 backdrop-blur-sm rounded-2xl border border-white/10 dark:border-white/10 p-6 hover:bg-white/10 dark:hover:bg-white/10 transition-all duration-300 group"
            >
              <div className="w-12 h-12 rounded-xl bg-primary/20 flex items-center justify-center mb-4 group-hover:bg-primary/30 transition-colors">
                <b.icon className="h-6 w-6 text-primary" />
              </div>
              {/* Defensive text-white on h3 — the QVO base reset rule
                  targets h1-h5, so card titles inside dark-band sections
                  go invisible without an explicit color. This was the
                  exact bug Wayne caught in the screenshot ("HIPAA Ready"
                  etc. rendering dark-navy-on-dark-navy). The same pattern
                  exists anywhere card titles are nested in a dark band
                  across the marketing surface. */}
              <h3 className="font-display text-white text-base font-semibold mb-2">{b.title}</h3>
              <p className="text-sm text-white/60 font-body leading-relaxed">{b.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export default function Product() {
  const [displayCurrency] = useDisplayCurrency();
  const productLowUsd = 99;
  const productHighUsd = 999;
  const productLow =
    displayCurrency === DEFAULT_DISPLAY_CURRENCY
      ? productLowUsd
      : convertUsd(productLowUsd, displayCurrency);
  const productHigh =
    displayCurrency === DEFAULT_DISPLAY_CURRENCY
      ? productHighUsd
      : convertUsd(productHighUsd, displayCurrency);
  const { t } = useTranslation('marketing');

  useEffect(() => {
    trackPageView('/product');
  }, []);

  const capabilities = [
    { icon: Bot, title: t('product.capabilities.voice_agents_title'), desc: t('product.capabilities.voice_agents_desc') },
    { icon: Phone, title: t('product.capabilities.call_handling_title'), desc: t('product.capabilities.call_handling_desc') },
    { icon: GitBranch, title: t('product.capabilities.routing_title'), desc: t('product.capabilities.routing_desc') },
    { icon: Calendar, title: t('product.capabilities.scheduling_title'), desc: t('product.capabilities.scheduling_desc') },
    { icon: Zap, title: t('product.capabilities.campaigns_title'), desc: t('product.capabilities.campaigns_desc') },
    { icon: BarChart3, title: t('product.capabilities.analytics_title'), desc: t('product.capabilities.analytics_desc') },
    { icon: Shield, title: t('product.capabilities.qa_title'), desc: t('product.capabilities.qa_desc') },
    { icon: Bell, title: t('product.capabilities.alerts_title'), desc: t('product.capabilities.alerts_desc') },
    { icon: Layers, title: t('product.capabilities.multitenant_title'), desc: t('product.capabilities.multitenant_desc') },
    { icon: FileText, title: t('product.capabilities.transcripts_title'), desc: t('product.capabilities.transcripts_desc') },
    { icon: Clock, title: t('product.capabilities.afterhours_title'), desc: t('product.capabilities.afterhours_desc') },
    { icon: Phone, title: t('product.capabilities.numbers_title'), desc: t('product.capabilities.numbers_desc') },
  ];

  const productSchema = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: 'QVO Voice Operations Platform',
    description: 'AI-powered voice operations platform for small businesses featuring intelligent call handling, appointment scheduling, and real-time analytics.',
    brand: { '@type': 'Organization', name: 'QVO' },
    offers: {
      '@type': 'AggregateOffer',
      priceCurrency: displayCurrency,
      lowPrice: String(productLow),
      highPrice: String(productHigh),
      offerCount: '3',
    },
  };

  return (
    <div>
      <SEO
        title={t('product.seo_title')}
        description={t('product.seo_description')}
        canonicalPath="/product"
        structuredData={productSchema}
      />
      {/*
        Product hero — flat dark band placeholder. Wayne's bespoke
        Higgsfield render slots in here later (drop file at
        /hero/product-hero.{webp,mp4} and add a <picture>/<video> above
        the gradient layer). Until then:
          - radial-gradient backdrop, off-center at 70% 50% so it doesn't
            feel identical to Pricing (50% 30%), Features (30% 50%), or
            UseCases (60% 40%) when navigating between them
          - oversize tracking-tight headline (text-6xl @ lg)
          - explicit text-white on h1 — defensive against the QVO base
            reset h1 color rule that renders headlines invisible on dark
            surfaces (same bug we fixed on /demo, /pricing, /features)
        py-16 lg:py-24 (was py-20 lg:py-28) — tighter density now that
        there's no image to support the larger padding.
      */}
      <section className="relative overflow-hidden bg-sidebar-bg text-white py-16 lg:py-24">
        <div
          aria-hidden
          className="absolute inset-0 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse 70% 60% at 70% 50%, rgba(46,140,131,0.20), transparent 70%)',
          }}
        />
        <div className="relative max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-4">
              {t('product.hero.eyebrow')}
            </p>
            <h1 className="font-display text-white text-4xl lg:text-6xl font-bold leading-tight tracking-tight mb-6">
              {t('product.hero.title')}
            </h1>
            <p className="text-lg text-white/70 leading-relaxed font-body max-w-2xl">
              {t('product.hero.description')}
            </p>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="max-w-2xl mb-14">
              <h2 className="font-display text-3xl font-bold text-text-primary mb-4">
                {t('product.intro.title')}
              </h2>
              <p className="text-text-secondary font-body leading-relaxed">
                {t('product.intro.subtitle')}
              </p>
            </div>
          </RevealSection>
          <RevealSection>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
              {capabilities.map((c) => (
                <div key={c.title} className="bg-surface rounded-2xl border border-border/50 p-7 hover:border-primary/30 hover:shadow-md hover:-translate-y-1 transition-all duration-300 group">
                  <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center mb-4 group-hover:bg-primary/15 transition-colors">
                    <c.icon className="h-5 w-5 text-primary" />
                  </div>
                  <h3 className="font-display text-base font-semibold text-text-primary mb-2">{c.title}</h3>
                  <p className="text-sm text-text-secondary leading-relaxed font-body">{c.desc}</p>
                </div>
              ))}
            </div>
          </RevealSection>
        </div>
      </section>

      <WorkflowSection />

      <section className="py-16 lg:py-24 bg-surface">
        <div className="max-w-6xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-10">
              <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-3">
                {t('product.agent_workflow.eyebrow')}
              </p>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                {t('product.agent_workflow.title')}
              </h2>
              <p className="text-text-secondary font-body leading-relaxed max-w-2xl mx-auto">
                {t('product.agent_workflow.subtitle')}
              </p>
            </div>
            <div className="mb-14">
              <WorkflowDiagram steps={genericWorkflowSteps} />
            </div>
            <h3 className="font-display text-xl lg:text-2xl font-semibold text-text-primary text-center mb-8">
              {t('product.agent_workflow.industry_workflows')}
            </h3>
            <div className="grid md:grid-cols-2 gap-6 lg:gap-8">
              {[healthcareWorkflow, legalWorkflow, realEstateWorkflow, customerSupportWorkflow].map((wf) => (
                <WorkflowDiagram
                  key={wf.title}
                  steps={wf.steps}
                  title={wf.title}
                  accent={wf.accent}
                  compact
                />
              ))}
            </div>
            <div className="mt-6 lg:mt-8 max-w-xl mx-auto">
              <WorkflowDiagram
                steps={hvacWorkflow.steps}
                title={hvacWorkflow.title}
                accent={hvacWorkflow.accent}
                compact
              />
            </div>
          </RevealSection>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-surface-secondary">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-3">
                {t('product.tools_section.eyebrow')}
              </p>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                {t('product.tools_section.title')}
              </h2>
              <p className="text-text-secondary font-body leading-relaxed max-w-2xl mx-auto">
                {t('product.tools_section.subtitle')}
              </p>
            </div>
          </RevealSection>
          <div className="grid md:grid-cols-2 gap-6 max-w-5xl mx-auto">
            {[
              { src: '/assets/tools/calendar-scheduling.png', title: t('product.tools_section.calendar_title'), desc: t('product.tools_section.calendar_desc') },
              { src: '/assets/tools/crm-lookup.png', title: t('product.tools_section.crm_title'), desc: t('product.tools_section.crm_desc') },
              { src: '/assets/tools/ticket-creation.png', title: t('product.tools_section.ticket_title'), desc: t('product.tools_section.ticket_desc') },
              { src: '/assets/tools/sms-confirmation.png', title: t('product.tools_section.sms_title'), desc: t('product.tools_section.sms_desc') },
            ].map((tool) => (
              <RevealSection key={tool.title}>
                <div className="bg-surface rounded-2xl border border-border/30 overflow-hidden hover:shadow-lg transition-shadow group">
                  <div className="aspect-[4/3] overflow-hidden">
                    <img
                      src={tool.src}
                      alt={`${tool.title}`}
                      loading="lazy"
                      className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-300"
                    />
                  </div>
                  <div className="p-5">
                    <h3 className="font-display text-base font-semibold text-text-primary mb-1">{tool.title}</h3>
                    <p className="text-sm text-text-secondary font-body leading-relaxed">{tool.desc}</p>
                  </div>
                </div>
              </RevealSection>
            ))}
          </div>
        </div>
      </section>

      <ScreenshotsSection />

      <section className="py-20 lg:py-28 bg-surface">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-3">
                {t('product.platform_features.eyebrow')}
              </p>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                {t('product.platform_features.title')}
              </h2>
            </div>
          </RevealSection>
          <div className="grid md:grid-cols-2 gap-6 max-w-5xl mx-auto">
            {[
              { src: '/assets/features/voice-ai-automation.png', title: t('product.platform_features.voice_ai_title'), desc: t('product.platform_features.voice_ai_desc') },
              { src: '/assets/features/tool-integration.png', title: t('product.platform_features.tool_int_title'), desc: t('product.platform_features.tool_int_desc') },
              { src: '/assets/features/multi-agent.png', title: t('product.platform_features.multi_agent_title'), desc: t('product.platform_features.multi_agent_desc') },
              { src: '/assets/features/realtime-analytics.png', title: t('product.platform_features.realtime_title'), desc: t('product.platform_features.realtime_desc') },
            ].map((feature) => (
              <RevealSection key={feature.title}>
                <div className="bg-surface-secondary rounded-2xl border border-border/30 overflow-hidden hover:shadow-lg transition-shadow group">
                  <div className="aspect-[4/3] overflow-hidden">
                    <img
                      src={feature.src}
                      alt={`${feature.title}`}
                      loading="lazy"
                      className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform duration-300"
                    />
                  </div>
                  <div className="p-5">
                    <h3 className="font-display text-base font-semibold text-text-primary mb-1">{feature.title}</h3>
                    <p className="text-sm text-text-secondary font-body leading-relaxed">{feature.desc}</p>
                  </div>
                </div>
              </RevealSection>
            ))}
          </div>
        </div>
      </section>

      <IntegrationsSection />
      <SecuritySection />

      <section className="py-20 lg:py-24 bg-surface">
        <div className="max-w-6xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-10">
              <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-3">
                {t('product.deeper.eyebrow')}
              </p>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                {t('product.deeper.title')}
              </h2>
              <p className="text-text-secondary font-body leading-relaxed max-w-2xl mx-auto">
                {t('product.deeper.subtitle')}
              </p>
            </div>
          </RevealSection>
          <div className="grid md:grid-cols-3 gap-6">
            {[
              {
                to: '/product/federated-ingest',
                eyebrow: t('product.deeper.ingest_eyebrow'),
                title: t('product.deeper.ingest_title'),
                desc: t('product.deeper.ingest_desc'),
                cta: t('product.deeper.ingest_cta'),
              },
              {
                to: '/product/global-intelligence-network',
                eyebrow: t('product.deeper.gin_eyebrow'),
                title: t('product.deeper.gin_title'),
                desc: t('product.deeper.gin_desc'),
                cta: t('product.deeper.gin_cta'),
              },
              {
                to: '/industries/vertical-agents',
                eyebrow: t('product.deeper.vertical_eyebrow'),
                title: t('product.deeper.vertical_title'),
                desc: t('product.deeper.vertical_desc'),
                cta: t('product.deeper.vertical_cta'),
              },
            ].map((card) => (
              <RevealSection key={card.to}>
                <Link
                  to={card.to}
                  className="block bg-surface-secondary rounded-2xl border border-border/30 p-7 h-full hover:shadow-lg hover:border-primary/30 transition-all group"
                  onClick={() => trackCTAClick(card.title, '/product', 'go-deeper')}
                >
                  <p className="text-xs font-semibold text-primary uppercase tracking-wide mb-2">{card.eyebrow}</p>
                  <h3 className="font-display text-lg font-semibold text-text-primary mb-2">{card.title}</h3>
                  <p className="text-sm text-text-primary/65 font-body leading-relaxed mb-4">{card.desc}</p>
                  <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary group-hover:text-primary-hover">
                    {card.cta}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </span>
                </Link>
              </RevealSection>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-surface-secondary py-20 lg:py-24">
        <div className="max-w-3xl mx-auto px-6 lg:px-8 text-center">
          <h2 className="font-display text-3xl font-bold text-text-primary mb-4">
            {t('product.bottom_cta.title')}
          </h2>
          <p className="text-lg text-text-secondary font-body mb-10">
            {t('product.bottom_cta.subtitle')}
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              to="/demo"
              className="inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-white font-semibold px-6 py-3.5 rounded-lg transition-colors text-sm"
              onClick={() => trackCTAClick(CTA.TRY_LIVE_DEMO, 'product_bottom')}
            >
              {t('product.bottom_cta.try_demo')}
            </Link>
            <Link
              to="/signup"
              className="inline-flex items-center justify-center gap-2 bg-sidebar-bg hover:bg-sidebar-hover text-white font-semibold px-6 py-3.5 rounded-lg transition-colors text-sm"
              onClick={() => trackCTAClick(CTA.START_FREE_TRIAL, 'product_bottom')}
            >
              {t('product.bottom_cta.start_trial')}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
