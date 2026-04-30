import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Calculator,
  ArrowUpRight,
  ArrowDownRight,
  Sparkles,
  TrendingUp,
  AlertTriangle,
  Lightbulb,
  CheckCircle2,
  Loader2,
} from 'lucide-react';
import {
  PLAN_CATALOG,
  PLAN_TIERS,
  centsToWholeDollars,
  getPlanMonthlyPriceWholeDollars,
  type PlanTier,
} from '../../../shared/billing/planCatalog';
import {
  averageTrailingMinutes,
  recommendCheapestPlan,
  type PlanRateOverride,
} from '../../../shared/billing/planRecommendation';
import {
  calculateMonthlyCost,
  calculateEffectiveRate,
  ANNUAL_DISCOUNT,
  type BillingPeriod,
} from './MinutesPricingCalculator';
import { formatDollars } from '../lib/formatCurrency';

/**
 * Live override of the catalog rates, sourced from the tenant's actual
 * Stripe subscription (`/billing/effective-rate`). When provided, these
 * values take precedence over the static `PLAN_CATALOG` for the *current*
 * tier so the estimate matches what Stripe will actually invoice for a
 * tenant on a custom / negotiated / grandfathered price.
 *
 * The same shape is also used for the comparison-tier card via
 * `upgradePreview` — there it carries the tenant-specific quote returned
 * by `/billing/upgrade-preview` (i.e. catalog list price minus any active
 * customer-level coupon/promotion code). When that prop is omitted the
 * comparison card falls back to the published catalog rate, matching the
 * pre-upgrade-preview behaviour.
 */
export interface BillingEstimatorRateOverride {
  /** Effective monthly base price, in cents. */
  basePriceCents?: number | null;
  /** Effective per-minute overage rate, in dollars (e.g. 0.12 = $0.12/min). */
  overageRatePerMinute?: number | null;
}

/**
 * Customer-level discount (coupon or promotion-code redemption) returned by
 * `/billing/upgrade-preview`. This is what *explains* a comparison-tier
 * quote that came in below the published catalog price — Sales attaches a
 * coupon to the tenant's Stripe customer record and the upgrade preview
 * applies it on top of the catalog base.
 *
 * Field semantics mirror Stripe's `Coupon` shape:
 *   - `percentOff` is a 0–100 number when set (mutually exclusive with
 *     `amountOffCents`).
 *   - `amountOffCents` is in the smallest currency unit (e.g. cents).
 *   - `promotionCode` is the human-readable code Sales/Support shares with
 *     the tenant; absent when the discount was attached as a raw coupon
 *     without a published promotion code.
 */
export interface BillingEstimatorDiscount {
  name?: string | null;
  percentOff?: number | null;
  amountOffCents?: number | null;
  currency?: string | null;
  promotionCode?: string | null;
}

/**
 * Comparison-tier override carrying both the post-discount rate AND the
 * discount metadata that explains why it differs from the published
 * catalog. Extends `BillingEstimatorRateOverride` so the upgrade-preview
 * call site stays a drop-in replacement for the previous rate-only shape.
 */
export interface BillingEstimatorUpgradePreview extends BillingEstimatorRateOverride {
  discount?: BillingEstimatorDiscount | null;
}

interface BillingEstimatorProps {
  currentPlan: PlanTier | string;
  monthToDateAiMinutes: number;
  /**
   * Optional Stripe-sourced rate override for the current tier. Falls back
   * to the catalog when omitted or when individual fields are nullish, so
   * the component still renders correctly during the loading window before
   * the API responds.
   */
  rateOverride?: BillingEstimatorRateOverride;
  /**
   * Tenant-specific upgrade quote for the comparison card. When the
   * comparison direction is "up" (i.e. the next-tier-up card is showing)
   * this override replaces the catalog list price so the card reflects any
   * customer-level coupon, promotion code, or sales-attached discount the
   * tenant would actually be billed at after upgrading. Ignored when the
   * comparison direction is "down" (downgrade card) since downgrade
   * pricing is just the published catalog floor.
   */
  upgradePreview?: BillingEstimatorUpgradePreview;
  /**
   * Multiplier used to project end-of-month minutes from MTD usage.
   * Computed by the parent as `daysInMonth / dayOfMonth`.
   */
  projectionMultiplier?: number;
  /**
   * Tenant's billing currency code (e.g. "USD", "EUR", "GBP"). When
   * provided, all rendered base prices, overage costs, and per-minute
   * rates are formatted in that currency. Defaults to USD so existing
   * call sites that don't yet plumb the tenant currency keep rendering.
   */
  currency?: string;
  /**
   * Trailing complete-month AI-minute totals (newest-first or any order)
   * used to drive the "cheapest plan" recommendation banner. When omitted
   * or empty the recommendation card is hidden — we don't want to nudge
   * a tenant toward a plan change based on a single MTD data point.
   */
  trailingMonthlyAiMinutes?: ReadonlyArray<number>;
  /**
   * Per-month breakdown that powers the inline sparkline/bar chart inside
   * the recommendation card. Each entry carries an ISO month tag (e.g.
   * `"2025-03"`) plus that month's AI-minute total. The backend's
   * `/billing/usage/trailing` endpoint returns this series newest-first;
   * the chart re-orders it chronologically (oldest → newest, left → right)
   * so the eye reads the trend the same way it reads time.
   *
   * Optional and decoupled from `trailingMonthlyAiMinutes` so existing
   * call sites that only supply the flat number array (and the
   * recommendation math that depends on it) keep working unchanged. When
   * this prop is omitted the recommendation card still renders the
   * headline copy, just without the visual trend.
   */
  trailingMonthlyBreakdown?: ReadonlyArray<{ month: string; aiMinutes: number }>;
  /**
   * Prior-year companion to `trailingMonthlyBreakdown`, aligned 1:1.
   * `aiMinutes: null` means no prior-year data for that month and
   * suppresses the overlay + YoY tooltip for that slot.
   */
  trailingMonthlyPriorYearBreakdown?: ReadonlyArray<{
    month: string;
    aiMinutes: number | null;
  }>;
  /**
   * Invoked when the tenant clicks the recommendation banner's
   * "Switch to <Plan>" CTA. The parent kicks off a Stripe Checkout flow
   * for the recommended tier on the chosen billing interval. The
   * interval is selected via a small monthly/annual toggle inside the
   * recommendation card and defaults to monthly so the headline savings
   * copy lines up with the recommendation arithmetic. The recommendation
   * snapshot is passed alongside so the parent can stamp it into the
   * Stripe session metadata for server-side attribution.
   * When this callback is omitted the CTA (and the toggle) are hidden —
   * that's how we gate the action for read-only roles without leaking
   * it into the markup.
   */
  onSwitchPlan?: (
    tier: PlanTier,
    interval: BillingPeriod,
    recommendation: RecommendationAttribution,
  ) => void;
  /**
   * Invoked when the banner generates an instrumentation event:
   *   - `impression`: fired once per (currentTier, recommendedTier,
   *     savings) combo per browser tab.
   *   - `click`: fired on every CTA press.
   * Completion is attributed server-side from the Stripe webhook, not
   * via a `switch_completed` callback.
   */
  onRecommendationEvent?: (event: RecommendationEvent) => void;
  /**
   * When set to a tier, the recommendation card renders its CTA in a
   * loading/disabled state for that tier. Wired to the parent's existing
   * `upgradeLoading` state so the slot card and the banner button stay in
   * sync while Stripe Checkout is being created.
   */
  switchingPlan?: PlanTier | null;
  /**
   * Currently selected trailing window (in months) used to fetch
   * `trailingMonthlyAiMinutes`. When provided alongside
   * `onTrailingWindowChange`, the recommendation card renders a small
   * segmented control letting the tenant switch between trailing windows
   * (e.g. 3 / 6 / 12 months). Pure presentation — the actual fetch and
   * persistence live in the parent.
   */
  trailingWindow?: TrailingWindow;
  /**
   * Invoked when the tenant picks a different trailing window from the
   * segmented control inside the recommendation card. Omit (along with
   * `trailingWindow`) to hide the control entirely — that's how this
   * component stays backwards compatible with call sites that don't yet
   * support window switching.
   */
  onTrailingWindowChange?: (months: TrailingWindow) => void;
  /**
   * The set of trailing windows offered in the segmented control. Defaults
   * to `[3, 6, 12]` to match the windows the backend exposes today (and
   * the spec for this component).
   */
  availableTrailingWindows?: ReadonlyArray<TrailingWindow>;
}

