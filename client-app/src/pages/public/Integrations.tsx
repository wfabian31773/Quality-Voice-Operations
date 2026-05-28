import { Link } from 'react-router-dom';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight, MessageSquare, Mail, FileText, Shield, Plug, CheckCircle2,
} from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';
import BrandLogo from '../../components/BrandLogo';
import { trackPageView, trackCTAClick } from '../../lib/analytics';
import { CTA } from '../../lib/analyticsCtas';

const primaryIntegrations = [
  { logoId: 'google-calendar', categoryKey: 'scheduling', title: 'Google Calendar', descKey: 'google_calendar_desc', features: ['google_calendar_f1', 'google_calendar_f2', 'google_calendar_f3', 'google_calendar_f4'] },
  { logoId: 'outlook-calendar', categoryKey: 'scheduling', title: 'Outlook Calendar', descKey: 'outlook_calendar_desc', features: ['outlook_calendar_f1', 'outlook_calendar_f2', 'outlook_calendar_f3', 'outlook_calendar_f4'] },
  { logoId: 'twilio', categoryKey: 'telephony', title: 'Twilio', descKey: 'twilio_desc', features: ['twilio_f1', 'twilio_f2', 'twilio_f3', 'twilio_f4'] },
  { logoId: 'stripe', categoryKey: 'payments', title: 'Stripe', descKey: 'stripe_desc', features: ['stripe_f1', 'stripe_f2', 'stripe_f3', 'stripe_f4'] },
  { logoId: 'hubspot', categoryKey: 'crm', title: 'HubSpot', descKey: 'hubspot_desc', features: ['hubspot_f1', 'hubspot_f2', 'hubspot_f3', 'hubspot_f4'] },
  { logoId: 'salesforce', categoryKey: 'crm', title: 'Salesforce', descKey: 'salesforce_desc', features: ['salesforce_f1', 'salesforce_f2', 'salesforce_f3', 'salesforce_f4'] },
  { logoId: 'pipedrive', categoryKey: 'crm', title: 'Pipedrive', descKey: 'pipedrive_desc', features: ['pipedrive_f1', 'pipedrive_f2', 'pipedrive_f3', 'pipedrive_f4'] },
  { logoId: 'quickbooks', categoryKey: 'accounting', title: 'QuickBooks', descKey: 'quickbooks_desc', features: ['quickbooks_f1', 'quickbooks_f2', 'quickbooks_f3', 'quickbooks_f4'] },
  { logoId: 'slack', categoryKey: 'notifications', title: 'Slack', descKey: 'slack_desc', features: ['slack_f1', 'slack_f2', 'slack_f3', 'slack_f4'] },
  { logoId: 'zapier', categoryKey: 'automation', title: 'Zapier', descKey: 'zapier_desc', features: ['zapier_f1', 'zapier_f2', 'zapier_f3', 'zapier_f4'] },
];

const additionalIntegrations = [
  { icon: MessageSquare, categoryKey: 'sms', titleKey: 'sms_messaging_title', descKey: 'sms_messaging_desc' },
  { icon: Mail, categoryKey: 'email', titleKey: 'email_notifications_title', descKey: 'email_notifications_desc' },
  { icon: FileText, categoryKey: 'compliance', titleKey: 'compliance_records_title', descKey: 'compliance_records_desc' },
  { icon: Shield, categoryKey: 'security', titleKey: 'auth_access_title', descKey: 'auth_access_desc' },
];

