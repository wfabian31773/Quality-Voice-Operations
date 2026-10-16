import { Navigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../../lib/auth';
import SEO from '../../components/SEO';
import {
  PageHero,
  SectionImage,
  BottomCTA,
  Pillars,
} from '../../components/marketing';
import {
  trackPageView,
  trackCTAClick,
  trackConversionEvent,
  captureUtmOnLoad,
} from '../../lib/analytics';
import { CTA } from '../../lib/analyticsCtas';
import { CONVERSION_STAGE } from '../../lib/analyticsLabels';

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

  const organizationSchema = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'QVO',
    url: window.location.origin,
    description:
      'Quality Voice Operations — voice agents that fill the business gaps your team can’t cover.',
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
        title={t('landing.seo_title', 'QVO — voice operations for real businesses')}
        description={t(
          'landing.seo_description',
          'Voice agents that answer, qualify, schedule, and follow up — 24/7, with a voice your customers trust.',
        )}
        canonicalPath="/"
        structuredData={organizationSchema}
      />

      <PageHero
        lightSrc="/industry-hero/home-services.jpg"
        darkSrc="/assets/sections-web/D1-dark-office.jpg"
        eyebrow={t('landing.hero.eyebrow', 'Voice operations for trade and home-service shops')}
        title={t('landing.hero.title', 'Calls that don’t get missed.')}
        titleAccent={t('landing.hero.title_2', 'Customers that don’t get lost.')}
        description={t(
          'landing.hero.description',
          'Now onboarding pilot shops. QVO answers, qualifies, schedules, and follows up 24/7, in a voice your customers trust.',
        )}
        ctas={[
          {
            label: t('common.try_live_demo', 'Try the live demo'),
            to: '/demo',
            variant: 'primary',
            onClick: () => trackCTAClick(CTA.TRY_LIVE_DEMO, '/', 'hero'),
          },
          {
            label: t('common.book_a_demo', 'Book a 20-min walkthrough'),
            to: '/book-demo',
            variant: 'ghost',
            onClick: () => trackCTAClick(CTA.BOOK_DEMO, '/', 'hero'),
          },
        ]}
        pills={[
          { label: t('landing.stats.hipaa_ready', 'Healthcare pilot approval pending') },
          { label: t('landing.stats.soc2_in_progress', 'Certifications not verified') },
          { label: t('landing.stats.aes_encryption', 'Recording disabled by default') },
          { label: t('landing.stats.gdpr_compliant', 'Legal review pending') },
        ]}
      />

      <Pillars
        eyebrow={t('landing.pillars.eyebrow', 'Why QVO exists')}
        title={t(
          'landing.pillars.title',
          'Three things every business needs the phone to do — and most can’t.',
        )}
        items={[
          {
            num: '01',
            title: 'Never miss a call.',
            body:
              'Every call answered in under two rings — including at 2 a.m., on weekends, and through staff turnover.',
          },
          {
            num: '02',
            title: 'Convert at first contact.',
            body:
              'Intake, qualification, scheduling, and warm handoffs — done while the prospect is still on the line.',
          },
          {
            num: '03',
            title: t('common.pilot_onboarding', 'Now onboarding pilot shops.'),
            body: 'QVO serves trade and home-service shops.',
          },
        ]}
      />

      <section className="bg-surface-secondary">
        <SectionImage
          img="/assets/sections-web/L2-waiting-room.jpg"
          alt="A calm shop waiting area with chairs and soft natural light."
          eyebrow="Built for real shops"
          title="The voice belongs in the room."
          body="QVO sounds like a competent member of your front desk — calm, warm, on-brand. Not the robotic voice callers have been trained to hang up on."
          eager
        />
        <SectionImage
          img="/assets/sections-web/L3-phone-closeup.jpg"
          alt="A silver desk phone on a marble counter, lit by warm window light."
          eyebrow="Always on the line"
          title="Answered in under two rings."
          body="Every call, every hour, every location. Through staff turnover, weekends, holidays, and the 2am questions you didn’t know callers asked."
          reverse
        />
        <SectionImage
          img="/assets/sections-web/D1-dark-office.jpg"
          alt="A modern dark office at midnight with a glowing dashboard and city lights."
          eyebrow="After hours, on duty"
          title="The thing that runs while you sleep."
          body="Triaging urgent calls, booking next-day appointments, sending follow-up texts. Your team walks in to a clean inbox, not a panicked voicemail queue."
        />
      </section>

      <section className="bg-surface py-24 lg:py-32">
        <div className="max-w-3xl mx-auto px-6 lg:px-8 text-center">
          <p className="font-body text-lg text-text-secondary leading-relaxed">
            {t('common.pilot_onboarding', 'Now onboarding pilot shops.')}
          </p>
        </div>
      </section>

      <BottomCTA
        eyebrow={t('landing.bottom_cta.eyebrow', 'Ready when you are')}
        title={t(
          'landing.bottom_cta.title',
          'Built once. Running across every location — even at 2 a.m.',
        )}
        body={t(
          'landing.bottom_cta.subtitle',
          'Now onboarding pilot shops. Book a walkthrough to get started.',
        )}
        ctas={[
          {
            label: t('common.book_a_demo', 'Book a demo'),
            to: '/book-demo',
            variant: 'primary',
            onClick: () => trackCTAClick(CTA.BOOK_DEMO, '/', 'bottom-cta'),
          },
          {
            label: t('common.try_live_demo', 'Try the live demo'),
            to: '/demo',
            variant: 'ghost',
            onClick: () => trackCTAClick(CTA.TRY_LIVE_DEMO, '/', 'bottom-cta'),
          },
        ]}
      />
    </div>
  );
}
