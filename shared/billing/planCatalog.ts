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
    monthlyPriceCents: 9_900,
    includedMinutes: 500,
    overageRatePerMinute: 0.15,
  },
  pro: {
    key: 'pro',
    name: 'Pro',
    monthlyPriceCents: 39_900,
    includedMinutes: 2_500,
    overageRatePerMinute: 0.12,
  },
  enterprise: {
    key: 'enterprise',
    name: 'Enterprise',
    monthlyPriceCents: 99_900,
    includedMinutes: 10_000,
    overageRatePerMinute: 0.08,
  },
};

export const PLAN_TIERS: PlanTier[] = ['starter', 'pro', 'enterprise'];

/**
 * Published per-message SMS rate, in dollars/message. SMS pricing is
 * tenant-wide rather than per-tier, so it lives outside `PLAN_CATALOG`.
 *
 * MUST be kept in lockstep with the server-side env default
 * `SMS_COST_PER_MESSAGE_CENTS` (see
 * `platform/billing/stripe/effectiveRate.ts:defaultSmsRatePerMessageDollars`):
 * the public pricing callout uses this constant as the catalog reference
 * when comparing a tenant's negotiated Stripe SMS rate (task #1327), so
 * a divergence here would falsely render a "you pay $X vs $Y" delta
 * against the wrong baseline.
 */
export const CATALOG_SMS_RATE_PER_MESSAGE = 0.01;

/**
 * Discount applied to the published monthly base price when a tenant
 * commits to annual billing (e.g. 0.2 == 20% off). Lives in the shared
 * catalog so the public pricing page, the in-app billing estimator, and
 * the plan-recommendation engine can all reason about annual pricing
 * with the same constant.
 */
export const ANNUAL_DISCOUNT = 0.2;

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
 * annualMonthly) × 12` — render as a clean dollar amount ($240 / $960 /
 * $2,400 at catalog prices) instead of a fractional carry-through like
 * $237.60. Centralising it here keeps the marketing card and the
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
