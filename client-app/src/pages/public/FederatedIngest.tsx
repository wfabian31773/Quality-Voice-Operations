import { Link } from 'react-router-dom';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight, Code2, Server, Webhook, ShieldCheck, KeyRound, Activity,
  Layers, Database, BarChart3, Plug, Workflow, RefreshCw, Lock,
  CheckCircle2, GitBranch, AlertTriangle, Zap,
} from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';
import { trackPageView, trackCTAClick, trackFeatureView } from '../../lib/analytics';
import { CTA } from '../../lib/analyticsCtas';

const useCaseIcons = [Server, Layers, Workflow];
const ingestStepIcons = [KeyRound, Webhook, Database, BarChart3];
const platformBenefitIcons = [BarChart3, Activity, GitBranch, Plug, Zap, ShieldCheck];
const securityIcons = [KeyRound, RefreshCw, Lock, AlertTriangle];

type TextItem = { title: string; desc: string };

export default function FederatedIngest() {
  const { t } = useTranslation();

  const transcriptAssistant = JSON.stringify(
    t('federated_ingest_page.ingest_steps.sample.transcript_assistant'),
  );
  const transcriptUser = JSON.stringify(
    t('federated_ingest_page.ingest_steps.sample.transcript_user'),
  );

  const sampleRequest = `POST /ingest/calls HTTP/1.1
Host: api.qvo.ai
Authorization: Bearer qvo_fed_live_***
Content-Type: application/json
Idempotency-Key: ext_call_8f02a7c1

{
  "external_id": "ext_call_8f02a7c1",
  "agent_external_id": "azul-vision-intake-v3",
  "phone_number": "+15551234567",
  "direction": "inbound",
  "started_at": "2026-04-27T15:08:11Z",
  "ended_at":   "2026-04-27T15:11:42Z",
  "outcome": "appointment_booked",
  "transcript": [
    { "role": "assistant", "text": ${transcriptAssistant} },
    { "role": "user",      "text": ${transcriptUser} }
  ],
  "tool_calls": [
    { "name": "scheduling.reschedule", "args": { "patient_id": "p_4521" }, "ok": true }
  ],
  "metadata": { "vertical": "ophthalmology", "language": "en-US" }
}`;

  useEffect(() => {
    trackPageView('/product/federated-ingest');
  }, []);

  const useCases = t('federated_ingest_page.use_cases.items', { returnObjects: true }) as TextItem[];
  const ingestSteps = t('federated_ingest_page.ingest_steps.items', { returnObjects: true }) as TextItem[];
  const platformBenefits = t('federated_ingest_page.platform_benefits.items', { returnObjects: true }) as TextItem[];
  const security = t('federated_ingest_page.security_section.items', { returnObjects: true }) as TextItem[];

  return (
    <div>
      <SEO
        title={t('federated_ingest_page.seo_title')}
        description={t('federated_ingest_page.seo_description')}
        canonicalPath="/product/federated-ingest"
      />

      <section className="bg-sidebar-bg text-white py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-4">
              {t('federated_ingest_page.hero.eyebrow')}
            </p>
            <h1 className="font-display text-4xl lg:text-5xl font-bold leading-tight mb-6">
              {t('federated_ingest_page.hero.title')}
            </h1>
            <p className="text-lg text-white/70 leading-relaxed font-body max-w-2xl mb-8">
              {t('federated_ingest_page.hero.description')}
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link
                to="/docs/api-overview"
                className="btn-primary-glow inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-on-primary font-semibold px-7 py-3.5 rounded-xl transition-colors duration-[var(--motion-base)] text-sm min-h-[44px]"
                onClick={() => trackCTAClick(CTA.READ_API_DOCS, '/product/federated-ingest', 'hero')}
              >
                {t('federated_ingest_page.hero.cta_primary')}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/contact"
                className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 backdrop-blur-sm text-white font-semibold px-7 py-3.5 rounded-xl transition-all text-sm border border-white/10"
                onClick={() => trackCTAClick(CTA.TALK_TO_ENGINEERING, '/product/federated-ingest', 'hero')}
              >
                {t('federated_ingest_page.hero.cta_secondary')}
              </Link>
            </div>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-white/60">
              <span className="inline-flex items-center gap-2"><Code2 className="h-4 w-4 text-primary" />{t('federated_ingest_page.hero.chip_endpoint')}</span>
              <span className="inline-flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-primary" />{t('federated_ingest_page.hero.chip_keys')}</span>
              <span className="inline-flex items-center gap-2"><RefreshCw className="h-4 w-4 text-primary" />{t('federated_ingest_page.hero.chip_idempotent')}</span>
            </div>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-surface-secondary">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                {t('federated_ingest_page.use_cases.heading')}
              </h2>
              <p className="text-lg text-text-primary/60 font-body max-w-2xl mx-auto">
                {t('federated_ingest_page.use_cases.subheading')}
              </p>
            </div>
          </RevealSection>
          <div className="grid md:grid-cols-3 gap-6 max-w-6xl mx-auto">
            {useCases.map((useCase, i) => {
              const Icon = useCaseIcons[i] || Server;
              return (
                <RevealSection key={useCase.title} delay={`scroll-delay-${(i % 3) + 1}`}>
                  <div
                    className="bg-white rounded-2xl border border-border/30 p-7 h-full hover:shadow-lg transition-shadow"
                    onMouseEnter={() => trackFeatureView(`federated-ingest:${useCase.title}`)}
                  >
                    <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                      <Icon className="h-5 w-5 text-primary" />
                    </div>
                    <h3 className="font-display text-lg font-semibold text-text-primary mb-2">{useCase.title}</h3>
                    <p className="text-sm text-text-primary/60 leading-relaxed font-body">{useCase.desc}</p>
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
              <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-3">
                {t('federated_ingest_page.ingest_steps.eyebrow')}
              </p>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                {t('federated_ingest_page.ingest_steps.heading')}
              </h2>
            </div>
          </RevealSection>

          <div className="grid lg:grid-cols-2 gap-12 items-start max-w-6xl mx-auto">
            <div className="space-y-6">
              {ingestSteps.map((step, i) => {
                const Icon = ingestStepIcons[i] || KeyRound;
                return (
                  <RevealSection key={step.title} delay={`scroll-delay-${(i % 3) + 1}`}>
                    <div className="bg-surface-secondary rounded-2xl border border-border/30 p-6 flex gap-4">
                      <div className="w-10 h-10 rounded-lg bg-surface-muted flex items-center justify-center shrink-0">
                        <Icon className="h-5 w-5 text-text-primary" />
                      </div>
                      <div>
                        <p className="text-xs font-semibold text-primary mb-1">
                          {t('federated_ingest_page.ingest_steps.step_label', { n: i + 1 })}
                        </p>
                        <h3 className="font-display text-lg font-semibold text-text-primary mb-1.5">{step.title}</h3>
                        <p className="text-sm text-text-primary/65 leading-relaxed font-body">{step.desc}</p>
                      </div>
                    </div>
                  </RevealSection>
                );
              })}
            </div>

            <RevealSection>
              <div className="bg-sidebar-bg rounded-2xl border border-sidebar-hover/40 overflow-hidden shadow-lg">
                <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
                  <div className="flex items-center gap-2 text-white/60 text-xs font-mono">
                    <Code2 className="h-3.5 w-3.5" />
                    POST /ingest/calls
                  </div>
                  <div className="flex gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-white/20" />
                    <span className="w-2.5 h-2.5 rounded-full bg-white/20" />
                    <span className="w-2.5 h-2.5 rounded-full bg-white/20" />
                  </div>
                </div>
                <pre className="px-5 py-5 text-xs leading-relaxed text-white/85 font-mono overflow-x-auto">
{sampleRequest}
                </pre>
              </div>
              <p className="text-xs text-text-primary/50 mt-3 font-body text-center">
                {t('federated_ingest_page.ingest_steps.code_caption')}
              </p>
            </RevealSection>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-surface-secondary">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <span className="inline-block text-sm font-semibold text-primary bg-primary/10 px-4 py-1.5 rounded-full mb-4">
                {t('federated_ingest_page.platform_benefits.pill')}
              </span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                {t('federated_ingest_page.platform_benefits.heading')}
              </h2>
              <p className="text-lg text-text-primary/60 font-body max-w-2xl mx-auto">
                {t('federated_ingest_page.platform_benefits.subheading')}
              </p>
            </div>
          </RevealSection>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6 max-w-6xl mx-auto">
            {platformBenefits.map((benefit, i) => {
              const Icon = platformBenefitIcons[i] || BarChart3;
              return (
                <RevealSection key={benefit.title} delay={`scroll-delay-${(i % 3) + 1}`}>
                  <div className="bg-white rounded-2xl border border-border/30 p-6 h-full hover:shadow-lg transition-shadow">
                    <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center mb-4">
                      <Icon className="h-5 w-5 text-primary" />
                    </div>
                    <h3 className="font-display text-base font-semibold text-text-primary mb-1.5">{benefit.title}</h3>
                    <p className="text-sm text-text-primary/65 leading-relaxed font-body">{benefit.desc}</p>
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
              <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-3">
                {t('federated_ingest_page.security_section.eyebrow')}
              </p>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                {t('federated_ingest_page.security_section.heading')}
              </h2>
            </div>
          </RevealSection>
          <div className="grid md:grid-cols-2 gap-6 max-w-5xl mx-auto">
            {security.map((item, i) => {
              const Icon = securityIcons[i] || KeyRound;
              return (
                <RevealSection key={item.title}>
                  <div className="bg-surface-secondary rounded-2xl border border-border/30 p-6 flex gap-4 h-full">
                    <div className="w-10 h-10 rounded-lg bg-danger/10 flex items-center justify-center shrink-0">
                      <Icon className="h-5 w-5 text-danger" />
                    </div>
                    <div>
                      <h3 className="font-display text-base font-semibold text-text-primary mb-1.5">{item.title}</h3>
                      <p className="text-sm text-text-primary/65 leading-relaxed font-body">{item.desc}</p>
                    </div>
                  </div>
                </RevealSection>
              );
            })}
          </div>

          <RevealSection>
            <div className="max-w-4xl mx-auto mt-12 bg-sidebar-bg rounded-2xl p-8 lg:p-10 text-white">
              <div className="flex items-center gap-3 mb-3">
                <CheckCircle2 className="h-5 w-5 text-primary" />
                <p className="font-display text-sm font-semibold tracking-wide uppercase text-primary">
                  {t('federated_ingest_page.security_section.compliance_eyebrow')}
                </p>
              </div>
              <p className="font-display text-xl text-white/90 leading-relaxed mb-2">
                {t('federated_ingest_page.security_section.compliance_text')}
              </p>
              <p className="text-sm text-white/60 font-body">
                {t('federated_ingest_page.security_section.compliance_followup')}
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <Link
                  to="/security"
                  className="inline-flex items-center gap-2 bg-white/10 hover:bg-white/15 text-white font-semibold px-5 py-2.5 rounded-lg text-sm border border-white/10"
                >
                  {t('federated_ingest_page.security_section.compliance_security_link')}
                </Link>
                <Link
                  to="/security/posture"
                  className="inline-flex items-center gap-2 bg-white/10 hover:bg-white/15 text-white font-semibold px-5 py-2.5 rounded-lg text-sm border border-white/10"
                >
                  {t('federated_ingest_page.security_section.compliance_posture_link')}
                </Link>
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
              {t('federated_ingest_page.bottom_cta.title')}
            </h2>
            <p className="text-lg text-white/65 font-body mb-10 max-w-xl mx-auto">
              {t('federated_ingest_page.bottom_cta.subtitle')}
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                to="/docs/api-overview"
                className="btn-primary-glow inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-on-primary font-semibold px-8 py-3.5 rounded-xl transition-colors duration-[var(--motion-base)] text-sm min-h-[44px]"
                onClick={() => trackCTAClick(CTA.READ_API_DOCS, '/product/federated-ingest', 'bottom-cta')}
              >
                {t('federated_ingest_page.bottom_cta.cta_primary')}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/book-demo"
                className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 backdrop-blur-sm text-white font-semibold px-8 py-3.5 rounded-xl transition-all text-sm border border-white/10"
                onClick={() => trackCTAClick(CTA.BOOK_PLATFORM_DEMO, '/product/federated-ingest', 'bottom-cta')}
              >
                {t('federated_ingest_page.bottom_cta.cta_secondary')}
              </Link>
            </div>
          </div>
        </RevealSection>
      </section>
    </div>
  );
}
