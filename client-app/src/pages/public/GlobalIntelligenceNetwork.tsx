import { Link } from 'react-router-dom';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight, Globe, BarChart3, ShieldCheck, Lock, EyeOff,
  TrendingUp, Users, Target, Sparkles, CheckCircle2, ToggleRight,
  Layers, Activity, GitBranch, Database, Award,
} from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';
import { trackPageView, trackCTAClick, trackFeatureView } from '../../lib/analytics';

const benchmarkRows = [
  { you: '92%', median: '78%', topQuartile: '94%' },
  { you: '63%', median: '54%', topQuartile: '71%' },
  { you: '4m 12s', median: '7m 30s', topQuartile: '3m 10s' },
  { you: '38%', median: '29%', topQuartile: '46%' },
];

const valuePropIcons = [Globe, TrendingUp, Sparkles];
const howItWorksIcons = [ToggleRight, EyeOff, Lock, Activity];
const benefitIcons = [BarChart3, Award, Target, GitBranch, Users, Database];

type TextItem = { title: string; desc: string };
type LabelItem = { label: string; desc: string };
type BenchmarkExample = { vertical: string; metric: string };

export default function GlobalIntelligenceNetwork() {
  const { t } = useTranslation();

  useEffect(() => {
    trackPageView('/product/global-intelligence-network');
  }, []);

  const benchmarkExamples = t('gin_page.benchmark.examples', { returnObjects: true }) as BenchmarkExample[];
  const valueProps = t('gin_page.value_props.items', { returnObjects: true }) as TextItem[];
  const howItWorks = t('gin_page.how_it_works.items', { returnObjects: true }) as TextItem[];
  const benefits = t('gin_page.control_plane.benefits', { returnObjects: true }) as LabelItem[];
  const privacyControls = t('gin_page.control_plane.privacy_controls', { returnObjects: true }) as string[];

  return (
    <div>
      <SEO
        title={t('gin_page.seo_title')}
        description={t('gin_page.seo_description')}
        canonicalPath="/product/global-intelligence-network"
      />

      <section className="bg-harbor text-white py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-4">
              {t('gin_page.hero.eyebrow')}
            </p>
            <h1 className="font-display text-4xl lg:text-5xl font-bold leading-tight mb-6">
              {t('gin_page.hero.title')}
            </h1>
            <p className="text-lg text-white/70 leading-relaxed font-body max-w-2xl mb-8">
              {t('gin_page.hero.description')}
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link
                to="/book-demo"
                className="inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-7 py-3.5 rounded-xl transition-all text-sm shadow-lg shadow-teal/25"
                onClick={() => trackCTAClick('See GIN in a demo', '/product/global-intelligence-network', 'hero')}
              >
                {t('gin_page.hero.cta_primary')}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/security"
                className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 backdrop-blur-sm text-white font-semibold px-7 py-3.5 rounded-xl transition-all text-sm border border-white/10"
                onClick={() => trackCTAClick('Read the privacy model', '/product/global-intelligence-network', 'hero')}
              >
                {t('gin_page.hero.cta_secondary')}
              </Link>
            </div>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-white/60">
              <span className="inline-flex items-center gap-2"><ToggleRight className="h-4 w-4 text-teal" />{t('gin_page.hero.chip_optin')}</span>
              <span className="inline-flex items-center gap-2"><EyeOff className="h-4 w-4 text-teal" />{t('gin_page.hero.chip_kanon')}</span>
              <span className="inline-flex items-center gap-2"><Lock className="h-4 w-4 text-teal" />{t('gin_page.hero.chip_transcripts')}</span>
            </div>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-mist">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
                {t('gin_page.benchmark.heading')}
              </h2>
              <p className="text-lg text-slate-ink/60 font-body max-w-2xl mx-auto">
                {t('gin_page.benchmark.subheading')}
              </p>
            </div>
          </RevealSection>

          <RevealSection>
            <div className="max-w-5xl mx-auto bg-white rounded-2xl border border-soft-steel/30 overflow-hidden shadow-sm">
              <div className="grid grid-cols-12 gap-2 px-6 py-4 border-b border-soft-steel/20 bg-mist/50 text-xs font-semibold uppercase tracking-wide text-slate-ink/55 font-display">
                <div className="col-span-3">{t('gin_page.benchmark.col_vertical')}</div>
                <div className="col-span-4">{t('gin_page.benchmark.col_metric')}</div>
                <div className="col-span-2 text-right">{t('gin_page.benchmark.col_you')}</div>
                <div className="col-span-2 text-right">{t('gin_page.benchmark.col_median')}</div>
                <div className="col-span-1 text-right">{t('gin_page.benchmark.col_top')}</div>
              </div>
              {benchmarkExamples.map((row, i) => {
                const numbers = benchmarkRows[i] || benchmarkRows[0];
                return (
                  <div key={`${row.vertical}-${row.metric}`} className="grid grid-cols-12 gap-2 px-6 py-4 border-b last:border-b-0 border-soft-steel/20 items-center text-sm font-body">
                    <div className="col-span-3 font-display text-harbor font-semibold">{row.vertical}</div>
                    <div className="col-span-4 text-slate-ink/70">{row.metric}</div>
                    <div className="col-span-2 text-right font-mono font-semibold text-teal">{numbers.you}</div>
                    <div className="col-span-2 text-right font-mono text-slate-ink/55">{numbers.median}</div>
                    <div className="col-span-1 text-right font-mono text-calm-green">{numbers.topQuartile}</div>
                  </div>
                );
              })}
              <div className="px-6 py-3 bg-mist/40 text-xs text-slate-ink/50 font-body italic">
                {t('gin_page.benchmark.footnote')}
              </div>
            </div>
          </RevealSection>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-white">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-3">
                {t('gin_page.value_props.eyebrow')}
              </p>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
                {t('gin_page.value_props.heading')}
              </h2>
            </div>
          </RevealSection>
          <div className="grid md:grid-cols-3 gap-6 max-w-6xl mx-auto">
            {valueProps.map((prop, i) => {
              const Icon = valuePropIcons[i] || Globe;
              return (
                <RevealSection key={prop.title} delay={`scroll-delay-${(i % 3) + 1}`}>
                  <div
                    className="bg-mist rounded-2xl border border-soft-steel/30 p-7 h-full hover:shadow-lg transition-shadow"
                    onMouseEnter={() => trackFeatureView(`gin:${prop.title}`)}
                  >
                    <div className="w-11 h-11 rounded-xl bg-teal/10 flex items-center justify-center mb-4">
                      <Icon className="h-5 w-5 text-teal" />
                    </div>
                    <h3 className="font-display text-lg font-semibold text-harbor mb-2">{prop.title}</h3>
                    <p className="text-sm text-slate-ink/65 leading-relaxed font-body">{prop.desc}</p>
                  </div>
                </RevealSection>
              );
            })}
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-mist">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <span className="inline-block text-sm font-semibold text-teal bg-teal/10 px-4 py-1.5 rounded-full mb-4">
                {t('gin_page.how_it_works.pill')}
              </span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-4">
                {t('gin_page.how_it_works.heading')}
              </h2>
              <p className="text-lg text-slate-ink/60 font-body max-w-2xl mx-auto">
                {t('gin_page.how_it_works.subheading')}
              </p>
            </div>
          </RevealSection>
          <div className="grid md:grid-cols-2 gap-6 max-w-5xl mx-auto">
            {howItWorks.map((step, i) => {
              const Icon = howItWorksIcons[i] || ToggleRight;
              return (
                <RevealSection key={step.title} delay={`scroll-delay-${(i % 3) + 1}`}>
                  <div className="bg-white rounded-2xl border border-soft-steel/30 p-6 flex gap-4 h-full">
                    <div className="w-10 h-10 rounded-lg bg-harbor/10 flex items-center justify-center shrink-0">
                      <Icon className="h-5 w-5 text-harbor" />
                    </div>
                    <div>
                      <h3 className="font-display text-base font-semibold text-harbor mb-1.5">{step.title}</h3>
                      <p className="text-sm text-slate-ink/65 leading-relaxed font-body">{step.desc}</p>
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
          <div className="grid lg:grid-cols-2 gap-12 items-start max-w-6xl mx-auto">
            <RevealSection>
              <div>
                <p className="text-teal font-display text-sm font-semibold tracking-wide uppercase mb-3">
                  {t('gin_page.control_plane.eyebrow')}
                </p>
                <h2 className="font-display text-3xl lg:text-4xl font-bold text-harbor mb-6">
                  {t('gin_page.control_plane.heading')}
                </h2>
                <div className="space-y-3">
                  {benefits.map((b, i) => {
                    const Icon = benefitIcons[i] || BarChart3;
                    return (
                      <div key={b.label} className="flex items-start gap-3 bg-mist rounded-xl border border-soft-steel/30 px-4 py-3">
                        <div className="w-9 h-9 rounded-lg bg-teal/10 flex items-center justify-center shrink-0">
                          <Icon className="h-4.5 w-4.5 text-teal" />
                        </div>
                        <div>
                          <h3 className="font-display text-sm font-semibold text-harbor">{b.label}</h3>
                          <p className="text-xs text-slate-ink/60 font-body leading-relaxed">{b.desc}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </RevealSection>

            <RevealSection>
              <div className="bg-harbor rounded-2xl p-8 lg:p-10 text-white">
                <div className="flex items-center gap-3 mb-3">
                  <ShieldCheck className="h-5 w-5 text-teal" />
                  <p className="font-display text-sm font-semibold tracking-wide uppercase text-teal">
                    {t('gin_page.control_plane.privacy_eyebrow')}
                  </p>
                </div>
                <h3 className="font-display text-xl font-bold mb-5">{t('gin_page.control_plane.privacy_heading')}</h3>
                <ul className="space-y-3">
                  {privacyControls.map((line) => (
                    <li key={line} className="flex items-start gap-2.5 text-sm text-white/80 font-body leading-relaxed">
                      <CheckCircle2 className="h-4 w-4 text-teal shrink-0 mt-0.5" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-6 pt-6 border-t border-white/10 flex flex-wrap gap-3">
                  <Link
                    to="/security"
                    className="inline-flex items-center gap-2 bg-white/10 hover:bg-white/15 text-white font-semibold px-5 py-2.5 rounded-lg text-sm border border-white/10"
                  >
                    {t('gin_page.control_plane.security_link')}
                  </Link>
                  <Link
                    to="/privacy"
                    className="inline-flex items-center gap-2 bg-white/10 hover:bg-white/15 text-white font-semibold px-5 py-2.5 rounded-lg text-sm border border-white/10"
                  >
                    {t('gin_page.control_plane.privacy_link')}
                  </Link>
                </div>
              </div>
            </RevealSection>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-mist">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="max-w-4xl mx-auto bg-white rounded-2xl border border-soft-steel/30 p-8 lg:p-12 text-center">
              <Layers className="h-9 w-9 text-teal mx-auto mb-5" />
              <h2 className="font-display text-2xl lg:text-3xl font-bold text-harbor mb-4">
                {t('gin_page.evolution_card.heading')}
              </h2>
              <p className="text-base text-slate-ink/65 font-body leading-relaxed mb-6 max-w-2xl mx-auto">
                {t('gin_page.evolution_card.desc')}
              </p>
              <Link
                to="/features"
                className="inline-flex items-center gap-2 text-teal hover:text-teal-hover font-semibold text-sm"
                onClick={() => trackCTAClick('Explore the platform', '/product/global-intelligence-network', 'mid-cta')}
              >
                {t('gin_page.evolution_card.cta')}
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </RevealSection>
        </div>
      </section>

      <section className="relative py-20 lg:py-24 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-harbor via-harbor-light/40 to-harbor" />
        <div className="absolute inset-0 opacity-15">
          <div className="absolute top-0 left-1/4 w-64 h-64 bg-teal rounded-full blur-[100px]" />
          <div className="absolute bottom-0 right-1/4 w-80 h-80 bg-teal rounded-full blur-[120px]" />
        </div>
        <RevealSection>
          <div className="relative max-w-3xl mx-auto px-6 lg:px-8 text-center">
            <h2 className="font-display text-3xl lg:text-4xl font-bold text-white mb-4">
              {t('gin_page.bottom_cta.title')}
            </h2>
            <p className="text-lg text-white/65 font-body mb-10 max-w-xl mx-auto">
              {t('gin_page.bottom_cta.subtitle')}
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                to="/book-demo"
                className="inline-flex items-center justify-center gap-2 bg-teal hover:bg-teal-hover text-white font-semibold px-8 py-3.5 rounded-xl transition-all text-sm shadow-lg shadow-teal/30"
                onClick={() => trackCTAClick('Book a demo', '/product/global-intelligence-network', 'bottom-cta')}
              >
                {t('gin_page.bottom_cta.cta_primary')}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/signup"
                className="inline-flex items-center justify-center gap-2 bg-white/10 hover:bg-white/15 backdrop-blur-sm text-white font-semibold px-8 py-3.5 rounded-xl transition-all text-sm border border-white/10"
                onClick={() => trackCTAClick('Start free trial', '/product/global-intelligence-network', 'bottom-cta')}
              >
                {t('gin_page.bottom_cta.cta_secondary')}
              </Link>
            </div>
          </div>
        </RevealSection>
      </section>
    </div>
  );
}
