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

// TODO(PR-04): Healthcare and Dental vertical routes stay reachable so
// existing tests do not break. They are hidden from public nav/footer in
// PublicLayout. Remove the routes in a follow-up once tests no longer
// depend on them. QVO serves trade/home-service shops; it does no healthcare.

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
          <Link to="/pricing" className="text-primary hover:underline">
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

      <PageHero
        lightSrc={config.heroLight}
        darkSrc={config.heroDark}
        eyebrow={verticalName}
        title={headline}
        description={subheadline}
        ctas={[
          {
            label: t('common.book_a_demo', 'Book a demo'),
            to: '/book-demo',
            variant: 'primary',
            onClick: () => {
              trackCTAClick(CTA.BOOK_DEMO, `industry-${config.slug}`, 'hero');
              trackConversionEvent(
                CONVERSION_STAGE.CTA_CLICK,
                `/industries/${config.slug}`,
                { cta: 'book_demo' },
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
      />

      <section className="bg-surface py-10 border-b border-border/60">
        <div className="max-w-3xl mx-auto px-6 lg:px-8 text-center">
          <p className="font-body text-text-secondary">
            {t('common.pilot_onboarding', 'Now onboarding pilot shops.')}
          </p>
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
            label: t('common.book_a_demo', 'Book a demo'),
            to: '/book-demo',
            variant: 'primary',
            onClick: () => {
              trackCTAClick(CTA.BOOK_DEMO, `industry-${config.slug}`, 'bottom-cta');
              trackConversionEvent(
                CONVERSION_STAGE.CTA_CLICK,
                `/industries/${config.slug}`,
                { cta: 'book_demo_bottom' },
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
