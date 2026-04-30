import { Link } from 'react-router-dom';
import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, X as XIcon, ArrowRight, ChevronDown, Star, ShieldCheck, BadgePercent } from 'lucide-react';
import SEO from '../../components/SEO';
import RevealSection from '../../components/RevealSection';
import ROICalculator from '../../components/ROICalculator';
import MinutesPricingCalculator, {
  ANNUAL_DISCOUNT,
  type BillingPeriod,
  type CurrentPlanOverride,
} from '../../components/MinutesPricingCalculator';
import LogosStrip from '../../components/LogosStrip';
import { trackPageView, trackCTAClick, trackConversionEvent, captureUtmOnLoad } from '../../lib/analytics';
import { CTA } from '../../lib/analyticsCtas';
import { CONVERSION_STAGE } from '../../lib/analyticsLabels';
import {
  PLAN_CATALOG,
  PLAN_TIERS,
  centsToWholeDollars,
  getAnnualMonthlyPriceCents,
  getDiscountedAnnualMonthlyDollars,
  getPlanMonthlyPriceWholeDollars,
  type PlanTier,
} from '../../../../shared/billing/planCatalog';
import { formatDollars } from '../../lib/formatCurrency';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';

export interface EffectiveRateResponse {
  plan: PlanTier;
  basePriceCents: number;
  overageRatePerMinute: number;
  basePriceSource: 'stripe' | 'catalog';
  overagePriceSource: 'stripe' | 'catalog';
  // Interval-specific quotes added in #1209. Optional for backward
  // compat with older API responses; the calculator falls back to
  // catalog rates on whichever side is missing.
  monthlyBasePriceCents?: number;
  monthlyBasePriceSource?: 'stripe' | 'catalog';
  annualBasePriceCents?: number;
  annualBasePriceSource?: 'stripe' | 'catalog';
  // Per-message SMS rate (in dollars) and its provenance, added in
  // #1265 so the calculator can surface a tenant's negotiated SMS
  // rate alongside the AI per-minute rate. Optional for backward
  // compat with older API responses; the calculator hides the SMS
  // line when neither field is present.
  smsRatePerMessage?: number;
  smsPriceSource?: 'stripe' | 'catalog';
}

/**
 * Summary of how the tenant's actual Stripe-invoiced monthly rate compares
 * to the *matching-interval* catalog price for the same tier — drives
 * the "you're on a custom plan" callout that appears above the
 * calculator.
 *
 * We deliberately compare like-with-like: a tenant on an annual
 * subscription is compared against the published annual price (catalog
 * monthly × 0.8), not against the catalog monthly. Otherwise every
 * tenant on the standard published *annual* rate would falsely see a
 * "you're paying less than the published rate" banner — they're on the
 * published rate, just on a different interval.
 *
 * The interval is inferred from which of `monthlyBasePriceCents` or
 * `annualBasePriceCents` matches `basePriceCents` (the API populates
 * the matching side from the tenant's actual subscription and the
 * other side from the published `STRIPE_PRICE_<TIER>_<INTERVAL>` env
 * var).
 *
 * The base-price delta is the headline of the callout. The optional
 * `overage` sub-delta surfaces a per-minute divergence on the same
 * banner so a grandfathered tenant negotiating purely on overage can
 * see the same kind of "you pay $X/min vs the published $Y/min"
 * summary (task #1270).
 */
export interface CustomRateOverageDelta {
  /** Tenant's actual Stripe-invoiced overage rate, in dollars/minute. */
  currentRatePerMinute: number;
  /** Catalog (published) overage rate for the same tier, dollars/minute. */
  catalogRatePerMinute: number;
  /** Absolute difference between catalog and tenant rate, dollars/minute. */
  deltaPerMinute: number;
  /** True when the tenant pays *less* per minute than the published rate. */
  isLess: boolean;
}

export interface CustomRateDelta {
  tier: PlanTier;
  tierName: string;
  frame: 'monthly' | 'annual';
  currentMonthlyDollars: number;
  catalogMonthlyDollars: number;
  /**
   * Whole-dollar absolute base-price delta. `0` when the tenant base
   * price matches catalog within rounding noise — in that case the
   * callout renders only the overage section (when present) and skips
   * the base sentence so it doesn't read as "$0/mo less than $399".
   */
  deltaDollars: number;
  /** Per-year projection. Populated only when `frame === 'annual'`. */
  annualCurrentDollars: number | null;
  annualCatalogDollars: number | null;
  annualDeltaDollars: number | null;
  /** True when the tenant pays *less* than the current published rate. */
  isLess: boolean;
  /**
   * Populated only when `overagePriceSource === 'stripe'` AND the
   * tenant's per-minute rate diverges from catalog by at least
   * `OVERAGE_RENDER_THRESHOLD_PER_MIN`. Absent otherwise.
   */
  overage?: CustomRateOverageDelta;
}

// Sub-dollar deltas are suppressed: the callout formats every monetary
// value as whole dollars, so smaller drifts would render arithmetic that
// doesn't add up on screen and are likely proration / Stripe rounding
// noise rather than a meaningful negotiated rate.
const RENDER_THRESHOLD_CENTS = 100;

// Half-cent-per-minute threshold for the overage line. Catalog rates are
// quoted to the nearest cent (e.g. $0.08, $0.12); negotiated Stripe
// rates can be sub-cent (e.g. $0.075). Anything below half a cent is
// almost certainly currency-conversion or pricing-engine drift rather
// than a meaningful contract delta, so we suppress it to match the
// "matches catalog within rounding noise" requirement.
const OVERAGE_RENDER_THRESHOLD_PER_MIN = 0.005;

