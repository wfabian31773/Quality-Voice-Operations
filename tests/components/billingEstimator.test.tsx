// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import BillingEstimator from '../../client-app/src/components/BillingEstimator';

void React;

afterEach(() => cleanup());

describe('BillingEstimator', () => {
  it('pre-fills the slider with month-to-date AI minutes', () => {
    render(<BillingEstimator currentPlan="starter" monthToDateAiMinutes={350} />);
    const input = document.getElementById('billing-estimator-input') as HTMLInputElement;
    expect(input.value).toBe('350');
  });

  it('shows current plan and the next tier up side-by-side for starter tenants', () => {
    render(<BillingEstimator currentPlan="starter" monthToDateAiMinutes={500} />);
    expect(screen.getByTestId('billing-estimator-tier-starter')).toBeTruthy();
    expect(screen.getByTestId('billing-estimator-tier-pro')).toBeTruthy();
    expect(screen.queryByTestId('billing-estimator-tier-enterprise')).toBeNull();
    expect(screen.getAllByText(/Next tier/i).length).toBeGreaterThan(0);
  });

  it('shows the next tier DOWN for pro tenants with a downgrade label', () => {
    render(<BillingEstimator currentPlan="pro" monthToDateAiMinutes={1000} />);
    expect(screen.getByTestId('billing-estimator-tier-pro')).toBeTruthy();
    expect(screen.getByTestId('billing-estimator-tier-starter')).toBeTruthy();
    expect(screen.queryByTestId('billing-estimator-tier-enterprise')).toBeNull();
    expect(screen.getAllByText(/Potential downgrade/i).length).toBeGreaterThan(0);
  });

  it('shows the next tier DOWN for enterprise tenants instead of a top-tier placeholder', () => {
    render(<BillingEstimator currentPlan="enterprise" monthToDateAiMinutes={5000} />);
    expect(screen.getByTestId('billing-estimator-tier-enterprise')).toBeTruthy();
    expect(screen.getByTestId('billing-estimator-tier-pro')).toBeTruthy();
    expect(screen.queryByTestId('billing-estimator-tier-starter')).toBeNull();
    expect(screen.queryByTestId('billing-estimator-top-tier')).toBeNull();
    expect(screen.getAllByText(/Potential downgrade/i).length).toBeGreaterThan(0);
  });

  it('warns on the downgrade card when projected usage exceeds the lower tier included minutes', () => {
    // Pro tenant projecting 1,800 min: starter only includes 500 min → warning expected
    render(<BillingEstimator currentPlan="pro" monthToDateAiMinutes={1800} />);
    expect(screen.getByTestId('billing-estimator-downgrade-warning-starter')).toBeTruthy();
  });

  it('hides the downgrade warning when projected usage fits within the lower tier', () => {
    // Pro tenant projecting 400 min: starter includes 500 min → no warning
    render(<BillingEstimator currentPlan="pro" monthToDateAiMinutes={400} />);
    expect(screen.queryByTestId('billing-estimator-downgrade-warning-starter')).toBeNull();
  });

  it('matches the public pricing calculator math when the slider changes', () => {
    render(<BillingEstimator currentPlan="starter" monthToDateAiMinutes={0} />);
    const input = document.getElementById('billing-estimator-input') as HTMLInputElement;

    // Starter @ 600 min = $99 + 100 * $0.15 = $114
    fireEvent.change(input, { target: { value: '600' } });
    expect(screen.getByTestId('billing-estimator-monthly-starter').textContent).toContain('$114');
    // Pro @ 600 min stays at base $399 (within 2,500 included)
    expect(screen.getByTestId('billing-estimator-monthly-pro').textContent).toContain('$399');
  });

  it('falls back to starter when an unknown plan is provided', () => {
    render(<BillingEstimator currentPlan="legacy-flex" monthToDateAiMinutes={0} />);
    expect(screen.getByTestId('billing-estimator-tier-starter')).toBeTruthy();
    expect(screen.getByTestId('billing-estimator-tier-pro')).toBeTruthy();
  });

  it('clamps month-to-date minutes that exceed the slider max', () => {
    render(
      <BillingEstimator currentPlan="enterprise" monthToDateAiMinutes={500_000} />,
    );
    const input = document.getElementById('billing-estimator-input') as HTMLInputElement;
    expect(input.value).toBe('25000');
  });

  it('renders monthly cost in the tenant billing currency when one is provided', () => {
    render(
      <BillingEstimator
        currentPlan="starter"
        monthToDateAiMinutes={0}
        currency="EUR"
      />,
    );
    const input = document.getElementById('billing-estimator-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '600' } });

    const normalize = (s: string) => s.replace(/\u00a0/g, ' ');
    const monthlyStarter = normalize(
      screen.getByTestId('billing-estimator-monthly-starter').textContent ?? '',
    );
    const monthlyPro = normalize(
      screen.getByTestId('billing-estimator-monthly-pro').textContent ?? '',
    );
    // Starter @ 600 min = €99 + 100 * €0.15 = €114
    expect(monthlyStarter).toContain('€114');
    // Pro @ 600 min stays at base €399 (within 2,500 included)
    expect(monthlyPro).toContain('€399');
    // No dollar sign should leak through for a Euro tenant.
    expect(monthlyStarter).not.toContain('$');
    expect(monthlyPro).not.toContain('$');

    const effectiveStarter = normalize(
      screen.getByTestId('billing-estimator-effective-starter').textContent ?? '',
    );
    expect(effectiveStarter).toContain('€');
    expect(effectiveStarter).not.toContain('$');
  });

  it('defaults to USD when no currency prop is provided', () => {
    render(<BillingEstimator currentPlan="starter" monthToDateAiMinutes={0} />);
    const monthlyStarter =
      screen.getByTestId('billing-estimator-monthly-starter').textContent ?? '';
    expect(monthlyStarter).toContain('$');
  });

  describe('plan recommendation card', () => {
    it('hides the recommendation card when no trailing usage history is provided', () => {
      render(
        <BillingEstimator currentPlan="pro" monthToDateAiMinutes={300} />,
      );
      expect(screen.queryByTestId('billing-estimator-recommendation')).toBeNull();
    });

    it('hides the recommendation card when the trailing series is empty', () => {
      render(
        <BillingEstimator
          currentPlan="pro"
          monthToDateAiMinutes={300}
          trailingMonthlyAiMinutes={[]}
        />,
      );
      expect(screen.queryByTestId('billing-estimator-recommendation')).toBeNull();
    });

    it('renders a downgrade recommendation when a Pro tenant has averaged well under Pro included minutes', () => {
      // Trailing avg = 300 min: Starter $99/mo vs. Pro $399/mo → save $300/mo.
      render(
        <BillingEstimator
          currentPlan="pro"
          monthToDateAiMinutes={300}
          trailingMonthlyAiMinutes={[280, 320, 300]}
        />,
      );
      const card = screen.getByTestId('billing-estimator-recommendation');
      expect(card.getAttribute('data-recommendation-state')).toBe('switch');
      expect(card.getAttribute('data-recommended-tier')).toBe('starter');
      expect(
        screen.getByTestId('billing-estimator-recommendation-tier').textContent,
      ).toContain('Starter');
      expect(
        screen.getByTestId('billing-estimator-recommendation-savings').textContent,
      ).toContain('$300');
      expect(card.textContent).toMatch(/last 3 complete months/i);
      expect(card.textContent).toContain('$3,600');
    });

    it('renders the "already optimal" variant when the current plan is the cheapest', () => {
      // Starter tenant averaging 100 min/mo — Starter is cheapest.
      render(
        <BillingEstimator
          currentPlan="starter"
          monthToDateAiMinutes={50}
          trailingMonthlyAiMinutes={[80, 120, 100]}
        />,
      );
      const card = screen.getByTestId('billing-estimator-recommendation');
      expect(card.getAttribute('data-recommendation-state')).toBe('optimal');
      expect(card.textContent).toMatch(/already on the cheapest plan/i);
      expect(screen.queryByTestId('billing-estimator-recommendation-savings')).toBeNull();
    });

    it('uses singular phrasing when only one trailing month is available', () => {
      render(
        <BillingEstimator
          currentPlan="pro"
          monthToDateAiMinutes={300}
          trailingMonthlyAiMinutes={[300]}
        />,
      );
      const card = screen.getByTestId('billing-estimator-recommendation');
      expect(card.textContent).toMatch(/last complete month/i);
      expect(card.textContent).not.toMatch(/last 1 complete months/i);
    });

    it('honors the Stripe rate override on the current plan when computing savings', () => {
      // Pro tenant on a $299 negotiated base, trailing avg 300 min.
      // Starter @ 300 min = $99, discounted Pro = $299 → save $200/mo.
      render(
        <BillingEstimator
          currentPlan="pro"
          monthToDateAiMinutes={300}
          trailingMonthlyAiMinutes={[300, 300, 300]}
          rateOverride={{
            basePriceCents: 29_900,
            overageRatePerMinute: 0.12,
          }}
        />,
      );
      expect(
        screen.getByTestId('billing-estimator-recommendation-savings').textContent,
      ).toContain('$200');
    });

    it('renders the recommendation savings in the tenant billing currency', () => {
      render(
        <BillingEstimator
          currentPlan="pro"
          monthToDateAiMinutes={300}
          trailingMonthlyAiMinutes={[300, 300, 300]}
          currency="EUR"
        />,
      );
      const savings =
        screen.getByTestId('billing-estimator-recommendation-savings').textContent ?? '';
      expect(savings).toContain('€');
      expect(savings).not.toContain('$');
    });

    it('hides the trailing-window toggle when no callback is provided', () => {
      render(
        <BillingEstimator
          currentPlan="pro"
          monthToDateAiMinutes={300}
          trailingMonthlyAiMinutes={[300, 300, 300]}
        />,
      );
      expect(
        screen.queryByTestId('billing-estimator-recommendation-window-toggle'),
      ).toBeNull();
    });

    it('renders the trailing-window toggle when a callback is wired and marks the active window', () => {
      const onChange = (_: 3 | 6 | 12) => undefined;
      render(
        <BillingEstimator
          currentPlan="pro"
          monthToDateAiMinutes={300}
          trailingMonthlyAiMinutes={[300, 300, 300]}
          trailingWindow={3}
          onTrailingWindowChange={onChange}
        />,
      );
      const toggle = screen.getByTestId('billing-estimator-recommendation-window-toggle');
      expect(toggle).toBeTruthy();
      expect(
        screen.getByTestId('billing-estimator-recommendation-window-3').getAttribute('aria-pressed'),
      ).toBe('true');
      expect(
        screen.getByTestId('billing-estimator-recommendation-window-6').getAttribute('aria-pressed'),
      ).toBe('false');
      expect(
        screen.getByTestId('billing-estimator-recommendation-window-12').getAttribute('aria-pressed'),
      ).toBe('false');
    });

    it('invokes the change handler when a different window pill is clicked', () => {
      const calls: Array<3 | 6 | 12> = [];
      render(
        <BillingEstimator
          currentPlan="pro"
          monthToDateAiMinutes={300}
          trailingMonthlyAiMinutes={[300, 300, 300]}
          trailingWindow={3}
          onTrailingWindowChange={(months) => calls.push(months)}
        />,
      );
      fireEvent.click(screen.getByTestId('billing-estimator-recommendation-window-12'));
      expect(calls).toEqual([12]);
    });

    it('does not re-fire the change handler when the active window is clicked again', () => {
      const calls: Array<3 | 6 | 12> = [];
      render(
        <BillingEstimator
          currentPlan="pro"
          monthToDateAiMinutes={300}
          trailingMonthlyAiMinutes={[300, 300, 300]}
          trailingWindow={6}
          onTrailingWindowChange={(months) => calls.push(months)}
        />,
      );
      fireEvent.click(screen.getByTestId('billing-estimator-recommendation-window-6'));
      expect(calls).toEqual([]);
    });

    it('also renders the trailing-window toggle on the "already optimal" variant', () => {
      render(
        <BillingEstimator
          currentPlan="starter"
          monthToDateAiMinutes={50}
          trailingMonthlyAiMinutes={[80, 120, 100]}
          trailingWindow={3}
          onTrailingWindowChange={() => undefined}
        />,
      );
      const card = screen.getByTestId('billing-estimator-recommendation');
      expect(card.getAttribute('data-recommendation-state')).toBe('optimal');
      expect(
        screen.getByTestId('billing-estimator-recommendation-window-toggle'),
      ).toBeTruthy();
    });

    it('reflects the count of months with usage data in the "based on N complete months" copy', () => {
      // Tenant chose the 12-month window but only 4 months had usage —
      // BillingEstimator counts months > 0 to derive the displayed
      // "complete months" copy, even though the math itself averages
      // across the full zero-filled series.
      render(
        <BillingEstimator
          currentPlan="pro"
          monthToDateAiMinutes={300}
          trailingMonthlyAiMinutes={[0, 0, 0, 0, 0, 0, 0, 0, 300, 320, 280, 310]}
          trailingWindow={12}
          onTrailingWindowChange={() => undefined}
        />,
      );
      const card = screen.getByTestId('billing-estimator-recommendation');
      expect(card.textContent).toMatch(/last 4 complete months/i);
      expect(card.textContent).not.toMatch(/last 12 complete months/i);
    });

    it('preserves the backend zero-filled averaging semantics over the requested window', () => {
      // [0, 0, 300] represents a brand-new Pro tenant whose only active
      // month had 300 min. The backend deliberately divides by the full
      // window (3) so the recommendation doesn't push them into a tier
      // that won't fit once usage ramps. That math gives a 100 min/mo
      // average — which keeps Starter cheapest by $300/mo. The copy
      // should still call out the single complete month with data.
      render(
        <BillingEstimator
          currentPlan="pro"
          monthToDateAiMinutes={300}
          trailingMonthlyAiMinutes={[0, 0, 300]}
        />,
      );
      const card = screen.getByTestId('billing-estimator-recommendation');
      expect(card.getAttribute('data-recommendation-state')).toBe('switch');
      expect(card.getAttribute('data-recommended-tier')).toBe('starter');
      expect(
        screen.getByTestId('billing-estimator-recommendation-savings').textContent,
      ).toContain('$300');
      expect(card.textContent).toMatch(/last complete month/i);
      expect(card.textContent).toMatch(/100/);
    });

    it('hides the recommendation card entirely when every trailing month is zero', () => {
      render(
        <BillingEstimator
          currentPlan="pro"
          monthToDateAiMinutes={0}
          trailingMonthlyAiMinutes={[0, 0, 0]}
        />,
      );
      expect(screen.queryByTestId('billing-estimator-recommendation')).toBeNull();
    });

    describe('interval toggle (monthly vs annual)', () => {
      it('hides the interval toggle when no onSwitchPlan callback is wired', () => {
        // Without a CTA to forward the choice to, the toggle has nothing
        // to do — and we don't want read-only roles teasing an option
        // they can't act on.
        render(
          <BillingEstimator
            currentPlan="pro"
            monthToDateAiMinutes={300}
            trailingMonthlyAiMinutes={[300, 300, 300]}
          />,
        );
        expect(
          screen.queryByTestId('billing-estimator-recommendation-interval-toggle'),
        ).toBeNull();
      });

      it('renders the interval toggle next to the CTA, defaulting to monthly', () => {
        render(
          <BillingEstimator
            currentPlan="pro"
            monthToDateAiMinutes={300}
            trailingMonthlyAiMinutes={[300, 300, 300]}
            onSwitchPlan={() => undefined}
          />,
        );
        expect(
          screen.getByTestId('billing-estimator-recommendation-interval-toggle'),
        ).toBeTruthy();
        expect(
          screen
            .getByTestId('billing-estimator-recommendation-interval-monthly')
            .getAttribute('aria-pressed'),
        ).toBe('true');
        expect(
          screen
            .getByTestId('billing-estimator-recommendation-interval-annual')
            .getAttribute('aria-pressed'),
        ).toBe('false');
        // CTA defaults to monthly billing in its data attribute and
        // tooltip — that matches the headline savings copy.
        const cta = screen.getByTestId('billing-estimator-recommendation-cta');
        expect(cta.getAttribute('data-recommendation-cta-interval')).toBe('monthly');
        expect(cta.getAttribute('title')).toMatch(/monthly billing/i);
      });

      it('updates the headline savings copy when annual is selected', () => {
        // Pro tenant @ 300 min: monthly headline is $300/mo savings on
        // Starter ($99). Annual variant: Starter base $99 * 0.8 = $79.2,
        // savings vs. Pro $399 = $319.8/mo, $3,837.6/yr → rounded.
        render(
          <BillingEstimator
            currentPlan="pro"
            monthToDateAiMinutes={300}
            trailingMonthlyAiMinutes={[300, 300, 300]}
            onSwitchPlan={() => undefined}
          />,
        );
        // Sanity-check the monthly headline first.
        expect(
          screen.getByTestId('billing-estimator-recommendation-savings').textContent,
        ).toContain('$300');
        expect(
          screen.queryByTestId('billing-estimator-recommendation-annual-tag'),
        ).toBeNull();

        fireEvent.click(
          screen.getByTestId('billing-estimator-recommendation-interval-annual'),
        );

        // Headline savings reflect the annual figure (rounded for display).
        const savingsAnnual =
          screen.getByTestId('billing-estimator-recommendation-savings').textContent ?? '';
        expect(savingsAnnual).toContain('$320');
        // Annual badge appears in the headline so the tenant knows the
        // savings number is the discounted variant.
        expect(
          screen.getByTestId('billing-estimator-recommendation-annual-tag'),
        ).toBeTruthy();
        // Subtitle shows the discounted recommended monthly cost.
        expect(
          screen
            .getByTestId('billing-estimator-recommendation-recommended-cost')
            .textContent,
        ).toContain('$79');
        // Annual savings line reflects the annualised discount.
        expect(
          screen
            .getByTestId('billing-estimator-recommendation-annual-savings')
            .textContent,
        ).toContain('$3,838');
      });

      it('forwards the chosen interval to onSwitchPlan when the CTA is clicked', () => {
        const calls: Array<{ tier: string; interval: string }> = [];
        render(
          <BillingEstimator
            currentPlan="pro"
            monthToDateAiMinutes={300}
            trailingMonthlyAiMinutes={[300, 300, 300]}
            onSwitchPlan={(tier, interval) => calls.push({ tier, interval })}
          />,
        );

        // Monthly is the default.
        fireEvent.click(screen.getByTestId('billing-estimator-recommendation-cta'));
        expect(calls).toEqual([{ tier: 'starter', interval: 'monthly' }]);

        // Pick annual and click again — the second call should reflect it.
        fireEvent.click(
          screen.getByTestId('billing-estimator-recommendation-interval-annual'),
        );
        fireEvent.click(screen.getByTestId('billing-estimator-recommendation-cta'));
        expect(calls).toEqual([
          { tier: 'starter', interval: 'monthly' },
          { tier: 'starter', interval: 'annual' },
        ]);
      });

      it('does not show the interval toggle on the "already optimal" variant', () => {
        // We don't pitch a switch when the current plan is the cheapest,
        // so there's no recommended tier to bill annually either.
        render(
          <BillingEstimator
            currentPlan="starter"
            monthToDateAiMinutes={50}
            trailingMonthlyAiMinutes={[80, 120, 100]}
            onSwitchPlan={() => undefined}
          />,
        );
        expect(
          screen.queryByTestId('billing-estimator-recommendation-interval-toggle'),
        ).toBeNull();
      });
    });

    it('honors a custom availableTrailingWindows prop', () => {
      render(
        <BillingEstimator
          currentPlan="pro"
          monthToDateAiMinutes={300}
          trailingMonthlyAiMinutes={[300, 300, 300]}
          trailingWindow={6}
          onTrailingWindowChange={() => undefined}
          availableTrailingWindows={[6, 12]}
        />,
      );
      expect(
        screen.queryByTestId('billing-estimator-recommendation-window-3'),
      ).toBeNull();
      expect(
        screen.getByTestId('billing-estimator-recommendation-window-6'),
      ).toBeTruthy();
      expect(
        screen.getByTestId('billing-estimator-recommendation-window-12'),
      ).toBeTruthy();
    });
  });
});
