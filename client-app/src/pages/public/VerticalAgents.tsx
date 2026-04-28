import { Link } from 'react-router-dom';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight, Stethoscope, Smile, Wrench, Eye, Scale, Home,
  Bot, Layers, Sparkles, ShieldCheck, CheckCircle2, BookOpen,
  Database, Plug, Settings, Activity, GitBranch, Target,
} from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';
import { trackPageView, trackCTAClick, trackVerticalEngagement } from '../../lib/analytics';

const agentMeta = [
  {
    slug: 'azul-vision',
    icon: Eye,
    accent: 'bg-blue-600',
    accentSoft: 'bg-blue-50',
    accentText: 'text-blue-700',
    verticalLink: '/industries/healthcare',
  },
  {
    slug: 'medical-front-desk',
    icon: Stethoscope,
    accent: 'bg-emerald-600',
    accentSoft: 'bg-emerald-50',
    accentText: 'text-emerald-700',
    verticalLink: '/industries/healthcare',
  },
  {
    slug: 'dental-practice',
    icon: Smile,
    accent: 'bg-cyan-600',
    accentSoft: 'bg-cyan-50',
    accentText: 'text-cyan-700',
    verticalLink: '/industries/dental',
  },
  {
    slug: 'field-service',
    icon: Wrench,
    accent: 'bg-orange-600',
    accentSoft: 'bg-orange-50',
    accentText: 'text-orange-700',
    verticalLink: '/industries/home-services',
  },
  {
    slug: 'legal-intake',
    icon: Scale,
    accent: 'bg-amber-600',
    accentSoft: 'bg-amber-50',
    accentText: 'text-amber-700',
    verticalLink: '/industries/legal',
  },
  {
    slug: 'real-estate',
    icon: Home,
    accent: 'bg-primary',
    accentSoft: 'bg-primary-light',
    accentText: 'text-primary',
    verticalLink: '/industries/real-estate',
  },
];

const whatYouGetIcons = [BookOpen, Plug, Database, ShieldCheck, Activity, GitBranch];
const deployStepIcons = [Sparkles, Settings, Target, Bot];

type TextItem = { title: string; desc: string };
type AgentCopy = {
  name: string;
  vertical: string;
  summary: string;
  capabilities: string[];
  source: string;
};

