// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import BillingEstimator from '../../client-app/src/components/BillingEstimator';
import type { PlanTier } from '../../shared/billing/planCatalog';

void React;

afterEach(() => cleanup());

type BillingPeriod = 'monthly' | 'annual';

interface RecommendationAttribution {
  currentTier: PlanTier;
  recommendedTier: PlanTier;
  monthlySavingsCents: number;
  trailingWindowMonths?: number;
}

type SwitchPlanCall = {
  tier: PlanTier;
  interval: BillingPeriod;
  attribution: RecommendationAttribution;
};

describe('BillingEstimator recommendation card variants', () => {
  describe('switch variant', () => {
    it('renders the switch banner without the annual-pitch sub-banner', () => {
      render(
        <BillingEstimator
          currentPlan="pro"
          monthToDateAiMinutes={300}
          trailingMonthlyAiMinutes={[280, 320, 300]}
          onSwitchPlan={() => undefined}
          currentBillingInterval="monthly"
        />,
      );
      const card = screen.getByTestId('billing-estimator-recommendation');
      expect(card.getAttribute('data-recommendation-state')).toBe('switch');
      expect(card.getAttribute('data-recommended-tier')).toBe('starter');
      expect(
        screen.queryByTestId('billing-estimator-recommendation-annual-pitch'),
      ).toBeNull();
      expect(
        screen.queryByTestId('billing-estimator-recommendation-annual-pitch-cta'),
      ).toBeNull();
    });
  });

  describe('optimal variant — annual pitch hidden', () => {
    it('hides the annual pitch when the tenant is already on annual billing', () => {
      render(
        <BillingEstimator
          currentPlan="starter"
          monthToDateAiMinutes={50}
          trailingMonthlyAiMinutes={[80, 120, 100]}
          onSwitchPlan={() => undefined}
          currentBillingInterval="annual"
        />,
      );
      const card = screen.getByTestId('billing-estimator-recommendation');
      expect(card.getAttribute('data-recommendation-state')).toBe('optimal');
      expect(card.getAttribute('data-annual-pitch')).toBe('false');
      expect(
        screen.queryByTestId('billing-estimator-recommendation-annual-pitch'),
      ).toBeNull();
    });

    it('hides the annual pitch when the current tier was sourced from a Stripe override', () => {
      // rateOverride flips sourcedFromStripe → also collapses
      // annualOption.monthlySavings to 0 (zero-savings edge case).
      render(
        <BillingEstimator
          currentPlan="starter"
          monthToDateAiMinutes={50}
          trailingMonthlyAiMinutes={[80, 120, 100]}
          onSwitchPlan={() => undefined}
          currentBillingInterval="monthly"
          rateOverride={{
            basePriceCents: 8_800,
            overageRatePerMinute: 0.1,
          }}
        />,
      );
      const card = screen.getByTestId('billing-estimator-recommendation');
      expect(card.getAttribute('data-recommendation-state')).toBe('optimal');
      expect(card.getAttribute('data-annual-pitch')).toBe('false');
      expect(
        screen.queryByTestId('billing-estimator-recommendation-annual-pitch'),
      ).toBeNull();
    });

    it('hides the annual pitch when currentBillingInterval is omitted', () => {
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
      expect(card.getAttribute('data-annual-pitch')).toBe('false');
      expect(
        screen.queryByTestId('billing-estimator-recommendation-annual-pitch'),
      ).toBeNull();
    });
  });

  describe('optimal variant — annual pitch shown', () => {
    it('renders the annual-pitch sub-banner with a CTA on monthly + catalog tier', () => {
      render(
        <BillingEstimator
          currentPlan="starter"
          monthToDateAiMinutes={50}
          trailingMonthlyAiMinutes={[80, 120, 100]}
          onSwitchPlan={() => undefined}
          currentBillingInterval="monthly"
        />,
      );
      const card = screen.getByTestId('billing-estimator-recommendation');
      expect(card.getAttribute('data-recommendation-state')).toBe('optimal');
      expect(card.getAttribute('data-annual-pitch')).toBe('true');
      expect(
        screen.getByTestId('billing-estimator-recommendation-annual-pitch'),
      ).toBeTruthy();
      const cta = screen.getByTestId(
        'billing-estimator-recommendation-annual-pitch-cta',
      ) as HTMLButtonElement;
      expect(cta.tagName).toBe('BUTTON');
      expect(cta.getAttribute('data-recommendation-cta-tier')).toBe('starter');
      expect(cta.getAttribute('data-recommendation-cta-interval')).toBe('annual');
    });

    it('hides the annual-pitch CTA but keeps the copy when onSwitchPlan is omitted', () => {
      render(
        <BillingEstimator
          currentPlan="starter"
          monthToDateAiMinutes={50}
          trailingMonthlyAiMinutes={[80, 120, 100]}
          currentBillingInterval="monthly"
        />,
      );
      expect(
        screen.getByTestId('billing-estimator-recommendation-annual-pitch'),
      ).toBeTruthy();
      expect(
        screen.queryByTestId('billing-estimator-recommendation-annual-pitch-cta'),
      ).toBeNull();
    });

    it('forwards (tier, "annual", attribution) to onSwitchPlan when the CTA is clicked', () => {
      const calls: SwitchPlanCall[] = [];
      render(
        <BillingEstimator
          currentPlan="starter"
          monthToDateAiMinutes={50}
          trailingMonthlyAiMinutes={[80, 120, 100]}
          onSwitchPlan={(tier, interval, attribution) =>
            calls.push({
              tier,
              interval,
              attribution: attribution as RecommendationAttribution,
            })
          }
          currentBillingInterval="monthly"
          trailingWindow={3}
          onTrailingWindowChange={() => undefined}
        />,
      );
      fireEvent.click(
        screen.getByTestId('billing-estimator-recommendation-annual-pitch-cta'),
      );
      // Starter @ 100 min: catalog base $99 → annual base $79.20
      // → monthly savings $19.80 → 1980¢.
      expect(calls).toEqual([
        {
          tier: 'starter',
          interval: 'annual',
          attribution: {
            currentTier: 'starter',
            recommendedTier: 'starter',
            monthlySavingsCents: 1_980,
            trailingWindowMonths: 3,
          },
        },
      ]);
    });

    it('disables the CTA and swaps the label when switchingPlan matches the recommended tier', () => {
      render(
        <BillingEstimator
          currentPlan="starter"
          monthToDateAiMinutes={50}
          trailingMonthlyAiMinutes={[80, 120, 100]}
          onSwitchPlan={() => undefined}
          currentBillingInterval="monthly"
          switchingPlan="starter"
        />,
      );
      const cta = screen.getByTestId(
        'billing-estimator-recommendation-annual-pitch-cta',
      ) as HTMLButtonElement;
      expect(cta.disabled).toBe(true);
      expect(cta.textContent).toMatch(/Redirecting/i);
      expect(cta.textContent).not.toMatch(/Switch to annual billing/i);
    });

    it('keeps the annual-pitch CTA enabled when switchingPlan is for a different tier', () => {
      render(
        <BillingEstimator
          currentPlan="starter"
          monthToDateAiMinutes={50}
          trailingMonthlyAiMinutes={[80, 120, 100]}
          onSwitchPlan={() => undefined}
          currentBillingInterval="monthly"
          switchingPlan="enterprise"
        />,
      );
      const cta = screen.getByTestId(
        'billing-estimator-recommendation-annual-pitch-cta',
      ) as HTMLButtonElement;
      expect(cta.disabled).toBe(false);
      expect(cta.textContent).toMatch(/Switch to annual billing/i);
    });

    it('does not invoke onSwitchPlan again when the CTA is clicked while loading', () => {
      const calls: SwitchPlanCall[] = [];
      render(
        <BillingEstimator
          currentPlan="starter"
          monthToDateAiMinutes={50}
          trailingMonthlyAiMinutes={[80, 120, 100]}
          onSwitchPlan={(tier, interval, attribution) =>
            calls.push({
              tier,
              interval,
              attribution: attribution as RecommendationAttribution,
            })
          }
          currentBillingInterval="monthly"
          switchingPlan="starter"
        />,
      );
      fireEvent.click(
        screen.getByTestId('billing-estimator-recommendation-annual-pitch-cta'),
      );
      expect(calls).toEqual([]);
    });
  });
});
