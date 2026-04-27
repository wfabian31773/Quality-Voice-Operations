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

export default function MinutesPricingCalculator() {
  const [minutes, setMinutes] = useState<number>(1_500);

  const results = useMemo(() => {
    const safeMinutes = Math.max(0, Math.min(MAX_MINUTES, Math.round(minutes)));
    return CALC_TIERS.map((tier) => {
      const monthlyCost = calculateMonthlyCost(tier, safeMinutes);
      const effectiveRate = safeMinutes > 0 ? monthlyCost / safeMinutes : 0;
      const overageMinutes = Math.max(0, safeMinutes - tier.includedMinutes);
      const overageCost = overageMinutes * tier.overageRate;
      return { tier, monthlyCost, effectiveRate, overageMinutes, overageCost };
    });
  }, [minutes]);

  const cheapest = useMemo(() => {
    if (minutes <= 0) return null;
    return results.reduce((best, current) =>
      current.monthlyCost < best.monthlyCost ? current : best,
    results[0]);
  }, [results, minutes]);

  return (
    <div className="bg-white rounded-2xl border border-soft-steel/50 shadow-sm overflow-hidden">
      <div className="p-6 lg:p-8 border-b border-soft-steel/30 bg-mist/30">
        <div className="flex items-start gap-3 mb-5">
          <div className="w-9 h-9 rounded-lg bg-teal/10 flex items-center justify-center shrink-0">
            <Calculator className="h-4.5 w-4.5 text-teal" />
          </div>
          <div>
            <h3 className="font-display text-lg font-bold text-harbor">Estimate your monthly bill</h3>
            <p className="text-sm text-slate-ink/60 font-body mt-0.5">
              Pick how many AI minutes you expect to use each month and see the effective per-minute price for every plan.
            </p>
          </div>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-4">
            <label htmlFor="minutes-slider" className="text-sm font-medium text-harbor">
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
                className="w-28 px-3 py-1.5 rounded-lg border border-soft-steel/50 text-sm font-display font-bold text-harbor text-right focus:outline-none focus:ring-2 focus:ring-teal/40"
                aria-label="Monthly AI minutes"
              />
              <span className="text-sm text-slate-ink/60 font-body">min/mo</span>
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
            className="w-full h-2 bg-soft-steel/40 rounded-lg appearance-none cursor-pointer accent-teal"
            aria-label="Adjust monthly AI minutes"
          />
          <div className="flex justify-between text-xs text-slate-ink/40 font-body">
            <span>{MIN_MINUTES.toLocaleString()} min</span>
            <span>{(MAX_MINUTES / 1000).toFixed(0)},000 min</span>
          </div>
        </div>
      </div>

      <div className="grid md:grid-cols-3 divide-y md:divide-y-0 md:divide-x divide-soft-steel/30">
        {results.map(({ tier, monthlyCost, effectiveRate, overageMinutes, overageCost }) => {
          const isBest = cheapest && cheapest.tier.key === tier.key && minutes > 0;
          return (
            <div
              key={tier.key}
              data-testid={`calc-tier-${tier.key}`}
              className={`p-6 transition-colors ${
                isBest ? 'bg-teal/[0.04]' : ''
              }`}
            >
              <div className="flex items-center justify-between mb-3">
                <span className={`font-display text-sm font-semibold ${tier.popular ? 'text-teal' : 'text-harbor'}`}>
                  {tier.name}
                </span>
                {isBest && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-teal bg-teal/10 px-2 py-0.5 rounded-full">
                    <Sparkles className="h-3 w-3" />
                    Best value
                  </span>
                )}
              </div>

              <div className="mb-4">
                <div className="flex items-baseline gap-1">
                  <span
                    data-testid={`calc-monthly-${tier.key}`}
                    className="font-display text-3xl font-bold text-harbor"
                  >
                    {formatCurrency(monthlyCost)}
                  </span>
                  <span className="text-xs text-slate-ink/50 font-body">/mo est.</span>
                </div>
                <div
                  data-testid={`calc-effective-${tier.key}`}
                  className="text-sm text-slate-ink/70 font-body mt-1"
                >
                  {minutes > 0 ? formatPerMinute(effectiveRate) : '—'} effective per minute
                </div>
              </div>

              <dl className="space-y-1.5 text-xs font-body border-t border-soft-steel/30 pt-3">
                <div className="flex justify-between">
                  <dt className="text-slate-ink/50">Base plan</dt>
                  <dd className="text-harbor font-medium">{formatCurrency(tier.basePrice)}/mo</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-ink/50">Minutes included</dt>
                  <dd className="text-harbor font-medium">{tier.includedMinutes.toLocaleString()}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-ink/50">Overage rate</dt>
                  <dd className="text-harbor font-medium">{formatPerMinute(tier.overageRate)}/min</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-ink/50">Overage this month</dt>
                  <dd className={`font-medium ${overageMinutes > 0 ? 'text-controlled-red' : 'text-calm-green'}`}>
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

      <div className="px-6 lg:px-8 py-4 bg-mist/40 border-t border-soft-steel/30 text-xs text-slate-ink/60 font-body">
        Estimates use the same per-minute rates billed by your usage meter. Only active conversation time counts toward AI minutes — hold time, ringing, and processing are not billed.
      </div>
    </div>
  );
}
