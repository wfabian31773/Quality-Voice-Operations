import { useEffect, useMemo, useRef, useState } from 'react';
import { Calculator, ArrowUpRight, Sparkles, TrendingUp } from 'lucide-react';
import {
  PLAN_CATALOG,
  PLAN_TIERS,
  getPlanMonthlyPriceWholeDollars,
  type PlanTier,
} from '../../../shared/billing/planCatalog';
import {
  calculateMonthlyCost,
  calculateEffectiveRate,
} from './MinutesPricingCalculator';
import { formatDollars } from '../lib/formatCurrency';

/**
 * Live override of the catalog rates, sourced from the tenant's actual
 * Stripe subscription (`/billing/effective-rate`). When provided, these
 * values take precedence over the static `PLAN_CATALOG` for the *current*
 * tier so the estimate matches what Stripe will actually invoice for a
 * tenant on a custom / negotiated / grandfathered price. The next-tier-up
 * card always uses the published catalog price because we don't know what
 * Stripe will quote that tenant for an upgrade.
 */
export interface BillingEstimatorRateOverride {
  /** Effective monthly base price, in cents. */
  basePriceCents?: number | null;
  /** Effective per-minute overage rate, in dollars (e.g. 0.12 = $0.12/min). */
  overageRatePerMinute?: number | null;
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
   * Multiplier used to project end-of-month minutes from MTD usage.
   * Computed by the parent as `daysInMonth / dayOfMonth`.
   */
  projectionMultiplier?: number;
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
}

const MIN_MINUTES = 0;
const MAX_MINUTES = 25_000;
const STEP_MINUTES = 50;

function toTierSpec(
  key: PlanTier,
  override?: BillingEstimatorRateOverride,
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
    ? Math.round(overrideBaseCents / 100)
    : getPlanMonthlyPriceWholeDollars(plan.key);
  const overageRate = overrideOverage != null
    ? overrideOverage
    : plan.overageRatePerMinute;

  return {
    key: plan.key,
    name: plan.name,
    basePrice,
    includedMinutes: plan.includedMinutes,
    overageRate,
    sourcedFromStripe: overrideBaseCents != null || overrideOverage != null,
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

function formatMoney(value: number): string {
  return formatDollars(value, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatPerMinute(value: number): string {
  return formatDollars(value, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

function clampMinutes(value: number): number {
  if (!Number.isFinite(value)) return MIN_MINUTES;
  return Math.max(MIN_MINUTES, Math.min(MAX_MINUTES, Math.round(value)));
}

function TierEstimate({
  tier,
  minutes,
  label,
  highlight,
}: {
  tier: TierSpec;
  minutes: number;
  label: string;
  highlight?: boolean;
}) {
  const monthlyCost = calculateMonthlyCost(tier, minutes);
  const overageMinutes = Math.max(0, minutes - tier.includedMinutes);
  const overageCost = overageMinutes * tier.overageRate;
  const effectiveRate = minutes > 0 ? calculateEffectiveRate(tier, minutes) : 0;

  return (
    <div
      data-testid={`billing-estimator-tier-${tier.key}`}
      className={`flex-1 rounded-lg border p-4 transition-colors ${
        highlight
          ? 'border-primary/40 bg-primary/[0.04]'
          : 'border-border bg-surface-hover/40'
      }`}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-medium uppercase tracking-wide text-text-muted">
          {label}
        </span>
        {highlight && (
          <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-primary bg-primary/10 px-2 py-0.5 rounded-full">
            <ArrowUpRight className="h-3 w-3" />
            Next tier
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
    </div>
  );
}

export default function BillingEstimator({
  currentPlan,
  monthToDateAiMinutes,
  rateOverride,
  projectionMultiplier,
}: BillingEstimatorProps) {
  const currentTierKey = normalizePlan(currentPlan);
  // Only the current tier gets the Stripe override — the next-tier card has
  // to use catalog defaults because we have no way to know what Stripe
  // would quote that tenant on a higher plan they aren't subscribed to.
  const currentTier = useMemo(
    () => toTierSpec(currentTierKey, rateOverride),
    [currentTierKey, rateOverride],
  );
  const nextTierKey = useMemo(() => nextTierUp(currentTierKey), [currentTierKey]);
  const nextTier = useMemo(
    () => (nextTierKey ? toTierSpec(nextTierKey) : null),
    [nextTierKey],
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
                : 'Drag the slider to model a different AI minute volume and see what your invoice would look like on your current plan and the next tier up.'}
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
        <TierEstimate tier={currentTier} minutes={safeMinutes} label="Current plan" />
        {nextTier ? (
          <TierEstimate
            tier={nextTier}
            minutes={safeMinutes}
            label="Next tier up"
            highlight
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
