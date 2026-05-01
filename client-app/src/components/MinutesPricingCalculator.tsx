import { useMemo, useState } from 'react';
import { Calculator, Sparkles, MessageSquare, Phone } from 'lucide-react';
import { formatDollars } from '../lib/formatCurrency';
import {
  DEFAULT_DISPLAY_CURRENCY,
  formatPublicPrice,
  isApproximateCurrency,
} from '../lib/displayCurrency';
import {
  ANNUAL_DISCOUNT,
  PLAN_CATALOG,
  PLAN_TIERS,
  centsToWholeDollars,
  getDiscountedAnnualMonthlyDollars,
  getPlanMonthlyPriceWholeDollars,
  type PlanTier,
} from '../../../shared/billing/planCatalog';

/**
 * Re-exported from the shared catalog so existing imports
 * (`import { ANNUAL_DISCOUNT } from '.../MinutesPricingCalculator'`) keep
 * working. The single source of truth lives in `shared/billing/planCatalog`.
 */
export { ANNUAL_DISCOUNT };

interface CalculatorTier {
  key: PlanTier;
  name: string;
  basePrice: number;
  includedMinutes: number;
  overageRate: number;
  popular?: boolean;
}

/**
 * Override sourced from `/billing/effective-rate` so a logged-in tenant
 * sees what their *current* tier actually invoices at — including any
 * negotiated, grandfathered, or otherwise-custom Stripe price — instead
 * of the published catalog default. Only the tenant's current tier is
 * overridden; the other tier cards keep catalog rates because Stripe
 * can't quote unsubscribed plans for that tenant.
 *
 * `basePriceCents` drives monthly mode (the per-month price for the
 * tenant's tier billed monthly). `annualBasePriceCents` drives annual
 * mode and is the monthly-equivalent of the same tier billed annually.
 * Per-minute overage is interval-agnostic.
 */
export interface CurrentPlanOverride {
  tier: PlanTier;
  basePriceCents?: number | null;
  overageRatePerMinute?: number | null;
  basePriceSource?: 'stripe' | 'catalog';
  overagePriceSource?: 'stripe' | 'catalog';
  annualBasePriceCents?: number | null;
  annualBasePriceSource?: 'stripe' | 'catalog';
  /**
   * Per-message SMS rate (in dollars) and its provenance, sourced
   * from `/billing/effective-rate.smsRatePerMessage`. Tenant-wide
   * (does not vary by AI tier or billing interval) so the calculator
   * surfaces it as a single line below the tier cards. The
   * "Live Stripe rate" badge engages when `smsPriceSource === 'stripe'`,
   * matching the convention used for AI base/overage rates.
   */
  smsRatePerMessage?: number | null;
  smsPriceSource?: 'stripe' | 'catalog' | null;
  /**
   * Per-minute Twilio (carrier) rate (in dollars) and its provenance,
   * sourced from `/billing/effective-rate.twilioRatePerMinute`. Like
   * the SMS rate, it's tenant-wide (does not vary by AI tier or
   * billing interval) so the calculator surfaces it as a single line
   * below the tier cards alongside the SMS row. The "Live Stripe rate"
   * badge engages when `twilioPriceSource === 'stripe'`, matching the
   * convention used for the AI base/overage and SMS rates so a tenant
   * comparing tiers on /pricing sees the same negotiated Twilio rate
   * that the in-app Billing screen surfaces (task #1356).
   */
  twilioRatePerMinute?: number | null;
  twilioPriceSource?: 'stripe' | 'catalog' | null;
}

export type BillingPeriod = 'monthly' | 'annual';

const POPULAR_TIER: PlanTier = 'pro';

const CALC_TIERS: CalculatorTier[] = PLAN_TIERS.map((key) => {
  const plan = PLAN_CATALOG[key];
  return {
    key: plan.key,
    name: plan.name,
    basePrice: getPlanMonthlyPriceWholeDollars(plan.key),
    includedMinutes: plan.includedMinutes,
    overageRate: plan.overageRatePerMinute,
    popular: plan.key === POPULAR_TIER,
  };
});

