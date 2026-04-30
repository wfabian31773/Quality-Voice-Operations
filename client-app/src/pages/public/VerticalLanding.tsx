import { useParams, Link } from 'react-router-dom';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Phone, Clock, DollarSign, Users, CheckCircle2, ArrowRight,
  Stethoscope, Home, Scale, Wrench, Smile, BarChart3, Shield,
  Calendar, MessageSquare, TrendingUp, Star, Zap, Target,
  PawPrint, Car, Landmark, Hotel,
} from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';
import ROICalculator from '../../components/ROICalculator';
import { trackPageView, trackVerticalEngagement, trackCTAClick, trackConversionEvent, captureUtmOnLoad } from '../../lib/analytics';
import { VERTICAL_ACTION, CONVERSION_STAGE } from '../../lib/analyticsLabels';
import { CTA } from '../../lib/analyticsCtas';

interface VerticalConfig {
  slug: string;
  icon: typeof Phone;
  color: string;
  colorLight: string;
  heroImage: string;
  heroOverlayAccent: string;
  demoAgent: string;
}

interface PainPoint {
  title: string;
  description: string;
}

interface AgentExample {
  name: string;
  description: string;
  capabilities: string[];
}

interface Stat {
  value: string;
  label: string;
}

interface Testimonial {
  quote: string;
  author: string;
  role: string;
  company: string;
}

const verticals: Record<string, VerticalConfig> = {
  healthcare: {
    slug: 'healthcare',
    icon: Stethoscope,
    color: 'bg-blue-600',
    colorLight: 'bg-blue-50',
    heroImage: '/industry-hero/healthcare.jpg',
    heroOverlayAccent: 'from-blue-500/20 to-primary/10',
    demoAgent: 'medical-intake',
  },
  'real-estate': {
    slug: 'real-estate',
    icon: Home,
    color: 'bg-emerald-600',
    colorLight: 'bg-emerald-50',
    heroImage: '/industry-hero/real-estate.jpg',
    heroOverlayAccent: 'from-emerald-500/20 to-primary/10',
    demoAgent: 'real-estate',
  },
  legal: {
    slug: 'legal',
    icon: Scale,
    color: 'bg-amber-600',
    colorLight: 'bg-amber-50',
    heroImage: '/industry-hero/legal.jpg',
    heroOverlayAccent: 'from-amber-600/20 to-orange-500/10',
    demoAgent: 'legal-intake',
  },
  'home-services': {
    slug: 'home-services',
    icon: Wrench,
    color: 'bg-orange-600',
    colorLight: 'bg-orange-50',
    heroImage: '/industry-hero/home-services.jpg',
    heroOverlayAccent: 'from-orange-500/20 to-amber-500/10',
    demoAgent: 'hvac-home-services',
  },
  dental: {
    slug: 'dental',
    icon: Smile,
    color: 'bg-cyan-600',
    colorLight: 'bg-cyan-50',
    heroImage: '/industry-hero/dental.jpg',
    heroOverlayAccent: 'from-cyan-500/20 to-primary/10',
    demoAgent: 'dental-scheduling',
  },
  veterinary: {
    slug: 'veterinary',
    icon: PawPrint,
    color: 'bg-green-600',
    colorLight: 'bg-green-50',
    heroImage: '/industry-hero/veterinary.jpg',
    heroOverlayAccent: 'from-green-500/20 to-primary/10',
    demoAgent: 'veterinary-scheduling',
  },
  automotive: {
    slug: 'automotive',
    icon: Car,
    color: 'bg-slate-700',
    colorLight: 'bg-slate-50',
    heroImage: '/industry-hero/automotive.jpg',
    heroOverlayAccent: 'from-slate-500/25 to-blue-500/10',
    demoAgent: 'automotive-service',
  },
  finance: {
    slug: 'finance',
    icon: Landmark,
    color: 'bg-indigo-700',
    colorLight: 'bg-indigo-50',
    heroImage: '/industry-hero/finance.jpg',
    heroOverlayAccent: 'from-indigo-500/25 to-blue-500/10',
    demoAgent: 'finance-prospect',
  },
  hospitality: {
    slug: 'hospitality',
    icon: Hotel,
    color: 'bg-amber-700',
    colorLight: 'bg-amber-50',
    heroImage: '/industry-hero/hospitality.jpg',
    heroOverlayAccent: 'from-amber-500/25 to-rose-500/10',
    demoAgent: 'hospitality-reservations',
  },
};

