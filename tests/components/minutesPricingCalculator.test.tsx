// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import MinutesPricingCalculator, {
  calculateMonthlyCost,
  calculateEffectiveRate,
  getDiscountedBasePrice,
  ANNUAL_DISCOUNT,
  type CurrentPlanOverride,
} from '../../client-app/src/components/MinutesPricingCalculator';

void React;

afterEach(() => cleanup());

const TIERS = {
  starter: { basePrice: 149, includedMinutes: 500, overageRate: 0.25 },
  pro: { basePrice: 349, includedMinutes: 1_500, overageRate: 0.22 },
  enterprise: { basePrice: 799, includedMinutes: 3_000, overageRate: 0.18 },
};

describe('MinutesPricingCalculator math', () => {
  it('returns base price when usage is within included minutes', () => {
    expect(calculateMonthlyCost(TIERS.starter, 250)).toBe(149);
    expect(calculateMonthlyCost(TIERS.pro, 1_500)).toBe(349);
    expect(calculateMonthlyCost(TIERS.enterprise, 3_000)).toBe(799);
  });

  it('adds overage at the published per-minute rate beyond included minutes', () => {
    // Starter: 500 included @ $149 + 100 overage @ $0.25 = $174
    expect(calculateMonthlyCost(TIERS.starter, 600)).toBeCloseTo(174, 5);
    // Pro: 1,500 included @ $349 + 1,000 overage @ $0.22 = $569
    expect(calculateMonthlyCost(TIERS.pro, 2_500)).toBeCloseTo(569, 5);
    // Enterprise: 3,000 included @ $799 + 2,000 overage @ $0.18 = $1,159
    expect(calculateMonthlyCost(TIERS.enterprise, 5_000)).toBeCloseTo(1_159, 5);
  });

  it('computes effective per-minute rate as total cost divided by minutes', () => {
    // 1,500 minutes on Pro = $349 (no overage) → $0.233/min
    const rate = calculateEffectiveRate(TIERS.pro, 1_500);
    expect(rate).toBeCloseTo(349 / 1_500, 6);
  });
});