export default function Integrations() {
  const { t } = useTranslation('marketing');

  useEffect(() => {
    trackPageView('/integrations');
  }, []);

  return (
    <div>
      <SEO
        title={t('integrations_page.seo_title')}
        description={t('integrations_page.seo_description')}
        canonicalPath="/integrations"
      />
      {/*
        Integrations hero — flat dark band placeholder. Wayne's bespoke
        Higgsfield render slots in here later (drop file at
        /hero/integrations-hero.{webp,mp4} and add a <picture>/<video>
        above the gradient layer). Until then:
          - radial-gradient backdrop at 35% 55% (off-center, distinct
            from /pricing 50% 30%, /features 30% 50%, /product 70% 50%,
            /use-cases 60% 40%, /contact 50% 50%, /book-demo 40% 60%)
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
              'radial-gradient(ellipse 70% 60% at 35% 55%, rgba(46,140,131,0.20), transparent 70%)',
          }}
        />
        <div className="relative max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-4">
              {t('integrations_page.hero.eyebrow')}
            </p>
            <h1 className="font-display text-white text-4xl lg:text-6xl font-bold leading-tight tracking-tight mb-6">
              {t('integrations_page.hero.title')}
            </h1>
            <p className="text-lg text-white/70 leading-relaxed font-body max-w-2xl mb-8">
              {t('integrations_page.hero.description')}
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link
                to="/demo"
                className="btn-primary-glow inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-on-primary font-semibold px-7 py-3.5 rounded-xl transition-colors duration-[var(--motion-base)] text-sm min-h-[44px]"
                onClick={() => trackCTAClick(CTA.TRY_LIVE_DEMO, '/integrations', 'hero')}
              >
                {t('integrations_page.hero.try_demo')}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/features"
                className="inline-flex items-center justify-center gap-2 bg-white/10 dark:bg-white/10 hover:bg-white/15 dark:hover:bg-white/15 text-white font-semibold px-7 py-3.5 rounded-xl transition-all text-sm border border-white/10 dark:border-white/10"
                onClick={() => trackCTAClick(CTA.SEE_FEATURES, '/integrations', 'hero')}
              >
                {t('integrations_page.hero.see_features')}
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                {t('integrations_page.core.title')}
              </h2>
              <p className="text-lg text-text-primary/60 font-body max-w-2xl mx-auto">
                {t('integrations_page.core.subtitle')}
              </p>
            </div>
          </RevealSection>

          <RevealSection>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 mb-16">
              {primaryIntegrations.map((int) => (
                <div key={int.title} className="bg-surface rounded-2xl border border-border/60 p-7 hover:border-primary/40 hover:shadow-lg hover:-translate-y-1 transition-all duration-300">
                  <div className="flex items-center gap-3 mb-4">
                    <BrandLogo provider={int.logoId} size={36} />
                    <span className="text-xs font-semibold font-display text-primary uppercase tracking-wide">{t(`integrations_page.categories.${int.categoryKey}`)}</span>
                  </div>
                  <h3 className="font-display text-lg font-semibold text-text-primary mb-2">{int.title}</h3>
                  <p className="text-sm text-text-primary/60 leading-relaxed font-body mb-4">{t(`integrations_page.items.${int.descKey}`)}</p>
                  <div className="space-y-1.5">
                    {int.features.map((f) => (
                      <div key={f} className="flex items-center gap-2 text-xs text-text-primary/70 font-body">
                        <CheckCircle2 className="h-3.5 w-3.5 text-success shrink-0" />
                        {t(`integrations_page.items.${f}`)}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </RevealSection>

          <RevealSection>
            <div className="text-center mb-10">
              <h2 className="font-display text-2xl font-bold text-text-primary mb-3">
                {t('integrations_page.additional.title')}
              </h2>
            </div>
            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
              {additionalIntegrations.map((int) => (
                <div key={int.titleKey} className="bg-surface rounded-2xl border border-border/50 p-6 hover:border-primary/30 hover:shadow-md transition-all duration-300">
                  <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                    <int.icon className="h-5 w-5 text-primary" />
                  </div>
                  <h3 className="font-display text-base font-semibold text-text-primary mb-2">{t(`integrations_page.items.${int.titleKey}`)}</h3>
                  <p className="text-sm text-text-primary/60 leading-relaxed font-body">{t(`integrations_page.items.${int.descKey}`)}</p>
                </div>
              ))}
            </div>
          </RevealSection>
        </div>
      </section>

      <section className="bg-surface py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl mx-auto text-center">
            <div className="w-14 h-14 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-6">
              <Plug className="h-7 w-7 text-primary" />
            </div>
            <h2 className="font-display text-3xl font-bold text-text-primary mb-4">
              {t('integrations_page.custom_cta.title')}
            </h2>
            <p className="text-text-primary/60 font-body mb-8 leading-relaxed">
              {t('integrations_page.custom_cta.subtitle')}
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                to="/signup"
                className="inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors"
                onClick={() => trackCTAClick(CTA.START_FREE_TRIAL, '/integrations', 'bottom-cta')}
              >
                {t('integrations_page.custom_cta.start_trial')}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/contact"
                className="inline-flex items-center gap-2 bg-sidebar-bg hover:bg-sidebar-hover text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors"
                onClick={() => trackCTAClick(CTA.TALK_TO_ENGINEERING, '/integrations', 'bottom-cta')}
              >
                {t('integrations_page.custom_cta.talk_engineering')}
              </Link>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