export default function VerticalLanding() {
  const { t } = useTranslation('marketing');
  const { vertical } = useParams<{ vertical: string }>();
  const config = vertical ? verticals[vertical] : null;

  useEffect(() => {
    captureUtmOnLoad();
    if (config) {
      trackPageView(`/industries/${config.slug}`);
      trackVerticalEngagement(config.slug, VERTICAL_ACTION.PAGE_VIEW);
      trackConversionEvent(CONVERSION_STAGE.PAGE_VIEW, `/industries/${config.slug}`);
    }
  }, [config]);

  if (!config) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-center">
          <h1 className="text-2xl font-display font-bold text-text-primary mb-4">{t('vertical_page.not_found.title')}</h1>
          <p className="text-slate-600 mb-6">{t('vertical_page.not_found.subtitle')}</p>
          <Link to="/use-cases" className="text-primary hover:underline">{t('vertical_page.not_found.view_all')} &rarr;</Link>
        </div>
      </div>
    );
  }

  const Icon = config.icon;
  const dataKey = `vertical_data.${config.slug}`;
  const verticalName = t(`${dataKey}.name`);
  const verticalLower = verticalName.toLocaleLowerCase();
  const headline = t(`${dataKey}.headline`);
  const subheadline = t(`${dataKey}.subheadline`);
  const metaTitle = t(`${dataKey}.metaTitle`);
  const metaDescription = t(`${dataKey}.metaDescription`);
  const painPoints = t(`${dataKey}.painPoints`, { returnObjects: true }) as PainPoint[];
  const agentExamples = t(`${dataKey}.agentExamples`, { returnObjects: true }) as AgentExample[];
  const stats = t(`${dataKey}.stats`, { returnObjects: true }) as Stat[];
  const testimonial = t(`${dataKey}.testimonial`, { returnObjects: true }) as Testimonial;

  return (
    <>
      <SEO
        title={metaTitle}
        description={metaDescription}
        canonicalPath={`/industries/${config.slug}`}
        structuredData={{
          '@context': 'https://schema.org',
          '@type': 'WebPage',
          name: metaTitle,
          description: metaDescription,
          url: `https://qvo.ai/industries/${config.slug}`,
          provider: {
            '@type': 'Organization',
            name: 'QVO',
            url: 'https://qvo.ai',
          },
        }}
      />

      <section className="relative overflow-hidden">
        {/* Background photo */}
        <div className="absolute inset-0">
          <img
            src={config.heroImage}
            alt={`${verticalName} workspace`}
            className="w-full h-full object-cover"
          />
          {/* Dark base for text contrast (left-weighted) */}
          <div className="absolute inset-0 bg-gradient-to-r from-sidebar-bg via-sidebar-bg/85 to-sidebar-bg/30 lg:to-sidebar-bg/10" />
          <div className="absolute inset-0 bg-gradient-to-t from-sidebar-bg/80 via-transparent to-sidebar-bg/40" />
          {/* Accent wash */}
          <div className={`absolute inset-0 bg-gradient-to-br opacity-70 mix-blend-soft-light ${config.heroOverlayAccent}`} />
        </div>

        <div className="relative max-w-7xl mx-auto px-6 lg:px-8 py-24 lg:py-32">
          <div className="grid lg:grid-cols-[1.1fr,1fr] gap-12 items-center">
            <div className="max-w-2xl">
              <div className="flex items-center gap-3 mb-6">
                <div className={`w-10 h-10 rounded-xl ${config.color} flex items-center justify-center shadow-lg`}>
                  <Icon className="h-5 w-5 text-white" />
                </div>
                <span className="text-sm font-medium text-primary uppercase tracking-[0.2em]">{verticalName}</span>
              </div>
              <h1 className="text-4xl md:text-5xl lg:text-6xl font-display font-bold text-white leading-[1.05] mb-6">
                {headline}
              </h1>
              <p className="text-lg md:text-xl text-white/80 leading-relaxed mb-8">
                {subheadline}
              </p>
              <div className="flex flex-wrap gap-4">
                <Link
                  to="/signup"
                  onClick={() => { trackCTAClick(CTA.START_FREE_TRIAL, `industry-${config.slug}`, 'hero'); trackConversionEvent(CONVERSION_STAGE.CTA_CLICK, `/industries/${config.slug}`, { cta: 'signup' }); }}
                  className="btn-primary-glow inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-on-primary px-6 py-3 rounded-xl font-medium transition-colors duration-[var(--motion-base)] min-h-[44px]"
                >
                  {t('vertical_page.hero.start_trial')} <ArrowRight className="h-4 w-4" />
                </Link>
                <Link
                  to={`/demo?agent=${config.demoAgent}`}
                  onClick={() => { trackCTAClick(CTA.TRY_LIVE_DEMO, `industry-${config.slug}`, 'hero'); trackConversionEvent(CONVERSION_STAGE.DEMO_STARTED, `/industries/${config.slug}`); }}
                  className="inline-flex items-center gap-2 bg-white/15 hover:bg-white/25 text-white px-6 py-3 rounded-xl font-medium transition-colors backdrop-blur-sm border border-white/20"
                >
                  {t('vertical_page.hero.try_demo')} <Phone className="h-4 w-4" />
                </Link>
              </div>
            </div>

            {/* Right-side floating stats card — desktop only */}
            <div className="hidden lg:flex justify-end">
              <div className="relative max-w-sm w-full">
                <div className="rounded-2xl bg-sidebar-bg/70 backdrop-blur-md border border-white/15 p-6 shadow-2xl">
                  <div className="flex items-center gap-2 mb-4">
                    <span className="w-2 h-2 rounded-full bg-success animate-pulse" />
                    <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-success">{t('vertical_page.card.live_performance')}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    {stats.slice(0, 4).map((stat) => (
                      <div key={stat.label}>
                        <p className="font-display text-2xl font-bold text-white leading-none">{stat.value}</p>
                        <p className="text-[11px] text-white/60 mt-1.5">{stat.label}</p>
                      </div>
                    ))}
                  </div>
                  <div className="mt-5 pt-4 border-t border-white/10 flex items-center gap-2 text-[11px] text-white/70">
                    <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
                    {t('vertical_page.card.from_customers_in', { vertical: verticalLower })}
                  </div>
                </div>
                <div className="absolute -bottom-3 -left-3 rounded-xl bg-white shadow-xl border border-slate-100 p-3 flex items-center gap-2.5 max-w-[220px]">
                  <div className={`w-8 h-8 rounded-lg ${config.color} flex items-center justify-center shrink-0`}>
                    <Icon className="h-4 w-4 text-white" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[11px] font-semibold text-text-primary leading-tight">{t('vertical_page.card.pre_built_for', { vertical: verticalName })}</p>
                    <p className="text-[10px] text-slate-500 leading-tight mt-0.5">{t('vertical_page.card.deploy_minutes')}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="py-12 bg-white border-b border-slate-100">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            {stats.map((stat) => (
              <div key={stat.label} className="text-center">
                <div className="text-3xl md:text-4xl font-display font-bold text-text-primary">{stat.value}</div>
                <div className="text-sm text-slate-500 mt-1">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 bg-surface-secondary">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-16">
              <h2 className="text-3xl md:text-4xl font-display font-bold text-text-primary mb-4">
                {t('vertical_page.problems.title')}
              </h2>
              <p className="text-lg text-slate-600 max-w-2xl mx-auto">
                {t('vertical_page.problems.subtitle', { vertical: verticalName })}
              </p>
            </div>
          </RevealSection>
          <div className="grid md:grid-cols-2 gap-6">
            {painPoints.map((point, idx) => (
              <RevealSection key={point.title} delay={`delay-${idx * 100}`}>
                <div className="bg-white rounded-2xl p-6 border border-slate-100 hover:shadow-lg transition-shadow">
                  <div className="flex items-start gap-4">
                    <div className="w-8 h-8 rounded-lg bg-red-50 flex items-center justify-center shrink-0 mt-0.5">
                      <Target className="h-4 w-4 text-red-500" />
                    </div>
                    <div>
                      <h3 className="font-display font-semibold text-text-primary mb-2">{point.title}</h3>
                      <p className="text-sm text-slate-600 leading-relaxed">{point.description}</p>
                    </div>
                  </div>
                </div>
              </RevealSection>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 bg-white">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-16">
              <h2 className="text-3xl md:text-4xl font-display font-bold text-text-primary mb-4">
                {t('vertical_page.agents.title', { vertical: verticalName })}
              </h2>
              <p className="text-lg text-slate-600 max-w-2xl mx-auto">
                {t('vertical_page.agents.subtitle', { vertical_lower: verticalLower })}
              </p>
            </div>
          </RevealSection>
          <div className="grid md:grid-cols-3 gap-8">
            {agentExamples.map((agent, idx) => (
              <RevealSection key={agent.name} delay={`delay-${idx * 150}`}>
                <div className="bg-surface-secondary rounded-2xl p-6 border border-slate-100 h-full flex flex-col">
                  <div className={`w-10 h-10 rounded-xl ${config.color} flex items-center justify-center mb-4`}>
                    <Zap className="h-5 w-5 text-white" />
                  </div>
                  <h3 className="font-display font-semibold text-text-primary text-lg mb-2">{agent.name}</h3>
                  <p className="text-sm text-slate-600 mb-4 flex-1">{agent.description}</p>
                  <ul className="space-y-2">
                    {agent.capabilities.map((cap) => (
                      <li key={cap} className="flex items-center gap-2 text-sm text-slate-700">
                        <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                        {cap}
                      </li>
                    ))}
                  </ul>
                </div>
              </RevealSection>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 bg-surface-secondary">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-12">
              <h2 className="text-3xl md:text-4xl font-display font-bold text-text-primary mb-4">
                {t('vertical_page.roi.title')}
              </h2>
              <p className="text-lg text-slate-600 max-w-2xl mx-auto">
                {t('vertical_page.roi.subtitle', { vertical_lower: verticalLower })}
              </p>
            </div>
          </RevealSection>
          <ROICalculator vertical={config.slug} />
        </div>
      </section>

      <section className="py-20 bg-sidebar-bg">
        <div className="max-w-4xl mx-auto px-6 lg:px-8 text-center">
          <RevealSection>
            <div className="flex justify-center mb-4">
              {[...Array(5)].map((_, i) => (
                <Star key={i} className="h-5 w-5 text-yellow-400 fill-yellow-400" />
              ))}
            </div>
            <blockquote className="text-xl md:text-2xl text-white font-display leading-relaxed mb-6">
              "{testimonial.quote}"
            </blockquote>
            <div className="text-white/70">
              <span className="font-semibold text-white">{testimonial.author}</span>
              <span className="mx-2">·</span>
              {testimonial.role}, {testimonial.company}
            </div>
          </RevealSection>
        </div>
      </section>

      <section className="py-20 bg-white">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-12">
              <h2 className="text-3xl md:text-4xl font-display font-bold text-text-primary mb-4">
                {t('vertical_page.why.title', { vertical: verticalName })}
              </h2>
            </div>
          </RevealSection>
          <div className="grid md:grid-cols-3 gap-8">
            {[
              { icon: Shield, title: t('vertical_page.why.industry_expertise_title'), desc: t('vertical_page.why.industry_expertise_desc', { vertical_lower: verticalLower }) },
              { icon: Clock, title: t('vertical_page.why.deploy_title'), desc: t('vertical_page.why.deploy_desc') },
              { icon: BarChart3, title: t('vertical_page.why.roi_title'), desc: t('vertical_page.why.roi_desc') },
            ].map((item, idx) => (
              <RevealSection key={item.title} delay={`delay-${idx * 150}`}>
                <div className="text-center">
                  <div className="w-12 h-12 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
                    <item.icon className="h-6 w-6 text-primary" />
                  </div>
                  <h3 className="font-display font-semibold text-text-primary text-lg mb-2">{item.title}</h3>
                  <p className="text-sm text-slate-600 leading-relaxed">{item.desc}</p>
                </div>
              </RevealSection>
            ))}
          </div>
        </div>
      </section>

      <section className="py-20 bg-gradient-to-br from-primary to-primary-hover">
        <div className="max-w-4xl mx-auto px-6 lg:px-8 text-center">
          <h2 className="text-3xl md:text-4xl font-display font-bold text-white mb-4">
            {t('vertical_page.bottom_cta.title', { vertical: verticalName })}
          </h2>
          <p className="text-lg text-white/80 mb-8 max-w-2xl mx-auto">
            {t('vertical_page.bottom_cta.subtitle', { vertical_lower: verticalLower })}
          </p>
          <div className="flex flex-wrap justify-center gap-4">
            <Link
              to="/signup"
              onClick={() => { trackCTAClick(CTA.START_FREE_TRIAL, `industry-${config.slug}`, 'bottom-cta'); trackConversionEvent(CONVERSION_STAGE.CTA_CLICK, `/industries/${config.slug}`, { cta: 'signup_bottom' }); }}
              className="inline-flex items-center gap-2 bg-white text-primary hover:bg-white/90 px-8 py-3.5 rounded-xl font-semibold transition-colors"
            >
              {t('vertical_page.bottom_cta.start_trial')} <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to={`/demo?agent=${config.demoAgent}`}
              onClick={() => trackCTAClick(CTA.TRY_LIVE_DEMO, `industry-${config.slug}`, 'bottom-cta')}
              className="inline-flex items-center gap-2 bg-white/20 hover:bg-white/30 text-white px-8 py-3.5 rounded-xl font-semibold transition-colors backdrop-blur-sm"
            >
              {t('vertical_page.bottom_cta.see_demo')} <Phone className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

export const VERTICAL_SLUGS = Object.keys(verticals);