const MIN_MINUTES = 100;
const MAX_MINUTES = 25_000;
const STEP_MINUTES = 100;

function formatCurrency(value: number, currency: string = DEFAULT_DISPLAY_CURRENCY): string {
  if (currency === DEFAULT_DISPLAY_CURRENCY) {
    return formatDollars(value, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
  return formatPublicPrice(value, currency, { fractionDigits: 0 });
}

function formatPerMinute(value: number, currency: string = DEFAULT_DISPLAY_CURRENCY): string {
  if (currency === DEFAULT_DISPLAY_CURRENCY) {
    return formatDollars(value, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  }
  return formatPublicPrice(value, currency, { fractionDigits: 3, precise: true });
}

/**
 * Per-message SMS rate formatter. SMS prices typically run 1–3 cents
 * (e.g. $0.0075–$0.025), so we widen the fraction band beyond the
 * per-minute formatter — a tenant on a $0.0075/msg negotiated rate
 * must see four meaningful digits, not "$0.008" rounded.
 */
function formatPerMessage(value: number, currency: string = DEFAULT_DISPLAY_CURRENCY): string {
  if (currency === DEFAULT_DISPLAY_CURRENCY) {
    return formatDollars(value, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  }
  return formatPublicPrice(value, currency, { fractionDigits: 4, precise: true });
}

export function calculateMonthlyCost(tier: Pick<CalculatorTier, 'basePrice' | 'includedMinutes' | 'overageRate'>, minutes: number): number {
  const billableOverage = Math.max(0, minutes - tier.includedMinutes);
  return tier.basePrice + billableOverage * tier.overageRate;
}

export function calculateEffectiveRate(tier: Pick<CalculatorTier, 'basePrice' | 'includedMinutes' | 'overageRate'>, minutes: number): number {
  if (minutes <= 0) return 0;
  return calculateMonthlyCost(tier, minutes) / minutes;
}

export function getDiscountedBasePrice(basePrice: number, period: BillingPeriod): number {
  return period === 'annual' ? basePrice * (1 - ANNUAL_DISCOUNT) : basePrice;
}

/**
 * Catalog annual base price for a tier displayed *in dollars*. Mirrors
 * the rounded annual figure shown on the /pricing tier card so the
 * "Saves $X/yr" line below the calculator reconciles to the
 * strikethrough/discounted price pair on the card above it. Falls back
 * to the unrounded monthly figure when the period is monthly.
 */
function getDisplayAnnualBaseDollars(monthlyDollars: number, period: BillingPeriod): number {
  return period === 'annual'
    ? getDiscountedAnnualMonthlyDollars(monthlyDollars)
    : monthlyDollars;
}

export interface MinutesPricingCalculatorProps {
  billingPeriod?: BillingPeriod;
  onBillingPeriodChange?: (period: BillingPeriod) => void;
  /**
   * Optional Stripe-sourced rate override applied to the tenant's current
   * tier card. When provided (and the calculator is in monthly mode), the
   * matching tier shows the live invoiced rate instead of the catalog
   * default and renders a "Live Stripe rate" badge.
   */
  currentPlanOverride?: CurrentPlanOverride;
  /**
   * Display currency code for the public marketing surface (e.g. `EUR`,
   * `GBP`). Defaults to `USD` for the in-app callers (Billing,
   * BillingEstimator) so existing behaviour is preserved. When set to
   * a non-USD code, every figure is FX-converted via
   * `client-app/src/lib/displayCurrency` and an "approximate
   * conversion" disclaimer is shown alongside the cards.
   */
  displayCurrency?: string;
}

export default function MinutesPricingCalculator({
  billingPeriod: billingPeriodProp,
  onBillingPeriodChange,
  currentPlanOverride,
  displayCurrency = DEFAULT_DISPLAY_CURRENCY,
}: MinutesPricingCalculatorProps = {}) {
  const isApprox = isApproximateCurrency(displayCurrency);
  const [minutes, setMinutes] = useState<number>(1_500);
  const [billingPeriodInternal, setBillingPeriodInternal] = useState<BillingPeriod>('monthly');
  const isControlled = billingPeriodProp !== undefined;
  const billingPeriod = isControlled ? billingPeriodProp : billingPeriodInternal;
  const setBillingPeriod = (period: BillingPeriod) => {
    if (!isControlled) setBillingPeriodInternal(period);
    onBillingPeriodChange?.(period);
  };

  const results = useMemo(() => {
    const safeMinutes = Math.max(0, Math.min(MAX_MINUTES, Math.round(minutes)));
    // In annual mode we ONLY engage the override when a Stripe-sourced
    // annual quote is present; without it we have no way to project a
    // custom monthly rate onto an annual interval, so we fall back
    // entirely to catalog (preserving pre-feature behaviour).
    const overrideActive = !!currentPlanOverride;
    const isAnnualMode = billingPeriod === 'annual';
    const annualOverrideUsable =
      isAnnualMode
      && overrideActive
      && currentPlanOverride?.annualBasePriceSource === 'stripe'
      && currentPlanOverride.annualBasePriceCents != null
      && Number.isFinite(currentPlanOverride.annualBasePriceCents);
    const overrideEngaged = isAnnualMode ? annualOverrideUsable : overrideActive;
    const overrideBaseCents = (() => {
      if (!overrideEngaged) return null;
      if (isAnnualMode) {
        return currentPlanOverride!.annualBasePriceCents ?? null;
      }
      if (
        currentPlanOverride?.basePriceSource === 'stripe'
        && currentPlanOverride.basePriceCents != null
        && Number.isFinite(currentPlanOverride.basePriceCents)
      ) {
        return currentPlanOverride.basePriceCents;
      }
      return null;
    })();
    const overrideOverage =
      overrideEngaged
        && currentPlanOverride?.overagePriceSource === 'stripe'
        && currentPlanOverride.overageRatePerMinute != null
        && Number.isFinite(currentPlanOverride.overageRatePerMinute)
        ? currentPlanOverride.overageRatePerMinute
        : null;

    return CALC_TIERS.map((tier) => {
      const isOverriddenTier =
        overrideActive && currentPlanOverride?.tier === tier.key;

      const baseFromOverride = isOverriddenTier && overrideBaseCents != null
        ? centsToWholeDollars(overrideBaseCents)
        : null;
      const overageFromOverride = isOverriddenTier && overrideOverage != null
        ? overrideOverage
        : null;

      // Catalog base in display units. Annual mode rounds the
      // discounted figure so the "Saves $X/yr vs monthly billing" line
      // below stays in lockstep with the strikethrough/discounted pair
      // shown on the matching /pricing tier card (which also rounds).
      const catalogBase = getDisplayAnnualBaseDollars(tier.basePrice, billingPeriod);
      const effectiveBase = baseFromOverride ?? catalogBase;
      const overageRate = overageFromOverride ?? tier.overageRate;
      const billingTier = {
        ...tier,
        basePrice: effectiveBase,
        overageRate,
      };
      const monthlyCost = calculateMonthlyCost(billingTier, safeMinutes);
      const effectiveRate = safeMinutes > 0 ? monthlyCost / safeMinutes : 0;
      const overageMinutes = Math.max(0, safeMinutes - tier.includedMinutes);
      const overageCost = overageMinutes * overageRate;
      // Annual savings only meaningful for catalog-priced cards. The
      // override card never shows the savings line because its base is
      // not derived from the catalog monthly→annual transform.
      const annualSavings = baseFromOverride != null
        ? 0
        : (tier.basePrice - effectiveBase) * 12;
      const sourcedFromStripe = baseFromOverride != null || overageFromOverride != null;
      return {
        tier,
        effectiveBase,
        effectiveOverageRate: overageRate,
        monthlyCost,
        effectiveRate,
        overageMinutes,
        overageCost,
        annualSavings,
        sourcedFromStripe,
      };
    });
  }, [minutes, billingPeriod, currentPlanOverride]);

  const cheapest = useMemo(() => {
    if (minutes <= 0) return null;
    return results.reduce((best, current) =>
      current.monthlyCost < best.monthlyCost ? current : best,
    results[0]);
  }, [results, minutes]);

  const isAnnual = billingPeriod === 'annual';

  // Per-message SMS rate is tenant-wide (does not vary by AI tier or
  // billing interval), so we surface it once below the tier cards
  // rather than inside each tier card. The badge mirrors the
  // per-tier "Live Stripe rate" convention — a catalog/env-default
  // rate renders without the badge so we don't falsely imply the
  // fallback came from Stripe.
  const smsRate =
    currentPlanOverride?.smsRatePerMessage != null
    && Number.isFinite(currentPlanOverride.smsRatePerMessage)
    && currentPlanOverride.smsRatePerMessage >= 0
      ? currentPlanOverride.smsRatePerMessage
      : null;
  const smsFromStripe = currentPlanOverride?.smsPriceSource === 'stripe';

  // Per-minute Twilio (carrier) rate is tenant-wide too, so we surface
  // it once below the tier cards on the row right after SMS — same
  // gating convention: row mounts when a numeric rate is present, the
  // "Live Stripe rate" badge only engages when the rate was actually
  // sourced from Stripe so we never falsely imply the env-default
  // fallback (`TWILIO_COST_PER_MINUTE_CENTS`) was a negotiated rate.
  const twilioRate =
    currentPlanOverride?.twilioRatePerMinute != null
    && Number.isFinite(currentPlanOverride.twilioRatePerMinute)
    && currentPlanOverride.twilioRatePerMinute >= 0
      ? currentPlanOverride.twilioRatePerMinute
      : null;
  const twilioFromStripe = currentPlanOverride?.twilioPriceSource === 'stripe';

  return (
    <div className="bg-surface rounded-2xl border border-border-strong/50 shadow-sm overflow-hidden">
      <div className="p-6 lg:p-8 border-b border-border-strong/30 bg-surface-secondary/30">
        <div className="flex items-start justify-between gap-4 mb-5 flex-wrap">
          <div className="flex items-start gap-3">
            <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
              <Calculator className="h-4.5 w-4.5 text-primary" />
            </div>
            <div>
              <h3 className="font-display text-lg font-bold text-text-primary">Estimate your monthly bill</h3>
              <p className="text-sm text-text-primary/60 font-body mt-0.5">
                Pick how many AI minutes you expect to use each month and see the effective per-minute price for every plan.
              </p>
            </div>
          </div>

          <div
            role="group"
            aria-label="Billing period"
            data-testid="calc-billing-toggle"
            className="inline-flex items-center bg-surface border border-border-strong/50 rounded-lg p-0.5 shrink-0"
          >
            <button
              type="button"
              data-testid="calc-billing-monthly"
              aria-pressed={!isAnnual}
              onClick={() => setBillingPeriod('monthly')}
              className={`px-3 py-1.5 text-xs font-display font-semibold rounded-md transition-colors ${
                !isAnnual
                  ? 'bg-primary text-white shadow-sm'
                  : 'text-text-primary/70 hover:text-text-primary'
              }`}
            >
              Monthly
            </button>
            <button
              type="button"
              data-testid="calc-billing-annual"
              aria-pressed={isAnnual}
              onClick={() => setBillingPeriod('annual')}
              className={`px-3 py-1.5 text-xs font-display font-semibold rounded-md transition-colors inline-flex items-center gap-1.5 ${
                isAnnual
                  ? 'bg-primary text-white shadow-sm'
                  : 'text-text-primary/70 hover:text-text-primary'
              }`}
            >
              Annual
              <span
                className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${
                  isAnnual ? 'bg-white/20 dark:bg-white/20 text-white' : 'bg-success/10 text-success'
                }`}
              >
                −20%
              </span>
            </button>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <label htmlFor="minutes-slider" className="text-sm font-medium text-text-primary">
              Monthly AI minutes
            </label>
            <div className="flex items-center gap-2">
              <input
                id="minutes-input"
                type="number"
                min={0}
                max={MAX_MINUTES}
                step={STEP_MINUTES}
                value={minutes}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) setMinutes(Math.max(0, Math.min(MAX_MINUTES, v)));
                }}
                className="w-28 px-3 py-1.5 rounded-lg border border-border-strong/50 text-sm font-display font-bold text-text-primary text-right focus:outline-none focus:ring-2 focus:ring-primary/40"
                aria-label="Monthly AI minutes"
              />
              <span className="text-sm text-text-primary/60 font-body">min/mo</span>
            </div>
          </div>
          <input
            id="minutes-slider"
            type="range"
            min={MIN_MINUTES}
            max={MAX_MINUTES}
            step={STEP_MINUTES}
            value={Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, minutes))}
            onChange={(e) => setMinutes(Number(e.target.value))}
            className="w-full h-2 bg-border-strong/40 rounded-lg appearance-none cursor-pointer accent-primary"
            aria-label="Adjust monthly AI minutes"
          />
          <div className="flex justify-between text-xs text-text-primary/40 font-body">
            <span>{MIN_MINUTES.toLocaleString()} min</span>
            <span>{(MAX_MINUTES / 1000).toFixed(0)},000 min</span>
          </div>
        </div>
      </div>

      <div className="grid md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-border-strong/30">
        {results.map(({ tier, effectiveBase, effectiveOverageRate, monthlyCost, effectiveRate, overageMinutes, overageCost, annualSavings, sourcedFromStripe }) => {
          const isBest = cheapest && cheapest.tier.key === tier.key && minutes > 0;
          return (
            <div
              key={tier.key}
              data-testid={`calc-tier-${tier.key}`}
              className={`p-6 transition-colors ${
                isBest ? 'bg-primary/[0.04]' : ''
              }`}
            >
              <div className="flex items-center justify-between mb-3">
                <span className={`font-display text-sm font-semibold ${tier.popular ? 'text-primary' : 'text-text-primary'}`}>
                  {tier.name}
                </span>
                {isBest && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                    <Sparkles className="h-3 w-3" />
                    Best value
                  </span>
                )}
              </div>

              <div className="mb-4">
                <div className="flex items-baseline gap-1">
                  <span
                    data-testid={`calc-monthly-${tier.key}`}
                    data-display-currency={displayCurrency}
                    className="font-display text-3xl font-bold text-text-primary"
                  >
                    {isApprox && '≈ '}{formatCurrency(monthlyCost, displayCurrency)}
                  </span>
                  <span className="text-xs text-text-primary/50 font-body">/mo est.</span>
                </div>
                <div
                  data-testid={`calc-effective-${tier.key}`}
                  className="text-sm text-text-primary/70 font-body mt-1"
                >
                  {minutes > 0 ? formatPerMinute(effectiveRate, displayCurrency) : '—'} effective per minute
                </div>
                {sourcedFromStripe && (
                  <div
                    data-testid={`calc-source-${tier.key}`}
                    className="mt-2 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-success bg-success/10 px-2 py-0.5 rounded-full"
                    title="Live Stripe price for your current plan — pulled from your subscription when available, otherwise from the published Stripe price for this billing interval. Overrides the catalog default."
                  >
                    Live Stripe rate
                  </div>
                )}
                {isAnnual && !sourcedFromStripe && (
                  <div
                    data-testid={`calc-savings-${tier.key}`}
                    className="text-[11px] text-success font-body font-medium mt-1.5"
                  >
                    Saves {formatCurrency(annualSavings, displayCurrency)}/yr vs monthly billing
                  </div>
                )}
              </div>

              <dl className="space-y-1.5 text-xs font-body border-t border-border-strong/30 pt-3">
                <div className="flex justify-between">
                  <dt className="text-text-primary/50">Base plan</dt>
                  <dd
                    data-testid={`calc-base-${tier.key}`}
                    className="text-text-primary font-medium"
                  >
                    {sourcedFromStripe ? (
                      <span>{formatCurrency(effectiveBase, displayCurrency)}/mo</span>
                    ) : isAnnual ? (
                      <span className="inline-flex items-baseline gap-1.5">
                        <span className="line-through text-text-primary/40">{formatCurrency(tier.basePrice, displayCurrency)}</span>
                        <span>{formatCurrency(effectiveBase, displayCurrency)}/mo</span>
                      </span>
                    ) : (
                      <span>{formatCurrency(tier.basePrice, displayCurrency)}/mo</span>
                    )}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-text-primary/50">Minutes included</dt>
                  <dd className="text-text-primary font-medium">{tier.includedMinutes.toLocaleString()}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-text-primary/50">Overage rate</dt>
                  <dd className="text-text-primary font-medium">{formatPerMinute(effectiveOverageRate, displayCurrency)}/min</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-text-primary/50">Overage this month</dt>
                  <dd className={`font-medium ${overageMinutes > 0 ? 'text-danger' : 'text-success'}`}>
                    {overageMinutes > 0
                      ? `${overageMinutes.toLocaleString()} min · ${formatCurrency(overageCost, displayCurrency)}`
                      : 'None'}
                  </dd>
                </div>
              </dl>
            </div>
          );
        })}
      </div>

      {smsRate != null && (
        <div
          data-testid="calc-sms-rate"
          data-sms-source={smsFromStripe ? 'stripe' : 'catalog'}
          className="px-6 lg:px-8 py-3 bg-surface-secondary/40 border-t border-border-strong/30 flex flex-wrap items-center justify-between gap-3"
        >
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
              <MessageSquare className="h-3.5 w-3.5 text-primary" />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-display font-semibold uppercase tracking-wide text-text-primary/70">
                Per-message SMS rate
              </div>
              <div className="text-[11px] text-text-primary/50 font-body mt-0.5">
                Charged per outbound SMS — same rate billed by your usage meter.
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span
              data-testid="calc-sms-rate-value"
              className="text-sm font-display font-semibold text-text-primary"
            >
              {isApprox && '≈ '}{formatPerMessage(smsRate, displayCurrency)}/msg
            </span>
            {smsFromStripe && (
              <span
                data-testid="calc-sms-source"
                className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-success bg-success/10 px-2 py-0.5 rounded-full"
                title="Live Stripe SMS rate for your account — pulled from your subscription. Overrides the env-default fallback."
              >
                Live Stripe rate
              </span>
            )}
          </div>
        </div>
      )}

      {twilioRate != null && (
        <div
          data-testid="calc-twilio-rate"
          data-twilio-source={twilioFromStripe ? 'stripe' : 'catalog'}
          className="px-6 lg:px-8 py-3 bg-surface-secondary/40 border-t border-border-strong/30 flex flex-wrap items-center justify-between gap-3"
        >
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
              <Phone className="h-3.5 w-3.5 text-primary" />
            </div>
            <div className="min-w-0">
              <div className="text-xs font-display font-semibold uppercase tracking-wide text-text-primary/70">
                Per-minute Twilio rate
              </div>
              <div className="text-[11px] text-text-primary/50 font-body mt-0.5">
                Carrier (Twilio) per-minute charge — same rate posted to your Stripe metered usage.
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span
              data-testid="calc-twilio-rate-value"
              className="text-sm font-display font-semibold text-text-primary"
            >
              {isApprox && '≈ '}{formatPerMinute(twilioRate, displayCurrency)}/min
            </span>
            {twilioFromStripe && (
              <span
                data-testid="calc-twilio-source"
                className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-success bg-success/10 px-2 py-0.5 rounded-full"
                title="Live Stripe Twilio rate for your account — pulled from your subscription. Overrides the env-default fallback."
              >
                Live Stripe rate
              </span>
            )}
          </div>
        </div>
      )}

      <div
        className="px-6 lg:px-8 py-4 bg-surface-secondary/40 border-t border-border-strong/30 text-xs text-text-primary/60 font-body"
        data-testid="calc-disclaimer"
      >
        {isAnnual
          ? 'Annual billing saves 20% off the base plan. Estimates assume the same per-minute usage every month — overage is still billed monthly at the published rate.'
          : 'Estimates use the same per-minute rates billed by your usage meter. Only active conversation time counts toward AI minutes — hold time, ringing, and processing are not billed.'}
        {isApprox && (
          <span data-testid="calc-fx-disclaimer" className="block mt-1.5 text-text-primary/50">
            Prices shown in {displayCurrency} are an approximate conversion from the published USD list price for reference only. Final invoicing happens in your billing currency.
          </span>
        )}
      </div>
    </div>
  );
}