/**
 * Trailing window options offered by the recommendation card's segmented
 * control. Capped at 12 because the backend `/billing/usage/trailing`
 * endpoint clamps `months` to the 1..12 range.
 */
export type TrailingWindow = 3 | 6 | 12;
const DEFAULT_TRAILING_WINDOWS: ReadonlyArray<TrailingWindow> = [3, 6, 12];

/**
 * Recommendation snapshot passed both to the analytics callback and to
 * `onSwitchPlan` so the parent can stamp it into Stripe session metadata.
 */
export interface RecommendationAttribution {
  currentTier: PlanTier;
  recommendedTier: PlanTier;
  monthlySavingsCents: number;
  trailingWindowMonths?: TrailingWindow;
}

export interface RecommendationEvent extends RecommendationAttribution {
  type: 'impression' | 'click';
}

interface TierSpec {
  key: PlanTier;
  name: string;
  basePrice: number;
  includedMinutes: number;
  overageRate: number;
  /**
   * Set when this tier's `basePrice` / `overageRate` were sourced from the
   * tenant's live Stripe subscription rather than the catalog defaults.
   */
  sourcedFromStripe?: boolean;
  /**
   * Customer-level discount that explains why this tier's `basePrice` came
   * in below the published catalog rate. Surfaced to the tenant via the
   * discount badge in the comparison card.
   */
  discount?: BillingEstimatorDiscount | null;
}

type ComparisonDirection = 'up' | 'down';

const MIN_MINUTES = 0;
const MAX_MINUTES = 25_000;
const STEP_MINUTES = 50;

function toTierSpec(
  key: PlanTier,
  override?: BillingEstimatorRateOverride | BillingEstimatorUpgradePreview,
): TierSpec {
  const plan = PLAN_CATALOG[key];
  // Coerce the override fields once: anything non-finite or nullish falls
  // back to the catalog so a partial Stripe response can't render NaN.
  const overrideBaseCents =
    override?.basePriceCents != null && Number.isFinite(override.basePriceCents)
      ? override.basePriceCents
      : null;
  const overrideOverage =
    override?.overageRatePerMinute != null
      && Number.isFinite(override.overageRatePerMinute)
      ? override.overageRatePerMinute
      : null;

  const basePrice = overrideBaseCents != null
    ? centsToWholeDollars(overrideBaseCents)
    : getPlanMonthlyPriceWholeDollars(plan.key);
  const overageRate = overrideOverage != null
    ? overrideOverage
    : plan.overageRatePerMinute;

  // Only the upgrade-preview shape carries `discount`; rate-only overrides
  // pass through as `undefined` here, leaving the badge hidden.
  const discount =
    override && 'discount' in override
      ? override.discount ?? null
      : null;

  return {
    key: plan.key,
    name: plan.name,
    basePrice,
    includedMinutes: plan.includedMinutes,
    overageRate,
    sourcedFromStripe: overrideBaseCents != null || overrideOverage != null,
    discount,
  };
}

function normalizePlan(plan: string): PlanTier {
  return (PLAN_TIERS as string[]).includes(plan) ? (plan as PlanTier) : 'starter';
}

function nextTierUp(current: PlanTier): PlanTier | null {
  const idx = PLAN_TIERS.indexOf(current);
  if (idx < 0 || idx >= PLAN_TIERS.length - 1) return null;
  return PLAN_TIERS[idx + 1];
}

function nextTierDown(current: PlanTier): PlanTier | null {
  const idx = PLAN_TIERS.indexOf(current);
  if (idx <= 0) return null;
  return PLAN_TIERS[idx - 1];
}