function inferTenantInterval(
  payload: EffectiveRateResponse,
): 'monthly' | 'annual' | 'unknown' {
  // The matching interval is BOTH stripe-sourced AND has the same cents
  // value as `basePriceCents` (the API populates the matching side from
  // the live subscription). Annual is checked first so an annual sub
  // wins when both happen to coincide with `basePriceCents`.
  const base = payload.basePriceCents;
  if (
    payload.annualBasePriceSource === 'stripe'
    && payload.annualBasePriceCents === base
  ) return 'annual';
  if (
    payload.monthlyBasePriceSource === 'stripe'
    && payload.monthlyBasePriceCents === base
  ) return 'monthly';
  // Pre-#1209 API responses don't carry the per-interval breakdown;
  // default to monthly (the common case) rather than skip the banner.
  if (
    payload.monthlyBasePriceSource == null
    && payload.annualBasePriceSource == null
  ) return 'monthly';
  return 'unknown';
}

function catalogReferenceCents(
  tier: PlanTier,
  interval: 'monthly' | 'annual',
): number {
  return interval === 'annual'
    ? getAnnualMonthlyPriceCents(tier)
    : PLAN_CATALOG[tier].monthlyPriceCents;
}

export function computeCustomRateDelta(
  payload: EffectiveRateResponse | null | undefined,
  billingPeriod: BillingPeriod = 'monthly',
): CustomRateDelta | null {
  if (!payload) return null;
  if (!(PLAN_TIERS as readonly string[]).includes(payload.plan)) return null;

  // Only surface the callout when something on the response is actually
  // sourced from Stripe — a fully-catalog response is identical to what
  // an anonymous visitor sees and would render a misleading "custom
  // plan" message for tenants on the published rate.
  const isStripeSourced =
    payload.basePriceSource === 'stripe'
    || payload.monthlyBasePriceSource === 'stripe'
    || payload.annualBasePriceSource === 'stripe'
    || payload.overagePriceSource === 'stripe';
  if (!isStripeSourced) return null;

  const tier = payload.plan;

  // Annual framing: compare the tenant's annual rate against the catalog
  // annual reference and project the delta over a year. Falls through to
  // monthly framing when `annualBasePriceCents` is unavailable.
  if (
    billingPeriod === 'annual'
    && payload.annualBasePriceCents != null
    && Number.isFinite(payload.annualBasePriceCents)
  ) {
    const tenantAnnualMonthlyCents = payload.annualBasePriceCents;
    const catalogAnnualMonthlyCents = catalogReferenceCents(tier, 'annual');
    const deltaMonthlyCents = catalogAnnualMonthlyCents - tenantAnnualMonthlyCents;
    if (Math.abs(deltaMonthlyCents) < RENDER_THRESHOLD_CENTS) return null;

    const absMonthlyCents = Math.abs(deltaMonthlyCents);
    return {
      tier,
      tierName: PLAN_CATALOG[tier].name,
      frame: 'annual',
      currentMonthlyDollars: centsToWholeDollars(tenantAnnualMonthlyCents),
      catalogMonthlyDollars: centsToWholeDollars(catalogAnnualMonthlyCents),
      deltaDollars: centsToWholeDollars(absMonthlyCents),
      annualCurrentDollars: centsToWholeDollars(tenantAnnualMonthlyCents * 12),
      annualCatalogDollars: centsToWholeDollars(catalogAnnualMonthlyCents * 12),
      annualDeltaDollars: centsToWholeDollars(absMonthlyCents * 12),
      isLess: deltaMonthlyCents > 0,
    };
  }

  const interval = inferTenantInterval(payload);
  // Ambiguous interval — we'd risk picking the wrong catalog reference
  // and showing a misleading delta. Skip the banner rather than guess.
  if (interval === 'unknown') return null;

  const tenantCents = Number.isFinite(payload.basePriceCents)
    ? payload.basePriceCents
    : catalogReferenceCents(tier, interval);
  const catalogCents = catalogReferenceCents(tier, interval);

  const baseDeltaCents = catalogCents - tenantCents;
  const baseMeaningful = Math.abs(baseDeltaCents) >= RENDER_THRESHOLD_CENTS;

  // Overage delta is computed independently of the base delta, but only
  // when Stripe actually sourced the overage rate — otherwise we'd be
  // comparing the catalog rate to itself (or worse, to a tenant value
  // that happens to drift from catalog purely because the API hadn't
  // resolved a Stripe price yet).
  let overage: CustomRateOverageDelta | undefined;
  if (payload.overagePriceSource === 'stripe') {
    const tenantRate = Number.isFinite(payload.overageRatePerMinute)
      ? payload.overageRatePerMinute
      : PLAN_CATALOG[tier].overageRatePerMinute;
    const catalogRate = PLAN_CATALOG[tier].overageRatePerMinute;
    const overageDelta = catalogRate - tenantRate;
    if (Math.abs(overageDelta) >= OVERAGE_RENDER_THRESHOLD_PER_MIN) {
      overage = {
        currentRatePerMinute: tenantRate,
        catalogRatePerMinute: catalogRate,
        deltaPerMinute: Math.abs(overageDelta),
        isLess: overageDelta > 0,
      };
    }
  }

  // Suppress entirely when neither base nor overage carries a
  // meaningful delta — an isStripeSourced payload can still match
  // catalog exactly (tenant on the published rate via a Stripe-managed
  // sub) and we don't want to mount a banner with nothing to say.
  if (!baseMeaningful && !overage) return null;

  return {
    tier,
    tierName: PLAN_CATALOG[tier].name,
    frame: 'monthly',
    currentMonthlyDollars: centsToWholeDollars(tenantCents),
    catalogMonthlyDollars: centsToWholeDollars(catalogCents),
    // When base matches catalog within rounding noise, zero out the
    // headline delta so the renderer skips the base sentence rather
    // than printing "$0/mo less than $399".
    deltaDollars: baseMeaningful ? centsToWholeDollars(Math.abs(baseDeltaCents)) : 0,
    annualCurrentDollars: null,
    annualCatalogDollars: null,
    annualDeltaDollars: null,
    isLess: baseMeaningful ? baseDeltaCents > 0 : false,
    ...(overage ? { overage } : {}),
  };
}

