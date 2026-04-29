import { Link } from 'react-router-dom';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Wrench, Calendar, Moon, ClipboardList, Target,
  ArrowRight, Phone, Truck, MessageSquare,
  Clock, Users, BarChart3,
} from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';
import { trackPageView, trackVerticalEngagement, trackCTAClick } from '../../lib/analytics';

type ScenarioKey = 'hvac' | 'scheduling' | 'after_hours' | 'intake' | 'qualification';

interface ScenarioMeta {
  key: ScenarioKey;
  icon: React.ComponentType<{ className?: string }>;
  metricIcons: React.ComponentType<{ className?: string }>[];
}

const SCENARIOS: ScenarioMeta[] = [
  { key: 'hvac', icon: Wrench, metricIcons: [Clock, Truck, Phone] },
  { key: 'scheduling', icon: Calendar, metricIcons: [Calendar, MessageSquare, Users] },
  { key: 'after_hours', icon: Moon, metricIcons: [Moon, Phone, BarChart3] },
  { key: 'intake', icon: ClipboardList, metricIcons: [ClipboardList, Clock, Users] },
  { key: 'qualification', icon: Target, metricIcons: [Target, Clock, BarChart3] },
];

export default function UseCases() {
  const { t } = useTranslation('marketing');

  useEffect(() => {
    trackPageView('/use-cases');
  }, []);

  return (
    <div>
      <SEO
        title={t('use_cases.seo_title')}
        description={t('use_cases.seo_description')}
        canonicalPath="/use-cases"
      />
      <section className="bg-sidebar-bg text-white py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-4">
              {t('use_cases.hero.eyebrow')}
            </p>
            <h1 className="font-display text-4xl lg:text-5xl font-bold leading-tight mb-6">
              {t('use_cases.hero.title')}
            </h1>
            <p className="text-lg text-white/70 leading-relaxed font-body max-w-2xl mb-8">
              {t('use_cases.hero.description')}
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link
                to="/demo"
                className="btn-primary-glow inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-on-primary font-semibold px-7 py-3.5 rounded-xl transition-colors duration-[var(--motion-base)] text-sm min-h-[44px]"
                onClick={() => trackCTAClick('Try Live Demo', '/use-cases', 'hero')}
              >
                {t('common.try_live_demo')}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/ai-agents"
                className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 text-white font-semibold px-7 py-3.5 rounded-xl transition-all text-sm border border-white/10"
                onClick={() => trackCTAClick('Explore Agents', '/use-cases', 'hero')}
              >
                {t('common.explore_agents')}
              </Link>
            </div>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 space-y-16">
          {SCENARIOS.map((s) => {
            const base = `use_cases.scenarios.${s.key}`;
            const title = t(`${base}.title`);
            const workflow: string[] = [
              t(`${base}.step1`), t(`${base}.step2`), t(`${base}.step3`),
              t(`${base}.step4`), t(`${base}.step5`),
            ];
            const tools: string[] = [
              t(`${base}.tool1`), t(`${base}.tool2`), t(`${base}.tool3`),
              t(`${base}.tool4`), t(`${base}.tool5`),
            ];
            const metrics = [
              { icon: s.metricIcons[0], label: t(`${base}.metric1_label`), value: t(`${base}.metric1_value`) },
              { icon: s.metricIcons[1], label: t(`${base}.metric2_label`), value: t(`${base}.metric2_value`) },
              { icon: s.metricIcons[2], label: t(`${base}.metric3_label`), value: t(`${base}.metric3_value`) },
            ];
            return (
              <RevealSection key={s.key}>
                <div
                  className="bg-white rounded-2xl border border-border/50 overflow-hidden"
                  onMouseEnter={() => trackVerticalEngagement(title, 'view')}
                >
                  <div className="p-8 lg:p-10">
                    <div className="flex items-start gap-4 mb-8">
                      <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                        <s.icon className="h-6 w-6 text-primary" />
                      </div>
                      <div>
                        <h3 className="font-display text-2xl font-bold text-text-primary">{title}</h3>
                        <p className="text-sm text-text-primary/50 font-body mt-1">{t(`${base}.subtitle`)}</p>
                      </div>
                    </div>

                    <div className="grid md:grid-cols-2 gap-8 mb-8">
                      <div>
                        <h4 className="font-display text-sm font-semibold text-danger uppercase tracking-wide mb-4">
                          {t('use_cases.labels.the_problem')}
                        </h4>
                        <p className="text-sm text-text-primary/70 font-body leading-relaxed">{t(`${base}.problem`)}</p>
                      </div>
                      <div>
                        <h4 className="font-display text-sm font-semibold text-success uppercase tracking-wide mb-4">
                          {t('use_cases.labels.how_qvo_solves')}
                        </h4>
                        <p className="text-sm text-text-primary/70 font-body leading-relaxed">{t(`${base}.solution`)}</p>
                      </div>
                    </div>

                    <div className="bg-surface-secondary/50 rounded-xl p-6 mb-8">
                      <h4 className="font-display text-sm font-semibold text-text-primary mb-4">
                        {t('use_cases.labels.workflow')}
                      </h4>
                      <ol className="space-y-2">
                        {workflow.map((step, i) => (
                          <li key={i} className="flex items-start gap-3 text-sm text-text-primary/70 font-body">
                            <span className="w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
                              {i + 1}
                            </span>
                            {step}
                          </li>
                        ))}
                      </ol>
                    </div>

                    <div className="grid md:grid-cols-2 gap-8">
                      <div>
                        <h4 className="font-display text-sm font-semibold text-text-primary mb-3">
                          {t('use_cases.labels.tools_used')}
                        </h4>
                        <div className="flex flex-wrap gap-2">
                          {tools.map((tool) => (
                            <span key={tool} className="text-xs font-medium bg-primary/5 text-primary border border-primary/15 px-3 py-1.5 rounded-full">
                              {tool}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div>
                        <h4 className="font-display text-sm font-semibold text-text-primary mb-3">
                          {t('use_cases.labels.key_metrics')}
                        </h4>
                        <div className="grid grid-cols-3 gap-3">
                          {metrics.map((m) => (
                            <div key={m.label} className="text-center">
                              <m.icon className="h-4 w-4 text-primary mx-auto mb-1" />
                              <p className="font-display text-lg font-bold text-text-primary">{m.value}</p>
                              <p className="text-[11px] text-text-primary/50 font-body">{m.label}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </RevealSection>
            );
          })}
        </div>
      </section>

      <section className="py-16 lg:py-20 bg-surface-secondary">
        <div className="max-w-4xl mx-auto px-6 lg:px-8 text-center">
          <RevealSection>
            <h2 className="font-display text-2xl lg:text-3xl font-bold text-text-primary mb-4">
              {t('use_cases.mid_cta.title')}
            </h2>
            <p className="text-text-primary/60 font-body mb-8 max-w-2xl mx-auto">
              {t('use_cases.mid_cta.subtitle')}
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                to="/demo"
                className="btn-primary-glow inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-on-primary font-semibold px-8 py-3.5 rounded-xl text-sm transition-colors duration-[var(--motion-base)] min-h-[44px]"
                onClick={() => trackCTAClick('Try the Demo', '/use-cases', 'mid-cta')}
              >
                {t('use_cases.mid_cta.try_demo')}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/features"
                className="inline-flex items-center gap-2 bg-white border border-border/50 hover:border-primary/30 text-text-primary font-semibold px-8 py-3.5 rounded-xl text-sm transition-colors"
                onClick={() => trackCTAClick('Explore Features', '/use-cases', 'mid-cta')}
              >
                {t('use_cases.mid_cta.explore_features')}
              </Link>
            </div>
          </RevealSection>
        </div>
      </section>

      <section className="bg-sidebar-bg text-white py-16">
        <div className="max-w-3xl mx-auto px-6 lg:px-8 text-center">
          <h2 className="font-display text-2xl font-bold mb-4">
            {t('use_cases.bottom_cta.title')}
          </h2>
          <p className="text-white/60 font-body mb-8">
            {t('use_cases.bottom_cta.subtitle')}
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link
              to="/contact"
              className="inline-flex items-center gap-2 bg-primary hover:bg-primary-hover text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors"
              onClick={() => trackCTAClick('Talk to Us', '/use-cases', 'bottom-cta')}
            >
              {t('common.talk_to_us')}
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to="/signup"
              className="inline-flex items-center gap-2 bg-white/10 hover:bg-white/15 text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors"
              onClick={() => trackCTAClick('Start Free Trial', '/use-cases', 'bottom-cta')}
            >
              {t('common.start_free_trial')}
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
