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
  ANNUAL_DISCOUNT,
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
  /**
   * Same as `monthlyCost` but with the standard annual discount applied
   * to the base price (overage is unaffected). Lets the UI quote both
   * monthly and annual options for the recommended tier without having
   * to know about the discount constant. For tiers whose pricing was
   * sourced from a Stripe override (i.e. the tenant's *current* plan)
   * this falls back to `monthlyCost` because we have no way to project
   * a custom/negotiated price onto a different billing interval.
   */
  annualMonthlyCost: number;
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
  /**
   * Annual-billing variant of the recommendation. Quotes the recommended
   * tier at its annual-discounted monthly rate so the UI can offer both
   * a "switch on monthly" and a "switch on annual" CTA from the same
   * recommendation card without recomputing the discount itself.
   *
   * The savings figures compare the discounted recommended cost to the
   * tenant's *current* monthly cost (which is what they're paying right
   * now). When the current tier is already optimal at this volume, the
   * annual savings are still surfaced as the 20%-off-base figure so the
   * caller can decide whether to pitch "switch your current plan to
   * annual to save 20%" — but for an overridden current tier this
   * collapses to zero because we have no way to project a custom price
   * onto a different billing interval.
   */
  annualOption: {
    /** Recommended tier's monthly cost when billed annually, in whole dollars. */
    monthlyCost: number;
    /** Savings/mo vs. the current plan when picking annual, in whole dollars. */
    monthlySavings: number;
    /** Same savings extrapolated to a full year, in whole dollars. */
    annualSavings: number;
  };
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
  const sourcedFromStripe = overrideBase != null || overrideOverage != null;

  const monthlyCost = planCost(plan, minutes, basePrice, overageRate);
  // Annual cost reuses the same overage line — only the base price gets
  // the discount. For overridden (Stripe-sourced) tiers we deliberately
  // skip the discount because the override IS the rate the tenant pays
  // today; we have no way to project a custom/negotiated price onto a
  // different billing interval, so quoting `base * 0.8` would be a lie.
  const annualBase = sourcedFromStripe
    ? basePrice
    : basePrice * (1 - ANNUAL_DISCOUNT);
  const annualMonthlyCost = planCost(plan, minutes, annualBase, overageRate);

  return {
    tier: plan.key,
    name: plan.name,
    basePrice,
    overageRate,
    includedMinutes: plan.includedMinutes,
    monthlyCost,
    annualMonthlyCost,
    sourcedFromStripe,
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
  const recommended = isAlreadyOptimal ? current : cheapest;

  // Annual variant compares the discounted recommended cost to whatever
  // the tenant is paying right now (current.monthlyCost). If the current
  // plan was sourced from a Stripe override, recommended.annualMonthlyCost
  // collapses to its monthlyCost in the optimal-current case — which
  // correctly yields zero savings rather than fabricating a discount.
  const annualMonthlySavings = Math.max(
    0,
    current.monthlyCost - recommended.annualMonthlyCost,
  );

  return {
    averageMinutes: minutes,
    current,
    recommended,
    monthlySavings,
    annualSavings: monthlySavings * 12,
    annualOption: {
      monthlyCost: recommended.annualMonthlyCost,
      monthlySavings: annualMonthlySavings,
      annualSavings: annualMonthlySavings * 12,
    },
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