export function buildOverride(payload: EffectiveRateResponse): CurrentPlanOverride | undefined {
  if (!(PLAN_TIERS as readonly string[]).includes(payload.plan)) return undefined;
  // Prefer the interval-specific monthly quote when present — it's the
  // apples-to-apples monthly Stripe price for the tenant's tier. The
  // legacy `basePriceCents` is interval-agnostic (it's the monthly
  // equivalent of whichever interval the tenant's sub is on), which
  // would render the wrong number in monthly mode for a tenant
  // currently on annual.
  const monthlyCents = payload.monthlyBasePriceCents ?? payload.basePriceCents;
  const monthlySource = payload.monthlyBasePriceSource ?? payload.basePriceSource;
  // No point passing an override that's pure catalog — that's exactly what
  // anonymous visitors already see, and would render a misleading
  // "Live Stripe rate" badge on the current tier card. SMS counts as
  // a Stripe-sourced signal too: a tenant on a negotiated SMS price
  // (with catalog AI/base rates) still deserves to see their rate
  // surfaced on the calculator's SMS row, so we treat
  // `smsPriceSource === 'stripe'` as a sufficient reason to engage
  // the override even when none of the AI-side sources are Stripe.
  if (
    monthlySource !== 'stripe'
    && payload.overagePriceSource !== 'stripe'
    && payload.annualBasePriceSource !== 'stripe'
    && payload.smsPriceSource !== 'stripe'
  ) {
    return undefined;
  }
  return {
    tier: payload.plan,
    basePriceCents: monthlyCents,
    overageRatePerMinute: payload.overageRatePerMinute,
    basePriceSource: monthlySource,
    overagePriceSource: payload.overagePriceSource,
    annualBasePriceCents: payload.annualBasePriceCents,
    annualBasePriceSource: payload.annualBasePriceSource,
    // SMS rate is tenant-wide and interval-agnostic, so it flows
    // through unchanged. The calculator surfaces it alongside the AI
    // per-minute rate so a tenant on a custom SMS price sees the
    // rate that's driving their SMS line on the invoice.
    smsRatePerMessage: payload.smsRatePerMessage ?? null,
    smsPriceSource: payload.smsPriceSource ?? null,
  };
}

function formatOverageRate(ratePerMinute: number): string {
  return `${formatDollars(ratePerMinute)}/min`;
}

