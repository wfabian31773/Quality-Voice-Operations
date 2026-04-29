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

export const PLAN_MONTHLY_PRICE_CENTS: Record<PlanTier, number> = {
  starter: PLAN_CATALOG.starter.monthlyPriceCents,
  pro: PLAN_CATALOG.pro.monthlyPriceCents,
  enterprise: PLAN_CATALOG.enterprise.monthlyPriceCents,
};