function makeFormatMoney(currency: string) {
  return (value: number) =>
    formatDollars(value, { currency, minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function makeFormatPerMinute(currency: string) {
  return (value: number) =>
    formatDollars(value, { currency, minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

function clampMinutes(value: number): number {
  if (!Number.isFinite(value)) return MIN_MINUTES;
  return Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, Math.round(value)));
}

/**
 * Format a percent-off value for the discount badge. Stripe stores
 * `percent_off` as a number that's usually integral (`25`, `50`) but can
 * carry a fractional component (`12.5`). We render integers as-is and
 * trim trailing zeros on fractions so the badge stays compact.
 */
function formatPercentOff(percentOff: number): string {
  if (!Number.isFinite(percentOff)) return '';
  if (Number.isInteger(percentOff)) return String(percentOff);
  // Single decimal place is plenty — Stripe's UI uses the same precision.
  return percentOff.toFixed(1).replace(/\.0$/, '');
}

/**
 * Build the badge label + tooltip for a customer-level discount. Returns
 * `null` when the discount carries neither a percent nor an amount off
 * (defensive — the upgrade-preview API already drops these).
 *
 * Label examples:
 *   - `25% off — PROMO25`
 *   - `12.5% off coupon`
 *   - `$50 off — SUMMER`
 *   - `€20 off coupon`
 *
 * The tooltip surfaces the coupon name and (when present) the promotion
 * code so Sales/Support can confirm the exact promo a tenant is asking
 * about without leaving the page.
 */
function buildDiscountBadge(
  discount: BillingEstimatorDiscount,
  formatMoney: (value: number) => string,
): { label: string; tooltip: string } | null {
  let offPart: string | null = null;
  if (discount.percentOff != null && Number.isFinite(discount.percentOff)) {
    offPart = `${formatPercentOff(discount.percentOff)}% off`;
  } else if (
    discount.amountOffCents != null
    && Number.isFinite(discount.amountOffCents)
  ) {
    // amountOffCents is in the smallest currency unit; convert to whole
    // currency for the badge. Prefer the coupon's own currency over the
    // estimator default — Stripe `amount_off` coupons are tied to a
    // specific currency, so a USD coupon shown to a EUR-defaulted card
    // should still render as "$50 off", not "€50 off". Falls back to the
    // estimator's `formatMoney` (i.e. tenant billing currency) when the
    // coupon currency is missing.
    const couponCurrency = discount.currency?.trim().toUpperCase();
    const formatter = couponCurrency
      ? makeFormatMoney(couponCurrency)
      : formatMoney;
    offPart = `${formatter(discount.amountOffCents / 100)} off`;
  }
  if (!offPart) return null;

  const promo = discount.promotionCode?.trim();
  const label = promo ? `${offPart} — ${promo}` : `${offPart} coupon`;

  const couponName = discount.name?.trim();
  const tooltipParts: string[] = [];
  tooltipParts.push(couponName ? `Coupon: ${couponName}` : 'Active discount applied');
  if (promo) tooltipParts.push(`Promotion code: ${promo}`);
  const tooltip = tooltipParts.join(' · ');

  return { label, tooltip };
}

function TierEstimate({
  tier,
  minutes,
  label,
  highlight,
  direction,
  formatMoney,
  formatPerMinute,
}: {
  tier: TierSpec;
  minutes: number;
  label: string;
  highlight?: boolean;
  direction?: ComparisonDirection;
  formatMoney: (value: number) => string;
  formatPerMinute: (value: number) => string;
}) {
  const monthlyCost = calculateMonthlyCost(tier, minutes);
  const overageMinutes = Math.max(0, minutes - tier.includedMinutes);
  const overageCost = overageMinutes * tier.overageRate;
  const effectiveRate = minutes > 0 ? calculateEffectiveRate(tier, minutes) : 0;
  const showDowngradeWarning = direction === 'down' && overageMinutes > 0;

  const badgeClass =
    direction === 'down'
      ? 'text-warning bg-warning/10'
      : 'text-primary bg-primary/10';
  const cardClass = highlight
    ? direction === 'down'
      ? 'border-warning/40 bg-warning/[0.04]'
      : 'border-primary/40 bg-primary/[0.04]'
    : 'border-border bg-surface-hover/40';

  return (
    <div
      data-testid={`billing-estimator-tier-${tier.key}`}
      className={`flex-1 rounded-lg border p-4 transition-colors ${cardClass}`}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
          {label}
        </span>
        {highlight && direction && (
          <span
            className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ${badgeClass}`}
          >
            {direction === 'down' ? (
              <>
                <ArrowDownRight className="h-3 w-3" />
                Potential downgrade
              </>
            ) : (
              <>
                <ArrowUpRight className="h-3 w-3" />
                Next tier
              </>
            )}
          </span>
        )}
      </div>

      <div className="flex items-baseline justify-between mb-3">
        <span className="text-base font-semibold text-text-primary">{tier.name}</span>
        <div className="text-right">
          <div
            data-testid={`billing-estimator-monthly-${tier.key}`}
            className="text-2xl font-bold text-text-primary leading-tight"
          >
            {formatMoney(monthlyCost)}
          </div>
          <div className="text-[11px] text-text-muted">/mo est.</div>
        </div>
      </div>

      {tier.sourcedFromStripe && (
        <div
          data-testid={`billing-estimator-source-${tier.key}`}
          className="mb-3 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-success bg-success/10 px-2 py-0.5 rounded-full"
          title="Pulled from your live Stripe subscription — overrides published catalog rates"
        >
          Live Stripe rate
        </div>
      )}

      {tier.discount && (() => {
        // Mirrors the "Live Stripe rate" pill style for visual consistency
        // (same shape, sizing, uppercase tracking) but uses the primary
        // accent so the discount stands out as a separate signal —
        // tenants need to recognise *why* the upgrade quote is below
        // catalog at a glance.
        const badge = buildDiscountBadge(tier.discount, formatMoney);
        if (!badge) return null;
        return (
          <div
            data-testid={`billing-estimator-discount-${tier.key}`}
            data-discount-label={badge.label}
            className={`mb-3 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-primary bg-primary/10 px-2 py-0.5 rounded-full${
              tier.sourcedFromStripe ? ' ml-2' : ''
            }`}
            title={badge.tooltip}
          >
            {badge.label}
          </div>
        );
      })()}

      <div
        data-testid={`billing-estimator-effective-${tier.key}`}
        className="text-xs text-text-muted mb-3"
      >
        {minutes > 0 ? formatPerMinute(effectiveRate) : '—'} effective per minute
      </div>

      <dl className="space-y-1 text-xs border-t border-border pt-2">
        <div className="flex justify-between">
          <dt className="text-text-muted">Base plan</dt>
          <dd className="text-text-primary font-medium">{formatMoney(tier.basePrice)}/mo</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-text-muted">Minutes included</dt>
          <dd className="text-text-primary font-medium">
            {tier.includedMinutes.toLocaleString()}
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-text-muted">Overage rate</dt>
          <dd className="text-text-primary font-medium">
            {formatPerMinute(tier.overageRate)}/min
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-text-muted">Overage at this volume</dt>
          <dd
            className={`font-medium ${
              overageMinutes > 0 ? 'text-danger' : 'text-success'
            }`}
          >
            {overageMinutes > 0
              ? `${overageMinutes.toLocaleString()} min · ${formatMoney(overageCost)}`
              : 'None'}
          </dd>
        </div>
      </dl>

      {showDowngradeWarning && (
        <div
          data-testid={`billing-estimator-downgrade-warning-${tier.key}`}
          className="mt-3 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/[0.06] px-2.5 py-2 text-[11px] text-warning"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            Projected usage exceeds {tier.name}&rsquo;s {tier.includedMinutes.toLocaleString()}{' '}
            included minutes. Downgrading would push {overageMinutes.toLocaleString()} min into
            overage at {formatPerMinute(tier.overageRate)}/min.
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Format an ISO month tag (`"YYYY-MM"`) as a short, locale-friendly
 * label suitable for the chart tooltip and axis hints. Falls back to
 * the raw input when the tag isn't parseable so we never render
 * "Invalid Date" — defensive, since the backend already validates.
 */
function formatMonthLabel(monthIso: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(monthIso);
  if (!match) return monthIso;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (!Number.isFinite(year) || month < 1 || month > 12) return monthIso;
  // UTC anchor + UTC formatter so the label doesn't drift across
  // timezones (the backend tags months in tenant-anchored UTC already).
  const date = new Date(Date.UTC(year, month - 1, 1));
  try {
    return date.toLocaleDateString('en-US', {
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  } catch {
    return monthIso;
  }
}

function formatYoyDelta(delta: number): string {
  if (!Number.isFinite(delta)) return '0';
  if (delta === 0) return 'flat';
  const sign = delta > 0 ? '+' : '−';
  return `${sign}${Math.abs(delta).toLocaleString()}`;
}

/**
 * Inline bar chart that visualises the trailing monthly AI-minute usage
 * behind the recommendation. Bars are scaled against the largest month
 * in the window so even a flat-but-low series is legible. Zero-usage
 * months render as an empty dashed slot so seasonal lulls stay visible
 * — the recommendation copy already explains the average, this chart
 * is what lets a tenant sanity-check the *shape*.
 *
 * Hovering a bar surfaces "Mon YYYY: N AI min" via the native title
 * tooltip. We deliberately stay native-tooltip-only here to keep the
 * component dependency-free and to match the rest of the estimator's
 * lightweight UI vocabulary.
 */
function TrailingMonthlyChart({
  data,
  priorYearData,
}: {
  data: ReadonlyArray<{ month: string; aiMinutes: number }>;
  priorYearData?: ReadonlyArray<{ month: string; aiMinutes: number | null }>;
}) {
  const ordered = useMemo(() => [...data].reverse(), [data]);
  const orderedPrior = useMemo(
    () => (priorYearData ? [...priorYearData].reverse() : null),
    [priorYearData],
  );
  const maxMinutes = useMemo(() => {
    let max = 0;
    for (const m of ordered) max = Math.max(max, m.aiMinutes);
    if (orderedPrior) {
      for (const m of orderedPrior) {
        if (m.aiMinutes != null) max = Math.max(max, m.aiMinutes);
      }
    }
    return max;
  }, [ordered, orderedPrior]);
  // Mirror the overlay's render condition (priorMinutes > 0) so the
  // legend never points at slots that drew nothing.
  const hasAnyPriorYearData = useMemo(
    () => Boolean(orderedPrior?.some((m) => m.aiMinutes != null && m.aiMinutes > 0)),
    [orderedPrior],
  );

  if (ordered.length === 0) return null;

  const firstLabel = formatMonthLabel(ordered[0].month);
  const lastLabel = formatMonthLabel(ordered[ordered.length - 1].month);

  return (
    <div
      data-testid="billing-estimator-recommendation-chart"
      data-has-prior-year={hasAnyPriorYearData ? 'true' : 'false'}
      className="mt-3 pt-3 border-t border-primary/20"
    >
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">
          AI minutes per month
        </span>
        <span className="text-[10px] text-text-muted">
          peak {maxMinutes.toLocaleString()} min
        </span>
      </div>
      <div
        className="flex items-end gap-1 h-14"
        role="img"
        aria-label={
          hasAnyPriorYearData
            ? `Monthly AI minutes from ${firstLabel} to ${lastLabel} with prior-year comparison`
            : `Monthly AI minutes from ${firstLabel} to ${lastLabel}`
        }
      >
        {ordered.map((entry, i) => {
          const isZero = entry.aiMinutes <= 0;
          const heightPct = isZero
            ? 0
            : maxMinutes > 0
              ? Math.max(6, Math.round((entry.aiMinutes / maxMinutes) * 100))
              : 6;
          const monthLabel = formatMonthLabel(entry.month);

          const prior = orderedPrior?.[i] ?? null;
          const priorMinutes = prior?.aiMinutes ?? null;
          const hasPrior = priorMinutes != null;
          const priorHeightPct = hasPrior && maxMinutes > 0
            ? Math.max(6, Math.round((priorMinutes / maxMinutes) * 100))
            : 0;
          const priorLabel = prior ? formatMonthLabel(prior.month) : '';
          const yoyDelta = hasPrior ? entry.aiMinutes - priorMinutes : null;
          const yoyText = formatYoyDelta(yoyDelta ?? 0);
          const tooltip = hasPrior
            ? `${monthLabel}: ${entry.aiMinutes.toLocaleString()} AI min · YoY ${yoyText}${yoyText === 'flat' ? '' : ' AI min'} vs ${priorLabel} (${priorMinutes.toLocaleString()} AI min)`
            : `${monthLabel}: ${entry.aiMinutes.toLocaleString()} AI min`;
          return (
            <div
              key={entry.month}
              data-testid={`billing-estimator-recommendation-chart-bar-${entry.month}`}
              data-month={entry.month}
              data-ai-minutes={entry.aiMinutes}
              data-zero={isZero ? 'true' : 'false'}
              {...(hasPrior
                ? {
                    'data-prior-month': prior!.month,
                    'data-prior-ai-minutes': String(priorMinutes),
                    'data-yoy-delta': String(yoyDelta),
                  }
                : {})}
              title={tooltip}
              aria-label={tooltip}
              className="group relative flex-1 min-w-[6px] h-full flex items-end"
            >
              {hasPrior && priorMinutes > 0 && (
                <div
                  data-testid={`billing-estimator-recommendation-chart-prior-${entry.month}`}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 bottom-0 rounded-sm border border-dashed border-primary/40 bg-primary/[0.03]"
                  style={{ height: `${priorHeightPct}%` }}
                />
              )}
              {isZero ? (
                <div className="relative w-full h-1.5 rounded-sm border border-dashed border-primary/30 bg-primary/[0.04] group-hover:bg-primary/10 transition-colors" />
              ) : (
                <div
                  className="relative w-full rounded-sm bg-primary/50 group-hover:bg-primary transition-colors"
                  style={{ height: `${heightPct}%` }}
                />
              )}
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between text-[10px] text-text-muted mt-1">
        <span>{firstLabel}</span>
        {hasAnyPriorYearData && (
          <span
            data-testid="billing-estimator-recommendation-chart-legend"
            className="inline-flex items-center gap-1"
          >
            <span
              aria-hidden="true"
              className="inline-block w-3 h-2 rounded-sm border border-dashed border-primary/40 bg-primary/[0.03]"
            />
            <span>vs. last year</span>
          </span>
        )}
        {ordered.length > 1 && <span>{lastLabel}</span>}
      </div>
    </div>
  );
}

function TrailingWindowToggle({
  value,
  onChange,
  options,
}: {
  value: TrailingWindow;
  onChange: (months: TrailingWindow) => void;
  options: ReadonlyArray<TrailingWindow>;
}) {
  return (
    <div
      role="group"
      aria-label="Trailing window for plan recommendation"
      data-testid="billing-estimator-recommendation-window-toggle"
      className="inline-flex items-center bg-surface border border-border rounded-md p-0.5 text-[11px]"
    >
      {options.map((opt) => {
        const selected = opt === value;
        return (
          <button
            key={opt}
            type="button"
            data-testid={`billing-estimator-recommendation-window-${opt}`}
            aria-pressed={selected}
            onClick={() => {
              if (!selected) onChange(opt);
            }}
            className={`px-2.5 py-1 rounded font-semibold transition-colors ${
              selected
                ? 'bg-primary text-white shadow-sm'
                : 'text-text-muted hover:text-text-primary'
            }`}
            title={`Average across the last ${opt} complete months`}
          >
            {opt} mo
          </button>
        );
      })}
    </div>
  );
}

function RecommendationCard({
  recommendation,
  monthsConsidered,
  formatMoney,
  onSwitchPlan,
  switchingPlan,
  trailingWindow,
  onTrailingWindowChange,
  availableTrailingWindows,
  onRecommendationEvent,
  trailingMonthlyBreakdown,
  trailingMonthlyPriorYearBreakdown,
}: {
  recommendation: NonNullable<ReturnType<typeof recommendCheapestPlan>>;
  monthsConsidered: number;
  formatMoney: (value: number) => string;
  onSwitchPlan?: (
    tier: PlanTier,
    interval: BillingPeriod,
    recommendation: RecommendationAttribution,
  ) => void;
  switchingPlan?: PlanTier | null;
  trailingWindow?: TrailingWindow;
  onTrailingWindowChange?: (months: TrailingWindow) => void;
  availableTrailingWindows?: ReadonlyArray<TrailingWindow>;
  onRecommendationEvent?: (event: RecommendationEvent) => void;
  trailingMonthlyBreakdown?: ReadonlyArray<{ month: string; aiMinutes: number }>;
  trailingMonthlyPriorYearBreakdown?: ReadonlyArray<{
    month: string;
    aiMinutes: number | null;
  }>;
}) {
  const {
    current,
    recommended,
    monthlySavings,
    annualSavings,
    annualOption,
    isAlreadyOptimal,
    averageMinutes,
  } = recommendation;
  // Math.round guards against floating-point drift since the
  // recommendation math operates in dollars. The attribution snapshot
  // tracks the canonical monthly savings projection, independent of
  // the user's later monthly/annual choice in the CTA toggle.
  const monthlySavingsCents = Math.max(0, Math.round(monthlySavings * 100));

  // Local interval choice for the recommendation CTA. Defaults to
  // monthly because the headline arithmetic at first render is the
  // monthly comparison ("you'd save $X/mo on Recommended"); flipping
  // to annual swaps the headline and the recommended cost shown in
  // the subtitle to the discounted figures from `annualOption`.
  const [interval, setIntervalState] = useState<BillingPeriod>('monthly');
  const isAnnual = interval === 'annual';
  const headlineMonthlySavings = isAnnual
    ? annualOption.monthlySavings
    : monthlySavings;
  const headlineAnnualSavings = isAnnual
    ? annualOption.annualSavings
    : annualSavings;
  const recommendedMonthlyCostForCopy = isAnnual
    ? annualOption.monthlyCost
    : recommended.monthlyCost;

  // Dedup impressions per (currentTier, recommendedTier, savings) per
  // browser tab so re-renders from slider / window toggles don't get
  // counted as new views.
  useEffect(() => {
    if (isAlreadyOptimal) return;
    if (!onRecommendationEvent) return;
    const dedupKey = `billing.rec.impression.${current.tier}.${recommended.tier}.${monthlySavingsCents}`;
    try {
      if (typeof window !== 'undefined' && window.sessionStorage) {
        if (window.sessionStorage.getItem(dedupKey)) return;
        window.sessionStorage.setItem(dedupKey, String(Date.now()));
      }
    } catch {
      // sessionStorage unavailable (privacy mode) — fire anyway.
    }
    onRecommendationEvent({
      type: 'impression',
      currentTier: current.tier,
      recommendedTier: recommended.tier,
      monthlySavingsCents,
      trailingWindowMonths: trailingWindow,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isAlreadyOptimal,
    current.tier,
    recommended.tier,
    monthlySavingsCents,
    trailingWindow,
  ]);


  const monthsLabel = monthsConsidered === 1
    ? 'last complete month'
    : `last ${monthsConsidered} complete months`;
  // Direction governs the verb: tenants who would save by moving to a
  // smaller tier should see "Downgrade to" rather than the more neutral
  // "Switch to" — matches the language used elsewhere in the estimator.
  const currentRank = PLAN_TIERS.indexOf(current.tier);
  const recommendedRank = PLAN_TIERS.indexOf(recommended.tier);
  const isDowngrade = recommendedRank >= 0 && currentRank >= 0
    && recommendedRank < currentRank;
  const isSwitchingThisTier = switchingPlan === recommended.tier;
  const ctaLabel = isSwitchingThisTier
    ? 'Redirecting...'
    : `${isDowngrade ? 'Downgrade to' : 'Switch to'} ${recommended.name}`;
  const ctaTitle = `${isDowngrade ? 'Downgrade' : 'Switch'} to the ${recommended.name} plan (${
    isAnnual ? 'annual' : 'monthly'
  } billing)`;

  const showWindowToggle =
    typeof trailingWindow === 'number'
    && typeof onTrailingWindowChange === 'function';
  const windowOptions = availableTrailingWindows && availableTrailingWindows.length > 0
    ? availableTrailingWindows
    : DEFAULT_TRAILING_WINDOWS;
  const windowToggle = showWindowToggle ? (
    <TrailingWindowToggle
      value={trailingWindow!}
      onChange={onTrailingWindowChange!}
      options={windowOptions}
    />
  ) : null;

  // Reuse the same chart in both card variants so tenants get the same
  // visual context whether they're being nudged to switch plans or
  // reassured they're already on the cheapest one. The prior-year
  // series is forwarded only when supplied; the chart itself drops the
  // overlay per-month when individual entries are null.
  const chart = trailingMonthlyBreakdown && trailingMonthlyBreakdown.length > 0
    ? (
      <TrailingMonthlyChart
        data={trailingMonthlyBreakdown}
        priorYearData={trailingMonthlyPriorYearBreakdown}
      />
    )
    : null;

  if (isAlreadyOptimal) {
    return (
      <div
        data-testid="billing-estimator-recommendation"
        data-recommendation-state="optimal"
        data-recommendation-window={trailingWindow ?? undefined}
        className="mb-5 rounded-lg border border-success/40 bg-success/[0.06] p-4"
      >
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-success/15 flex items-center justify-center shrink-0">
            <CheckCircle2 className="h-4 w-4 text-success" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-text-primary">
              You&rsquo;re already on the cheapest plan for your usage.
            </p>
            <p className="text-xs text-text-muted mt-0.5">
              Based on your {monthsLabel} ({averageMinutes.toLocaleString()} AI min/mo on average), your{' '}
              <span className="font-medium text-text-primary">{current.name}</span> plan is the best fit at{' '}
              <span className="font-medium text-text-primary">{formatMoney(current.monthlyCost)}/mo</span>.
              No change needed.
            </p>
          </div>
          {windowToggle && <div className="shrink-0">{windowToggle}</div>}
        </div>
        {chart}
      </div>
    );
  }

  return (
    <div
      data-testid="billing-estimator-recommendation"
      data-recommendation-state="switch"
      data-recommended-tier={recommended.tier}
      data-recommendation-window={trailingWindow ?? undefined}
      className="mb-5 rounded-lg border border-primary/40 bg-primary/[0.06] p-4"
    >
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-primary/15 flex items-center justify-center shrink-0">
          <Lightbulb className="h-4 w-4 text-primary" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text-primary">
            You&rsquo;d save{' '}
            <span
              data-testid="billing-estimator-recommendation-savings"
              className="text-primary"
            >
              {formatMoney(headlineMonthlySavings)}/mo
            </span>{' '}
            on{' '}
            <span data-testid="billing-estimator-recommendation-tier" className="text-primary">
              {recommended.name}
            </span>
            {isAnnual && (
              <>
                {' '}
                <span
                  data-testid="billing-estimator-recommendation-annual-tag"
                  className="text-[10px] font-semibold uppercase tracking-wide text-success bg-success/10 px-1.5 py-0.5 rounded-full align-middle"
                >
                  billed annually
                </span>
              </>
            )}{' '}
            based on your {monthsLabel}.
          </p>
          <p className="text-xs text-text-muted mt-0.5">
            You averaged {averageMinutes.toLocaleString()} AI min/mo. {current.name} would have billed{' '}
            {formatMoney(current.monthlyCost)}/mo at that volume; {recommended.name} comes out to{' '}
            <span data-testid="billing-estimator-recommendation-recommended-cost">
              {formatMoney(recommendedMonthlyCostForCopy)}/mo
            </span>
            {isAnnual && ' on annual'} — about{' '}
            <span
              data-testid="billing-estimator-recommendation-annual-savings"
              className="font-medium text-text-primary"
            >
              {formatMoney(headlineAnnualSavings)}/yr
            </span>{' '}
            back in your pocket.
          </p>
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          {windowToggle}
          {onSwitchPlan && (
            <>
              <RecommendationIntervalToggle
                value={interval}
                onChange={setIntervalState}
              />
              <button
                type="button"
                data-testid="billing-estimator-recommendation-cta"
                data-recommendation-cta-tier={recommended.tier}
                data-recommendation-cta-interval={interval}
                onClick={() => {
                  const attribution: RecommendationAttribution = {
                    currentTier: current.tier,
                    recommendedTier: recommended.tier,
                    monthlySavingsCents,
                    trailingWindowMonths: trailingWindow,
                  };
                  if (onRecommendationEvent) {
                    onRecommendationEvent({ type: 'click', ...attribution });
                  }
                  onSwitchPlan(recommended.tier, interval, attribution);
                }}
                disabled={isSwitchingThisTier}
                className="inline-flex items-center gap-1 px-3 py-1.5 bg-primary hover:bg-primary-hover text-white text-xs font-semibold rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                title={ctaTitle}
              >
                {isSwitchingThisTier ? (
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                ) : isDowngrade ? (
                  <ArrowDownRight className="h-3 w-3" aria-hidden="true" />
                ) : (
                  <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                )}
                {ctaLabel}
              </button>
            </>
          )}
        </div>
      </div>
      {chart}
    </div>
  );
}

/**
 * Compact monthly/annual toggle shown next to the recommendation CTA.
 * Mirrors the look of the trailing-window toggle so the two controls
 * read as a pair, but is a separate component because the labels and
 * the discount badge differ. Hidden when there's no `onSwitchPlan`
 * callback — without a CTA to forward the choice to, the toggle has
 * nothing to do.
 */
function RecommendationIntervalToggle({
  value,
  onChange,
}: {
  value: BillingPeriod;
  onChange: (interval: BillingPeriod) => void;
}) {
  const options: Array<{ key: BillingPeriod; label: string; title: string }> = [
    {
      key: 'monthly',
      label: 'Monthly',
      title: 'Bill the recommended plan monthly',
    },
    {
      key: 'annual',
      label: 'Annual',
      title: `Save ${Math.round(ANNUAL_DISCOUNT * 100)}% by committing to annual billing`,
    },
  ];
  return (
    <div
      role="group"
      aria-label="Billing interval for plan recommendation"
      data-testid="billing-estimator-recommendation-interval-toggle"
      className="inline-flex items-center bg-surface border border-border rounded-md p-0.5 text-[11px]"
    >
      {options.map((opt) => {
        const selected = opt.key === value;
        return (
          <button
            key={opt.key}
            type="button"
            data-testid={`billing-estimator-recommendation-interval-${opt.key}`}
            aria-pressed={selected}
            onClick={() => {
              if (!selected) onChange(opt.key);
            }}
            className={`px-2.5 py-1 rounded font-semibold transition-colors inline-flex items-center gap-1 ${
              selected
                ? 'bg-primary text-white shadow-sm'
                : 'text-text-muted hover:text-text-primary'
            }`}
            title={opt.title}
          >
            {opt.label}
            {opt.key === 'annual' && (
              <span
                className={`text-[9px] font-semibold px-1 py-0.5 rounded-full ${
                  selected ? 'bg-white/20 text-white' : 'bg-success/10 text-success'
                }`}
              >
                −{Math.round(ANNUAL_DISCOUNT * 100)}%
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export default function BillingEstimator({
  currentPlan,
  monthToDateAiMinutes,
  rateOverride,
  upgradePreview,
  projectionMultiplier,
  currency = 'USD',
  trailingMonthlyAiMinutes,
  trailingMonthlyBreakdown,
  trailingMonthlyPriorYearBreakdown,
  onSwitchPlan,
  switchingPlan,
  trailingWindow,
  onTrailingWindowChange,
  availableTrailingWindows,
  onRecommendationEvent,
}: BillingEstimatorProps) {
  const formatMoney = useMemo(() => makeFormatMoney(currency), [currency]);
  const formatPerMinute = useMemo(() => makeFormatPerMinute(currency), [currency]);
  const currentTierKey = normalizePlan(currentPlan);

  // Defer averaging + filtering to the shared helper so the UI and
  // server-side consumers stay drift-free. Override shape is mapped to
  // PlanRateOverride here (BillingEstimatorRateOverride is the same shape
  // but the props type predates the shared helper).
  //
  // The recommendation math averages across the FULL provided series —
  // including zero-usage months — to match the backend's intentional
  // zero-filled averaging behavior (a brand-new tenant whose only
  // trailing month had 300 min should average to 100 over 3 months, not
  // 300, so we don't push them into a tier that won't fit once usage
  // ramps). The displayed `monthsConsidered` separately reports the
  // number of months that actually had usage so the "based on N complete
  // months" copy reflects the tenant's real history rather than the
  // raw window length.
  const recommendation = useMemo(() => {
    if (!trailingMonthlyAiMinutes || trailingMonthlyAiMinutes.length === 0) return null;
    const valid = trailingMonthlyAiMinutes.filter(
      (n) => Number.isFinite(n) && n >= 0,
    );
    if (valid.length === 0) return null;
    const monthsWithData = valid.filter((n) => n > 0).length;
    // Hide the card entirely when no month had any usage — recommending
    // off an all-zero series would be noise, not signal.
    if (monthsWithData === 0) return null;
    const avg = averageTrailingMinutes(valid);
    const override: PlanRateOverride | undefined = rateOverride
      ? {
          basePriceCents: rateOverride.basePriceCents ?? null,
          overageRatePerMinute: rateOverride.overageRatePerMinute ?? null,
        }
      : undefined;
    return {
      monthsConsidered: monthsWithData,
      result: recommendCheapestPlan(currentTierKey, avg, override),
    };
  }, [trailingMonthlyAiMinutes, currentTierKey, rateOverride]);
  // Current-tier override is sourced from the tenant's actual subscription
  // items via /billing/effective-rate; comparison-tier override (when
  // direction === 'up') comes from /billing/upgrade-preview, which factors
  // in customer-level coupons/promotion codes Sales attached to the tenant.
  const currentTier = useMemo(
    () => toTierSpec(currentTierKey, rateOverride),
    [currentTierKey, rateOverride],
  );

  const comparisonDirection: ComparisonDirection =
    currentTierKey === 'starter' ? 'up' : 'down';

  const comparisonTierKey = useMemo(
    () =>
      comparisonDirection === 'up'
        ? nextTierUp(currentTierKey)
        : nextTierDown(currentTierKey),
    [currentTierKey, comparisonDirection],
  );
  const comparisonTier = useMemo(
    () => {
      if (!comparisonTierKey) return null;
      // Downgrade pricing always uses the published catalog floor — there
      // is no tenant-specific quote to apply when stepping DOWN to a tier
      // they aren't currently on.
      const override = comparisonDirection === 'up' ? upgradePreview : undefined;
      return toTierSpec(comparisonTierKey, override);
    },
    [comparisonTierKey, comparisonDirection, upgradePreview],
  );

  const mtdMinutes = useMemo(
    () => clampMinutes(monthToDateAiMinutes),
    [monthToDateAiMinutes],
  );
  const safeMultiplier =
    typeof projectionMultiplier === 'number' &&
    Number.isFinite(projectionMultiplier) &&
    projectionMultiplier >= 1
      ? projectionMultiplier
      : 1;
  const projectedMinutes = useMemo(
    () => clampMinutes(monthToDateAiMinutes * safeMultiplier),
    [monthToDateAiMinutes, safeMultiplier],
  );
  const hasProjection = projectedMinutes > mtdMinutes;

  const [minutes, setMinutes] = useState<number>(
    hasProjection ? projectedMinutes : mtdMinutes,
  );
  const userDirtyRef = useRef(false);

  const handleUserChange = (value: number) => {
    userDirtyRef.current = true;
    setMinutes(value);
  };

  // If MTD/projection data arrives async (e.g. the usage query resolves
  // after mount), sync the slider to the smart default — but only while the
  // user hasn't manually adjusted it yet.
  useEffect(() => {
    if (userDirtyRef.current) return;
    setMinutes(hasProjection ? projectedMinutes : mtdMinutes);
  }, [hasProjection, projectedMinutes, mtdMinutes]);

  const safeMinutes = clampMinutes(minutes);
  const isAtMtd = safeMinutes === mtdMinutes;
  const isAtProjected = safeMinutes === projectedMinutes;
  const isShowingProjectedDefault = hasProjection && isAtProjected;

  const comparisonLabel =
    comparisonDirection === 'down' ? 'Potential downgrade' : 'Next tier up';
  const intro =
    comparisonDirection === 'down'
      ? 'Drag the slider to model a different AI minute volume and see what your invoice would look like on your current plan or if you downgraded one tier.'
      : 'Drag the slider to model a different AI minute volume and see what your invoice would look like on your current plan and the next tier up.';

  return (
    <div className="bg-surface border border-border rounded-xl p-6">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Calculator className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-text-primary">
              Project End-of-Month Bill
            </h2>
            <p className="text-sm text-text-muted mt-0.5">
              {isShowingProjectedDefault
                ? 'Pre-filled with a smart end-of-month projection based on your usage so far. Drag the slider or use a preset to model a different AI minute volume.'
                : intro}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
          {hasProjection && (
            <button
              type="button"
              onClick={() => handleUserChange(projectedMinutes)}
              disabled={isAtProjected}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-primary border border-primary/40 bg-primary/[0.04] rounded-md hover:bg-primary/10 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              data-testid="billing-estimator-use-projected"
              title={`Project full month from ${mtdMinutes.toLocaleString()} MTD min × ${safeMultiplier.toFixed(2)}`}
            >
              <TrendingUp className="h-3 w-3" />
              Use projected end-of-month
            </button>
          )}
          <button
            type="button"
            onClick={() => handleUserChange(mtdMinutes)}
            disabled={isAtMtd}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-text-muted border border-border rounded-md hover:bg-surface-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            data-testid="billing-estimator-reset"
          >
            <Sparkles className="h-3 w-3" />
            Reset to MTD
          </button>
        </div>
      </div>

      {recommendation?.result && (
        <RecommendationCard
          recommendation={recommendation.result}
          monthsConsidered={recommendation.monthsConsidered}
          formatMoney={formatMoney}
          onSwitchPlan={onSwitchPlan}
          switchingPlan={switchingPlan}
          trailingWindow={trailingWindow}
          onTrailingWindowChange={onTrailingWindowChange}
          availableTrailingWindows={availableTrailingWindows}
          onRecommendationEvent={onRecommendationEvent}
          trailingMonthlyBreakdown={trailingMonthlyBreakdown}
          trailingMonthlyPriorYearBreakdown={trailingMonthlyPriorYearBreakdown}
        />
      )}

      <div className="space-y-3 mb-5">
        <div className="flex items-center justify-between gap-4">
          <label
            htmlFor="billing-estimator-slider"
            className="text-sm font-medium text-text-primary"
          >
            Projected AI minutes this month
          </label>
          <div className="flex items-center gap-2">
            <input
              id="billing-estimator-input"
              type="number"
              min={MIN_MINUTES}
              max={MAX_MINUTES}
              step={STEP_MINUTES}
              value={safeMinutes}
              onChange={(e) => handleUserChange(clampMinutes(Number(e.target.value)))}
              className="w-28 px-3 py-1.5 rounded-lg border border-border bg-surface text-sm font-semibold text-text-primary text-right focus:outline-none focus:ring-2 focus:ring-primary/40"
              aria-label="Projected AI minutes for the month"
              data-testid="billing-estimator-input"
            />
            <span className="text-sm text-text-muted">min/mo</span>
          </div>
        </div>
        <input
          id="billing-estimator-slider"
          type="range"
          min={MIN_MINUTES}
          max={MAX_MINUTES}
          step={STEP_MINUTES}
          value={safeMinutes}
          onChange={(e) => handleUserChange(clampMinutes(Number(e.target.value)))}
          className="w-full h-2 bg-surface-hover rounded-lg appearance-none cursor-pointer accent-primary"
          aria-label="Adjust projected AI minutes for the month"
          data-testid="billing-estimator-slider"
        />
        <div className="flex justify-between text-[11px] text-text-muted">
          <span>{MIN_MINUTES.toLocaleString()} min</span>
          <span>
            MTD: {mtdMinutes.toLocaleString()} min
            {hasProjection && (
              <>
                {' · '}
                <span className="text-primary">
                  Projected: {projectedMinutes.toLocaleString()} min
                </span>
              </>
            )}
          </span>
          <span>{MAX_MINUTES.toLocaleString()} min</span>
        </div>
      </div>

      <div className="flex flex-col md:flex-row gap-3">
        <TierEstimate
          tier={currentTier}
          minutes={safeMinutes}
          label="Current plan"
          formatMoney={formatMoney}
          formatPerMinute={formatPerMinute}
        />
        {comparisonTier ? (
          <TierEstimate
            tier={comparisonTier}
            minutes={safeMinutes}
            label={comparisonLabel}
            direction={comparisonDirection}
            highlight
            formatMoney={formatMoney}
            formatPerMinute={formatPerMinute}
          />
        ) : (
          <div
            className="flex-1 rounded-lg border border-dashed border-border p-4 flex items-center justify-center text-center text-sm text-text-muted"
            data-testid="billing-estimator-top-tier"
          >
            You are on the highest published plan. Contact sales for custom volume pricing.
          </div>
        )}
      </div>

      <p className="mt-4 text-xs text-text-muted">
        Estimates use the same per-minute rates posted to your Stripe metered usage. Only
        active conversation time counts toward AI minutes — hold time, ringing, and
        processing are not billed.
      </p>
    </div>
  );
}