function formatPlanMonthlyPrice(tier: 'starter' | 'pro' | 'enterprise'): string {
  return formatDollars(getPlanMonthlyPriceWholeDollars(tier), {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

interface Feature {
  nameKey: string;
  starter: boolean | string;
  pro: boolean | string;
  enterprise: boolean | string;
}

function FeatureCell({ value }: { value: boolean | string }) {
  if (typeof value === 'string') {
    return <span className="text-sm font-medium text-text-primary">{value}</span>;
  }
  return value ? (
    <CheckCircle2 className="h-4.5 w-4.5 text-success mx-auto" />
  ) : (
    <XIcon className="h-4 w-4 text-text-muted mx-auto" />
  );
}

function FAQItem({ q, a, id }: { q: string; a: string; id: string }) {
  const [open, setOpen] = useState(false);
  const panelId = `faq-panel-${id}`;
  const triggerId = `faq-trigger-${id}`;

  return (
    <div className="border-b border-border/30 last:border-b-0">
      <button
        id={triggerId}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-5 px-1 text-left group focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 rounded-lg"
      >
        <span className="font-display text-base font-semibold text-text-primary group-hover:text-primary transition-colors pr-4">
          {q}
        </span>
        <ChevronDown
          className={`h-5 w-5 text-text-primary/40 flex-shrink-0 transition-transform duration-300 ${
            open ? 'rotate-180' : ''
          }`}
        />
      </button>
      <div
        id={panelId}
        role="region"
        aria-labelledby={triggerId}
        className={`overflow-hidden transition-all duration-300 ${
          open ? 'max-h-96 pb-5' : 'max-h-0'
        }`}
      >
        <p className="text-sm text-text-primary/60 font-body leading-relaxed px-1">{a}</p>
      </div>
    </div>
  );
}

function formatWholeDollars(value: number): string {
  return formatDollars(value, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// Per-minute rates can be sub-cent (e.g. negotiated $0.075/min), so we
// allow up to 3 decimals while still rendering common whole-cent rates
// like $0.08 with two-decimal precision rather than awkward $0.080.
function formatPerMinuteRate(rate: number): string {
  return `${formatDollars(rate, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  })}/min`;
}

interface CustomRateCalloutProps {
  delta: CustomRateDelta;
  t: ReturnType<typeof useTranslation>['t'];
}

function CustomRateCallout({ delta, t }: CustomRateCalloutProps) {
  const isAnnualFrame = delta.frame === 'annual';

  // Annual framing renders a single annual-framed sentence and skips
  // the base+overage compositional path — overage rendering only
  // exists in monthly framing.
  if (isAnnualFrame) {
    const interp = {
      tierName: delta.tierName,
      annualCurrentPrice: formatWholeDollars(delta.annualCurrentDollars ?? 0),
      annualCatalogPrice: formatWholeDollars(delta.annualCatalogDollars ?? 0),
      annualDeltaPrice: formatWholeDollars(delta.annualDeltaDollars ?? 0),
    };
    const titleKey = delta.isLess
      ? 'pricing.override_callout.title_annual_less'
      : 'pricing.override_callout.title_annual_more';
    const descriptionKey = delta.isLess
      ? 'pricing.override_callout.description_annual_less'
      : 'pricing.override_callout.description_annual_more';
    const tone = delta.isLess
      ? {
          wrapper: 'border-success/30 bg-success/[0.06]',
          accent: 'text-success',
          iconBg: 'bg-success/15',
        }
      : {
          wrapper: 'border-warning/30 bg-warning/[0.06]',
          accent: 'text-warning',
          iconBg: 'bg-warning/15',
        };
    return (
      <div
        data-testid="pricing-override-callout"
        data-direction={delta.isLess ? 'less' : 'more'}
        data-frame="annual"
        role="status"
        className={`mb-6 flex flex-col sm:flex-row sm:items-start gap-3 rounded-xl border p-4 sm:p-5 ${tone.wrapper}`}
      >
        <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tone.iconBg} ${tone.accent}`}>
          <BadgePercent className="h-4.5 w-4.5" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <p className={`font-display text-sm font-semibold ${tone.accent}`}>
            {t(titleKey)}
          </p>
          <p
            data-testid="pricing-override-callout-description"
            className="text-sm font-body text-text-primary/80 mt-1"
          >
            {t(descriptionKey, interp)}
          </p>
        </div>
        <Link
          to="/billing"
          data-testid="pricing-override-callout-link"
          className={`inline-flex items-center gap-1 self-start sm:self-center font-display text-sm font-semibold whitespace-nowrap hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-current focus-visible:ring-offset-2 rounded ${tone.accent}`}
        >
          {t('pricing.override_callout.manage_link')}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      </div>
    );
  }

  const baseInterp = {
    tierName: delta.tierName,
    currentPrice: formatWholeDollars(delta.currentMonthlyDollars),
    catalogPrice: formatWholeDollars(delta.catalogMonthlyDollars),
    deltaPrice: formatWholeDollars(delta.deltaDollars),
  };
  // `deltaDollars === 0` means base matched catalog within rounding
  // noise — `computeCustomRateDelta` only returns a delta in that case
  // when overage diverges, so we skip the base sentence entirely and
  // let the overage line stand on its own.
  const baseMeaningful = delta.deltaDollars > 0;
  const overage = delta.overage;

  const overageInterp = overage
    ? {
        tierName: delta.tierName,
        currentRate: formatPerMinuteRate(overage.currentRatePerMinute),
        catalogRate: formatPerMinuteRate(overage.catalogRatePerMinute),
        deltaRate: formatPerMinuteRate(overage.deltaPerMinute),
      }
    : null;

  // Title and tone are anchored on whichever delta is the headline:
  // base when present, otherwise the overage-only variant. Mixed
  // directions (e.g. base less, overage more) keep the base headline —
  // the overage line below states its own direction explicitly so the
  // banner still reads correctly.
  const headlineIsLess = baseMeaningful
    ? delta.isLess
    : overage!.isLess;

  let titleKey: string;
  if (baseMeaningful) {
    titleKey = delta.isLess
      ? 'pricing.override_callout.title_less'
      : 'pricing.override_callout.title_more';
  } else {
    titleKey = overage!.isLess
      ? 'pricing.override_callout.title_overage_less'
      : 'pricing.override_callout.title_overage_more';
  }
  const baseDescriptionKey = delta.isLess
    ? 'pricing.override_callout.description_less'
    : 'pricing.override_callout.description_more';
  const overageLineKey = overage?.isLess
    ? 'pricing.override_callout.overage_line_less'
    : 'pricing.override_callout.overage_line_more';

  // Tinted by direction: success-green when the tenant is paying less than
  // the current published price (good news), warning-amber when they're
  // paying more (gentle nudge to revisit their plan).
  const tone = headlineIsLess
    ? {
        wrapper: 'border-success/30 bg-success/[0.06]',
        accent: 'text-success',
        iconBg: 'bg-success/15',
      }
    : {
        wrapper: 'border-warning/30 bg-warning/[0.06]',
        accent: 'text-warning',
        iconBg: 'bg-warning/15',
      };

  return (
    <div
      data-testid="pricing-override-callout"
      data-direction={headlineIsLess ? 'less' : 'more'}
      data-frame="monthly"
      data-has-base={baseMeaningful ? 'true' : 'false'}
      data-has-overage={overage ? 'true' : 'false'}
      role="status"
      className={`mb-6 flex flex-col sm:flex-row sm:items-start gap-3 rounded-xl border p-4 sm:p-5 ${tone.wrapper}`}
    >
      <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${tone.iconBg} ${tone.accent}`}>
        <BadgePercent className="h-4.5 w-4.5" aria-hidden="true" />
      </div>
      <div className="flex-1 min-w-0">
        <p className={`font-display text-sm font-semibold ${tone.accent}`}>
          {t(titleKey)}
        </p>
        {baseMeaningful && (
          <p
            data-testid="pricing-override-callout-description"
            className="text-sm font-body text-text-primary/80 mt-1"
          >
            {t(baseDescriptionKey, baseInterp)}
          </p>
        )}
        {overage && overageInterp && (
          <p
            data-testid="pricing-override-callout-overage"
            className={`text-sm font-body text-text-primary/80 ${baseMeaningful ? 'mt-1.5' : 'mt-1'}`}
          >
            {t(overageLineKey, overageInterp)}
          </p>
        )}
      </div>
      <Link
        to="/billing"
        data-testid="pricing-override-callout-link"
        className={`inline-flex items-center gap-1 self-start sm:self-center font-display text-sm font-semibold whitespace-nowrap hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-current focus-visible:ring-offset-2 rounded ${tone.accent}`}
      >
        {t('pricing.override_callout.manage_link')}
        <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Link>
    </div>
  );
}

export default function Pricing() {
  const { t } = useTranslation('marketing');
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>('monthly');
  const isAnnual = billingPeriod === 'annual';
  const { user } = useAuth();

  useEffect(() => {
    trackPageView('/pricing');
    captureUtmOnLoad();
    trackConversionEvent(CONVERSION_STAGE.PAGE_VIEW, '/pricing');
  }, []);

  // Logged-in tenants browsing the public pricing page get a teaser of
  // their actual Stripe-invoiced rate on the *current* tier card (next
  // tiers stay at catalog prices because Stripe can't quote unsubscribed
  // plans). Anonymous visitors skip the fetch entirely so we don't hammer
  // the API or leak the existence of authenticated endpoints.
  //
  // We use a plain `useEffect` + `api.get` here (rather than React Query
  // like the in-app BillingEstimator does) because the public marketing
  // bundle (`main.public.tsx`) renders under Preact without a
  // QueryClientProvider — pulling the React Query runtime into the
  // marketing pages would bloat the eager preload graph for every
  // anonymous visitor, just to power one optional teaser badge for the
  // logged-in subset.
  const tenantId = user?.tenantId ?? null;
  // Cache the raw payload so the calculator override and the custom-rate
  // callout can each derive from it; the callout re-derives when the
  // billing toggle flips without needing a refetch.
  const [effectiveRatePayload, setEffectiveRatePayload] =
    useState<EffectiveRateResponse | null>(null);

  useEffect(() => {
    if (!tenantId) {
      setEffectiveRatePayload(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const payload = await api.get<EffectiveRateResponse>('/billing/effective-rate');
        if (cancelled) return;
        setEffectiveRatePayload(payload);
      } catch {
        // Silently ignore — the calculator just falls back to catalog
        // rates, which is exactly what anonymous visitors already see.
        if (!cancelled) setEffectiveRatePayload(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Keyed on `tenantId` (not just `isAuthenticated`) so an account/tenant
    // switch while staying logged in correctly refetches the rate for the
    // new tenant. Unlikely on a public marketing page, but cheap and
    // correct.
  }, [tenantId]);

  const currentPlanOverride = useMemo<CurrentPlanOverride | undefined>(
    () => (effectiveRatePayload ? buildOverride(effectiveRatePayload) : undefined),
    [effectiveRatePayload],
  );
  const customRateDelta = useMemo<CustomRateDelta | null>(
    () => computeCustomRateDelta(effectiveRatePayload, billingPeriod),
    [effectiveRatePayload, billingPeriod],
  );

  const tUnlimited = t('pricing.features_list.unlimited');
  const tUpTo3 = t('pricing.features_list.up_to_3');
  const tUpTo10 = t('pricing.features_list.up_to_10');

  const features: Feature[] = [
    {
      nameKey: 'ai_minutes',
      starter: PLAN_CATALOG.starter.includedMinutes.toLocaleString(),
      pro: PLAN_CATALOG.pro.includedMinutes.toLocaleString(),
      enterprise: PLAN_CATALOG.enterprise.includedMinutes.toLocaleString(),
    },
    {
      nameKey: 'overage',
      starter: formatOverageRate(PLAN_CATALOG.starter.overageRatePerMinute),
      pro: formatOverageRate(PLAN_CATALOG.pro.overageRatePerMinute),
      enterprise: formatOverageRate(PLAN_CATALOG.enterprise.overageRatePerMinute),
    },
    { nameKey: 'agents', starter: tUnlimited, pro: tUnlimited, enterprise: tUnlimited },
    { nameKey: 'phones', starter: tUpTo3, pro: tUpTo10, enterprise: tUnlimited },
    { nameKey: 'inbound', starter: true, pro: true, enterprise: true },
    { nameKey: 'outbound', starter: false, pro: true, enterprise: true },
    { nameKey: 'transcripts', starter: true, pro: true, enterprise: true },
    { nameKey: 'quality', starter: false, pro: true, enterprise: true },
    { nameKey: 'analytics', starter: true, pro: true, enterprise: true },
    { nameKey: 'team', starter: tUpTo3, pro: tUpTo10, enterprise: tUnlimited },
    { nameKey: 'rbac', starter: false, pro: true, enterprise: true },
    { nameKey: 'api', starter: false, pro: true, enterprise: true },
    { nameKey: 'crm', starter: false, pro: true, enterprise: true },
    { nameKey: 'templates', starter: false, pro: true, enterprise: true },
    { nameKey: 'audit', starter: false, pro: false, enterprise: true },
    { nameKey: 'multi_loc', starter: false, pro: false, enterprise: true },
    { nameKey: 'priority', starter: false, pro: true, enterprise: true },
    { nameKey: 'onboarding', starter: false, pro: false, enterprise: true },
    { nameKey: 'demo', starter: true, pro: true, enterprise: true },
    { nameKey: 'trial', starter: true, pro: true, enterprise: true },
  ];

  const TIER_COPY: Record<'starter' | 'pro' | 'enterprise', { desc: string; popular?: boolean }> = {
    starter: { desc: t('pricing.tier_copy.starter_desc') },
    pro: { desc: t('pricing.tier_copy.pro_desc'), popular: true },
    enterprise: { desc: t('pricing.tier_copy.enterprise_desc') },
  };

  const tiers = (['starter', 'pro', 'enterprise'] as const).map((key) => {
    const plan = PLAN_CATALOG[key];
    const copy = TIER_COPY[key];
    return {
      key,
      name: plan.name,
      desc: copy.desc,
      popular: copy.popular,
      minutes: t('pricing.tier_card.minutes_included', { minutes: plan.includedMinutes.toLocaleString() }),
      overage: t('pricing.tier_card.overage_label', { overage: formatOverageRate(plan.overageRatePerMinute) }),
    };
  });

  const overageInterp = {
    starter: formatOverageRate(PLAN_CATALOG.starter.overageRatePerMinute),
    pro: formatOverageRate(PLAN_CATALOG.pro.overageRatePerMinute),
    enterprise: formatOverageRate(PLAN_CATALOG.enterprise.overageRatePerMinute),
  };

  const faqs = [
    { q: t('pricing.faq.q1'), a: t('pricing.faq.a1') },
    { q: t('pricing.faq.q2'), a: t('pricing.faq.a2') },
    { q: t('pricing.faq.q3'), a: t('pricing.faq.a3', overageInterp) },
    { q: t('pricing.faq.q4'), a: t('pricing.faq.a4') },
    { q: t('pricing.faq.q5'), a: t('pricing.faq.a5') },
    { q: t('pricing.faq.q6'), a: t('pricing.faq.a6') },
    { q: t('pricing.faq.q7'), a: t('pricing.faq.a7') },
    { q: t('pricing.faq.q8'), a: t('pricing.faq.a8') },
  ];

  const complianceBadges = [
    t('pricing.compliance.soc2'),
    t('pricing.compliance.hipaa'),
    t('pricing.compliance.gdpr'),
    t('pricing.compliance.ccpa'),
    t('pricing.compliance.tls'),
    t('pricing.compliance.aes'),
  ];

  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      {
        '@type': 'Question',
        name: 'How much does QVO cost?',
        acceptedAnswer: { '@type': 'Answer', text: `QVO offers three plans: Starter at ${formatPlanMonthlyPrice('starter')}/month, Pro at ${formatPlanMonthlyPrice('pro')}/month, and Enterprise at ${formatPlanMonthlyPrice('enterprise')}/month. All plans include a 14-day free trial.` },
      },
      {
        '@type': 'Question',
        name: 'What is included in the free trial?',
        acceptedAnswer: { '@type': 'Answer', text: 'Every QVO plan includes a 14-day free trial with full access to all features in your chosen tier. No credit card required to start.' },
      },
      {
        '@type': 'Question',
        name: 'Can I change my plan later?',
        acceptedAnswer: { '@type': 'Answer', text: 'Yes, you can upgrade or downgrade your plan at any time. Changes take effect at the start of your next billing cycle.' },
      },
    ],
  };

  return (
    <div>
      <SEO
        title={t('pricing.seo_title')}
        description={t('pricing.seo_description', { starter: formatPlanMonthlyPrice('starter') })}
        canonicalPath="/pricing"
        structuredData={faqSchema}
      />
      <section className="bg-sidebar-bg text-white py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 text-center">
          <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-4">
            {t('pricing.hero.eyebrow')}
          </p>
          <h1 className="font-display text-4xl lg:text-5xl font-bold mb-6">
            {t('pricing.hero.title')}
          </h1>
          <p className="text-lg text-white/70 font-body max-w-2xl mx-auto mb-6">
            {t('pricing.hero.description')}
          </p>
          <div className="inline-flex items-center gap-2 bg-success/15 border border-success/30 rounded-full px-4 py-1.5 text-success text-sm font-medium">
            <ShieldCheck className="h-4 w-4" />
            {t('pricing.hero.guarantee')}
          </div>
        </div>
      </section>

      <section className="py-20 lg:py-28">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <RevealSection>
          <div className="max-w-5xl mx-auto mb-20">
            <div className="flex justify-center mb-8">
              <div
                role="group"
                aria-label="Billing period"
                data-testid="pricing-billing-toggle"
                className="inline-flex items-center bg-surface border border-border-strong/50 rounded-lg p-0.5 shadow-sm"
              >
                <button
                  type="button"
                  data-testid="pricing-billing-monthly"
                  aria-pressed={!isAnnual}
                  onClick={() => setBillingPeriod('monthly')}
                  className={`px-4 py-2 text-sm font-display font-semibold rounded-md transition-colors ${
                    !isAnnual
                      ? 'bg-primary text-white shadow-sm'
                      : 'text-text-primary/70 hover:text-text-primary'
                  }`}
                >
                  {t('pricing.billing_toggle.monthly')}
                </button>
                <button
                  type="button"
                  data-testid="pricing-billing-annual"
                  aria-pressed={isAnnual}
                  onClick={() => setBillingPeriod('annual')}
                  className={`px-4 py-2 text-sm font-display font-semibold rounded-md transition-colors inline-flex items-center gap-2 ${
                    isAnnual
                      ? 'bg-primary text-white shadow-sm'
                      : 'text-text-primary/70 hover:text-text-primary'
                  }`}
                >
                  {t('pricing.billing_toggle.annual')}
                  <span
                    className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                      isAnnual ? 'bg-white/20 dark:bg-white/20 text-white' : 'bg-success/10 text-success'
                    }`}
                  >
                    {t('pricing.billing_toggle.save_badge')}
                  </span>
                </button>
              </div>
            </div>

            <div className="grid md:grid-cols-3 gap-6">
            {tiers.map((tier) => {
              const monthlyPrice = getPlanMonthlyPriceWholeDollars(tier.key);
              const annualMonthlyPrice = getDiscountedAnnualMonthlyDollars(monthlyPrice);
              const displayedPrice = isAnnual ? annualMonthlyPrice : monthlyPrice;
              // Annual savings = the dollar gap between the two displayed
              // prices, projected over a year — keeps the math visibly
              // consistent with the strikethrough/displayed price pair on
              // the same card.
              const annualSavingsDollars = (monthlyPrice - annualMonthlyPrice) * 12;
              const annualSavingsFormatted = formatDollars(annualSavingsDollars, {
                minimumFractionDigits: 0,
                maximumFractionDigits: 0,
              });
              const signupHref = `/signup?plan=${tier.key}${isAnnual ? '&interval=annual' : ''}`;
              return (
              <div
                key={tier.key}
                data-testid={`pricing-tier-${tier.key}`}
                className={`relative bg-surface rounded-2xl border p-8 transition-all duration-300 hover:-translate-y-1 hover:shadow-xl group ${
                  tier.popular
                    ? 'border-primary ring-2 ring-primary/20 shadow-lg shadow-primary/10'
                    : 'border-border/50 hover:border-primary/30 hover:shadow-primary/5'
                }`}
              >
                {tier.popular && (
                  <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                    <span className="inline-flex items-center gap-1.5 bg-primary text-white text-xs font-semibold px-4 py-1.5 rounded-full shadow-sm">
                      <Star className="h-3 w-3 fill-current" />
                      {t('pricing.tier_card.most_popular')}
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between gap-2 mb-1">
                  <h3 className="font-display text-xl font-bold text-text-primary">{tier.name}</h3>
                  {isAnnual && (
                    <span
                      data-testid={`pricing-tier-${tier.key}-save-badge`}
                      aria-label={t('pricing.tier_card.save_badge_aria', { percent: Math.round(ANNUAL_DISCOUNT * 100) })}
                      className="inline-flex items-center text-[11px] font-semibold font-body bg-success/10 text-success px-2 py-0.5 rounded-full uppercase tracking-wide"
                    >
                      {t('pricing.tier_card.save_badge', { percent: Math.round(ANNUAL_DISCOUNT * 100) })}
                    </span>
                  )}
                </div>
                <p className="text-sm text-text-primary/50 font-body mb-5">{tier.desc}</p>
                <div className="mb-2">
                  {isAnnual && (
                    <div className="text-xs text-text-primary/40 font-body line-through" data-testid={`pricing-tier-${tier.key}-monthly-price`}>
                      {formatDollars(monthlyPrice, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}{t('pricing.tier_card.per_month')}
                    </div>
                  )}
                  <span
                    data-testid={`pricing-tier-${tier.key}-price`}
                    className="font-display text-5xl font-bold text-text-primary"
                  >
                    {formatDollars(displayedPrice, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                  </span>
                  <span className="text-sm text-text-primary/50 font-body">{t('pricing.tier_card.per_month')}</span>
                </div>
                {isAnnual && (
                  <div
                    data-testid={`pricing-tier-${tier.key}-save-amount`}
                    aria-label={t('pricing.tier_card.save_amount_aria', { amount: annualSavingsFormatted })}
                    className="text-xs text-success font-body font-semibold mb-1"
                  >
                    {t('pricing.tier_card.save_amount', { amount: annualSavingsFormatted })}
                  </div>
                )}
                <div
                  data-testid={`pricing-tier-${tier.key}-billing-label`}
                  className="text-xs text-text-primary/50 font-body mb-3"
                >
                  {isAnnual
                    ? t('pricing.tier_card.billed_annually')
                    : t('pricing.tier_card.billed_monthly')}
                </div>
                <div className="flex flex-col gap-1 mb-6">
                  <span className="text-xs text-primary font-semibold font-body">{tier.minutes}</span>
                  <span className="text-xs text-text-primary/40 font-body">{tier.overage}</span>
                </div>
                <Link
                  to={signupHref}
                  data-testid={`pricing-tier-${tier.key}-cta`}
                  className={`block text-center font-semibold py-3.5 px-4 rounded-lg text-sm transition-colors duration-[var(--motion-base)] min-h-[44px] ${
                    tier.popular
                      ? 'btn-primary-glow bg-primary hover:bg-primary-hover text-on-primary'
                      : 'bg-surface-hover hover:bg-primary text-text-primary hover:text-on-primary'
                  }`}
                  onClick={() => trackCTAClick(CTA.START_FREE_TRIAL, 'pricing_card', `${tier.key}_${billingPeriod}`)}
                >
                  {t('pricing.tier_card.start_trial')}
                  <ArrowRight className="h-4 w-4 inline-block ml-2" />
                </Link>
              </div>
              );
            })}
            </div>
          </div>
          </RevealSection>

          <RevealSection>
          <div className="max-w-5xl mx-auto mb-20">
            <div className="text-center mb-8">
              <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-3">
                {t('pricing.calculator.eyebrow')}
              </p>
              <h2 className="font-display text-2xl font-bold text-text-primary mb-3">
                {t('pricing.calculator.title')}
              </h2>
              <p className="text-text-primary/60 font-body max-w-2xl mx-auto">
                {t('pricing.calculator.subtitle')}
              </p>
            </div>
            {customRateDelta && (
              <CustomRateCallout delta={customRateDelta} t={t} />
            )}
            <MinutesPricingCalculator
              billingPeriod={billingPeriod}
              onBillingPeriodChange={setBillingPeriod}
              currentPlanOverride={currentPlanOverride}
            />
          </div>
          </RevealSection>

          <RevealSection>
          <div className="max-w-5xl mx-auto">
            <h2 className="font-display text-2xl font-bold text-text-primary mb-8 text-center">
              {t('pricing.compare.title')}
            </h2>
            <div className="bg-surface rounded-2xl border border-border/50 overflow-hidden shadow-sm">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border/30 bg-surface-secondary/50">
                      <th className="text-left py-4 px-6 font-display text-sm font-semibold text-text-primary">
                        {t('pricing.compare.feature_col')}
                      </th>
                      {tiers.map((tier) => (
                        <th key={tier.key} className="text-center py-4 px-4 font-display text-sm font-semibold text-text-primary w-36">
                          <span className={tier.popular ? 'text-primary' : ''}>{tier.name}</span>
                          {tier.popular && (
                            <span className="block text-[10px] text-primary font-medium mt-0.5">
                              {t('pricing.tier_card.recommended')}
                            </span>
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {features.map((f, i) => (
                      <tr
                        key={f.nameKey}
                        className={`transition-colors hover:bg-primary/5 ${i % 2 === 0 ? 'bg-surface-secondary/30' : ''}`}
                      >
                        <td className="py-3.5 px-6 text-sm text-text-primary/70 font-body">
                          {t(`pricing.features_list.${f.nameKey}`)}
                        </td>
                        <td className="py-3.5 px-4 text-center"><FeatureCell value={f.starter} /></td>
                        <td className={`py-3.5 px-4 text-center ${tiers[1].popular ? 'bg-primary/[0.02]' : ''}`}>
                          <FeatureCell value={f.pro} />
                        </td>
                        <td className="py-3.5 px-4 text-center"><FeatureCell value={f.enterprise} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          </RevealSection>
        </div>
      </section>

      <section className="bg-surface py-12 border-t border-border/30">
        <div className="max-w-5xl mx-auto px-6 lg:px-8">
          <p className="text-center text-xs font-semibold text-text-primary/40 uppercase tracking-wider mb-6">
            {t('pricing.compliance.eyebrow')}
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            {complianceBadges.map((badge) => (
              <Link
                key={badge}
                to="/security"
                className="inline-flex items-center gap-1.5 text-xs font-medium text-text-primary bg-surface-secondary hover:bg-primary/10 border border-border/40 hover:border-primary/30 rounded-full px-3 py-1.5 transition-colors"
              >
                <ShieldCheck className="h-3.5 w-3.5 text-primary" /> {badge}
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="bg-surface-secondary py-20 lg:py-28">
        <div className="max-w-3xl mx-auto px-6 lg:px-8">
          <div className="text-center mb-12">
            <p className="text-primary font-display text-sm font-semibold tracking-wide uppercase mb-3">
              {t('pricing.faq.eyebrow')}
            </p>
            <h2 className="font-display text-3xl font-bold text-text-primary mb-4">
              {t('pricing.faq.title')}
            </h2>
            <p className="text-text-primary/60 font-body leading-relaxed">
              {t('pricing.faq.subtitle')}
            </p>
          </div>
          <div className="bg-surface rounded-2xl border border-border/30 px-6 lg:px-8 shadow-sm">
            {faqs.map((faq, i) => (
              <FAQItem key={faq.q} q={faq.q} a={faq.a} id={String(i)} />
            ))}
          </div>
        </div>
      </section>

      <section className="bg-surface-secondary py-16">
        <div className="max-w-7xl mx-auto px-6 lg:px-8">
          <div className="text-center mb-12">
            <h2 className="font-display text-2xl font-bold text-text-primary mb-3">{t('pricing.roi.title')}</h2>
            <p className="text-slate-600">{t('pricing.roi.subtitle')}</p>
          </div>
          <ROICalculator />
        </div>
      </section>

      <section className="bg-surface py-14 border-t border-border/20">
        <div className="max-w-6xl mx-auto px-6 lg:px-8">
          <LogosStrip title={t('pricing.logos.title')} />
        </div>
      </section>

      <section className="bg-sidebar-bg text-white py-16">
        <div className="max-w-3xl mx-auto px-6 lg:px-8 text-center">
          <h2 className="font-display text-2xl font-bold mb-4">
            {t('pricing.bottom_cta.title')}
          </h2>
          <p className="text-white/60 font-body mb-8">
            {t('pricing.bottom_cta.subtitle')}
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              to="/book-demo"
              className="btn-primary-glow inline-flex items-center justify-center gap-2 bg-primary hover:bg-primary-hover text-on-primary font-semibold px-6 py-3 rounded-lg text-sm transition-colors duration-[var(--motion-base)] min-h-[44px]"
              onClick={() => trackCTAClick(CTA.BOOK_DEMO, 'pricing_bottom')}
            >
              {t('common.book_a_demo')}
              <ArrowRight className="h-4 w-4" />
            </Link>
            <Link
              to="/signup"
              className="inline-flex items-center justify-center gap-2 bg-white/10 dark:bg-white/10 hover:bg-white/15 dark:hover:bg-white/15 text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors duration-[var(--motion-base)] border border-white/15 dark:border-white/15 hover:border-white/25 dark:hover:border-white/25 min-h-[44px]"
              onClick={() => trackCTAClick(CTA.START_FREE_TRIAL, 'pricing_bottom')}
            >
              {t('common.start_free_trial')}
            </Link>
            <Link
              to="/contact"
              className="inline-flex items-center justify-center gap-2 text-white/80 hover:text-white font-semibold px-6 py-3 rounded-lg text-sm transition-colors"
              onClick={() => trackCTAClick(CTA.CONTACT_SALES, 'pricing_bottom')}
            >
              {t('common.contact_sales')}
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
