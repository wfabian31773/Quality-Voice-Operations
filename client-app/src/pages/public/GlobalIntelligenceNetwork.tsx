import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowRight, Globe, BarChart3, ShieldCheck, Lock, EyeOff,
  TrendingUp, Users, Target, Sparkles, CheckCircle2, ToggleRight,
  Layers, Activity, GitBranch, Database, Award, Info,
} from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';
import { trackPageView, trackCTAClick, trackFeatureView } from '../../lib/analytics';
import { CTA } from '../../lib/analyticsCtas';
import { FEATURE, type FeatureName } from '../../lib/analyticsLabels';
import {
  ginBenchmarkFallback,
  type GinBenchmarkSnapshot,
  type GinBenchmarkStatus,
} from '../../data/ginBenchmarks';

// "preview" was the lone raw-Tailwind sky entry in an otherwise
// brand-semantic map (warning for illustrative, success for live).
// Collapsed preview to brand `info` so all three status badges read
// from the same token system.
const STATUS_TONE: Record<GinBenchmarkStatus, string> = {
  illustrative: 'bg-warning-light dark:bg-warning text-warning dark:text-warning border-warning dark:border-warning',
  preview: 'bg-info/10 dark:bg-info/20 text-info border-info/40',
  live: 'bg-success-light dark:bg-success text-success dark:text-success border-success dark:border-success',
};

const STATUS_LABEL_KEY: Record<GinBenchmarkStatus, string> = {
  illustrative: 'gin_page.benchmark.status_illustrative',
  preview: 'gin_page.benchmark.status_preview',
  live: 'gin_page.benchmark.status_live',
};

const STATUS_DISCLOSURE_KEY: Record<GinBenchmarkStatus, string> = {
  illustrative: 'gin_page.benchmark.disclosure_illustrative',
  preview: 'gin_page.benchmark.disclosure_preview',
  live: 'gin_page.benchmark.disclosure_live',
};