export default function VerticalAgents() {
  const { t } = useTranslation();

  useEffect(() => {
    trackPageView('/industries/vertical-agents');
  }, []);

  const agentsCopy = t('vertical_agents_page.catalog.agents', { returnObjects: true }) as AgentCopy[];
  const whatYouGet = t('vertical_agents_page.what_you_get.items', { returnObjects: true }) as TextItem[];
  const deploySteps = t('vertical_agents_page.deploy_steps.items', { returnObjects: true }) as TextItem[];
  const spotlightBullets = t('vertical_agents_page.spotlight.bullets', { returnObjects: true }) as string[];

  return (
    <div>
      <SEO
        title={t('vertical_agents_page.seo_title')}
        description={t('vertical_agents_page.seo_description')}
        canonicalPath="/industries/vertical-agents"
      />

      <section className="bg-sidebar-bg text-white py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-4">
              {t('vertical_agents_page.hero.eyebrow')}
            </p>
            <h1 className="font-display text-4xl lg:text-5xl font-bold leading-tight mb-6">
              {t('vertical_agents_page.hero.title')}
            </h1>
            <p className="text-lg text-white/70 leading-relaxed font-body max-w-2xl mb-8">
              {t('vertical_agents_page.hero.description')}
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link
                to="/demo"
                className="btn-primary-glow inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-on-primary font-semibold px-7 py-3.5 rounded-xl transition-colors duration-[var(--motion-base)] text-sm min-h-[44px]"
                onClick={() => trackCTAClick('Try a vertical agent', '/industries/vertical-agents', 'hero')}
              >
                {t('vertical_agents_page.hero.cta_primary')}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/book-demo"
                className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 backdrop-blur-sm text-white font-semibold px-7 py-3.5 rounded-xl transition-all text-sm border border-white/10"
                onClick={() => trackCTAClick('Book a demo', '/industries/vertical-agents', 'hero')}
              >
                {t('vertical_agents_page.hero.cta_secondary')}
              </Link>
            </div>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-white/60">
              <span className="inline-flex items-center gap-2"><Layers className="h-4 w-4 text-primary" />{t('vertical_agents_page.hero.chip_verticals')}</span>
              <span className="inline-flex items-center gap-2"><Bot className="h-4 w-4 text-primary" />{t('vertical_agents_page.hero.chip_native')}</span>
              <span className="inline-flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-primary" />{t('vertical_agents_page.hero.chip_compliance')}</span>
            </div>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-surface-secondary">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                {t('vertical_agents_page.catalog.heading')}
              </h2>
              <p className="text-lg text-text-primary/60 font-body max-w-2xl mx-auto">
                {t('vertical_agents_page.catalog.subheading')}
              </p>
            </div>
          </RevealSection>

          <div className="grid md:grid-cols-2 gap-6 max-w-6xl mx-auto">
            {agentMeta.map((agent, i) => {
              const copy = agentsCopy[i];
              if (!copy) return null;
              const Icon = agent.icon;
              return (
                <RevealSection key={agent.slug} delay={i % 2 === 0 ? '' : 'scroll-delay-1'}>
                  <div
                    className="bg-white rounded-2xl border border-border/30 overflow-hidden hover:shadow-lg transition-shadow h-full flex flex-col"
                    onMouseEnter={() => trackVerticalEngagement(agent.slug, 'card_hover')}
                  >
                    <div className={`px-7 pt-7 pb-5 ${agent.accentSoft}`}>
                      <div className="flex items-center gap-3 mb-3">
                        <div className={`w-11 h-11 rounded-xl ${agent.accent} flex items-center justify-center`}>
                          <Icon className="h-5 w-5 text-white" />
                        </div>
                        <div>
                          <p className={`text-xs font-semibold uppercase tracking-wide ${agent.accentText}`}>{copy.vertical}</p>
                          <h3 className="font-display text-xl font-bold text-text-primary">{copy.name}</h3>
                        </div>
                      </div>
                      <p className="text-sm text-text-primary/70 font-body leading-relaxed">{copy.summary}</p>
                    </div>
                    <div className="px-7 py-6 flex-1 flex flex-col">
                      <ul className="space-y-2 mb-5">
                        {copy.capabilities.map((cap) => (
                          <li key={cap} className="flex items-start gap-2 text-sm text-text-primary/70 font-body">
                            <CheckCircle2 className="h-4 w-4 text-success shrink-0 mt-0.5" />
                            <span>{cap}</span>
                          </li>
                        ))}
                      </ul>
                      <p className="text-xs text-text-primary/50 font-body italic mb-5">{copy.source}</p>
                      <div className="mt-auto flex flex-wrap gap-3">
                        <Link
                          to={agent.verticalLink}
                          className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary hover:text-primary-hover"
                          onClick={() => trackVerticalEngagement(agent.slug, 'see_industry')}
                        >
                          {t('vertical_agents_page.catalog.industry_link')}
                          <ArrowRight className="h-3.5 w-3.5" />
                        </Link>
                        <Link
                          to="/demo"
                          className="inline-flex items-center gap-1.5 text-sm font-semibold text-text-primary hover:text-text-primary"
                          onClick={() => trackVerticalEngagement(agent.slug, 'try_demo')}
                        >
                          {t('vertical_agents_page.catalog.demo_link')}
                          <ArrowRight className="h-3.5 w-3.5" />
                        </Link>
                      </div>
                    </div>
                  </div>
                </RevealSection>
              );
            })}
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-white">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <span className="inline-block text-sm font-semibold text-primary bg-primary/10 px-4 py-1.5 rounded-full mb-4">
                {t('vertical_agents_page.what_you_get.pill')}
              </span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                {t('vertical_agents_page.what_you_get.heading')}
              </h2>
            </div>
          </RevealSection>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-6xl mx-auto">
            {whatYouGet.map((item, i) => {
              const Icon = whatYouGetIcons[i] || BookOpen;
              return (
                <RevealSection key={item.title} delay={`scroll-delay-${(i % 3) + 1}`}>
                  <div className="bg-surface-secondary rounded-2xl border border-border/30 p-6 h-full hover:shadow-lg transition-shadow">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
                      <Icon className="h-5 w-5 text-primary" />
                    </div>
                    <h3 className="font-display text-base font-semibold text-text-primary mb-1.5">{item.title}</h3>
                    <p className="text-sm text-text-primary/65 leading-relaxed font-body">{item.desc}</p>
                  </div>
                </RevealSection>
              );
            })}
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-surface-secondary">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-3">
                {t('vertical_agents_page.deploy_steps.eyebrow')}
              </p>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                {t('vertical_agents_page.deploy_steps.heading')}
              </h2>
            </div>
          </RevealSection>
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-5 max-w-6xl mx-auto">
            {deploySteps.map((step, i) => {
              const Icon = deployStepIcons[i] || Sparkles;
              return (
                <RevealSection key={step.title}>
                  <div className="bg-white rounded-2xl border border-border/30 p-6 h-full">
                    <div className="w-10 h-10 rounded-lg bg-sidebar-bg/10 flex items-center justify-center mb-4">
                      <Icon className="h-5 w-5 text-text-primary" />
                    </div>
                    <h3 className="font-display text-base font-semibold text-text-primary mb-1.5">{step.title}</h3>
                    <p className="text-sm text-text-primary/65 leading-relaxed font-body">{step.desc}</p>
                  </div>
                </RevealSection>
              );
            })}
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-white">
        <div className="max-w-5xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="bg-sidebar-bg text-white rounded-2xl p-8 lg:p-12">
              <div className="flex flex-col lg:flex-row gap-8 items-start">
                <div className="lg:w-1/2">
                  <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-3">
                    {t('vertical_agents_page.spotlight.eyebrow')}
                  </p>
                  <h2 className="font-display text-2xl lg:text-3xl font-bold mb-4">
                    {t('vertical_agents_page.spotlight.heading')}
                  </h2>
                  <p className="text-base text-white/75 font-body leading-relaxed mb-5">
                    {t('vertical_agents_page.spotlight.desc')}
                  </p>
                  <ul className="space-y-2 text-sm text-white/85 font-body">
                    {spotlightBullets.map((bullet) => (
                      <li key={bullet} className="flex items-start gap-2">
                        <CheckCircle2 className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                        {bullet}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="lg:w-1/2 lg:pl-8 lg:border-l lg:border-white/10">
                  <h3 className="font-display text-base font-semibold text-white mb-4">
                    {t('vertical_agents_page.spotlight.partner_heading')}
                  </h3>
                  <p className="text-sm text-white/70 font-body leading-relaxed mb-5">
                    {t('vertical_agents_page.spotlight.partner_desc')}
                  </p>
                  <div className="flex flex-col sm:flex-row gap-3">
                    <Link
                      to="/contact"
                      className="inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-white font-semibold px-5 py-2.5 rounded-lg text-sm"
                      onClick={() => trackCTAClick('Partner with QVO', '/industries/vertical-agents', 'spotlight')}
                    >
                      {t('vertical_agents_page.spotlight.partner_cta')}
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                    <Link
                      to="/product/federated-ingest"
                      className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 text-white font-semibold px-5 py-2.5 rounded-lg text-sm border border-white/10"
                    >
                      {t('vertical_agents_page.spotlight.partner_alt')}
                    </Link>
                  </div>
                </div>
              </div>
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
              {t('vertical_agents_page.bottom_cta.title')}
            </h2>
            <p className="text-lg text-white/65 font-body mb-10 max-w-xl mx-auto">
              {t('vertical_agents_page.bottom_cta.subtitle')}
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                to="/signup"
                className="btn-primary-glow inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-on-primary font-semibold px-8 py-3.5 rounded-xl transition-colors duration-[var(--motion-base)] text-sm min-h-[44px]"
                onClick={() => trackCTAClick('Start free trial', '/industries/vertical-agents', 'bottom-cta')}
              >
                {t('vertical_agents_page.bottom_cta.cta_primary')}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/use-cases"
                className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 backdrop-blur-sm text-white font-semibold px-8 py-3.5 rounded-xl transition-all text-sm border border-white/10"
                onClick={() => trackCTAClick('See use cases', '/industries/vertical-agents', 'bottom-cta')}
              >
                {t('vertical_agents_page.bottom_cta.cta_secondary')}
              </Link>
            </div>
          </div>
        </RevealSection>
      </section>
    </div>
  );
}
