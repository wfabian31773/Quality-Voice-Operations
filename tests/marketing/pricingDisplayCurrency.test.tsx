// @vitest-environment happy-dom
/**
 * Task #1137: confirms the public marketing surface (the
 * MinutesPricingCalculator embedded on /pricing and /signup) renders
 * tier prices, overage rates, and the FX disclaimer in the visitor's
 * chosen display currency. The picker is the cheapest user-facing
 * proof we never quote a UK / EU visitor in USD before they sign up,
 * so this test exercises the prop-driven re-render path:
 *
 *   - Default render uses USD with no "approximate" prefix or
 *     disclaimer (USD is the canonical published price).
 *   - Re-rendering with `displayCurrency="EUR"` swaps every monetary
 *     figure to a € value and surfaces the "≈" + disclaimer that
 *     keeps Stripe-charged-in-USD billing honest.
 */
import * as React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

import MinutesPricingCalculator from '../../client-app/src/components/MinutesPricingCalculator';

void React;

afterEach(() => {
  cleanup();
});

describe('MinutesPricingCalculator — display currency switching', () => {
  function getMonthly(tier: 'starter' | 'pro' | 'enterprise'): HTMLElement {
    const el = document.querySelector(
      `[data-testid="calc-monthly-${tier}"]`,
    ) as HTMLElement | null;
    if (!el) throw new Error(`calc-monthly-${tier} not rendered`);
    return el;
  }

  it('defaults to USD with no approximate prefix or disclaimer', () => {
    render(<MinutesPricingCalculator />);

    const starterCost = getMonthly('starter');
    expect(starterCost.textContent).toMatch(/\$/);
    expect(starterCost.textContent).not.toMatch(/≈/);
    expect(starterCost.dataset.displayCurrency).toBe('USD');

    // The FX disclaimer is only rendered for approximate currencies.
    expect(
      screen.queryByText(/approximate conversion from the published USD/i),
    ).toBeNull();
  });

  it('renders EUR figures with an approximate prefix and FX disclaimer', () => {
    render(<MinutesPricingCalculator displayCurrency="EUR" />);

    const starterCost = getMonthly('starter');
    expect(starterCost.textContent).toMatch(/€/);
    expect(starterCost.textContent).toMatch(/≈/);
    expect(starterCost.dataset.displayCurrency).toBe('EUR');

    // The disclaimer makes it clear the visitor will still be invoiced
    // in the canonical currency. It must explicitly cite EUR so a
    // GBP visitor sees "GBP" and not a hard-coded fallback.
    const disclaimer = screen.getByText(
      /approximate conversion from the published USD list price/i,
    );
    expect(disclaimer.textContent).toMatch(/EUR/);
  });

  it('switches currency on subsequent re-renders without remounting', () => {
    const { rerender } = render(<MinutesPricingCalculator displayCurrency="GBP" />);

    let starterCost = getMonthly('starter');
    expect(starterCost.dataset.displayCurrency).toBe('GBP');
    expect(starterCost.textContent).toMatch(/£/);

    rerender(<MinutesPricingCalculator displayCurrency="JPY" />);

    starterCost = getMonthly('starter');
    expect(starterCost.dataset.displayCurrency).toBe('JPY');
    expect(starterCost.textContent).toMatch(/¥|JPY/);
  });
});
