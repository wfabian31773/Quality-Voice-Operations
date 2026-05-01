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
  CATALOG_SMS_RATE_PER_MESSAGE,
  PLAN_CATALOG,
  PLAN_TIERS,
  centsToWholeDollars,
  getAnnualMonthlyPriceCents,
  getDiscountedAnnualMonthlyDollars,
  getPlanMonthlyPriceWholeDollars,
  type PlanTier,
} from '../../../../shared/billing/planCatalog';
import { formatDollars, dollarsToCents } from '../../lib/formatCurrency';
import {
  DEFAULT_DISPLAY_CURRENCY,
  formatPublicPrice,
  isApproximateCurrency,
  useDisplayCurrency,
} from '../../lib/displayCurrency';
import DisplayCurrencyPicker from '../../components/DisplayCurrencyPicker';
import { useAuth } from '../../lib/auth';
import { api } from '../../lib/api';
import {
  readBillingPeriodPreference,
  writeBillingPeriodPreference,
  subscribeBillingPeriodPreference,
} from '../../lib/billingPeriodPreference';

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
  // Per-minute Twilio (carrier) rate (in dollars) and its provenance,
  // added in #1356 so the public pricing calculator can surface a
  // tenant's negotiated Twilio carrier rate alongside the AI and SMS
  // rates — same field the in-app Billing screen now reads. Optional
  // for backward compat with older API responses; the calculator
  // hides the Twilio line when neither field is present.
  twilioRatePerMinute?: number;
  twilioPriceSource?: 'stripe' | 'catalog';
  // Active customer-level discount (a Stripe coupon or promotion-code
  // redemption attached to the tenant's customer record) added in
  // #1324 so the public pricing page can render the post-discount
  // monthly/annual base alongside the published rate. Optional for
  // backward compat with older API responses; treated as no-discount
  // when absent or `null`.
  discount?: EffectiveRateDiscount | null;
}

/**
 * Customer-level discount as surfaced by `/billing/effective-rate`.
 * Mirrors the server-side `UpgradeDiscount` shape so the FE can apply
 * the same post-discount math. `percentOff` is in [0, 100];
 * `amountOffCents` is in the smallest currency unit. Both are mutually
 * exclusive on a single Stripe coupon — `percentOff` wins when both
 * happen to be present (mirrors the server's `applyDiscountToBaseCents`).
 */
export interface EffectiveRateDiscount {
  couponId: string | null;
  name: string | null;
  percentOff: number | null;
  amountOffCents: number | null;
  currency: string | null;
  promotionCode: string | null;
  promotionCodeId: string | null;
}

/**
 * Apply a Stripe customer-level discount to a base price expressed in
 * cents. Mirrors the server-side `applyDiscountToBaseCents` logic so
 * the public pricing page's discounted-price preview lines up with what
 * Stripe will actually invoice. `percent_off` wins over `amount_off`
 * when both are present (Stripe treats them as mutually exclusive on a
 * single coupon, but defensive code is cheap). Returns the post-discount
 * price clamped to >= 0.
 *
 * IMPORTANT: `baseCents` must be the full per-invoice amount (i.e. the
 * monthly invoice for monthly subs, the annual invoice for annual subs)
 * — Stripe's `amount_off` reduces a single invoice by `amount_off`
 * regardless of cadence, so a monthly-equivalent figure on an annual
 * sub would over-discount by ~12×. Use `applyDiscountToMonthlyDisplayCents`
 * when you want to show the post-discount price as a "/month" figure.
 */
export function applyDiscountCents(
  baseCents: number,
  discount: EffectiveRateDiscount | null | undefined,
): number {
  if (!discount) return baseCents;
  if (discount.percentOff != null && Number.isFinite(discount.percentOff)) {
    const factor = Math.max(0, Math.min(100, discount.percentOff)) / 100;
    return Math.max(0, Math.round(baseCents * (1 - factor)));
  }
  if (discount.amountOffCents != null && Number.isFinite(discount.amountOffCents)) {
    return Math.max(0, baseCents - discount.amountOffCents);
  }
  return baseCents;
}

