import { useParams, Link } from 'react-router-dom';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CheckCircle2,
  Phone,
  Stethoscope,
  Home,
  Scale,
  Wrench,
  Smile,
  PawPrint,
  Car,
  Landmark,
  Hotel,
  HeadphonesIcon,
} from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';
import ROICalculator from '../../components/ROICalculator';
import { PageHero, Pillars, BottomCTA } from '../../components/marketing';
import {
  trackPageView,
  trackVerticalEngagement,
  trackCTAClick,
  trackConversionEvent,
  captureUtmOnLoad,
} from '../../lib/analytics';
import { VERTICAL_ACTION, CONVERSION_STAGE } from '../../lib/analyticsLabels';
import { CTA } from '../../lib/analyticsCtas';

interface VerticalConfig {
  slug: string;
  icon: typeof Phone;
  heroLight: string;
  heroDark: string;
  avatar: string;
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
    heroLight: '/assets/sections-web/V1-consultation-suite.jpg',
    heroDark: '/assets/sections-web/D1-dark-office.jpg',
    avatar: '/assets/avatars-v2-web/medical.jpg',
    demoAgent: 'medical-intake',
  },
  'real-estate': {
    slug: 'real-estate',
    icon: Home,
    heroLight: '/assets/sections-web/L1-notebook-phone.jpg',
    heroDark: '/assets/sections-web/D1-dark-office.jpg',
    avatar: '/assets/avatars-v2-web/real-estate.jpg',
    demoAgent: 'real-estate',
  },
  legal: {
    slug: 'legal',
    icon: Scale,
    heroLight: '/assets/sections-web/L1-notebook-phone.jpg',
    heroDark: '/assets/sections-web/D1-dark-office.jpg',
    avatar: '/assets/avatars-v2-web/legal.jpg',
    demoAgent: 'legal-intake',
  },
  'home-services': {
    slug: 'home-services',
    icon: Wrench,
    heroLight: '/assets/sections-web/L1-notebook-phone.jpg',
    heroDark: '/assets/sections-web/D1-dark-office.jpg',
    avatar: '/assets/avatars-v2-web/hvac.jpg',
    demoAgent: 'hvac-home-services',
  },
  dental: {
    slug: 'dental',
    icon: Smile,
    heroLight: '/assets/sections-web/V1-consultation-suite.jpg',
    heroDark: '/assets/sections-web/D1-dark-office.jpg',
    avatar: '/assets/avatars-v2-web/dental.jpg',
    demoAgent: 'dental-scheduling',
  },
  veterinary: {
    slug: 'veterinary',
    icon: PawPrint,
    heroLight: '/assets/sections-web/L1-notebook-phone.jpg',
    heroDark: '/assets/sections-web/D1-dark-office.jpg',
    avatar: '/assets/avatars-v2-web/medical.jpg',
    demoAgent: 'veterinary-scheduling',
  },
  automotive: {
    slug: 'automotive',
    icon: Car,
    heroLight: '/assets/sections-web/L1-notebook-phone.jpg',
    heroDark: '/assets/sections-web/D1-dark-office.jpg',
    avatar: '/assets/avatars-v2-web/automotive.jpg',
    demoAgent: 'automotive-service',
  },
  finance: {
    slug: 'finance',
    icon: Landmark,
    heroLight: '/assets/sections-web/L1-notebook-phone.jpg',
    heroDark: '/assets/sections-web/D1-dark-office.jpg',
    avatar: '/assets/avatars-v2-web/insurance.jpg',
    demoAgent: 'finance-prospect',
  },
  hospitality: {
    slug: 'hospitality',
    icon: Hotel,
    heroLight: '/assets/sections-web/L2-waiting-room.jpg',
    heroDark: '/assets/sections-web/D1-dark-office.jpg',
    avatar: '/assets/avatars-v2-web/customer-support.jpg',
    demoAgent: 'hospitality-reservations',
  },
  'customer-support': {
    slug: 'customer-support',
    icon: HeadphonesIcon,
    heroLight: '/assets/sections-web/L1-notebook-phone.jpg',
    heroDark: '/assets/sections-web/D1-dark-office.jpg',
    avatar: '/assets/avatars-v2-web/customer-support.jpg',
    demoAgent: 'customer-support',
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
          <h1 className="text-2xl font-display font-bold text-text-primary mb-4">
            {t('vertical_page.not_found.title')}
          </h1>
          <p className="text-text-secondary mb-6">
            {t('vertical_page.not_found.subtitle')}
          </p>
          <Link to="/use-cases" className="text-primary hover:underline">
            {t('vertical_page.not_found.view_all')} &rarr;
          </Link>
        </div>
      </div>
    );
  }

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

  // Floating live-performance card rendered in the hero's right column on lg+.
  const heroRightCard = (
    <div className="relative max-w-sm w-full">
      <div className="rounded-2xl bg-black/55 backdrop-blur-md border border-white/15 p-6 shadow-2xl">
        <div className="flex items-center gap-2 mb-5">
          <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
          <span className="text-[11px] font-semibold uppercase tracking-[0.15em] text-primary-light">
            {t('vertical_page.card.live_performance')}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-5">
          {stats.slice(0, 4).map((stat) => (
            <div key={stat.label}>
              <p className="font-display text-2xl font-bold text-white leading-none tabular-nums">
                {stat.value}
              </p>
              <p className="text-[11px] text-white/65 mt-1.5">{stat.label}</p>
            </div>
          ))}
        </div>
        <div className="mt-5 pt-4 border-t border-white/15 flex items-center gap-2 text-[11px] text-white/70">
          <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
          {t('vertical_page.card.from_customers_in', { vertical: verticalLower })}
        </div>
      </div>
      <div className="absolute -bottom-4 -left-4 rounded-xl bg-surface shadow-xl border border-border p-3 flex items-center gap-3 max-w-[260px]">
        <div className="w-10 h-10 rounded-full overflow-hidden bg-surface-muted ring-1 ring-border/60 shrink-0">
          <img src={config.avatar} alt="" className="w-full h-full object-cover" loading="lazy" />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] font-semibold text-text-primary leading-tight">
            {t('vertical_page.card.pre_built_for', { vertical: verticalName })}
          </p>
          <p className="text-[10px] text-text-muted leading-tight mt-0.5">
            {t('vertical_page.card.deploy_minutes')}
          </p>
        </div>
      </div>
    </div>
  );

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
          provider: { '@type': 'Organization', name: 'QVO', url: 'https://qvo.ai' },
        }}
      />

      {/* 1 · HERO via shared component, with floating stats card */}
      <PageHero
        lightSrc={config.heroLight}
        darkSrc={config.heroDark}
        eyebrow={verticalName}
        title={headline}
        description={subheadline}
        ctas={[
          {
            label: t('vertical_page.hero.start_trial'),
            to: '/signup',
            variant: 'primary',
            onClick: () => {
              trackCTAClick(CTA.START_FREE_TRIAL, `industry-${config.slug}`, 'hero');
              trackConversionEvent(
                CONVERSION_STAGE.CTA_CLICK,
                `/industries/${config.slug}`,
                { cta: 'signup' },
              );
            },
          },
          {
            label: t('vertical_page.hero.try_demo'),
            to: `/demo?agent=${config.demoAgent}`,
            variant: 'ghost',
            trailingIcon: <Phone className="h-4 w-4" />,
            onClick: () => {
              trackCTAClick(CTA.TRY_LIVE_DEMO, `industry-${config.slug}`, 'hero');
              trackConversionEvent(
                CONVERSION_STAGE.DEMO_STARTED,
                `/industries/${config.slug}`,
              );
            },
          },
        ]}
        rightContent={heroRightCard}
      />

      {/* 2 · STATS STRIP */}
      <section className="bg-surface py-14 border-b border-border/60">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
            {stats.map((stat) => (
              <div key={stat.label} className="text-center">
                <p className="font-display text-3xl md:text-4xl font-bold text-text-primary tabular-nums">
                  {stat.value}
                </p>
                <p className="text-xs lg:text-sm text-text-secondary font-body mt-2 uppercase tracking-wider">
                  {stat.label}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* 3 · PAIN POINTS */}
      <section className="bg-surface-secondary py-24 lg:py-32">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="max-w-3xl mb-16">
              <p className="font-display text-[11px] tracking-[0.18em] uppercase text-primary mb-3">
                {t('vertical_page.problems.eyebrow', 'The phone is leaking')}
              </p>
              <h2 className="font-display text-3xl lg:text-5xl font-bold text-text-primary leading-[1.1] mb-5 [text-wrap:balance]">
                {t('vertical_page.problems.title')}
              </h2>
              <p className="font-body text-lg text-text-secondary leading-relaxed">
                {t('vertical_page.problems.subtitle', { vertical: verticalName })}
              </p>
            </div>
          </RevealSection>
          <div className="grid md:grid-cols-2 gap-6">
            {painPoints.map((point, i) => (
              <RevealSection key={point.title} delay={`scroll-delay-${(i % 4) + 1}`}>
                <div className="border-l-2 border-primary/40 hover:border-primary pl-6 py-2 transition-colors">
                  <h3 className="font-display text-xl font-semibold text-text-primary mb-3 [text-wrap:balance]">
                    {point.title}
                  </h3>
                  <p className="font-body text-base text-text-secondary leading-relaxed">
                    {point.description}
                  </p>
                </div>
              </RevealSection>
            ))}
          </div>
        </div>
      </section>

      {/* 4 · AGENT EXAMPLES */}
      <section className="bg-surface py-24 lg:py-32">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="max-w-3xl mb-16">
              <p className="font-display text-[11px] tracking-[0.18em] uppercase text-primary mb-3">
                {t('vertical_page.agents.eyebrow', 'Pre-built agents')}
              </p>
              <h2 className="font-display text-3xl lg:text-5xl font-bold text-text-primary leading-[1.1] mb-5 [text-wrap:balance]">
                {t('vertical_page.agents.title', { vertical: verticalName })}
              </h2>
              <p className="font-body text-lg text-text-secondary leading-relaxed">
                {t('vertical_page.agents.subtitle', { vertical_lower: verticalLower })}
              </p>
            </div>
          </RevealSection>
          <div className="grid md:grid-cols-3 gap-6">
            {agentExamples.map((agent, i) => (
              <RevealSection key={agent.name} delay={`scroll-delay-${(i % 3) + 1}`}>
                <div className="bg-surface-secondary border border-border/60 rounded-2xl p-7 h-full flex flex-col hover:border-primary/40 hover:shadow-[0_12px_40px_-12px_rgba(14,39,56,0.15)] transition-all">
                  <h3 className="font-display text-lg font-semibold text-text-primary mb-3 [text-wrap:balance]">
                    {agent.name}
                  </h3>
                  <p className="font-body text-sm text-text-secondary leading-relaxed mb-6 flex-1">
                    {agent.description}
                  </p>
                  <ul className="space-y-2.5">
                    {agent.capabilities.map((cap) => (
                      <li key={cap} className="flex items-start gap-2.5 text-sm text-text-primary">
                        <CheckCircle2 className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                        <span className="font-body">{cap}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </RevealSection>
            ))}
          </div>
        </div>
      </section>

      {/* 5 · ROI CALCULATOR */}
      <section className="bg-surface-secondary py-24 lg:py-32 border-y border-border/60">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="max-w-3xl mb-12">
              <p className="font-display text-[11px] tracking-[0.18em] uppercase text-primary mb-3">
                {t('vertical_page.roi.eyebrow', 'Run the numbers')}
              </p>
              <h2 className="font-display text-3xl lg:text-5xl font-bold text-text-primary leading-[1.1] mb-5 [text-wrap:balance]">
                {t('vertical_page.roi.title')}
              </h2>
              <p className="font-body text-lg text-text-secondary leading-relaxed">
                {t('vertical_page.roi.subtitle', { vertical_lower: verticalLower })}
              </p>
            </div>
          </RevealSection>
          <ROICalculator vertical={config.slug} />
        </div>
      </section>

      {/* 6 · TESTIMONIAL */}
      <section className="bg-sidebar-bg py-24 lg:py-32">
        <div className="max-w-4xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <p className="font-display text-[11px] tracking-[0.18em] uppercase text-primary-light mb-6 text-center">
              {t('vertical_page.testimonial.eyebrow', 'From the front desk')}
            </p>
            <blockquote className="font-display text-2xl lg:text-[34px] text-white font-bold leading-[1.25] text-center max-w-3xl mx-auto mb-10 [text-wrap:balance]">
              &ldquo;{testimonial.quote}&rdquo;
            </blockquote>
            <div className="flex items-center justify-center gap-4">
              <div className="w-12 h-12 rounded-full overflow-hidden bg-white/10 ring-1 ring-white/20 shrink-0">
                <img src={config.avatar} alt="" className="w-full h-full object-cover" loading="lazy" />
              </div>
              <div className="text-left">
                <p className="font-display text-sm font-semibold text-white">{testimonial.author}</p>
                <p className="font-body text-xs text-white/65 mt-0.5">
                  {testimonial.role} · {testimonial.company}
                </p>
              </div>
            </div>
          </RevealSection>
        </div>
      </section>

      {/* 7 · WHY US via shared Pillars */}
      <Pillars
        eyebrow={t('vertical_page.why.eyebrow', 'Why QVO')}
        title={t('vertical_page.why.title', { vertical: verticalName })}
        items={[
          {
            num: '01',
            title: t('vertical_page.why.industry_expertise_title'),
            body: t('vertical_page.why.industry_expertise_desc', {
              vertical_lower: verticalLower,
            }),
          },
          {
            num: '02',
            title: t('vertical_page.why.deploy_title'),
            body: t('vertical_page.why.deploy_desc'),
          },
          {
            num: '03',
            title: t('vertical_page.why.roi_title'),
            body: t('vertical_page.why.roi_desc'),
          },
        ]}
      />

      {/* 8 · BOTTOM CTA */}
      <BottomCTA
        eyebrow={t('vertical_page.bottom_cta.eyebrow', 'Ready when you are')}
        title={t('vertical_page.bottom_cta.title', { vertical: verticalName })}
        body={t('vertical_page.bottom_cta.subtitle', { vertical_lower: verticalLower })}
        ctas={[
          {
            label: t('vertical_page.bottom_cta.start_trial'),
            to: '/signup',
            variant: 'primary',
            onClick: () => {
              trackCTAClick(CTA.START_FREE_TRIAL, `industry-${config.slug}`, 'bottom-cta');
              trackConversionEvent(
                CONVERSION_STAGE.CTA_CLICK,
                `/industries/${config.slug}`,
                { cta: 'signup_bottom' },
              );
            },
          },
          {
            label: t('vertical_page.bottom_cta.see_demo'),
            to: `/demo?agent=${config.demoAgent}`,
            variant: 'ghost',
            trailingIcon: <Phone className="h-4 w-4" />,
            onClick: () =>
              trackCTAClick(CTA.TRY_LIVE_DEMO, `industry-${config.slug}`, 'bottom-cta'),
          },
        ]}
      />
    </>
  );
}
