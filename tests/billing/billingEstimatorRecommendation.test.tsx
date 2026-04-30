// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import BillingEstimator, {
  type RecommendationEvent,
} from '../../client-app/src/components/BillingEstimator';
import type { PlanTier } from '../../shared/billing/planCatalog';

void React;

afterEach(() => cleanup());

// Clear the impression-dedup sessionStorage between specs.
beforeEach(() => {
  if (typeof window !== 'undefined' && window.sessionStorage) {
    window.sessionStorage.clear();
  }
});

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

  describe('pitch dimension on emitted analytics events', () => {
    it('stamps pitch=tier-switch on the upgrade CTA click attribution', () => {
      const events: RecommendationEvent[] = [];
      const switchCalls: Array<{
        tier: PlanTier;
        attribution: { pitch: string; currentTier: string; recommendedTier: string };
      }> = [];
      render(
        <BillingEstimator
          currentPlan="pro"
          monthToDateAiMinutes={300}
          trailingMonthlyAiMinutes={[280, 320, 300]}
          onSwitchPlan={(tier, _interval, attribution) =>
            switchCalls.push({
              tier,
              attribution: attribution as {
                pitch: string;
                currentTier: string;
                recommendedTier: string;
              },
            })
          }
          onRecommendationEvent={(event) => events.push(event)}
        />,
      );

      const impressions = events.filter((e) => e.type === 'impression');
      expect(impressions).toHaveLength(1);
      expect(impressions[0]!.pitch).toBe('tier-switch');
      expect(impressions[0]!.currentTier).toBe('pro');
      expect(impressions[0]!.recommendedTier).toBe('starter');

      fireEvent.click(screen.getByTestId('billing-estimator-recommendation-cta'));

      const clicks = events.filter((e) => e.type === 'click');
      expect(clicks).toHaveLength(1);
      expect(clicks[0]!.pitch).toBe('tier-switch');
      expect(switchCalls).toHaveLength(1);
      expect(switchCalls[0]!.attribution.pitch).toBe('tier-switch');
      expect(switchCalls[0]!.attribution.currentTier).toBe('pro');
      expect(switchCalls[0]!.attribution.recommendedTier).toBe('starter');
    });

    it('fires an annual-only impression on the optimal branch when the tenant is monthly-billed and could save by going annual', () => {
      const events: RecommendationEvent[] = [];
      render(
        <BillingEstimator
          currentPlan="starter"
          monthToDateAiMinutes={50}
          trailingMonthlyAiMinutes={[80, 120, 100]}
          currentBillingInterval="monthly"
          onSwitchPlan={() => undefined}
          onRecommendationEvent={(event) => events.push(event)}
        />,
      );

      expect(
        screen.getByTestId('billing-estimator-recommendation-annual-pitch'),
      ).toBeTruthy();

      const impressions = events.filter((e) => e.type === 'impression');
      expect(impressions).toHaveLength(1);
      const impression = impressions[0]!;
      expect(impression.pitch).toBe('annual-only');
      expect(impression.currentTier).toBe('starter');
      expect(impression.recommendedTier).toBe('starter');
      expect(impression.monthlySavingsCents).toBeGreaterThan(0);
    });

    it('does not double-fire the annual-only impression on a re-render with the same dedup key', () => {
      const events: RecommendationEvent[] = [];
      const { rerender } = render(
        <BillingEstimator
          currentPlan="starter"
          monthToDateAiMinutes={50}
          trailingMonthlyAiMinutes={[80, 120, 100]}
          currentBillingInterval="monthly"
          onSwitchPlan={() => undefined}
          onRecommendationEvent={(event) => events.push(event)}
        />,
      );
      rerender(
        <BillingEstimator
          currentPlan="starter"
          monthToDateAiMinutes={50}
          trailingMonthlyAiMinutes={[80, 120, 100]}
          currentBillingInterval="monthly"
          onSwitchPlan={() => undefined}
          onRecommendationEvent={(event) => events.push(event)}
          switchingPlan={null}
        />,
      );

      const annualImpressions = events.filter(
        (e) => e.type === 'impression' && e.pitch === 'annual-only',
      );
      expect(annualImpressions).toHaveLength(1);
    });

    it('suppresses the annual pitch impression and CTA when the tenant is already on annual billing', () => {
      const events: RecommendationEvent[] = [];
      render(
        <BillingEstimator
          currentPlan="starter"
          monthToDateAiMinutes={50}
          trailingMonthlyAiMinutes={[80, 120, 100]}
          currentBillingInterval="annual"
          onSwitchPlan={() => undefined}
          onRecommendationEvent={(event) => events.push(event)}
        />,
      );

      expect(
        screen.queryByTestId('billing-estimator-recommendation-annual-pitch'),
      ).toBeNull();
      expect(
        screen.queryByTestId(
          'billing-estimator-recommendation-annual-pitch-cta',
        ),
      ).toBeNull();
      expect(events.filter((e) => e.pitch === 'annual-only')).toEqual([]);
    });

    it('stamps pitch=annual-only on the optimal-branch annual CTA click attribution', () => {
      const events: RecommendationEvent[] = [];
      const switchCalls: Array<{
        tier: PlanTier;
        interval: string;
        attribution: { pitch: string; currentTier: string; recommendedTier: string };
      }> = [];
      render(
        <BillingEstimator
          currentPlan="starter"
          monthToDateAiMinutes={50}
          trailingMonthlyAiMinutes={[80, 120, 100]}
          currentBillingInterval="monthly"
          onSwitchPlan={(tier, interval, attribution) =>
            switchCalls.push({
              tier,
              interval,
              attribution: attribution as {
                pitch: string;
                currentTier: string;
                recommendedTier: string;
              },
            })
          }
          onRecommendationEvent={(event) => events.push(event)}
        />,
      );

      const cta = screen.getByTestId(
        'billing-estimator-recommendation-annual-pitch-cta',
      );
      fireEvent.click(cta);

      const clicks = events.filter((e) => e.type === 'click');
      expect(clicks).toHaveLength(1);
      expect(clicks[0]!.pitch).toBe('annual-only');
      expect(clicks[0]!.currentTier).toBe('starter');
      expect(clicks[0]!.recommendedTier).toBe('starter');

      expect(switchCalls).toHaveLength(1);
      expect(switchCalls[0]!.tier).toBe('starter');
      expect(switchCalls[0]!.interval).toBe('annual');
      expect(switchCalls[0]!.attribution.pitch).toBe('annual-only');
    });
  });
});