/**
 * Apply a discount to a monthly-equivalent display price, accounting
 * for the actual invoice cadence. `monthlyEquivCents` is the "/month"
 * figure shown on the tier card (annual subs already divide their
 * yearly invoice by 12 for display); `monthsPerInvoice` is 1 for
 * monthly subs and 12 for annual subs. The function scales up to the
 * per-invoice amount, applies the discount once (matching how Stripe
 * will reduce the invoice), then scales back down to a /month figure
 * so the strikethrough/displayed prices stay in the same units.
 *
 * For `percent_off` coupons the math is identical for both cadences
 * (a percentage scales linearly), but for `amount_off` coupons the
 * scale-up step is critical: a $50 amount_off on an annual sub
 * reduces the YEAR's invoice by $50, which is ~$4.17/mo — not $50/mo.
 */
export function applyDiscountToMonthlyDisplayCents(
  monthlyEquivCents: number,
  discount: EffectiveRateDiscount | null | undefined,
  monthsPerInvoice: number,
): number {
  if (!discount) return monthlyEquivCents;
  const safeMonths = Math.max(1, Math.round(monthsPerInvoice));
  const perInvoiceCents = monthlyEquivCents * safeMonths;
  const discountedInvoiceCents = applyDiscountCents(perInvoiceCents, discount);
  return Math.max(0, Math.round(discountedInvoiceCents / safeMonths));
}

/**
 * Human-readable "25% off" / "$50 off" label for a discount, used in
 * the discount badge above the tier cards. Returns `null` when the
 * discount carries no usable savings (defence against a malformed
 * payload — the server already filters those out via `normalizeDiscount`).
 */
export function formatDiscountLabel(
  discount: EffectiveRateDiscount | null | undefined,
): string | null {
  if (!discount) return null;
  if (discount.percentOff != null && Number.isFinite(discount.percentOff)) {
    const pct = Math.max(0, Math.min(100, discount.percentOff));
    const rounded = Number.isInteger(pct) ? pct : Math.round(pct * 10) / 10;
    return `${rounded}% off`;
  }
  if (discount.amountOffCents != null && Number.isFinite(discount.amountOffCents)) {
    // eslint-disable-next-line local/no-cents-divided-by-100 -- cents→dollars conversion for display label.
    const dollars = Math.max(0, discount.amountOffCents) / 100;
    return `${formatDollars(dollars, { minimumFractionDigits: 0, maximumFractionDigits: 2 })} off`;
  }
  return null;
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

/**
 * Per-message SMS divergence summary for the custom-rate callout
 * (task #1327). Mirrors `CustomRateOverageDelta` shape so the renderer
 * can treat the SMS line and the overage line uniformly. SMS pricing is
 * tenant-wide rather than per-tier, so the catalog reference comes from
 * `CATALOG_SMS_RATE_PER_MESSAGE` (not `PLAN_CATALOG`).
 */
export interface CustomRateSmsDelta {
  /** Tenant's actual Stripe-invoiced SMS rate, in dollars/message. */
  currentRatePerMessage: number;
  /** Catalog (published) SMS rate, dollars/message. */
  catalogRatePerMessage: number;
  /** Absolute difference between catalog and tenant rate, dollars/message. */
  deltaPerMessage: number;
  /** True when the tenant pays *less* per message than the published rate. */
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
  /**
   * Populated only when `smsPriceSource === 'stripe'` AND the tenant's
   * per-message rate diverges from `CATALOG_SMS_RATE_PER_MESSAGE` by at
   * least `SMS_RENDER_THRESHOLD_PER_MSG`. Absent otherwise. Mirrors
   * the `overage` field's treatment so a tenant with any of base,
   * overage, or SMS negotiated sees the full picture in one banner
   * (task #1327).
   */
  sms?: CustomRateSmsDelta;
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

// Half-tenth-of-a-cent-per-message threshold for the SMS line. The
// catalog SMS rate is quoted in whole cents ($0.01/msg) and negotiated
// rates routinely run sub-cent (e.g. $0.0075/msg, $0.012/msg) — so the
// $0.005/min threshold used for overage would be far too coarse here.
// $0.0005/msg sits at the same fractional position relative to the
// catalog reference (half of one significant unit of the published rate)
// and is well above the four-decimal `formatPerMessageRate` rendering
// granularity, so anything below it is rounding noise we don't want to
// surface as a "you pay $0.0000/msg less than $0.0100" sentence.
const SMS_RENDER_THRESHOLD_PER_MSG = 0.0005;

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

  // SMS delta is computed independently of base/overage. Same source-
  // gated logic as overage: only when Stripe actually sourced the SMS
  // rate do we trust the divergence as a real negotiated rate rather
  // than catalog-vs-catalog noise. The catalog reference here is the
  // shared `CATALOG_SMS_RATE_PER_MESSAGE` constant — SMS pricing is
  // tenant-wide rather than per-tier, so there's no per-tier catalog
  // figure to fall back to.
  let sms: CustomRateSmsDelta | undefined;
  if (payload.smsPriceSource === 'stripe') {
    const tenantRate = Number.isFinite(payload.smsRatePerMessage)
      ? (payload.smsRatePerMessage as number)
      : CATALOG_SMS_RATE_PER_MESSAGE;
    if (tenantRate >= 0) {
      const catalogRate = CATALOG_SMS_RATE_PER_MESSAGE;
      const smsDelta = catalogRate - tenantRate;
      if (Math.abs(smsDelta) >= SMS_RENDER_THRESHOLD_PER_MSG) {
        sms = {
          currentRatePerMessage: tenantRate,
          catalogRatePerMessage: catalogRate,
          deltaPerMessage: Math.abs(smsDelta),
          isLess: smsDelta > 0,
        };
      }
    }
  }

  // Suppress entirely when none of base, overage, or SMS carries a
  // meaningful delta — an isStripeSourced payload can still match
  // catalog exactly (tenant on the published rate via a Stripe-managed
  // sub) and we don't want to mount a banner with nothing to say.
  if (!baseMeaningful && !overage && !sms) return null;

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
    ...(sms ? { sms } : {}),
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
    // Twilio counts as a Stripe-sourced signal too (task #1356): a
    // tenant on a negotiated Twilio carrier rate (with catalog AI/SMS
    // rates) still deserves to see their rate surfaced on the
    // calculator's Twilio row, mirroring the SMS gating above.
    && payload.twilioPriceSource !== 'stripe'
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
    // Twilio carrier rate is tenant-wide and interval-agnostic too,
    // so it flows through verbatim alongside the SMS fields. Missing
    // values are normalised to `null` so the calculator's render
    // gate (keyed on the numeric value being present) suppresses the
    // row for older API responses that don't yet carry the field.
    twilioRatePerMinute: payload.twilioRatePerMinute ?? null,
    twilioPriceSource: payload.twilioPriceSource ?? null,
  };
}

