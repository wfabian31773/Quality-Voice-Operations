// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import BillingEstimator from '../../client-app/src/components/BillingEstimator';
import type { PlanTier } from '../../shared/billing/planCatalog';

void React;

afterEach(() => cleanup());

/**
 * UI tests for the BillingEstimator recommendation banner CTA.
 *
 * The math powering the recommendation lives in
 * `shared/billing/planRecommendation` and is covered by
 * `tests/billing/planRecommendation.test.ts`. These specs focus on the
 * React wiring that turns that math into an actionable Stripe-Checkout
 * button: role-gating via `onSwitchPlan`, the Switch-vs-Downgrade verb,
 * the recommended tier passed to the callback, and the per-tier loading
 * state driven by `switchingPlan`.
 */
describe('BillingEstimator recommendation CTA', () => {
  describe('role gating via onSwitchPlan', () => {
    it('hides the CTA when no onSwitchPlan callback is provided (read-only role)', () => {
      // Without `onSwitchPlan` the banner must render without a button so
      // read-only roles can never trigger Stripe Checkout from the markup.
      render(
        <BillingEstimator
          currentPlan="pro"
          monthToDateAiMinutes={300}
          trailingMonthlyAiMinutes={[280, 320, 300]}
        />,
      );
      expect(screen.getByTestId('billing-estimator-recommendation')).toBeTruthy();
      expect(screen.queryByTestId('billing-estimator-recommendation-cta')).toBeNull();
    });

    it('renders the CTA when an onSwitchPlan callback is wired (admin role)', () => {
      render(
        <BillingEstimator
          currentPlan="pro"
          monthToDateAiMinutes={300}
          trailingMonthlyAiMinutes={[280, 320, 300]}
          onSwitchPlan={() => undefined}
        />,
      );
      const cta = screen.getByTestId('billing-estimator-recommendation-cta');
      expect(cta).toBeTruthy();
      expect(cta.tagName).toBe('BUTTON');
    });

    it('does not render a CTA on the "already optimal" variant even with onSwitchPlan wired', () => {
      // Starter tenant averaging 100 min — already on the cheapest plan,
      // so there is no recommended switch and the CTA should be absent
      // even when `onSwitchPlan` is wired up.
      render(
        <BillingEstimator
          currentPlan="starter"
          monthToDateAiMinutes={50}
          trailingMonthlyAiMinutes={[80, 120, 100]}
          onSwitchPlan={() => undefined}
        />,
      );
      const card = screen.getByTestId('billing-estimator-recommendation');
      expect(card.getAttribute('data-recommendation-state')).toBe('optimal');
      expect(screen.queryByTestId('billing-estimator-recommendation-cta')).toBeNull();
    });
  });

  describe('Switch vs Downgrade label', () => {
    it('uses "Switch to <Plan>" when the recommended tier is an upgrade from the current plan', () => {
      // Starter tenant averaging 4,000 min → Pro is cheaper than Starter at
      // that volume (Starter $624 vs Pro $579). Recommended tier is *above*
      // the current tier, so the verb should be "Switch to" — not "Downgrade".
      render(
        <BillingEstimator
          currentPlan="starter"
          monthToDateAiMinutes={4_000}
          trailingMonthlyAiMinutes={[4_000, 4_000, 4_000]}
          onSwitchPlan={() => undefined}
        />,
      );
      const cta = screen.getByTestId('billing-estimator-recommendation-cta');
      expect(cta.getAttribute('data-recommendation-cta-tier')).toBe('pro');
      expect(cta.textContent).toMatch(/Switch to Pro/i);
      expect(cta.textContent).not.toMatch(/Downgrade/i);
    });

    it('uses "Downgrade to <Plan>" when the recommended tier is below the current plan', () => {
      // Pro tenant averaging 300 min → Starter is cheaper. Recommended tier
      // is *below* the current tier, so the verb should be "Downgrade to".
      render(
        <BillingEstimator
          currentPlan="pro"
          monthToDateAiMinutes={300}
          trailingMonthlyAiMinutes={[280, 320, 300]}
          onSwitchPlan={() => undefined}
        />,
      );
      const cta = screen.getByTestId('billing-estimator-recommendation-cta');
      expect(cta.getAttribute('data-recommendation-cta-tier')).toBe('starter');
      expect(cta.textContent).toMatch(/Downgrade to Starter/i);
      expect(cta.textContent).not.toMatch(/Switch to Starter/i);
    });

    it('uses "Downgrade to <Plan>" when an Enterprise tenant should drop to Pro', () => {
      // Enterprise @ 4,000 min = $999; Pro @ 4,000 min = $399 + 1,500*$0.12 =
      // $579; Starter @ 4,000 min = $99 + 3,500*$0.15 = $624. Pro is the
      // cheapest tier, so this exercises the enterprise → pro downgrade path
      // (not the multi-step enterprise → starter path).
      render(
        <BillingEstimator
          currentPlan="enterprise"
          monthToDateAiMinutes={4_000}
          trailingMonthlyAiMinutes={[3_900, 4_100, 4_000]}
          onSwitchPlan={() => undefined}
        />,
      );
      const cta = screen.getByTestId('billing-estimator-recommendation-cta');
      expect(cta.getAttribute('data-recommendation-cta-tier')).toBe('pro');
      expect(cta.textContent).toMatch(/Downgrade to Pro/i);
    });
  });

  describe('CTA click invokes callback with the recommended tier', () => {
    it('passes the downgrade target tier to onSwitchPlan when clicked', () => {
      const calls: PlanTier[] = [];
      render(
        <BillingEstimator
          currentPlan="pro"
          monthToDateAiMinutes={300}
          trailingMonthlyAiMinutes={[280, 320, 300]}
          onSwitchPlan={(tier) => calls.push(tier)}
        />,
      );
      fireEvent.click(screen.getByTestId('billing-estimator-recommendation-cta'));
      // Critical regression check: the CTA must hand the *recommended* tier
      // to the parent, not the current tier. Pro → Starter recommendation
      // should kick off Checkout for Starter.
      expect(calls).toEqual(['starter']);
    });

    it('passes the upgrade target tier to onSwitchPlan when clicked', () => {
      const calls: PlanTier[] = [];
      render(
        <BillingEstimator
          currentPlan="starter"
          monthToDateAiMinutes={4_000}
          trailingMonthlyAiMinutes={[4_000, 4_000, 4_000]}
          onSwitchPlan={(tier) => calls.push(tier)}
        />,
      );
      fireEvent.click(screen.getByTestId('billing-estimator-recommendation-cta'));
      expect(calls).toEqual(['pro']);
    });

    it('does not invoke onSwitchPlan when the CTA is not present (no recommendation)', () => {
      // No trailing data → recommendation card hidden → no CTA to click.
      // Make sure the callback isn't invoked from any other code path.
      const calls: PlanTier[] = [];
      render(
        <BillingEstimator
          currentPlan="pro"
          monthToDateAiMinutes={300}
          onSwitchPlan={(tier) => calls.push(tier)}
        />,
      );
      expect(screen.queryByTestId('billing-estimator-recommendation-cta')).toBeNull();
      expect(calls).toEqual([]);
    });
  });

  describe('switchingPlan loading state', () => {
    it('disables the CTA and swaps the label when switchingPlan matches the recommended tier', () => {
      render(
        <BillingEstimator
          currentPlan="pro"
          monthToDateAiMinutes={300}
          trailingMonthlyAiMinutes={[280, 320, 300]}
          onSwitchPlan={() => undefined}
          switchingPlan="starter"
        />,
      );
      const cta = screen.getByTestId(
        'billing-estimator-recommendation-cta',
      ) as HTMLButtonElement;
      expect(cta.disabled).toBe(true);
      expect(cta.textContent).toMatch(/Redirecting/i);
      expect(cta.textContent).not.toMatch(/Downgrade to Starter/i);
    });

    it('keeps the CTA enabled when switchingPlan is for a different tier', () => {
      // Parent's upgradeLoading is set to a tier that isn't the one this
      // banner is recommending — the recommendation CTA should stay live so
      // the tenant can still act on it. (E.g. an upgrade card below the
      // banner is loading Enterprise while the banner recommends Starter.)
      render(
        <BillingEstimator
          currentPlan="pro"
          monthToDateAiMinutes={300}
          trailingMonthlyAiMinutes={[280, 320, 300]}
          onSwitchPlan={() => undefined}
          switchingPlan="enterprise"
        />,
      );
      const cta = screen.getByTestId(
        'billing-estimator-recommendation-cta',
      ) as HTMLButtonElement;
      expect(cta.disabled).toBe(false);
      expect(cta.textContent).toMatch(/Downgrade to Starter/i);
      expect(cta.textContent).not.toMatch(/Redirecting/i);
    });

    it('keeps the CTA enabled when switchingPlan is null (idle)', () => {
      render(
        <BillingEstimator
          currentPlan="pro"
          monthToDateAiMinutes={300}
          trailingMonthlyAiMinutes={[280, 320, 300]}
          onSwitchPlan={() => undefined}
          switchingPlan={null}
        />,
      );
      const cta = screen.getByTestId(
        'billing-estimator-recommendation-cta',
      ) as HTMLButtonElement;
      expect(cta.disabled).toBe(false);
      expect(cta.textContent).toMatch(/Downgrade to Starter/i);
    });

    it('does not invoke onSwitchPlan again when the CTA is clicked while loading', () => {
      const calls: PlanTier[] = [];
      render(
        <BillingEstimator
          currentPlan="pro"
          monthToDateAiMinutes={300}
          trailingMonthlyAiMinutes={[280, 320, 300]}
          onSwitchPlan={(tier) => calls.push(tier)}
          switchingPlan="starter"
        />,
      );
      const cta = screen.getByTestId('billing-estimator-recommendation-cta');
      fireEvent.click(cta);
      // Disabled buttons must not fire onClick — this guards against a
      // double-Checkout when the tenant taps the spinner impatiently.
      expect(calls).toEqual([]);
    });
  });
});
