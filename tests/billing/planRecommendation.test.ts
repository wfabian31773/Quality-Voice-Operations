import { describe, it, expect } from 'vitest';
import {
  averageTrailingMinutes,
  recommendCheapestPlan,
} from '../../shared/billing/planRecommendation';
import { PLAN_CATALOG } from '../../shared/billing/planCatalog';

describe('averageTrailingMinutes', () => {
  it('returns 0 for an empty list (no recommendation possible yet)', () => {
    expect(averageTrailingMinutes([])).toBe(0);
  });

  it('averages plain numeric inputs', () => {
    expect(averageTrailingMinutes([100, 200, 300])).toBe(200);
  });

  it('skips NaN, Infinity, and negative entries instead of poisoning the mean', () => {
    expect(averageTrailingMinutes([100, Number.NaN, Infinity, -50, 300])).toBe(200);
  });
});

describe('recommendCheapestPlan', () => {
  it('returns null for non-finite or negative averages so the UI can hide the card', () => {
    expect(recommendCheapestPlan('starter', Number.NaN)).toBeNull();
    expect(recommendCheapestPlan('starter', -10)).toBeNull();
  });

  it('recommends Starter when a Pro tenant averages well under Pro included minutes', () => {
    // Starter @ 300 min: $149 (no overage, within 500 included)
    // Pro @ 300 min: $349 (within 1,500 included)
    // Switching to Starter saves $200/mo.
    const rec = recommendCheapestPlan('pro', 300)!;
    expect(rec).not.toBeNull();
    expect(rec.recommended.tier).toBe('starter');
    expect(rec.current.tier).toBe('pro');
    expect(rec.current.monthlyCost).toBe(349);
    expect(rec.recommended.monthlyCost).toBe(149);
    expect(rec.monthlySavings).toBe(200);
    expect(rec.annualSavings).toBe(2_400);
    expect(rec.isAlreadyOptimal).toBe(false);
  });

  it('flags the current plan as optimal when no other tier is cheaper', () => {
    // Starter @ 100 min: $149 base, no overage. Every other plan is more
    // expensive at this volume, so the recommendation should be Starter.
    const rec = recommendCheapestPlan('starter', 100)!;
    expect(rec.isAlreadyOptimal).toBe(true);
    expect(rec.recommended.tier).toBe('starter');
    expect(rec.monthlySavings).toBe(0);
    expect(rec.annualSavings).toBe(0);
  });

  it('recommends Pro when a Starter tenant blows past included minutes', () => {
    // Starter    @ 4,000 min: $149 + 3,500 * $0.25 = $1,024
    // Pro        @ 4,000 min: $349 + 2,500 * $0.22 = $899
    // Enterprise @ 4,000 min: $799 + 1,000 * $0.18 = $979
    // Pro is cheapest, beating Starter by $125/mo.
    const rec = recommendCheapestPlan('starter', 4_000)!;
    expect(rec.recommended.tier).toBe('pro');
    expect(rec.current.monthlyCost).toBe(1_024);
    expect(rec.recommended.monthlyCost).toBe(899);
    expect(rec.monthlySavings).toBe(125);
    expect(rec.isAlreadyOptimal).toBe(false);
  });

  it('honors a Stripe rate override on the current plan only', () => {
    // Pro tenant on a discounted $299 base; comparison tiers stay at catalog.
    // Starter @ 300 min = $149, discounted Pro @ 300 min = $299.
    // Savings switching to Starter: $150/mo (vs. $200 with no override).
    const rec = recommendCheapestPlan('pro', 300, {
      basePriceCents: 29_900,
      overageRatePerMinute: PLAN_CATALOG.pro.overageRatePerMinute,
    })!;
    expect(rec.current.monthlyCost).toBe(299);
    expect(rec.current.sourcedFromStripe).toBe(true);
    expect(rec.recommended.tier).toBe('starter');
    expect(rec.recommended.monthlyCost).toBe(149);
    expect(rec.monthlySavings).toBe(150);
  });

  it('falls back to the catalog when rate-override fields are nullish/non-finite', () => {
    const rec = recommendCheapestPlan('pro', 300, {
      basePriceCents: null,
      overageRatePerMinute: Number.NaN,
    })!;
    expect(rec.current.sourcedFromStripe).toBe(false);
    expect(rec.current.monthlyCost).toBe(349);
  });

  it('treats unknown plan strings as Starter (matches BillingEstimator fallback)', () => {
    const rec = recommendCheapestPlan('legacy-flex', 200)!;
    expect(rec.current.tier).toBe('starter');
    expect(rec.isAlreadyOptimal).toBe(true);
  });

  describe('annual option', () => {
    it('quotes the recommended tier at the 15%-off-base annual rate', () => {
      // Pro tenant @ 300 min: monthly recommendation is Starter @ $149,
      // saves $200/mo. Annual variant: Starter base $149 * 0.85 = $126.65
      // (unrounded). Savings vs. current Pro $349 = $222.35/mo,
      // $2,668.20/yr.
      const rec = recommendCheapestPlan('pro', 300)!;
      // Monthly variant unaffected.
      expect(rec.recommended.tier).toBe('starter');
      expect(rec.recommended.monthlyCost).toBe(149);
      expect(rec.monthlySavings).toBe(200);
      // Annual variant: discount applied only to base. The catalog
      // stores cents so the result is exact ($149 * 0.85 = $126.65). We
      // assert via the math (not a hard-coded "126.65") so the test
      // stays robust to minor catalog tweaks.
      expect(rec.recommended.annualMonthlyCost).toBeCloseTo(149 * 0.85, 6);
      expect(rec.annualOption.monthlyCost).toBeCloseTo(149 * 0.85, 6);
      expect(rec.annualOption.monthlySavings).toBeCloseTo(349 - 149 * 0.85, 6);
      expect(rec.annualOption.annualSavings).toBeCloseTo((349 - 149 * 0.85) * 12, 6);
    });

    it('keeps overage at the catalog rate when applying the annual discount', () => {
      // Starter tenant @ 4,000 min: Pro is cheapest monthly ($899),
      // saves $125/mo. Annual: Pro base $349 * 0.85 = $296.65, plus
      // overage 2,500 * $0.22 = $550 → $846.65. Savings vs. current
      // Starter $1,024: $177.35/mo.
      const rec = recommendCheapestPlan('starter', 4_000)!;
      expect(rec.recommended.tier).toBe('pro');
      expect(rec.recommended.monthlyCost).toBe(899);
      expect(rec.recommended.annualMonthlyCost).toBeCloseTo(349 * 0.85 + 2500 * 0.22, 6);
      expect(rec.annualOption.monthlySavings).toBeCloseTo(1024 - (349 * 0.85 + 2500 * 0.22), 6);
    });

    it('skips the annual discount on a Stripe-overridden current tier (no fabricated discount)', () => {
      // Pro tenant on a $299 negotiated base; the override IS the rate
      // they pay today, so we don't pretend to know what an annual
      // commit would quote. annualMonthlyCost on the current tier
      // collapses to the override-derived monthlyCost.
      const rec = recommendCheapestPlan('pro', 300, {
        basePriceCents: 29_900,
        overageRatePerMinute: 0.12,
      })!;
      expect(rec.current.sourcedFromStripe).toBe(true);
      expect(rec.current.monthlyCost).toBe(299);
      expect(rec.current.annualMonthlyCost).toBe(299);
      // Recommended (Starter) is still catalog so it gets the discount.
      expect(rec.recommended.tier).toBe('starter');
      expect(rec.recommended.annualMonthlyCost).toBeCloseTo(149 * 0.85, 6);
      expect(rec.annualOption.monthlySavings).toBeCloseTo(299 - 149 * 0.85, 6);
    });

    it('reports zero annual savings when the current plan is already optimal and is overridden', () => {
      // Starter tenant on a $79 negotiated base — already optimal.
      // recommended === current (overridden), so annualOption should
      // collapse to zero rather than pretend to discount the override.
      const rec = recommendCheapestPlan('starter', 100, {
        basePriceCents: 7_900,
      })!;
      expect(rec.isAlreadyOptimal).toBe(true);
      expect(rec.recommended.tier).toBe('starter');
      expect(rec.recommended.sourcedFromStripe).toBe(true);
      expect(rec.annualOption.monthlySavings).toBe(0);
      expect(rec.annualOption.annualSavings).toBe(0);
    });
  });
});
