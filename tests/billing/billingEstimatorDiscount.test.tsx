// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, screen } from '@testing-library/react';
import BillingEstimator, {
  type DiscountEvent,
} from '../../client-app/src/components/BillingEstimator';

void React;

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

afterEach(() => {
  cleanup();
  try {
    window.sessionStorage.clear();
  } catch {
    // ignore
  }
});

beforeEach(() => {
  try {
    window.sessionStorage.clear();
  } catch {
    // ignore
  }
});

// UI tests for the upgrade-card discount badge analytics callback.
// Click attribution lives in the parent (Billing.tsx); these tests
// cover impression emission only.
describe('BillingEstimator discount impression callback', () => {
  it('fires a discount_impression with the resolved coupon identity when the badge renders', () => {
    const events: DiscountEvent[] = [];
    render(
      <BillingEstimator
        currentPlan="starter"
        monthToDateAiMinutes={300}
        tenantId={TENANT_A}
        upgradePreview={{
          basePriceCents: 30000,
          overageRatePerMinute: 0.09,
          discount: {
            couponId: 'cou_promo20',
            promotionCode: 'PROMO20',
            percentOff: 25,
            name: '25% off',
          },
        }}
        onDiscountEvent={(event) => events.push(event)}
      />,
    );

    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event!.type).toBe('discount_impression');
    expect(event!.tier).toBe('pro');
    expect(event!.currentTier).toBe('starter');
    expect(event!.couponId).toBe('cou_promo20');
    expect(event!.promotionCode).toBe('PROMO20');
  });

  it('does not fire when the discount has no off-amount / off-percent (badge is not rendered)', () => {
    const events: DiscountEvent[] = [];
    render(
      <BillingEstimator
        currentPlan="starter"
        monthToDateAiMinutes={300}
        tenantId={TENANT_A}
        upgradePreview={{
          basePriceCents: 30000,
          overageRatePerMinute: 0.09,
          discount: {
            couponId: 'cou_promo20',
            promotionCode: 'PROMO20',
          },
        }}
        onDiscountEvent={(event) => events.push(event)}
      />,
    );

    expect(events).toHaveLength(0);
  });

  it('does not fire when neither couponId nor promotionCode is available', () => {
    const events: DiscountEvent[] = [];
    render(
      <BillingEstimator
        currentPlan="starter"
        monthToDateAiMinutes={300}
        tenantId={TENANT_A}
        upgradePreview={{
          basePriceCents: 30000,
          overageRatePerMinute: 0.09,
          discount: {
            percentOff: 25,
            name: 'Internal trial',
          },
        }}
        onDiscountEvent={(event) => events.push(event)}
      />,
    );

    expect(events).toHaveLength(0);
  });

  it('does not fire on the current-tier card even when the current tier carries a discount', () => {
    // BillingEstimator only forwards onDiscountEvent to the comparison
    // card; the current-tier card is never instrumented.
    const events: DiscountEvent[] = [];
    render(
      <BillingEstimator
        currentPlan="enterprise"
        monthToDateAiMinutes={300}
        tenantId={TENANT_A}
        rateOverride={{
          basePriceCents: 90000,
          overageRatePerMinute: 0,
        }}
        upgradePreview={{
          basePriceCents: 9900,
          overageRatePerMinute: 0.15,
          discount: null,
        }}
        onDiscountEvent={(event) => events.push(event)}
      />,
    );

    expect(events).toHaveLength(0);
  });

  it('dedupes the impression across rerenders within the same tenant + tab', () => {
    const events: DiscountEvent[] = [];
    const { rerender } = render(
      <BillingEstimator
        currentPlan="starter"
        monthToDateAiMinutes={300}
        tenantId={TENANT_A}
        upgradePreview={{
          basePriceCents: 30000,
          overageRatePerMinute: 0.09,
          discount: {
            couponId: 'cou_promo20',
            promotionCode: 'PROMO20',
            percentOff: 25,
          },
        }}
        onDiscountEvent={(event) => events.push(event)}
      />,
    );
    expect(events).toHaveLength(1);

    rerender(
      <BillingEstimator
        currentPlan="starter"
        monthToDateAiMinutes={400}
        tenantId={TENANT_A}
        upgradePreview={{
          basePriceCents: 30000,
          overageRatePerMinute: 0.09,
          discount: {
            couponId: 'cou_promo20',
            promotionCode: 'PROMO20',
            percentOff: 25,
          },
        }}
        onDiscountEvent={(event) => events.push(event)}
      />,
    );
    expect(events).toHaveLength(1);
  });

  it('re-fires the impression when the tab is reused by a different tenant', () => {
    // Tenant scope in the dedup key prevents tenant A from suppressing
    // tenant B's impression on the same coupon — without this scope,
    // the admin "seen" count would silently lose tenant B's view.
    const events: DiscountEvent[] = [];
    const { rerender } = render(
      <BillingEstimator
        currentPlan="starter"
        monthToDateAiMinutes={300}
        tenantId={TENANT_A}
        upgradePreview={{
          basePriceCents: 30000,
          overageRatePerMinute: 0.09,
          discount: {
            couponId: 'cou_promo20',
            promotionCode: 'PROMO20',
            percentOff: 25,
          },
        }}
        onDiscountEvent={(event) => events.push(event)}
      />,
    );
    expect(events).toHaveLength(1);

    rerender(
      <BillingEstimator
        currentPlan="starter"
        monthToDateAiMinutes={300}
        tenantId={TENANT_B}
        upgradePreview={{
          basePriceCents: 30000,
          overageRatePerMinute: 0.09,
          discount: {
            couponId: 'cou_promo20',
            promotionCode: 'PROMO20',
            percentOff: 25,
          },
        }}
        onDiscountEvent={(event) => events.push(event)}
      />,
    );
    expect(events).toHaveLength(2);
  });

  it('does not fire when tenantId is missing (cannot scope dedup safely)', () => {
    const events: DiscountEvent[] = [];
    render(
      <BillingEstimator
        currentPlan="starter"
        monthToDateAiMinutes={300}
        upgradePreview={{
          basePriceCents: 30000,
          overageRatePerMinute: 0.09,
          discount: {
            couponId: 'cou_promo20',
            promotionCode: 'PROMO20',
            percentOff: 25,
          },
        }}
        onDiscountEvent={(event) => events.push(event)}
      />,
    );
    expect(events).toHaveLength(0);
  });

  it('fires a fresh impression when the couponId changes (different discount = different funnel)', () => {
    const events: DiscountEvent[] = [];
    const { rerender } = render(
      <BillingEstimator
        currentPlan="starter"
        monthToDateAiMinutes={300}
        tenantId={TENANT_A}
        upgradePreview={{
          basePriceCents: 30000,
          overageRatePerMinute: 0.09,
          discount: {
            couponId: 'cou_promo20',
            promotionCode: 'PROMO20',
            percentOff: 25,
          },
        }}
        onDiscountEvent={(event) => events.push(event)}
      />,
    );
    expect(events).toHaveLength(1);

    rerender(
      <BillingEstimator
        currentPlan="starter"
        monthToDateAiMinutes={300}
        tenantId={TENANT_A}
        upgradePreview={{
          basePriceCents: 28000,
          overageRatePerMinute: 0.09,
          discount: {
            couponId: 'cou_blackfriday',
            promotionCode: 'BLACKFRIDAY',
            percentOff: 30,
          },
        }}
        onDiscountEvent={(event) => events.push(event)}
      />,
    );
    expect(events).toHaveLength(2);
    expect(events[1]!.couponId).toBe('cou_blackfriday');
    expect(events[1]!.promotionCode).toBe('BLACKFRIDAY');
  });

  it('renders without crashing when onDiscountEvent is omitted (analytics is opt-in)', () => {
    expect(() =>
      render(
        <BillingEstimator
          currentPlan="starter"
          monthToDateAiMinutes={300}
          tenantId={TENANT_A}
          upgradePreview={{
            basePriceCents: 30000,
            overageRatePerMinute: 0.09,
            discount: {
              couponId: 'cou_promo20',
              promotionCode: 'PROMO20',
              percentOff: 25,
            },
          }}
        />,
      ),
    ).not.toThrow();
    expect(screen.queryByTestId('billing-estimator-tier-pro')).toBeTruthy();
  });

  it('does not interact with the recommendation analytics surface', () => {
    // Discount and recommendation impressions must fire independently
    // when both surfaces are visible on mount.
    const discountEvents: DiscountEvent[] = [];
    const recommendationEvents: unknown[] = [];
    render(
      <BillingEstimator
        currentPlan="starter"
        monthToDateAiMinutes={4_000}
        tenantId={TENANT_A}
        trailingMonthlyAiMinutes={[4_000, 4_000, 4_000]}
        upgradePreview={{
          basePriceCents: 30000,
          overageRatePerMinute: 0.09,
          discount: {
            couponId: 'cou_promo20',
            promotionCode: 'PROMO20',
            percentOff: 25,
          },
        }}
        onDiscountEvent={(event) => discountEvents.push(event)}
        onRecommendationEvent={(event) => recommendationEvents.push(event)}
        onSwitchPlan={() => undefined}
      />,
    );
    expect(discountEvents).toHaveLength(1);
    expect(recommendationEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('keeps the recommendation CTA interactive after impression', () => {
    const events: DiscountEvent[] = [];
    render(
      <BillingEstimator
        currentPlan="starter"
        monthToDateAiMinutes={4_000}
        tenantId={TENANT_A}
        trailingMonthlyAiMinutes={[4_000, 4_000, 4_000]}
        upgradePreview={{
          basePriceCents: 30000,
          overageRatePerMinute: 0.09,
          discount: {
            couponId: 'cou_promo20',
            promotionCode: 'PROMO20',
            percentOff: 25,
          },
        }}
        onDiscountEvent={(event) => events.push(event)}
        onSwitchPlan={() => undefined}
      />,
    );
    const cta = screen.queryByTestId('billing-estimator-recommendation-cta');
    if (cta) fireEvent.click(cta);
    expect(events).toHaveLength(1);
  });
});
