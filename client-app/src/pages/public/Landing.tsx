import { Link, Navigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight } from 'lucide-react';
import { useAuth } from '../../lib/auth';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';
import ComparisonTable from '../../components/ComparisonTable';
import {
  PageHero,
  SectionImage,
  BottomCTA,
  Pillars,
  StatsStrip,
} from '../../components/marketing';
import {
  trackPageView,
  trackCTAClick,
  trackConversionEvent,
  captureUtmOnLoad,
} from '../../lib/analytics';
import { CTA } from '../../lib/analyticsCtas';
import { CONVERSION_STAGE } from '../../lib/analyticsLabels';

const verticalCards = [
  {
    slug: 'healthcare',
    name: 'Healthcare',
    avatar: '/assets/avatars-v2-web/medical.jpg',
    tagline: 'HIPAA-grade intake, scheduling, refills, recall.',
  },
  {
    slug: 'dental',
    name: 'Dental',
    avatar: '/assets/avatars-v2-web/dental.jpg',
    tagline: 'Hygiene recall, new-patient intake, treatment plans.',
  },
  {
    slug: 'legal',
    name: 'Legal',
    avatar: '/assets/avatars-v2-web/legal.jpg',
    tagline: 'Conflict checks, lead qualification, intake.',
  },
  {
    slug: 'real-estate',
    name: 'Real estate',
    avatar: '/assets/avatars-v2-web/real-estate.jpg',
    tagline: 'Lead intake, showing scheduling, follow-up.',
  },
  {
    slug: 'home-services',
    name: 'Home services',
    avatar: '/assets/avatars-v2-web/hvac.jpg',
    tagline: 'Emergency dispatch, ETA updates, scheduling.',
  },
  {
    slug: 'customer-support',
    name: 'Support & ops',
    avatar: '/assets/avatars-v2-web/customer-support.jpg',
    tagline: 'Tier-1 deflection, order status, returns.',
  },
];

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

      {/* 1 · HERO
          Positioning: lead UNIVERSAL ("voice for every front desk") with
          healthcare prominent as the proof point ("healthcare-grade by
          default" + 40,000+ real healthcare calls). Hero imagery stays
          healthcare (V1 consultation suite) so the visual anchors the
          specialty while the copy opens the aperture to every vertical.
          Per Wayne 2026-05-25: "highlight healthcare but also make it
          obvious that voice can be applied in any setting." */}
      <PageHero
        lightSrc="/assets/moodboards-web/V1-hero.jpg"
        darkSrc="/assets/sections-web/D1-dark-office.jpg"
        eyebrow={t(
          'landing.hero.eyebrow',
          'Voice for every front desk · Healthcare-grade by default',
        )}
        title={t('landing.hero.title', 'Calls that don’t get missed.')}
        titleAccent={t('landing.hero.title_2', 'Customers that don’t get lost.')}
        description={t(
          'landing.hero.description',
          'Built and battle-tested on 40,000+ real healthcare calls — and ready for every business that lives by the phone. QVO answers, qualifies, schedules, and follows up 24/7, in a voice your customers trust.',
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
          { label: t('landing.stats.hipaa_ready', 'HIPAA-ready') },
          { label: t('landing.stats.soc2_in_progress', 'SOC 2 in progress') },
          { label: t('landing.stats.aes_encryption', 'AES-256 encryption') },
          { label: t('landing.stats.gdpr_compliant', 'GDPR-compliant') },
        ]}
      />

      {/* 2 · THREE PILLARS + stats */}
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
            title: 'Built for healthcare.',
            body:
              'HIPAA-aware by default. AES-256 in transit and at rest. Audit logs every operator can read.',
          },
        ]}
      >
        <StatsStrip
          stats={[
            { value: 2400000, suffix: '+', label: t('landing.stats.calls_handled', 'Calls handled') },
            { value: 850, suffix: '+', label: t('landing.stats.agents_deployed', 'Agents deployed') },
            { display: '99.9', suffix: '%', label: t('landing.stats.uptime', 'Voice uptime') },
            { value: 30, suffix: '+', label: t('landing.stats.locations', 'Live locations') },
          ]}
        />
      </Pillars>

      {/* 3 · VISUAL PROOF — three alternating splits */}
      <section className="bg-surface-secondary">
        <SectionImage
          img="/assets/sections-web/L2-waiting-room.jpg"
          alt="A modern, calm clinic waiting room with sage chairs and soft natural light."
          eyebrow="Built for real clinics"
          title="The voice belongs in the room."
          body="QVO sounds like a competent member of your front desk — calm, warm, on-brand. Not the robotic voice your patients have been trained to hang up on."
          eager
        />
        <SectionImage
          img="/assets/sections-web/L3-phone-closeup.jpg"
          alt="A silver desk phone on a marble counter, lit by warm window light."
          eyebrow="Always on the line"
          title="Answered in under two rings."
          body="Every call, every hour, every location. Through staff turnover, weekends, holidays, and the 2am questions you didn’t know patients asked."
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

      {/* 4 · SOLUTIONS BY VERTICAL */}
      <section className="bg-surface py-24 lg:py-32">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="max-w-3xl mb-16">
              <p className="font-display text-[11px] tracking-[0.18em] uppercase text-primary mb-3">
                {t('landing.solutions.eyebrow', 'Solutions by vertical')}
              </p>
              <h2 className="font-display text-3xl lg:text-5xl font-bold text-text-primary leading-[1.1] mb-5 [text-wrap:balance]">
                {t('landing.solutions.title', 'A different agent for every front desk you run.')}
              </h2>
              <p className="font-body text-lg text-text-secondary leading-relaxed">
                {t(
                  'landing.solutions.subtitle',
                  'Pre-trained voice agents for the workflows your industry actually uses — not generic "AI receptionists" glued onto a chat model.',
                )}
              </p>
            </div>
          </RevealSection>

          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {verticalCards.map((v, i) => (
              <RevealSection key={v.slug} delay={`scroll-delay-${(i % 3) + 1}`}>
                <Link
                  to={`/industries/${v.slug}`}
                  className="group relative block bg-surface border border-border/60 rounded-2xl p-6 hover:border-primary/40 hover:shadow-[0_12px_40px_-12px_rgba(14,39,56,0.15)] transition-all h-full"
                >
                  <div className="flex items-center gap-4 mb-5">
                    <div className="relative w-14 h-14 rounded-full overflow-hidden bg-surface-muted ring-1 ring-border/60">
                      <img
                        src={v.avatar}
                        alt=""
                        loading="lazy"
                        className="absolute inset-0 w-full h-full object-cover"
                      />
                    </div>
                    <h3 className="font-display text-lg font-semibold text-text-primary">
                      {v.name}
                    </h3>
                  </div>
                  <p className="font-body text-sm text-text-secondary leading-relaxed mb-6">
                    {v.tagline}
                  </p>
                  <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary group-hover:gap-2.5 transition-all">
                    {t('common.explore', 'Explore')}
                    <ArrowRight className="h-3.5 w-3.5" />
                  </span>
                </Link>
              </RevealSection>
            ))}
          </div>

          <RevealSection>
            <div className="text-center mt-12">
              <Link
                to="/ai-agents"
                className="inline-flex items-center gap-2 text-sm font-semibold text-primary hover:text-primary-hover transition-colors"
              >
                {t('common.explore_marketplace', 'Explore the full agent marketplace')}
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </RevealSection>
        </div>
      </section>

      {/* 5 · CUSTOMER RESULTS */}
      <section className="bg-surface-secondary py-24 lg:py-32 border-y border-border/60">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="max-w-3xl mb-16">
              <p className="font-display text-[11px] tracking-[0.18em] uppercase text-primary mb-3">
                {t('landing.results.eyebrow', 'Results from real customers')}
              </p>
              <h2 className="font-display text-3xl lg:text-5xl font-bold text-text-primary leading-[1.1] [text-wrap:balance]">
                {t('landing.results.title', 'Numbers from rooms, calls, and clinics — not slideware.')}
              </h2>
            </div>
          </RevealSection>

          <div className="grid md:grid-cols-3 gap-10 lg:gap-12">
            {[
              {
                metric: t('landing.results.real_estate.metric', '38%'),
                metricLabel: t('landing.results.real_estate.metric_label', 'lift in qualified showings'),
                quote: t('landing.results.real_estate.quote', '"Our buyer leads stopped going cold overnight."'),
                name: t('landing.results.real_estate.name', 'Maya Reyes'),
                role: t('landing.results.real_estate.role', 'Broker · Cypress Hill Realty'),
              },
              {
                metric: t('landing.results.medical.metric', '92%'),
                metricLabel: t('landing.results.medical.metric_label', 'after-hours intake handled'),
                quote: t('landing.results.medical.quote', '"Used to be a panicked Monday voicemail queue."'),
                name: t('landing.results.medical.name', 'Dr. Priya Shah'),
                role: t('landing.results.medical.role', 'Practice Lead · Bayside Eye'),
              },
              {
                metric: t('landing.results.legal.metric', '3.1×'),
                metricLabel: t('landing.results.legal.metric_label', 'consultation conversion'),
                quote: t('landing.results.legal.quote', '"Conflict-checks and lead qualification before a paralegal ever sees the file."'),
                name: t('landing.results.legal.name', 'Daniel Vega'),
                role: t('landing.results.legal.role', 'Managing Partner · Vega & Co.'),
              },
            ].map((r, i) => (
              <RevealSection key={r.name} delay={`scroll-delay-${i + 1}`}>
                <div className="border-l-2 border-primary pl-6">
                  <p className="font-display text-5xl lg:text-6xl font-bold text-text-primary tabular-nums leading-none mb-2">
                    {r.metric}
                  </p>
                  <p className="font-body text-sm text-text-secondary mb-6">{r.metricLabel}</p>
                  <p className="font-body text-base text-text-primary leading-relaxed mb-5 italic">
                    {r.quote}
                  </p>
                  <p className="font-display text-sm font-semibold text-text-primary">{r.name}</p>
                  <p className="font-body text-xs text-text-secondary mt-0.5">{r.role}</p>
                </div>
              </RevealSection>
            ))}
          </div>
        </div>
      </section>

      {/* 6 · COMPARE */}
      <section className="bg-surface py-24 lg:py-32">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="max-w-3xl mb-12">
              <p className="font-display text-[11px] tracking-[0.18em] uppercase text-primary mb-3">
                {t('landing.comparison.eyebrow', 'Honest comparison')}
              </p>
              <h2 className="font-display text-3xl lg:text-5xl font-bold text-text-primary leading-[1.1] [text-wrap:balance]">
                {t('landing.comparison.title', 'Why teams move from generic AI receptionists to QVO.')}
              </h2>
            </div>
          </RevealSection>
          <RevealSection>
            <ComparisonTable />
          </RevealSection>
        </div>
      </section>

      {/* 7 · BOTTOM CTA */}
      <BottomCTA
        eyebrow={t('landing.bottom_cta.eyebrow', 'Ready when you are')}
        title={t(
          'landing.bottom_cta.title',
          'Built once. Running across every location — even at 2 a.m.',
        )}
        body={t(
          'landing.bottom_cta.subtitle',
          'Drop in a phone number. Pick a workflow. Listen to your first call by tomorrow morning.',
        )}
        ctas={[
          {
            label: t('common.start_free_trial', 'Start a free trial'),
            to: '/signup',
            variant: 'primary',
            onClick: () => trackCTAClick(CTA.START_FREE_TRIAL, '/', 'bottom-cta'),
          },
          {
            label: t('common.book_a_demo', 'Book a demo'),
            to: '/book-demo',
            variant: 'ghost',
            onClick: () => trackCTAClick(CTA.BOOK_DEMO, '/', 'bottom-cta'),
          },
        ]}
      />
    </div>
  );
}
