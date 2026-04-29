import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Mic, Settings, Zap, LayoutDashboard, BookOpen, Plug,
  Calendar, Ticket, MessageSquare, Truck, Users, ArrowRight,
  CheckCircle2, Bot, Cpu, Wrench, Database, Shield,
} from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';
import { useEffect } from 'react';
import { trackPageView, trackFeatureView, trackCTAClick } from '../../lib/analytics';
import { CTA } from '../../lib/analyticsCtas';

export default function Features() {
  const { t } = useTranslation('marketing');

  useEffect(() => {
    trackPageView('/features');
  }, []);

  const platformCapabilities = [
    {
      icon: Mic,
      title: t('features.capabilities.voice_runtime_title'),
      desc: t('features.capabilities.voice_runtime_desc'),
      details: [
        t('features.capabilities.voice_runtime_d1'),
        t('features.capabilities.voice_runtime_d2'),
        t('features.capabilities.voice_runtime_d3'),
        t('features.capabilities.voice_runtime_d4'),
        t('features.capabilities.voice_runtime_d5'),
      ],
    },
    {
      icon: Settings,
      title: t('features.capabilities.agent_builder_title'),
      desc: t('features.capabilities.agent_builder_desc'),
      details: [
        t('features.capabilities.agent_builder_d1'),
        t('features.capabilities.agent_builder_d2'),
        t('features.capabilities.agent_builder_d3'),
        t('features.capabilities.agent_builder_d4'),
        t('features.capabilities.agent_builder_d5'),
      ],
    },
    {
      icon: Zap,
      title: t('features.capabilities.tool_engine_title'),
      desc: t('features.capabilities.tool_engine_desc'),
      details: [
        t('features.capabilities.tool_engine_d1'),
        t('features.capabilities.tool_engine_d2'),
        t('features.capabilities.tool_engine_d3'),
        t('features.capabilities.tool_engine_d4'),
        t('features.capabilities.tool_engine_d5'),
      ],
    },
    {
      icon: LayoutDashboard,
      title: t('features.capabilities.dashboard_title'),
      desc: t('features.capabilities.dashboard_desc'),
      details: [
        t('features.capabilities.dashboard_d1'),
        t('features.capabilities.dashboard_d2'),
        t('features.capabilities.dashboard_d3'),
        t('features.capabilities.dashboard_d4'),
        t('features.capabilities.dashboard_d5'),
      ],
    },
    {
      icon: BookOpen,
      title: t('features.capabilities.knowledge_title'),
      desc: t('features.capabilities.knowledge_desc'),
      details: [
        t('features.capabilities.knowledge_d1'),
        t('features.capabilities.knowledge_d2'),
        t('features.capabilities.knowledge_d3'),
        t('features.capabilities.knowledge_d4'),
        t('features.capabilities.knowledge_d5'),
      ],
    },
    {
      icon: Plug,
      title: t('features.capabilities.integration_title'),
      desc: t('features.capabilities.integration_desc'),
      details: [
        t('features.capabilities.integration_d1'),
        t('features.capabilities.integration_d2'),
        t('features.capabilities.integration_d3'),
        t('features.capabilities.integration_d4'),
        t('features.capabilities.integration_d5'),
      ],
    },
  ];

  const miniSystems = [
    { icon: Calendar, title: t('features.mini_systems.scheduling_title'), desc: t('features.mini_systems.scheduling_desc') },
    { icon: Ticket, title: t('features.mini_systems.ticketing_title'), desc: t('features.mini_systems.ticketing_desc') },
    { icon: MessageSquare, title: t('features.mini_systems.sms_title'), desc: t('features.mini_systems.sms_desc') },
    { icon: Truck, title: t('features.mini_systems.dispatch_title'), desc: t('features.mini_systems.dispatch_desc') },
    { icon: Users, title: t('features.mini_systems.tracking_title'), desc: t('features.mini_systems.tracking_desc') },
  ];

  const architectureBlocks = [
    { icon: Cpu, label: t('features.architecture.voice_runtime'), color: 'bg-primary/15 text-primary' },
    { icon: Bot, label: t('features.architecture.agent_builder'), color: 'bg-surface-muted text-text-primary' },
    { icon: Zap, label: t('features.architecture.tool_engine'), color: 'bg-accent/15 text-accent' },
    { icon: Database, label: t('features.architecture.knowledge_rag'), color: 'bg-success/15 text-success' },
    { icon: Plug, label: t('features.architecture.integrations'), color: 'bg-primary/15 text-primary' },
    { icon: Shield, label: t('features.architecture.security_layer'), color: 'bg-danger/15 text-danger' },
  ];

  return (
    <div>
      <SEO
        title={t('features.seo_title')}
        description={t('features.seo_description')}
        canonicalPath="/features"
      />

      <section className="bg-sidebar-bg text-white py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-4">
              {t('features.hero.eyebrow')}
            </p>
            <h1 className="font-display text-4xl lg:text-5xl font-bold leading-tight mb-6">
              {t('features.hero.title')}
            </h1>
            <p className="text-lg text-white/70 leading-relaxed font-body max-w-2xl mb-8">
              {t('features.hero.description')}
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link
                to="/demo"
                className="btn-primary-glow inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-on-primary font-semibold px-7 py-3.5 rounded-xl transition-colors duration-[var(--motion-base)] text-sm min-h-[44px]"
                onClick={() => trackCTAClick(CTA.TRY_LIVE_DEMO, '/features', 'hero')}
              >
                {t('common.try_live_demo')}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/use-cases"
                className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 backdrop-blur-sm text-white font-semibold px-7 py-3.5 rounded-xl transition-all text-sm border border-white/10"
                onClick={() => trackCTAClick(CTA.SEE_USE_CASES, '/features', 'hero')}
              >
                {t('common.see_use_cases')}
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-surface-secondary">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                {t('features.architecture.title')}
              </h2>
              <p className="text-lg text-text-primary/60 font-body max-w-2xl mx-auto">
                {t('features.architecture.subtitle')}
              </p>
            </div>
          </RevealSection>

          <RevealSection>
            <div className="max-w-4xl mx-auto mb-16">
              <div className="bg-white rounded-2xl border border-border/30 p-8 lg:p-10">
                <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                  {architectureBlocks.map((block) => (
                    <div
                      key={block.label}
                      className="flex items-center gap-3 p-4 rounded-xl border border-border/20 hover:shadow-md transition-all"
                    >
                      <div className={`w-10 h-10 rounded-lg ${block.color} flex items-center justify-center shrink-0`}>
                        <block.icon className="h-5 w-5" />
                      </div>
                      <span className="font-display text-sm font-semibold text-text-primary">{block.label}</span>
                    </div>
                  ))}
                </div>
                <div className="mt-6 pt-6 border-t border-border/20 text-center">
                  <p className="text-xs text-text-primary/40 font-body">
                    {t('features.architecture.footer')}
                  </p>
                </div>
              </div>
            </div>
          </RevealSection>

          <div className="space-y-12">
            {platformCapabilities.map((cap, i) => (
              <RevealSection key={cap.title} delay={i % 2 === 0 ? '' : 'scroll-delay-1'}>
                <div
                  className="bg-white rounded-2xl border border-border/30 overflow-hidden hover:shadow-lg transition-shadow"
                  onMouseEnter={() => trackFeatureView(cap.title)}
                >
                  <div className="p-8 lg:p-10">
                    <div className="flex items-start gap-4 mb-6">
                      <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                        <cap.icon className="h-6 w-6 text-primary" />
                      </div>
                      <div>
                        <h3 className="font-display text-2xl font-bold text-text-primary">{cap.title}</h3>
                      </div>
                    </div>
                    <p className="text-text-primary/70 font-body leading-relaxed mb-6 max-w-3xl">
                      {cap.desc}
                    </p>
                    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                      {cap.details.map((detail) => (
                        <div key={detail} className="flex items-center gap-2 text-sm text-text-primary/70 font-body">
                          <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
                          {detail}
                        </div>
                      ))}
                    </div>
                  </div>
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
              <span className="inline-block text-sm font-semibold text-primary bg-primary/10 px-4 py-1.5 rounded-full mb-4">
                {t('features.mini_systems.badge')}
              </span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                {t('features.mini_systems.title')}
              </h2>
              <p className="text-lg text-text-primary/60 font-body max-w-2xl mx-auto">
                {t('features.mini_systems.subtitle')}
              </p>
            </div>
          </RevealSection>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-5xl mx-auto">
            {miniSystems.map((sys, i) => (
              <RevealSection key={sys.title} delay={`scroll-delay-${(i % 3) + 1}`}>
                <div className="bg-gradient-to-br from-surface-secondary to-info-light/30 rounded-2xl border border-border/30 p-7 hover:shadow-lg transition-all h-full">
                  <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                    <sys.icon className="h-5 w-5 text-primary" />
                  </div>
                  <h3 className="font-display text-lg font-semibold text-text-primary mb-2">{sys.title}</h3>
                  <p className="text-sm text-text-primary/60 leading-relaxed font-body">{sys.desc}</p>
                </div>
              </RevealSection>
            ))}
          </div>
        </div>
      </section>

      <section className="relative py-20 lg:py-24 overflow-hidden bg-sidebar-bg">
        <div className="absolute inset-0 bg-gradient-to-r from-sidebar-bg via-sidebar-hover/40 to-sidebar-bg" />
        <div className="absolute inset-0 opacity-15">
          <div className="absolute top-0 left-1/4 w-64 h-64 bg-primary rounded-full blur-[100px]" />
          <div className="absolute bottom-0 right-1/4 w-80 h-80 bg-primary rounded-full blur-[120px]" />
        </div>
        <RevealSection>
          <div className="relative max-w-3xl mx-auto px-6 lg:px-8 text-center">
            <h2 className="font-display text-3xl lg:text-4xl font-bold text-white mb-4">
              {t('features.bottom_cta.title')}
            </h2>
            <p className="text-lg text-white/60 font-body mb-10 max-w-xl mx-auto">
              {t('features.bottom_cta.subtitle')}
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                to="/signup"
                className="btn-primary-glow inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-on-primary font-semibold px-8 py-3.5 rounded-xl transition-colors duration-[var(--motion-base)] text-sm min-h-[44px]"
                onClick={() => trackCTAClick(CTA.START_FREE_TRIAL, '/features', 'bottom-cta')}
              >
                {t('common.start_free_trial')}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/demo"
                className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 backdrop-blur-sm text-white font-semibold px-8 py-3.5 rounded-xl transition-all text-sm border border-white/10"
                onClick={() => trackCTAClick(CTA.TRY_LIVE_DEMO, '/features', 'bottom-cta')}
              >
                {t('common.try_live_demo')}
              </Link>
            </div>
          </div>
        </RevealSection>
      </section>
    </div>
  );
}