function formatSnapshotDate(snapshotAt: string | null, locale: string): string | null {
  if (!snapshotAt) return null;
  const parsed = new Date(snapshotAt);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toLocaleDateString(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

const valuePropIcons = [Globe, TrendingUp, Sparkles];
// Positional mapping to `gin_page.value_props.items` in
// `client-app/src/locales/*/common.json`. Keep this list in lock-step
// with the i18n array so each card emits a stable funnel label.
const valuePropFeatures: FeatureName[] = [
  FEATURE.GIN_SEE_WHERE_YOU_STAND,
  FEATURE.GIN_LEARN_FROM_TOP_QUARTILE,
  FEATURE.GIN_POWER_EVOLUTION_ENGINE,
];
const howItWorksIcons = [ToggleRight, EyeOff, Lock, Activity];
const benefitIcons = [BarChart3, Award, Target, GitBranch, Users, Database];

type TextItem = { title: string; desc: string };
type LabelItem = { label: string; desc: string };
type BenchmarkExample = { vertical: string; metric: string };

export default function GlobalIntelligenceNetwork() {
  const { t, i18n } = useTranslation();
  const [snapshot, setSnapshot] = useState<GinBenchmarkSnapshot>(ginBenchmarkFallback);

  useEffect(() => {
    trackPageView('/product/global-intelligence-network');
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/public/gin/benchmarks', { credentials: 'omit' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as Partial<GinBenchmarkSnapshot> & { rows?: GinBenchmarkSnapshot['rows'] };
        if (cancelled) return;
        const rows = Array.isArray(data.rows) ? data.rows : [];
        if (rows.length === 0) return;
        setSnapshot({
          status: (data.status as GinBenchmarkStatus) ?? 'preview',
          snapshotAt: data.snapshotAt ?? null,
          refreshCadence: data.refreshCadence ?? ginBenchmarkFallback.refreshCadence,
          kAnonymity: data.kAnonymity ?? ginBenchmarkFallback.kAnonymity,
          source: data.source ?? 'industry_benchmarks',
          disclosure: data.disclosure ?? '',
          rows,
        });
      })
      .catch(() => {
        // Keep fallback snapshot — pipeline not reachable or no data yet.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const status = snapshot.status;
  const snapshotDateLabel = formatSnapshotDate(snapshot.snapshotAt, i18n.language);
  const disclosureText = t(STATUS_DISCLOSURE_KEY[status]);
  const cadenceText =
    snapshot.refreshCadence === ginBenchmarkFallback.refreshCadence
      ? t('gin_page.benchmark.refresh_cadence')
      : snapshot.refreshCadence;

  const valueProps = (t('gin_page.value_props.items', { returnObjects: true }) as TextItem[]).map(
    (prop, i) => ({
      ...prop,
      // Pair each card with its canonical analytics label here so a
      // mismatch between the i18n list and `valuePropFeatures` shows
      // up as a missing funnel event for that specific card — never
      // as a silent fallback to a different label.
      feature: valuePropFeatures[i] ?? null,
    }),
  );
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

      {/*
        GIN hero — flat dark band placeholder. Wayne's bespoke
        Higgsfield render slots in here later (drop file at
        /hero/gin-hero.{webp,mp4} and add a <picture>/<video> above
        the gradient layer). Until then:
          - radial-gradient backdrop at 75% 45% (off-center, distinct
            from /federated-ingest 65% 55% — the two adjacent product
            sub-pages stay visually separated)
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
              'radial-gradient(ellipse 70% 60% at 75% 45%, rgba(46,140,131,0.20), transparent 70%)',
          }}
        />
        <div className="relative max-w-7xl mx-auto px-6 lg:px-8">
          <div className="max-w-3xl">
            <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-4">
              {t('gin_page.hero.eyebrow')}
            </p>
            <h1 className="font-display text-white text-4xl lg:text-6xl font-bold leading-tight tracking-tight mb-6">
              {t('gin_page.hero.title')}
            </h1>
            <p className="text-lg text-white/70 leading-relaxed font-body max-w-2xl mb-8">
              {t('gin_page.hero.description')}
            </p>
            <div className="flex flex-col sm:flex-row gap-4">
              <Link
                to="/book-demo"
                className="btn-primary-glow inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-on-primary font-semibold px-7 py-3.5 rounded-xl transition-colors duration-[var(--motion-base)] text-sm min-h-[44px]"
                onClick={() => trackCTAClick(CTA.SEE_GIN_DEMO, '/product/global-intelligence-network', 'hero')}
              >
                {t('gin_page.hero.cta_primary')}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/security"
                className="inline-flex items-center justify-center gap-2 bg-white/10 dark:bg-white/10 hover:bg-white/15 dark:hover:bg-white/15 backdrop-blur-sm text-white font-semibold px-7 py-3.5 rounded-xl transition-all text-sm border border-white/10 dark:border-white/10"
                onClick={() => trackCTAClick(CTA.READ_PRIVACY_MODEL, '/product/global-intelligence-network', 'hero')}
              >
                {t('gin_page.hero.cta_secondary')}
              </Link>
            </div>
            <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-white/60">
              <span className="inline-flex items-center gap-2"><ToggleRight className="h-4 w-4 text-primary" />{t('gin_page.hero.chip_optin')}</span>
              <span className="inline-flex items-center gap-2"><EyeOff className="h-4 w-4 text-primary" />{t('gin_page.hero.chip_kanon')}</span>
              <span className="inline-flex items-center gap-2"><Lock className="h-4 w-4 text-primary" />{t('gin_page.hero.chip_transcripts')}</span>
            </div>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-surface-secondary">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                {t('gin_page.benchmark.heading')}
              </h2>
              <p className="text-lg text-text-primary/60 font-body max-w-2xl mx-auto">
                {t('gin_page.benchmark.subheading')}
              </p>
            </div>
          </RevealSection>

          <RevealSection>
            <div className="max-w-5xl mx-auto bg-surface rounded-2xl border border-border/30 overflow-hidden shadow-sm">
              <div className="px-6 py-4 border-b border-border/20 bg-surface-secondary/40 flex flex-wrap items-center justify-between gap-3">
                <span
                  className={`inline-flex items-center gap-2 text-xs font-semibold px-3 py-1 rounded-full border ${STATUS_TONE[status]}`}
                  data-testid="gin-benchmark-status"
                >
                  <Info className="h-3.5 w-3.5" />
                  {t(STATUS_LABEL_KEY[status])}
                </span>
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-text-primary/60 font-body">
                  <span data-testid="gin-benchmark-snapshot-date">
                    {t('gin_page.benchmark.snapshot_label')}{' '}
                    <span className="font-semibold text-text-primary/80">
                      {snapshotDateLabel ?? t('gin_page.benchmark.snapshot_pending')}
                    </span>
                  </span>
                  <span>
                    {t('gin_page.benchmark.kanon_label')}{' '}
                    <span className="font-semibold text-text-primary/80">
                      {t('gin_page.benchmark.kanon_value', { n: snapshot.kAnonymity })}
                    </span>
                  </span>
                </div>
              </div>
              <div className="grid grid-cols-12 gap-2 px-6 py-4 border-b border-border/20 bg-surface-secondary/50 text-xs font-semibold uppercase tracking-wide text-text-primary/55 font-display">
                <div className="col-span-3">{t('gin_page.benchmark.col_vertical')}</div>
                <div className="col-span-3">{t('gin_page.benchmark.col_metric')}</div>
                <div className="col-span-2 text-right">{t('gin_page.benchmark.col_cohort_avg')}</div>
                <div className="col-span-2 text-right">{t('gin_page.benchmark.col_median')}</div>
                <div className="col-span-1 text-right">{t('gin_page.benchmark.col_top')}</div>
                <div className="col-span-1 text-right">{t('gin_page.benchmark.col_cohort')}</div>
              </div>
              {snapshot.rows.map((row) => (
                <div key={`${row.vertical}-${row.metric}`} className="grid grid-cols-12 gap-2 px-6 py-4 border-b last:border-b-0 border-border/20 items-center text-sm font-body">
                  <div className="col-span-3 font-display text-text-primary font-semibold">{row.vertical}</div>
                  <div className="col-span-3 text-text-primary/70">{row.metric}</div>
                  <div className="col-span-2 text-right font-mono font-semibold text-primary">{row.cohortAvg}</div>
                  <div className="col-span-2 text-right font-mono text-text-primary/55">{row.median}</div>
                  <div className="col-span-1 text-right font-mono text-success">{row.topQuartile}</div>
                  <div className="col-span-1 text-right font-mono text-text-primary/45">
                    {row.cohortSize > 0 ? t('gin_page.benchmark.cohort_size', { n: row.cohortSize }) : '—'}
                  </div>
                </div>
              ))}
              <div className="px-6 py-3 bg-surface-secondary/40 text-xs text-text-primary/55 font-body italic">
                {t('gin_page.benchmark.footnote')} {disclosureText} {t('gin_page.benchmark.disclosure_suffix', { k: snapshot.kAnonymity, cadence: cadenceText })}
              </div>
            </div>
          </RevealSection>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-surface">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="text-center mb-14">
              <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-3">
                {t('gin_page.value_props.eyebrow')}
              </p>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
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
                    className="bg-surface-secondary rounded-2xl border border-border/30 p-7 h-full hover:shadow-lg transition-shadow"
                    onMouseEnter={prop.feature ? () => trackFeatureView(prop.feature!) : undefined}
                  >
                    <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                      <Icon className="h-5 w-5 text-primary" />
                    </div>
                    <h3 className="font-display text-lg font-semibold text-text-primary mb-2">{prop.title}</h3>
                    <p className="text-sm text-text-primary/65 leading-relaxed font-body">{prop.desc}</p>
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
              <span className="inline-block text-sm font-semibold text-primary bg-primary/10 px-4 py-1.5 rounded-full mb-4">
                {t('gin_page.how_it_works.pill')}
              </span>
              <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-4">
                {t('gin_page.how_it_works.heading')}
              </h2>
              <p className="text-lg text-text-primary/60 font-body max-w-2xl mx-auto">
                {t('gin_page.how_it_works.subheading')}
              </p>
            </div>
          </RevealSection>
          <div className="grid md:grid-cols-2 gap-6 max-w-5xl mx-auto">
            {howItWorks.map((step, i) => {
              const Icon = howItWorksIcons[i] || ToggleRight;
              return (
                <RevealSection key={step.title} delay={`scroll-delay-${(i % 3) + 1}`}>
                  <div className="bg-surface rounded-2xl border border-border/30 p-6 flex gap-4 h-full">
                    <div className="w-10 h-10 rounded-lg bg-surface-muted flex items-center justify-center shrink-0">
                      <Icon className="h-5 w-5 text-text-primary" />
                    </div>
                    <div>
                      <h3 className="font-display text-base font-semibold text-text-primary mb-1.5">{step.title}</h3>
                      <p className="text-sm text-text-primary/65 leading-relaxed font-body">{step.desc}</p>
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
          <div className="grid lg:grid-cols-2 gap-12 items-start max-w-6xl mx-auto">
            <RevealSection>
              <div>
                <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-3">
                  {t('gin_page.control_plane.eyebrow')}
                </p>
                <h2 className="font-display text-3xl lg:text-4xl font-bold text-text-primary mb-6">
                  {t('gin_page.control_plane.heading')}
                </h2>
                <div className="space-y-3">
                  {benefits.map((b, i) => {
                    const Icon = benefitIcons[i] || BarChart3;
                    return (
                      <div key={b.label} className="flex items-start gap-3 bg-surface-secondary rounded-xl border border-border/30 px-4 py-3">
                        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                          <Icon className="h-4.5 w-4.5 text-primary" />
                        </div>
                        <div>
                          <h3 className="font-display text-sm font-semibold text-text-primary">{b.label}</h3>
                          <p className="text-xs text-text-primary/60 font-body leading-relaxed">{b.desc}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </RevealSection>

            <RevealSection>
              <div className="bg-sidebar-bg rounded-2xl p-8 lg:p-10 text-white">
                <div className="flex items-center gap-3 mb-3">
                  <ShieldCheck className="h-5 w-5 text-primary" />
                  <p className="font-display text-sm font-semibold tracking-wide uppercase text-primary">
                    {t('gin_page.control_plane.privacy_eyebrow')}
                  </p>
                </div>
                <h3 className="font-display text-xl font-bold mb-5">{t('gin_page.control_plane.privacy_heading')}</h3>
                <ul className="space-y-3">
                  {privacyControls.map((line) => (
                    <li key={line} className="flex items-start gap-2.5 text-sm text-white/80 font-body leading-relaxed">
                      <CheckCircle2 className="h-4 w-4 text-primary shrink-0 mt-0.5" />
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-6 pt-6 border-t border-white/10 dark:border-white/10 flex flex-wrap gap-3">
                  <Link
                    to="/security"
                    className="inline-flex items-center gap-2 bg-white/10 dark:bg-white/10 hover:bg-white/15 dark:hover:bg-white/15 text-white font-semibold px-5 py-2.5 rounded-lg text-sm border border-white/10 dark:border-white/10"
                  >
                    {t('gin_page.control_plane.security_link')}
                  </Link>
                  <Link
                    to="/privacy"
                    className="inline-flex items-center gap-2 bg-white/10 dark:bg-white/10 hover:bg-white/15 dark:hover:bg-white/15 text-white font-semibold px-5 py-2.5 rounded-lg text-sm border border-white/10 dark:border-white/10"
                  >
                    {t('gin_page.control_plane.privacy_link')}
                  </Link>
                </div>
              </div>
            </RevealSection>
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28 bg-surface-secondary">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
            <div className="max-w-4xl mx-auto bg-surface rounded-2xl border border-border/30 p-8 lg:p-12 text-center">
              <Layers className="h-9 w-9 text-primary mx-auto mb-5" />
              <h2 className="font-display text-2xl lg:text-3xl font-bold text-text-primary mb-4">
                {t('gin_page.evolution_card.heading')}
              </h2>
              <p className="text-base text-text-primary/65 font-body leading-relaxed mb-6 max-w-2xl mx-auto">
                {t('gin_page.evolution_card.desc')}
              </p>
              <Link
                to="/features"
                className="inline-flex items-center gap-2 text-primary hover:text-primary-hover font-semibold text-sm"
                onClick={() => trackCTAClick(CTA.EXPLORE_PLATFORM, '/product/global-intelligence-network', 'mid-cta')}
              >
                {t('gin_page.evolution_card.cta')}
                <ArrowRight className="h-4 w-4" />
              </Link>
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
              {t('gin_page.bottom_cta.title')}
            </h2>
            <p className="text-lg text-white/65 font-body mb-10 max-w-xl mx-auto">
              {t('gin_page.bottom_cta.subtitle')}
            </p>
            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Link
                to="/book-demo"
                className="btn-primary-glow inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-on-primary font-semibold px-8 py-3.5 rounded-xl transition-colors duration-[var(--motion-base)] text-sm min-h-[44px]"
                onClick={() => trackCTAClick(CTA.BOOK_DEMO, '/product/global-intelligence-network', 'bottom-cta')}
              >
                {t('gin_page.bottom_cta.cta_primary')}
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/signup"
                className="inline-flex items-center justify-center gap-2 bg-white/10 dark:bg-white/10 hover:bg-white/15 dark:hover:bg-white/15 backdrop-blur-sm text-white font-semibold px-8 py-3.5 rounded-xl transition-all text-sm border border-white/10 dark:border-white/10"
                onClick={() => trackCTAClick(CTA.START_FREE_TRIAL, '/product/global-intelligence-network', 'bottom-cta')}
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
