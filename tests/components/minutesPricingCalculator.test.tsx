// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import MinutesPricingCalculator, {
  calculateMonthlyCost,
  calculateEffectiveRate,
  getDiscountedBasePrice,
  ANNUAL_DISCOUNT,
} from '../../client-app/src/components/MinutesPricingCalculator';

void React;

afterEach(() => cleanup());

const TIERS = {
  starter: { basePrice: 99, includedMinutes: 500, overageRate: 0.15 },
  pro: { basePrice: 399, includedMinutes: 2_500, overageRate: 0.12 },
  enterprise: { basePrice: 999, includedMinutes: 10_000, overageRate: 0.08 },
};

describe('MinutesPricingCalculator math', () => {
  it('returns base price when usage is within included minutes', () => {
    expect(calculateMonthlyCost(TIERS.starter, 250)).toBe(99);
    expect(calculateMonthlyCost(TIERS.pro, 2_500)).toBe(399);
    expect(calculateMonthlyCost(TIERS.enterprise, 10_000)).toBe(999);
  });

  it('adds overage at the published per-minute rate beyond included minutes', () => {
    // Starter: 500 included @ $99 + 100 overage @ $0.15 = $114
    expect(calculateMonthlyCost(TIERS.starter, 600)).toBeCloseTo(114, 5);
    // Pro: 2,500 included @ $399 + 1,000 overage @ $0.12 = $519
    expect(calculateMonthlyCost(TIERS.pro, 3_500)).toBeCloseTo(519, 5);
    // Enterprise: 10,000 included @ $999 + 5,000 overage @ $0.08 = $1,399
    expect(calculateMonthlyCost(TIERS.enterprise, 15_000)).toBeCloseTo(1_399, 5);
  });

  it('computes effective per-minute rate as total cost divided by minutes', () => {
    // 1,500 minutes on Pro = $399 (no overage) → $0.266/min
    const rate = calculateEffectiveRate(TIERS.pro, 1_500);
    expect(rate).toBeCloseTo(399 / 1_500, 6);
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
    expect(starter).toContain('$0.150');
    expect(pro).toContain('$0.120');
    expect(ent).toContain('$0.080');
  });

  it('updates the estimated monthly cost when minutes change', () => {
    render(<MinutesPricingCalculator />);
    const input = document.getElementById('minutes-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '600' } });
    // Starter @ 600 min = $99 + 100 * $0.15 = $114
    expect(screen.getByTestId('calc-monthly-starter').textContent).toContain('$114');
    // Pro @ 600 min = $399 (within 2,500 included)
    expect(screen.getByTestId('calc-monthly-pro').textContent).toContain('$399');
    // Enterprise @ 600 min = $999
    expect(screen.getByTestId('calc-monthly-enterprise').textContent).toContain('$999');
  });
});

describe('MinutesPricingCalculator annual toggle', () => {
  it('exposes a 20% annual discount constant matching the FAQ', () => {
    expect(ANNUAL_DISCOUNT).toBeCloseTo(0.2, 6);
    expect(getDiscountedBasePrice(100, 'monthly')).toBe(100);
    expect(getDiscountedBasePrice(100, 'annual')).toBeCloseTo(80, 6);
  });

  it('discounts the displayed monthly bill by 20% on the base when Annual is selected', () => {
    render(<MinutesPricingCalculator />);
    const input = document.getElementById('minutes-input') as HTMLInputElement;
    // Pin minutes to a within-included value so only the base price drives the bill.
    fireEvent.change(input, { target: { value: '500' } });

    // Sanity-check monthly baseline first
    expect(screen.getByTestId('calc-monthly-starter').textContent).toContain('$99');
    expect(screen.getByTestId('calc-monthly-pro').textContent).toContain('$399');
    expect(screen.getByTestId('calc-monthly-enterprise').textContent).toContain('$999');

    // Flip to annual
    fireEvent.click(screen.getByTestId('calc-billing-annual'));

    // 20% off base: $99 → $79 (rounded), $399 → $319, $999 → $799
    expect(screen.getByTestId('calc-monthly-starter').textContent).toContain('$79');
    expect(screen.getByTestId('calc-monthly-pro').textContent).toContain('$319');
    expect(screen.getByTestId('calc-monthly-enterprise').textContent).toContain('$799');
  });

  it('keeps the per-minute overage rate the same when Annual is selected', () => {
    render(<MinutesPricingCalculator />);
    fireEvent.click(screen.getByTestId('calc-billing-annual'));
    const starter = screen.getByTestId('calc-tier-starter').textContent ?? '';
    const pro = screen.getByTestId('calc-tier-pro').textContent ?? '';
    const ent = screen.getByTestId('calc-tier-enterprise').textContent ?? '';
    expect(starter).toContain('$0.150');
    expect(pro).toContain('$0.120');
    expect(ent).toContain('$0.080');
  });

  it('shows an annual savings note under each card when Annual is selected', () => {
    render(<MinutesPricingCalculator />);
    // No savings note while monthly
    expect(screen.queryByTestId('calc-savings-pro')).toBeNull();

    fireEvent.click(screen.getByTestId('calc-billing-annual'));

    // Pro savings = ($399 - $319.20) * 12 ≈ $958
    const proSavings = screen.getByTestId('calc-savings-pro').textContent ?? '';
    expect(proSavings.toLowerCase()).toContain('vs monthly');
    expect(proSavings).toMatch(/\$95[78]/);
  });
});
