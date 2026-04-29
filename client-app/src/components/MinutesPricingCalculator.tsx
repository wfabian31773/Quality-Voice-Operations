import { useMemo, useState } from 'react';
import { Calculator, Sparkles } from 'lucide-react';
import { formatDollars } from '../lib/formatCurrency';
import { PLAN_CATALOG, PLAN_TIERS, getPlanMonthlyPriceWholeDollars, type PlanTier } from '../../../shared/billing/planCatalog';

interface CalculatorTier {
  key: PlanTier;
  name: string;
  basePrice: number;
  includedMinutes: number;
  overageRate: number;
  popular?: boolean;
}

export type BillingPeriod = 'monthly' | 'annual';

const POPULAR_TIER: PlanTier = 'pro';
export const ANNUAL_DISCOUNT = 0.2;

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

function formatCurrency(value: number): string {
  return formatDollars(value, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatPerMinute(value: number): string {
  return formatDollars(value, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
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

export interface MinutesPricingCalculatorProps {
  billingPeriod?: BillingPeriod;
  onBillingPeriodChange?: (period: BillingPeriod) => void;
}

export default function MinutesPricingCalculator({
  billingPeriod: billingPeriodProp,
  onBillingPeriodChange,
}: MinutesPricingCalculatorProps = {}) {
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
    return CALC_TIERS.map((tier) => {
      const effectiveBase = getDiscountedBasePrice(tier.basePrice, billingPeriod);
      const billingTier = { ...tier, basePrice: effectiveBase };
      const monthlyCost = calculateMonthlyCost(billingTier, safeMinutes);
      const effectiveRate = safeMinutes > 0 ? monthlyCost / safeMinutes : 0;
      const overageMinutes = Math.max(0, safeMinutes - tier.includedMinutes);
      const overageCost = overageMinutes * tier.overageRate;
      const annualSavings = (tier.basePrice - effectiveBase) * 12;
      return { tier, effectiveBase, monthlyCost, effectiveRate, overageMinutes, overageCost, annualSavings };
    });
  }, [minutes, billingPeriod]);

  const cheapest = useMemo(() => {
    if (minutes <= 0) return null;
    return results.reduce((best, current) =>
      current.monthlyCost < best.monthlyCost ? current : best,
    results[0]);
  }, [results, minutes]);

  const isAnnual = billingPeriod === 'annual';

  return (
    <div className="bg-white rounded-2xl border border-border-strong/50 shadow-sm overflow-hidden">
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
            className="inline-flex items-center bg-white border border-border-strong/50 rounded-lg p-0.5 shrink-0"
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
                  isAnnual ? 'bg-white/20 text-white' : 'bg-success/10 text-success'
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
        {results.map(({ tier, effectiveBase, monthlyCost, effectiveRate, overageMinutes, overageCost, annualSavings }) => {
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
                    className="font-display text-3xl font-bold text-text-primary"
                  >
                    {formatCurrency(monthlyCost)}
                  </span>
                  <span className="text-xs text-text-primary/50 font-body">/mo est.</span>
                </div>
                <div
                  data-testid={`calc-effective-${tier.key}`}
                  className="text-sm text-text-primary/70 font-body mt-1"
                >
                  {minutes > 0 ? formatPerMinute(effectiveRate) : '—'} effective per minute
                </div>
                {isAnnual && (
                  <div
                    data-testid={`calc-savings-${tier.key}`}
                    className="text-[11px] text-success font-body font-medium mt-1.5"
                  >
                    Saves {formatCurrency(annualSavings)}/yr vs monthly billing
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
                    {isAnnual ? (
                      <span className="inline-flex items-baseline gap-1.5">
                        <span className="line-through text-text-primary/40">{formatCurrency(tier.basePrice)}</span>
                        <span>{formatCurrency(effectiveBase)}/mo</span>
                      </span>
                    ) : (
                      <span>{formatCurrency(tier.basePrice)}/mo</span>
                    )}
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-text-primary/50">Minutes included</dt>
                  <dd className="text-text-primary font-medium">{tier.includedMinutes.toLocaleString()}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-text-primary/50">Overage rate</dt>
                  <dd className="text-text-primary font-medium">{formatPerMinute(tier.overageRate)}/min</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-text-primary/50">Overage this month</dt>
                  <dd className={`font-medium ${overageMinutes > 0 ? 'text-danger' : 'text-success'}`}>
                    {overageMinutes > 0
                      ? `${overageMinutes.toLocaleString()} min · ${formatCurrency(overageCost)}`
                      : 'None'}
                  </dd>
                </div>
              </dl>
            </div>
          );
        })}
      </div>

      <div className="px-6 lg:px-8 py-4 bg-surface-secondary/40 border-t border-border-strong/30 text-xs text-text-primary/60 font-body">
        {isAnnual
          ? 'Annual billing saves 20% off the base plan. Estimates assume the same per-minute usage every month — overage is still billed monthly at the published rate.'
          : 'Estimates use the same per-minute rates billed by your usage meter. Only active conversation time counts toward AI minutes — hold time, ringing, and processing are not billed.'}
      </div>
    </div>
  );
}