function formatOverageRate(ratePerMinute: number): string {
  return `${formatDollars(ratePerMinute)}/min`;
}

function formatPlanMonthlyPrice(
  tier: 'starter' | 'pro' | 'enterprise',
  currency: string = DEFAULT_DISPLAY_CURRENCY,
): string {
  const usd = getPlanMonthlyPriceWholeDollars(tier);
  if (currency === DEFAULT_DISPLAY_CURRENCY) {
    return formatDollars(usd, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
  return formatPublicPrice(usd, currency, { fractionDigits: 0 });
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

// Per-message rates run sub-cent (e.g. $0.0075/msg vs catalog $0.01/msg),
// so we widen the band to four fraction digits — matching
// `MinutesPricingCalculator.formatPerMessage` so the callout and the
// calculator quote the negotiated rate identically rather than drifting
// at the third decimal.
function formatPerMessageRate(rate: number): string {
  return `${formatDollars(rate, {
    minimumFractionDigits: 4,
    maximumFractionDigits: 4,
  })}/msg`;
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
  // when overage or SMS diverges, so we skip the base sentence entirely
  // and let the overage / SMS line(s) stand on their own.
  const baseMeaningful = delta.deltaDollars > 0;
  const overage = delta.overage;
  const sms = delta.sms;

  const overageInterp = overage
    ? {
        tierName: delta.tierName,
        currentRate: formatPerMinuteRate(overage.currentRatePerMinute),
        catalogRate: formatPerMinuteRate(overage.catalogRatePerMinute),
        deltaRate: formatPerMinuteRate(overage.deltaPerMinute),
      }
    : null;

  const smsInterp = sms
    ? {
        currentRate: formatPerMessageRate(sms.currentRatePerMessage),
        catalogRate: formatPerMessageRate(sms.catalogRatePerMessage),
        deltaRate: formatPerMessageRate(sms.deltaPerMessage),
      }
    : null;

  // Title and tone are anchored on whichever delta is the headline:
  // base when present, otherwise overage when present, otherwise the
  // SMS-only variant. Mixed directions (e.g. base less, overage more)
  // keep the base headline — each line below states its own direction
  // explicitly so the banner still reads correctly when base, overage,
  // and SMS are simultaneously custom (task #1327).
  let headlineIsLess: boolean;
  if (baseMeaningful) headlineIsLess = delta.isLess;
  else if (overage) headlineIsLess = overage.isLess;
  else headlineIsLess = sms!.isLess;

  let titleKey: string;
  if (baseMeaningful) {
    titleKey = delta.isLess
      ? 'pricing.override_callout.title_less'
      : 'pricing.override_callout.title_more';
  } else if (overage) {
    titleKey = overage.isLess
      ? 'pricing.override_callout.title_overage_less'
      : 'pricing.override_callout.title_overage_more';
  } else {
    titleKey = sms!.isLess
      ? 'pricing.override_callout.title_sms_less'
      : 'pricing.override_callout.title_sms_more';
  }
  const baseDescriptionKey = delta.isLess
    ? 'pricing.override_callout.description_less'
    : 'pricing.override_callout.description_more';
  const overageLineKey = overage?.isLess
    ? 'pricing.override_callout.overage_line_less'
    : 'pricing.override_callout.overage_line_more';
  const smsLineKey = sms?.isLess
    ? 'pricing.override_callout.sms_line_less'
    : 'pricing.override_callout.sms_line_more';

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

  // Whether the SMS line needs top spacing depends on whether ANY line
  // already rendered above it (base sentence or overage sentence) —
  // matches the same `mt-1.5` vs `mt-1` rhythm overage uses.
  const smsHasPrior = baseMeaningful || !!overage;

  return (
    <div
      data-testid="pricing-override-callout"
      data-direction={headlineIsLess ? 'less' : 'more'}
      data-frame="monthly"
      data-has-base={baseMeaningful ? 'true' : 'false'}
      data-has-overage={overage ? 'true' : 'false'}
      data-has-sms={sms ? 'true' : 'false'}
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
        {sms && smsInterp && (
          <p
            data-testid="pricing-override-callout-sms"
            className={`text-sm font-body text-text-primary/80 ${smsHasPrior ? 'mt-1.5' : 'mt-1'}`}
          >
            {t(smsLineKey, smsInterp)}
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
  const [displayCurrency] = useDisplayCurrency();
  const isApprox = isApproximateCurrency(displayCurrency);
  const formatPriceForCurrency = (usd: number) => {
    if (displayCurrency === DEFAULT_DISPLAY_CURRENCY) {
      return formatDollars(usd, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
    }
    return formatPublicPrice(usd, displayCurrency, { fractionDigits: 0 });
  };
  const { t } = useTranslation('marketing');
  const [billingPeriod, setBillingPeriodState] = useState<BillingPeriod>(
    () => readBillingPeriodPreference() ?? 'monthly',
  );
  const setBillingPeriod = (next: BillingPeriod) => {
    setBillingPeriodState(next);
    // Broadcast so other marketing surfaces (chat widget recommendation
    // card) honor the same choice without a page refresh.
    writeBillingPeriodPreference(next);
  };
  // Reflect changes that happen elsewhere (e.g. the chat widget's
  // per-card toggle, or another tab/window) so the page stays in sync.
  useEffect(() => {
    return subscribeBillingPeriodPreference((next) => {
      setBillingPeriodState((current) => (current === next ? current : next));
    });
  }, []);
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
        acceptedAnswer: {
          '@type': 'Answer',
          text: `QVO offers three plans: Starter at ${formatPlanMonthlyPrice('starter', displayCurrency)}/month, Pro at ${formatPlanMonthlyPrice('pro', displayCurrency)}/month, and Enterprise at ${formatPlanMonthlyPrice('enterprise', displayCurrency)}/month. All plans include a 14-day free trial.${isApprox ? ` Prices in ${displayCurrency} are approximate; final billing happens in your selected billing currency.` : ''}`,
        },
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
        description={t('pricing.seo_description', { starter: formatPlanMonthlyPrice('starter', displayCurrency) })}
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
            <div className="flex flex-wrap items-center justify-center gap-4 mb-8">
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
              <DisplayCurrencyPicker testId="pricing-display-currency" ariaLabel="Display prices in" />
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
              const annualSavingsFormatted = formatPriceForCurrency(annualSavingsDollars);
              const signupHref = `/signup?plan=${tier.key}${isAnnual ? '&interval=annual' : ''}`;
              // Apply the active customer-level discount (if any) so the
              // card surfaces the post-coupon price the tenant will
              // actually be invoiced. We work in cents (matching what
              // Stripe will charge) and convert back to whole dollars
              // for display via the existing `formatPriceForCurrency`.
              // Pure UI projection — `displayedPrice` itself is left
              // untouched so the calculator and signup CTA continue to
              // point at the published rate.
              const tierDiscount = effectiveRatePayload?.discount ?? null;
              const discountLabel = formatDiscountLabel(tierDiscount);
              // Annual cards show a monthly-equivalent figure but a Stripe
              // `amount_off` coupon reduces the WHOLE annual invoice by
              // `amount_off`, not each month. `applyDiscountToMonthlyDisplayCents`
              // scales up to the invoice cadence before applying the
              // discount and scales back to /month so the strikethrough
              // pair stays in the same units we display elsewhere on the
              // card. (Percent-off scales linearly so this is a no-op
              // for those coupons.)
              const monthsPerInvoice = isAnnual ? 12 : 1;
              const discountedCents = tierDiscount
                ? applyDiscountToMonthlyDisplayCents(
                    dollarsToCents(displayedPrice),
                    tierDiscount,
                    monthsPerInvoice,
                  )
                : dollarsToCents(displayedPrice);
              // eslint-disable-next-line local/no-cents-divided-by-100 -- post-discount cents → display dollars; staying in cents for the strikethrough comparison below.
              const discountedPriceDollars = discountedCents / 100;
              const hasVisibleDiscount =
                tierDiscount != null
                && discountLabel != null
                && discountedCents < dollarsToCents(displayedPrice);
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
                      {formatPriceForCurrency(monthlyPrice)}{t('pricing.tier_card.per_month')}
                    </div>
                  )}
                  {hasVisibleDiscount && (
                    <div
                      className="text-xs text-text-primary/40 font-body line-through"
                      data-testid={`pricing-tier-${tier.key}-pre-discount-price`}
                    >
                      {isApprox && '≈ '}{formatPriceForCurrency(displayedPrice)}{t('pricing.tier_card.per_month')}
                    </div>
                  )}
                  <span
                    data-testid={`pricing-tier-${tier.key}-price`}
                    data-display-currency={displayCurrency}
                    data-discount-applied={hasVisibleDiscount ? 'true' : 'false'}
                    className="font-display text-5xl font-bold text-text-primary"
                  >
                    {isApprox && '≈ '}{formatPriceForCurrency(hasVisibleDiscount ? discountedPriceDollars : displayedPrice)}
                  </span>
                  <span className="text-sm text-text-primary/50 font-body">{t('pricing.tier_card.per_month')}</span>
                </div>
                {hasVisibleDiscount && discountLabel && (
                  <div
                    data-testid={`pricing-tier-${tier.key}-discount-badge`}
                    aria-label={t('pricing.tier_card.discount_badge_aria', { label: discountLabel })}
                    className="inline-flex items-center text-[11px] font-semibold font-body bg-primary/10 text-primary px-2 py-0.5 rounded-full uppercase tracking-wide mb-1"
                  >
                    {t('pricing.tier_card.discount_badge', { label: discountLabel })}
                    {tierDiscount?.promotionCode && (
                      <span className="ml-1.5 normal-case font-normal text-text-primary/60">
                        · {t('pricing.tier_card.discount_promo_code', { code: tierDiscount.promotionCode })}
                      </span>
                    )}
                  </div>
                )}
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
              displayCurrency={displayCurrency}
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
            <p className="text-text-secondary">{t('pricing.roi.subtitle')}</p>
          </div>
          <ROICalculator displayCurrency={displayCurrency} />
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
