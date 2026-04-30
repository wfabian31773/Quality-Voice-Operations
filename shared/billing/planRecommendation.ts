/**
 * Pure helpers for deciding which published plan would have been cheapest
 * for a tenant given their recent AI-minute volume. Used by the tenant
 * billing estimator to render an actionable "you would have saved $X on
 * Starter last quarter" recommendation.
 *
 * Lives in `shared/` so the React component, server endpoints, and
 * vitest specs can all import the same arithmetic and stay drift-free.
 */
import {
  PLAN_CATALOG,
  PLAN_TIERS,
  type PlanCatalogEntry,
  type PlanTier,
} from './planCatalog';
import { centsToWholeDollars } from './formatCurrency';

/**
 * Optional Stripe-sourced override for the tenant's *current* plan only.
 * The recommendation engine deliberately uses catalog defaults for every
 * other tier — we have no way to know what Stripe would actually quote
 * the tenant for a plan they don't yet have.
 */
export interface PlanRateOverride {
  /** Effective monthly base price for the current plan, in cents. */
  basePriceCents?: number | null;
  /** Effective per-minute overage rate for the current plan, in dollars. */
  overageRatePerMinute?: number | null;
}

export interface PlanCostBreakdown {
  tier: PlanTier;
  /** Plan display name (e.g. "Starter"). */
  name: string;
  /** Monthly base price in whole dollars (already override-adjusted for the current tier). */
  basePrice: number;
  /** Per-minute overage rate in dollars. */
  overageRate: number;
  /** Plan-included minutes per month. */
  includedMinutes: number;
  /** Cost in whole dollars at `minutes` of monthly usage. */
  monthlyCost: number;
  /** True when this tier's pricing was sourced from the override (Stripe), not the catalog. */
  sourcedFromStripe: boolean;
}

export interface PlanRecommendation {
  /** Trailing average AI minutes/month used to drive the recommendation. */
  averageMinutes: number;
  /** Cost breakdown for the tenant's current plan at `averageMinutes`. */
  current: PlanCostBreakdown;
  /** Cheapest tier (by monthly cost at `averageMinutes`). */
  recommended: PlanCostBreakdown;
  /**
   * Projected monthly savings vs. the current plan, in whole dollars.
   * Always >= 0; equals 0 when the current plan is already optimal.
   */
  monthlySavings: number;
  /** Same savings extrapolated to a full year, in whole dollars. */
  annualSavings: number;
  /** True when the current plan already has the lowest cost (or is tied). */
  isAlreadyOptimal: boolean;
}

function planCost(plan: PlanCatalogEntry, minutes: number, basePrice: number, overageRate: number): number {
  const overage = Math.max(0, minutes - plan.includedMinutes);
  return basePrice + overage * overageRate;
}

function toBreakdown(
  plan: PlanCatalogEntry,
  minutes: number,
  override?: PlanRateOverride,
): PlanCostBreakdown {
  const overrideBase =
    override?.basePriceCents != null && Number.isFinite(override.basePriceCents)
      ? centsToWholeDollars(override.basePriceCents)
      : null;
  const overrideOverage =
    override?.overageRatePerMinute != null && Number.isFinite(override.overageRatePerMinute)
      ? override.overageRatePerMinute
      : null;

  const basePrice = overrideBase ?? centsToWholeDollars(plan.monthlyPriceCents);
  const overageRate = overrideOverage ?? plan.overageRatePerMinute;

  return {
    tier: plan.key,
    name: plan.name,
    basePrice,
    overageRate,
    includedMinutes: plan.includedMinutes,
    monthlyCost: planCost(plan, minutes, basePrice, overageRate),
    sourcedFromStripe: overrideBase != null || overrideOverage != null,
  };
}

function normalizeTier(plan: string): PlanTier {
  return (PLAN_TIERS as string[]).includes(plan) ? (plan as PlanTier) : 'starter';
}

/**
 * Returns the cheapest published plan for the given trailing usage and a
 * full cost breakdown vs. the tenant's current plan. The current tier
 * always uses `currentRateOverride` when provided so the comparison
 * matches what Stripe will actually invoice; comparison tiers always use
 * catalog defaults because there is no way to know what Stripe would
 * quote the tenant on a plan they aren't subscribed to.
 *
 * Returns null only when `averageMinutes` is non-finite or negative —
 * callers should hide the recommendation card in that case rather than
 * render misleading numbers.
 */
export function recommendCheapestPlan(
  currentPlan: string,
  averageMinutes: number,
  currentRateOverride?: PlanRateOverride,
): PlanRecommendation | null {
  if (!Number.isFinite(averageMinutes) || averageMinutes < 0) return null;

  const minutes = Math.max(0, Math.round(averageMinutes));
  const currentTier = normalizeTier(currentPlan);

  const current = toBreakdown(PLAN_CATALOG[currentTier], minutes, currentRateOverride);

  let cheapest: PlanCostBreakdown = current;
  for (const tier of PLAN_TIERS) {
    if (tier === currentTier) continue;
    const candidate = toBreakdown(PLAN_CATALOG[tier], minutes);
    if (candidate.monthlyCost < cheapest.monthlyCost) {
      cheapest = candidate;
    }
  }

  const monthlySavings = Math.max(0, current.monthlyCost - cheapest.monthlyCost);
  const isAlreadyOptimal = cheapest.tier === current.tier || monthlySavings <= 0;

  return {
    averageMinutes: minutes,
    current,
    recommended: isAlreadyOptimal ? current : cheapest,
    monthlySavings,
    annualSavings: monthlySavings * 12,
    isAlreadyOptimal,
  };
}

/**
 * Average a list of per-month minute totals, ignoring entries whose
 * value is non-finite. Returns 0 when the list is empty so the caller
 * doesn't have to special-case "no usage history yet" — the UI hides
 * the recommendation card in that scenario instead.
 */
export function averageTrailingMinutes(monthlyTotals: ReadonlyArray<number>): number {
  const valid = monthlyTotals.filter(
    (n) => Number.isFinite(n) && n >= 0,
  );
  if (valid.length === 0) return 0;
  const sum = valid.reduce((acc, n) => acc + n, 0);
  return sum / valid.length;
}
