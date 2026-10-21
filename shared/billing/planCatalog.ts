import { centsToWholeDollars } from './formatCurrency';

export type PlanTier = 'starter' | 'pro' | 'enterprise';

export interface PlanCatalogEntry {
  key: PlanTier;
  name: string;
  monthlyPriceCents: number;
  includedMinutes: number;
  overageRatePerMinute: number;
}

export const PLAN_CATALOG: Record<PlanTier, PlanCatalogEntry> = {
  starter: {
    key: 'starter',
    name: 'Starter',
    monthlyPriceCents: 14_900,
    includedMinutes: 500,
    overageRatePerMinute: 0.25,
  },
  pro: {
    key: 'pro',
    name: 'Pro',
    monthlyPriceCents: 34_900,
    includedMinutes: 1_500,
    overageRatePerMinute: 0.22,
  },
  enterprise: {
    key: 'enterprise',
    name: 'Enterprise',
    monthlyPriceCents: 79_900,
    includedMinutes: 3_000,
    overageRatePerMinute: 0.18,
  },
};

export const PLAN_TIERS: PlanTier[] = ['starter', 'pro', 'enterprise'];

/**
 * Discount applied to the published monthly base price when a tenant
 * commits to annual billing (e.g. 0.15 == 15% off). Lives in the shared
 * catalog so the public pricing page, the in-app billing estimator, and
 * the plan-recommendation engine can all reason about annual pricing
 * with the same constant.
 *
 * Carrier (Twilio voice and SMS) costs are folded into the plan price:
 * there is no separate per-minute or per-message carrier charge.
 */
export const ANNUAL_DISCOUNT = 0.15;

export function getPlan(tier: PlanTier): PlanCatalogEntry {
  return PLAN_CATALOG[tier];
}

export function getPlanMonthlyPriceCents(tier: PlanTier): number {
  return PLAN_CATALOG[tier].monthlyPriceCents;
}

export { centsToWholeDollars };

export function getPlanMonthlyPriceWholeDollars(tier: PlanTier): number {
  return centsToWholeDollars(PLAN_CATALOG[tier].monthlyPriceCents);
}

/**
 * Discount the published monthly price by ANNUAL_DISCOUNT and round to a
 * whole-dollar figure. Used wherever we display the annual-billing
 * monthly-equivalent price (the strikethrough/discounted pair on the
 * /pricing tier card and on the in-page MinutesPricingCalculator). The
 * rounding is what makes the per-tier annual savings — `(monthly −
 * annualMonthly) × 12` — render as a clean dollar amount ($264 / $624 /
 * $1,440 at catalog prices) instead of a fractional carry-through like
 * $268.20. Centralising it here keeps the marketing card and the
 * calculator in lockstep so the two figures never drift.
 */
export function getDiscountedAnnualMonthlyDollars(monthlyDollars: number): number {
  return Math.round(monthlyDollars * (1 - ANNUAL_DISCOUNT));
}

/**
 * Catalog reference price for the annual billing interval, expressed in
 * cents per month (i.e. annual yearly price ÷ 12). Mirrors the rounding
 * convention used everywhere else we project the discounted annual rate
 * so the public pricing card, the calculator, and the custom-rate
 * callout all reason about the same per-month cents figure.
 */
export function getAnnualMonthlyPriceCents(tier: PlanTier): number {
  return Math.round(PLAN_CATALOG[tier].monthlyPriceCents * (1 - ANNUAL_DISCOUNT));
}

export const PLAN_MONTHLY_PRICE_CENTS: Record<PlanTier, number> = {
  starter: PLAN_CATALOG.starter.monthlyPriceCents,
  pro: PLAN_CATALOG.pro.monthlyPriceCents,
  enterprise: PLAN_CATALOG.enterprise.monthlyPriceCents,
};