describe('MinutesPricingCalculator UI', () => {
  it('renders the three tiers with their published overage rates', () => {
    render(<MinutesPricingCalculator />);
    expect(screen.getByTestId('calc-tier-starter')).toBeTruthy();
    expect(screen.getByTestId('calc-tier-pro')).toBeTruthy();
    expect(screen.getByTestId('calc-tier-enterprise')).toBeTruthy();
    // Overage rates from billing meter must appear in the breakdown
    const starter = screen.getByTestId('calc-tier-starter').textContent ?? '';
    const pro = screen.getByTestId('calc-tier-pro').textContent ?? '';
    const ent = screen.getByTestId('calc-tier-enterprise').textContent ?? '';
    expect(starter).toContain('$0.250');
    expect(pro).toContain('$0.220');
    expect(ent).toContain('$0.180');
  });

  it('updates the estimated monthly cost when minutes change', () => {
    render(<MinutesPricingCalculator />);
    const input = document.getElementById('minutes-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '600' } });
    // Starter @ 600 min = $149 + 100 * $0.25 = $174
    expect(screen.getByTestId('calc-monthly-starter').textContent).toContain('$174');
    // Pro @ 600 min = $349 (within 1,500 included)
    expect(screen.getByTestId('calc-monthly-pro').textContent).toContain('$349');
    // Enterprise @ 600 min = $799 (within 3,000 included)
    expect(screen.getByTestId('calc-monthly-enterprise').textContent).toContain('$799');
  });
});

describe('MinutesPricingCalculator annual toggle', () => {
  it('exposes a 15% annual discount constant matching the FAQ', () => {
    expect(ANNUAL_DISCOUNT).toBeCloseTo(0.15, 6);
    expect(getDiscountedBasePrice(100, 'monthly')).toBe(100);
    expect(getDiscountedBasePrice(100, 'annual')).toBeCloseTo(85, 6);
  });

  it('discounts the displayed monthly bill by 15% on the base when Annual is selected', () => {
    render(<MinutesPricingCalculator />);
    const input = document.getElementById('minutes-input') as HTMLInputElement;
    // Pin minutes to a within-included value so only the base price drives the bill.
    fireEvent.change(input, { target: { value: '500' } });

    // Sanity-check monthly baseline first
    expect(screen.getByTestId('calc-monthly-starter').textContent).toContain('$149');
    expect(screen.getByTestId('calc-monthly-pro').textContent).toContain('$349');
    expect(screen.getByTestId('calc-monthly-enterprise').textContent).toContain('$799');

    // Flip to annual
    fireEvent.click(screen.getByTestId('calc-billing-annual'));

    // 15% off base (rounded): $149 → $127, $349 → $297, $799 → $679
    expect(screen.getByTestId('calc-monthly-starter').textContent).toContain('$127');
    expect(screen.getByTestId('calc-monthly-pro').textContent).toContain('$297');
    expect(screen.getByTestId('calc-monthly-enterprise').textContent).toContain('$679');
  });

  it('keeps the per-minute overage rate the same when Annual is selected', () => {
    render(<MinutesPricingCalculator />);
    fireEvent.click(screen.getByTestId('calc-billing-annual'));
    const starter = screen.getByTestId('calc-tier-starter').textContent ?? '';
    const pro = screen.getByTestId('calc-tier-pro').textContent ?? '';
    const ent = screen.getByTestId('calc-tier-enterprise').textContent ?? '';
    expect(starter).toContain('$0.250');
    expect(pro).toContain('$0.220');
    expect(ent).toContain('$0.180');
  });

  it('shows an annual savings note under each card when Annual is selected', () => {
    render(<MinutesPricingCalculator />);
    // No savings note while monthly
    expect(screen.queryByTestId('calc-savings-pro')).toBeNull();

    fireEvent.click(screen.getByTestId('calc-billing-annual'));

    // Pro savings = ($349 - $297) * 12 = $624 — matches the rounded
    // strikethrough/discounted pair on the /pricing tier card above
    // (shared `getDiscountedAnnualMonthlyDollars` helper).
    const proSavings = screen.getByTestId('calc-savings-pro').textContent ?? '';
    expect(proSavings.toLowerCase()).toContain('vs monthly');
    expect(proSavings).toContain('$624');
  });

  it('matches the per-tier annual savings shown on the /pricing tier cards', () => {
    // Source of truth: the rounded annual savings on each /pricing tier
    // card is `(monthly − round(monthly × 0.85)) × 12`. At catalog prices
    // that's $264 / $624 / $1,440. The calculator's "Saves $X/yr"
    // microcopy must reconcile to the same dollar amount per tier so the
    // two figures don't visibly disagree on the same page.
    render(<MinutesPricingCalculator />);
    fireEvent.click(screen.getByTestId('calc-billing-annual'));

    const expected: Record<'starter' | 'pro' | 'enterprise', string> = {
      starter: '$264',
      pro: '$624',
      enterprise: '$1,440',
    };
    for (const tier of ['starter', 'pro', 'enterprise'] as const) {
      const text = screen.getByTestId(`calc-savings-${tier}`).textContent ?? '';
      expect(text).toContain(expected[tier]);
      expect(text).toMatch(/\/yr/);
    }
  });
});

describe('MinutesPricingCalculator currentPlanOverride (logged-in tenant teaser)', () => {
  // Negotiated Pro: $250/mo flat instead of catalog $349, $0.05/min overage
  const proStripeOverride: CurrentPlanOverride = {
    tier: 'pro',
    basePriceCents: 25_000,
    overageRatePerMinute: 0.05,
    basePriceSource: 'stripe',
    overagePriceSource: 'stripe',
  };

  it('applies the Stripe rate to the matching tier and renders the live-rate badge', () => {
    render(<MinutesPricingCalculator currentPlanOverride={proStripeOverride} />);
    const input = document.getElementById('minutes-input') as HTMLInputElement;
    // 400 min — within all three tiers' included buckets, so monthly cost
    // for each card == base price only (keeps the assertions clean).
    fireEvent.change(input, { target: { value: '400' } });

    // Pro card shows the negotiated $250 base, NOT the catalog $349
    expect(screen.getByTestId('calc-monthly-pro').textContent).toContain('$250');
    expect(screen.getByTestId('calc-base-pro').textContent).toContain('$250');
    expect(screen.getByTestId('calc-source-pro')).toBeTruthy();

    // Overage rate also flipped to the negotiated $0.050/min
    expect(screen.getByTestId('calc-tier-pro').textContent).toContain('$0.050');

    // Other tiers stay on catalog rates and have no badge
    expect(screen.getByTestId('calc-monthly-starter').textContent).toContain('$149');
    expect(screen.getByTestId('calc-monthly-enterprise').textContent).toContain('$799');
    expect(screen.queryByTestId('calc-source-starter')).toBeNull();
    expect(screen.queryByTestId('calc-source-enterprise')).toBeNull();
  });

  it('only overrides the named tier — catalog rates apply elsewhere even at higher minutes', () => {
    render(<MinutesPricingCalculator currentPlanOverride={proStripeOverride} />);
    const input = document.getElementById('minutes-input') as HTMLInputElement;
    // 3,000 min — 1,500 over Pro's included
    fireEvent.change(input, { target: { value: '3000' } });

    // Pro: $250 base + 1,500 * $0.05 = $325  (override overage applied)
    expect(screen.getByTestId('calc-monthly-pro').textContent).toContain('$325');

    // Starter overage still uses catalog $0.250/min
    const starterText = screen.getByTestId('calc-tier-starter').textContent ?? '';
    expect(starterText).toContain('$0.250');
  });

  it('falls back to catalog (no badge) when annual mode is selected', () => {
    render(<MinutesPricingCalculator currentPlanOverride={proStripeOverride} />);
    const input = document.getElementById('minutes-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1500' } });

    // Sanity: badge present in monthly mode
    expect(screen.getByTestId('calc-source-pro')).toBeTruthy();

    fireEvent.click(screen.getByTestId('calc-billing-annual'));

    // Badge is gone — Stripe override only applies to monthly
    expect(screen.queryByTestId('calc-source-pro')).toBeNull();
    // Pro card shows the catalog annual price ($349 → $297), not $250
    expect(screen.getByTestId('calc-monthly-pro').textContent).toContain('$297');
  });

  it('does not render the badge when both override sources are catalog (anonymous fallback)', () => {
    render(
      <MinutesPricingCalculator
        currentPlanOverride={{
          tier: 'pro',
          basePriceCents: 34_900,
          overageRatePerMinute: 0.22,
          basePriceSource: 'catalog',
          overagePriceSource: 'catalog',
        }}
      />,
    );
    expect(screen.queryByTestId('calc-source-pro')).toBeNull();
    // And the catalog price is unchanged
    const input = document.getElementById('minutes-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1500' } });
    expect(screen.getByTestId('calc-monthly-pro').textContent).toContain('$349');
  });

  it('still shows badge when only the overage rate is overridden', () => {
    render(
      <MinutesPricingCalculator
        currentPlanOverride={{
          tier: 'starter',
          basePriceCents: 14_900,
          overageRatePerMinute: 0.10,
          basePriceSource: 'catalog',
          overagePriceSource: 'stripe',
        }}
      />,
    );
    expect(screen.getByTestId('calc-source-starter')).toBeTruthy();
    // Starter base remains $149 (catalog), overage rate is the Stripe $0.10/min
    const text = screen.getByTestId('calc-tier-starter').textContent ?? '';
    expect(text).toContain('$149');
    expect(text).toContain('$0.100');
  });

  it('renders unchanged for anonymous visitors (no override prop)', () => {
    render(<MinutesPricingCalculator />);
    expect(screen.queryByTestId('calc-source-starter')).toBeNull();
    expect(screen.queryByTestId('calc-source-pro')).toBeNull();
    expect(screen.queryByTestId('calc-source-enterprise')).toBeNull();
    expect(screen.getByTestId('calc-monthly-pro').textContent).toContain('$349');
  });

  describe('annual-mode override (Stripe annual quote)', () => {
    // Tenant on a custom Pro monthly sub at $250 with a Stripe Pro
    // annual price ($319/mo equivalent) returned alongside, so the
    // calculator can keep showing a live Stripe rate when the user
    // toggles to Annual instead of falling back to the catalog discount.
    const proWithAnnual: CurrentPlanOverride = {
      tier: 'pro',
      basePriceCents: 25_000,
      overageRatePerMinute: 0.05,
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
      annualBasePriceCents: 31_900,
      annualBasePriceSource: 'stripe',
    };

    it('renders the live Stripe annual rate (with badge) on the matching tier in annual mode', () => {
      render(<MinutesPricingCalculator currentPlanOverride={proWithAnnual} />);
      const input = document.getElementById('minutes-input') as HTMLInputElement;
      // 400 min — within Pro's 1,500 included so monthly cost == base price.
      fireEvent.change(input, { target: { value: '400' } });

      // Sanity: monthly mode shows the negotiated $250 with badge
      expect(screen.getByTestId('calc-monthly-pro').textContent).toContain('$250');
      expect(screen.getByTestId('calc-source-pro')).toBeTruthy();

      // Flip to annual — badge MUST stay on (Stripe-sourced annual quote)
      fireEvent.click(screen.getByTestId('calc-billing-annual'));
      expect(screen.getByTestId('calc-source-pro')).toBeTruthy();
      // Annual mode shows the Stripe annual quote ($319), not the
      // catalog 15%-off-of-$250 ≈ $213 (which would be a fictitious
      // projection of the negotiated rate onto annual billing).
      expect(screen.getByTestId('calc-monthly-pro').textContent).toContain('$319');
      // And not the published-catalog-of-$349 minus 15% = $297 either —
      // the Stripe-sourced annual quote wins outright, so the
      // calculator stops needing to know which one to compute.
      expect(screen.getByTestId('calc-monthly-pro').textContent).not.toContain('$297');

      // The "Saves $X/yr vs monthly billing" line is gated on the card
      // NOT being Stripe-sourced (because the savings calc is a
      // catalog-only monthly→annual transform). On a Stripe-overridden
      // annual card it should stay hidden — a Stripe-quoted figure has
      // no catalog monthly counterpart to subtract from.
      expect(screen.queryByTestId('calc-savings-pro')).toBeNull();
    });

    it('does not show the override on other tiers in annual mode (only the matching tier)', () => {
      render(<MinutesPricingCalculator currentPlanOverride={proWithAnnual} />);
      const input = document.getElementById('minutes-input') as HTMLInputElement;
      // Pin minutes to 400 — within all three tiers' included so monthly
      // cost == base price only and the override isolation is the only
      // thing under test.
      fireEvent.change(input, { target: { value: '400' } });
      fireEvent.click(screen.getByTestId('calc-billing-annual'));
      // Starter & Enterprise still use catalog 15%-off rates ($127, $679)
      expect(screen.getByTestId('calc-monthly-starter').textContent).toContain('$127');
      expect(screen.getByTestId('calc-monthly-enterprise').textContent).toContain('$679');
      expect(screen.queryByTestId('calc-source-starter')).toBeNull();
      expect(screen.queryByTestId('calc-source-enterprise')).toBeNull();
    });

    it('shows the same teaser in monthly and annual mode for tenants on annual subs', () => {
      // Tenant currently on Pro annual at $300/mo equivalent. Monthly
      // side comes from the published $349 monthly Stripe price.
      const proAnnualTenant: CurrentPlanOverride = {
        tier: 'pro',
        basePriceCents: 34_900,
        overageRatePerMinute: 0.10,
        basePriceSource: 'stripe',
        overagePriceSource: 'stripe',
        annualBasePriceCents: 30_000,
        annualBasePriceSource: 'stripe',
      };
      render(<MinutesPricingCalculator currentPlanOverride={proAnnualTenant} />);
      const input = document.getElementById('minutes-input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '400' } });

      // Monthly mode: badge present, $349 published monthly
      expect(screen.getByTestId('calc-source-pro')).toBeTruthy();
      expect(screen.getByTestId('calc-monthly-pro').textContent).toContain('$349');

      // Annual mode: badge STILL present, $300 sub-derived annual
      fireEvent.click(screen.getByTestId('calc-billing-annual'));
      expect(screen.getByTestId('calc-source-pro')).toBeTruthy();
      expect(screen.getByTestId('calc-monthly-pro').textContent).toContain('$300');
    });

    it('falls back to catalog (no badge) in annual mode when annualBasePriceSource is catalog', () => {
      render(
        <MinutesPricingCalculator
          currentPlanOverride={{
            tier: 'pro',
            basePriceCents: 25_000,
            overageRatePerMinute: 0.05,
            basePriceSource: 'stripe',
            overagePriceSource: 'stripe',
            annualBasePriceCents: 31_900,
            annualBasePriceSource: 'catalog',
          }}
        />,
      );
      const input = document.getElementById('minutes-input') as HTMLInputElement;
      fireEvent.change(input, { target: { value: '400' } });

      // Monthly mode: live badge stays
      expect(screen.getByTestId('calc-source-pro')).toBeTruthy();

      fireEvent.click(screen.getByTestId('calc-billing-annual'));
      // Annual mode: catalog-sourced annual → no badge, catalog $297
      expect(screen.queryByTestId('calc-source-pro')).toBeNull();
      expect(screen.getByTestId('calc-monthly-pro').textContent).toContain('$297');
    });
  });
});
