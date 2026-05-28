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
import { VERTICAL_ACTION } from '../../lib/analyticsLabels';
import { CTA } from '../../lib/analyticsCtas';

const agentMeta = [
  {
    slug: 'azul-vision',
    icon: Eye,
    accent: 'bg-info',
    accentSoft: 'bg-info-light dark:bg-info',
    accentText: 'text-info dark:text-info',
    verticalLink: '/industries/healthcare',
  },
  {
    slug: 'medical-front-desk',
    icon: Stethoscope,
    accent: 'bg-success',
    accentSoft: 'bg-success-light dark:bg-success',
    accentText: 'text-success dark:text-success',
    verticalLink: '/industries/healthcare',
  },
  {
    // Dental was the lone raw-Tailwind cyan in an otherwise brand-semantic
    // array (success / warning / warning / primary on the other entries).
    // Collapsed to brand `info` (the brand-semantic equivalent of the
    // sky/cyan/indigo family) so the page no longer mixes raw Tailwind
    // tokens with brand tokens.
    slug: 'dental-practice',
    icon: Smile,
    accent: 'bg-info',
    accentSoft: 'bg-info/10 dark:bg-info/15',
    accentText: 'text-info',
    verticalLink: '/industries/dental',
  },
  {
    slug: 'field-service',
    icon: Wrench,
    accent: 'bg-warning',
    accentSoft: 'bg-warning-light dark:bg-warning',
    accentText: 'text-warning dark:text-warning',
    verticalLink: '/industries/home-services',
  },
  {
    slug: 'legal-intake',
    icon: Scale,
    accent: 'bg-warning',
    accentSoft: 'bg-warning-light dark:bg-warning',
    accentText: 'text-warning dark:text-warning',
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

      {/*
        VerticalAgents hero — flat dark band placeholder. Wayne's bespoke
        Higgsfield render slots in here later (drop file at
        /hero/vertical-agents-hero.{webp,mp4} and add a <picture>/<video>
        above the gradient layer). Until then:
          - radial-gradient backdrop at 50% 40% (off-center)
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
              'radial-gradient(ellipse 70% 60% at 50% 40%, rgba(46,140,131,0.20), transparent 70%)',
          }}
        />
        <div className="relative max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-4">
              {t('vertical_agents_page.hero.eyebrow')}
            </p>
            <h1 className="font-display text-white text-4xl lg:text-6xl font-bold leading-tight tracking-tight mb-6">
              {t('vertical_agents_page.hero.title')}
            </h1>
            <p className="text-lg text-white/70 leading-relaxed font-body max-w-2xl mb-8">
              {t('vertical_agents_page.hero.description')}
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link
                to="/demo"
                className="btn-primary-glow inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-on-primary font-semibold px-7 py-3.5 rounded-xl transition-colors duration-[var(--motion-base)] text-sm min-h-[44px]"
                onClick={() => trackCTAClick(CTA.TRY_VERTICAL_AGENT, '/industries/vertical-agents', 'hero')}
              >
                {t('vertical_agents_page.hero.cta_primary')}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/book-demo"
                className="inline-flex items-center justify-center gap-2 bg-white/10 dark:bg-white/10 hover:bg-white/15 dark:hover:bg-white/15 backdrop-blur-sm text-white font-semibold px-7 py-3.5 rounded-xl transition-all text-sm border border-white/10 dark:border-white/10"
                onClick={() => trackCTAClick(CTA.BOOK_DEMO, '/industries/vertical-agents', 'hero')}
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
                    className="bg-surface rounded-2xl border border-border/30 overflow-hidden hover:shadow-lg transition-shadow h-full flex flex-col"
                    onMouseEnter={() => trackVerticalEngagement(agent.slug, VERTICAL_ACTION.CARD_HOVER)}
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
                          onClick={() => trackVerticalEngagement(agent.slug, VERTICAL_ACTION.SEE_INDUSTRY)}
                        >
                          {t('vertical_agents_page.catalog.industry_link')}
                          <ArrowRight className="h-3.5 w-3.5" />
                        </Link>
                        <Link
                          to="/demo"
                          className="inline-flex items-center gap-1.5 text-sm font-semibold text-text-primary hover:text-text-primary"
                          onClick={() => trackVerticalEngagement(agent.slug, VERTICAL_ACTION.TRY_DEMO)}
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

      <section className="py-20 lg:py-28 bg-surface">
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
                  <div className="bg-surface rounded-2xl border border-border/30 p-6 h-full">
                    <div className="w-10 h-10 rounded-lg bg-surface-muted flex items-center justify-center mb-4">
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

      <section className="py-20 lg:py-28 bg-surface">
        <div className="max-w-5xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="bg-sidebar-bg text-white rounded-2xl p-8 lg:p-12">
              <div className="flex flex-col lg:flex-row gap-8 items-start">
                <div className="lg:w-1/2">
                  <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-3">
                    {t('vertical_agents_page.spotlight.eyebrow')}
                  </p>
                  {/* Explicit text-white + tracking-tight defensive
                      against the QVO base reset rule (h2 → light-theme
                      dark token on dark surfaces would render invisible).
                      Same fix as the hero h1 above. */}
                  <h2 className="font-display text-white text-2xl lg:text-3xl font-bold tracking-tight mb-4">
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
                      onClick={() => trackCTAClick(CTA.PARTNER_WITH_QVO, '/industries/vertical-agents', 'spotlight')}
                    >
                      {t('vertical_agents_page.spotlight.partner_cta')}
                      <ArrowRight className="h-3.5 w-3.5" />
                    </Link>
                    <Link
                      to="/product/federated-ingest"
                      className="inline-flex items-center justify-center gap-2 bg-white/10 dark:bg-white/10 hover:bg-white/15 dark:hover:bg-white/15 text-white font-semibold px-5 py-2.5 rounded-lg text-sm border border-white/10 dark:border-white/10"
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
                onClick={() => trackCTAClick(CTA.START_FREE_TRIAL, '/industries/vertical-agents', 'bottom-cta')}
              >
                {t('vertical_agents_page.bottom_cta.cta_primary')}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/use-cases"
                className="inline-flex items-center justify-center gap-2 bg-white/10 dark:bg-white/10 hover:bg-white/15 dark:hover:bg-white/15 backdrop-blur-sm text-white font-semibold px-8 py-3.5 rounded-xl transition-all text-sm border border-white/10 dark:border-white/10"
                onClick={() => trackCTAClick(CTA.SEE_USE_CASES, '/industries/vertical-agents', 'bottom-cta')}
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
