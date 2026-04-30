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
    // Starter @ 300 min: $99 (no overage, within 500 included)
    // Pro @ 300 min: $399 (within 2,500 included)
    // Switching to Starter saves $300/mo.
    const rec = recommendCheapestPlan('pro', 300)!;
    expect(rec).not.toBeNull();
    expect(rec.recommended.tier).toBe('starter');
    expect(rec.current.tier).toBe('pro');
    expect(rec.current.monthlyCost).toBe(399);
    expect(rec.recommended.monthlyCost).toBe(99);
    expect(rec.monthlySavings).toBe(300);
    expect(rec.annualSavings).toBe(3_600);
    expect(rec.isAlreadyOptimal).toBe(false);
  });

  it('flags the current plan as optimal when no other tier is cheaper', () => {
    // Starter @ 100 min: $99 base, no overage. Every other plan is more
    // expensive at this volume, so the recommendation should be Starter.
    const rec = recommendCheapestPlan('starter', 100)!;
    expect(rec.isAlreadyOptimal).toBe(true);
    expect(rec.recommended.tier).toBe('starter');
    expect(rec.monthlySavings).toBe(0);
    expect(rec.annualSavings).toBe(0);
  });

  it('recommends Pro when a Starter tenant blows past included minutes', () => {
    // Starter @ 4,000 min: $99 + 3,500 * $0.15 = $624
    // Pro    @ 4,000 min: $399 + 1,500 * $0.12 = $579
    // Pro is cheaper by $45/mo.
    const rec = recommendCheapestPlan('starter', 4_000)!;
    expect(rec.recommended.tier).toBe('pro');
    expect(rec.current.monthlyCost).toBe(624);
    expect(rec.recommended.monthlyCost).toBe(579);
    expect(rec.monthlySavings).toBe(45);
    expect(rec.isAlreadyOptimal).toBe(false);
  });

  it('honors a Stripe rate override on the current plan only', () => {
    // Pro tenant on a discounted $299 base; comparison tiers stay at catalog.
    // Starter @ 300 min = $99, discounted Pro @ 300 min = $299.
    // Savings switching to Starter: $200/mo (vs. $300 with no override).
    const rec = recommendCheapestPlan('pro', 300, {
      basePriceCents: 29_900,
      overageRatePerMinute: PLAN_CATALOG.pro.overageRatePerMinute,
    })!;
    expect(rec.current.monthlyCost).toBe(299);
    expect(rec.current.sourcedFromStripe).toBe(true);
    expect(rec.recommended.tier).toBe('starter');
    expect(rec.recommended.monthlyCost).toBe(99);
    expect(rec.monthlySavings).toBe(200);
  });

  it('falls back to the catalog when rate-override fields are nullish/non-finite', () => {
    const rec = recommendCheapestPlan('pro', 300, {
      basePriceCents: null,
      overageRatePerMinute: Number.NaN,
    })!;
    expect(rec.current.sourcedFromStripe).toBe(false);
    expect(rec.current.monthlyCost).toBe(399);
  });

  it('treats unknown plan strings as Starter (matches BillingEstimator fallback)', () => {
    const rec = recommendCheapestPlan('legacy-flex', 200)!;
    expect(rec.current.tier).toBe('starter');
    expect(rec.isAlreadyOptimal).toBe(true);
  });
});
