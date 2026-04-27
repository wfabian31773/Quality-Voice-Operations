import { describe, it, expect } from 'vitest';
import {
  PLAN_CATALOG,
  PLAN_MONTHLY_PRICE_CENTS,
  PLAN_TIERS,
  getPlanMonthlyPriceCents,
  getPlanMonthlyPriceWholeDollars,
} from '../../shared/billing/planCatalog';
import { PLAN_MONTHLY_PRICE_CENTS as STRIPE_PLAN_MONTHLY_PRICE_CENTS } from '../../platform/billing/stripe/plans';

describe('plan catalog (single source of truth)', () => {
  it('exposes one canonical price unit (cents) for every tier', () => {
    for (const tier of PLAN_TIERS) {
      const entry = PLAN_CATALOG[tier];
      expect(typeof entry.monthlyPriceCents).toBe('number');
      expect(Number.isInteger(entry.monthlyPriceCents)).toBe(true);
      expect(entry.monthlyPriceCents).toBeGreaterThan(0);
    }
  });

  it('derives whole-dollar prices from cents (no parallel literal)', () => {
    for (const tier of PLAN_TIERS) {
      const cents = PLAN_CATALOG[tier].monthlyPriceCents;
      expect(getPlanMonthlyPriceWholeDollars(tier)).toBe(Math.round(cents / 100));
    }
  });

  it('keeps the cents-map and helper aligned with PLAN_CATALOG', () => {
    for (const tier of PLAN_TIERS) {
      expect(PLAN_MONTHLY_PRICE_CENTS[tier]).toBe(PLAN_CATALOG[tier].monthlyPriceCents);
      expect(getPlanMonthlyPriceCents(tier)).toBe(PLAN_CATALOG[tier].monthlyPriceCents);
    }
  });

  it('is the same map that the admin MRR calculation reads through platform/billing/stripe/plans', () => {
    expect(STRIPE_PLAN_MONTHLY_PRICE_CENTS).toBe(PLAN_MONTHLY_PRICE_CENTS);
  });
});
