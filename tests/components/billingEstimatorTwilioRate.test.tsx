// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import BillingEstimator from '../../client-app/src/components/BillingEstimator';

void React;

afterEach(() => cleanup());

describe('BillingEstimator Twilio rate row', () => {
  it('renders the Live Stripe rate badge when twilioPriceSource === "stripe"', () => {
    render(
      <BillingEstimator
        currentPlan="pro"
        monthToDateAiMinutes={0}
        rateOverride={{
          twilioRatePerMinute: 0.013,
          twilioPriceSource: 'stripe',
          twilioPriceId: 'price_twilio_negotiated_123',
        }}
      />,
    );

    const row = screen.getByTestId('billing-estimator-twilio-rate');
    expect(row.getAttribute('data-twilio-source')).toBe('stripe');

    const value = screen.getByTestId('billing-estimator-twilio-rate-value');
    expect(value.textContent).toContain('$0.013');
    expect(value.textContent).toContain('/min');

    const badge = screen.getByTestId('billing-estimator-twilio-source');
    expect(badge.textContent).toMatch(/live stripe rate/i);
    expect(badge.getAttribute('data-twilio-price-id')).toBe('price_twilio_negotiated_123');
  });

  it('renders the rate without the badge when twilioPriceSource is "catalog"', () => {
    render(
      <BillingEstimator
        currentPlan="pro"
        monthToDateAiMinutes={0}
        rateOverride={{
          twilioRatePerMinute: 0.02,
          twilioPriceSource: 'catalog',
        }}
      />,
    );

    const row = screen.getByTestId('billing-estimator-twilio-rate');
    expect(row.getAttribute('data-twilio-source')).toBe('catalog');

    const value = screen.getByTestId('billing-estimator-twilio-rate-value');
    expect(value.textContent).toContain('$0.020');

    expect(screen.queryByTestId('billing-estimator-twilio-source')).toBeNull();
  });

  it('renders the rate without the badge when twilioPriceSource is omitted (undefined)', () => {
    // Backwards-compat: a rate-only override (no provenance flag) must
    // still render the row but suppress the Stripe badge so we don't
    // falsely imply a catalog/env-default fallback came from Stripe.
    render(
      <BillingEstimator
        currentPlan="pro"
        monthToDateAiMinutes={0}
        rateOverride={{
          twilioRatePerMinute: 0.02,
        }}
      />,
    );

    const row = screen.getByTestId('billing-estimator-twilio-rate');
    expect(row.getAttribute('data-twilio-source')).toBe('catalog');
    expect(screen.queryByTestId('billing-estimator-twilio-source')).toBeNull();
  });

  it('hides the Twilio rate row entirely when twilioRatePerMinute is omitted', () => {
    // Older API responses that haven't plumbed the field yet must keep
    // rendering — surface a "$0.00/min" line would be misleading.
    render(
      <BillingEstimator
        currentPlan="pro"
        monthToDateAiMinutes={0}
        rateOverride={{}}
      />,
    );

    expect(screen.queryByTestId('billing-estimator-twilio-rate')).toBeNull();
    expect(screen.queryByTestId('billing-estimator-twilio-rate-value')).toBeNull();
    expect(screen.queryByTestId('billing-estimator-twilio-source')).toBeNull();
  });

  it('omits the data-twilio-price-id attribute when no price id was supplied', () => {
    render(
      <BillingEstimator
        currentPlan="pro"
        monthToDateAiMinutes={0}
        rateOverride={{
          twilioRatePerMinute: 0.013,
          twilioPriceSource: 'stripe',
        }}
      />,
    );

    const badge = screen.getByTestId('billing-estimator-twilio-source');
    // happy-dom returns null (not "undefined") for an absent attribute
    expect(badge.getAttribute('data-twilio-price-id')).toBeNull();
  });

  it('hides the badge when a price id is provided but the source is catalog', () => {
    // Defensive: a stale/misconfigured caller passing a price id without
    // a Stripe-sourced provenance must not engage the badge or expose
    // the id as a data attribute (we'd be falsely implying a Stripe
    // override was active).
    render(
      <BillingEstimator
        currentPlan="pro"
        monthToDateAiMinutes={0}
        rateOverride={{
          twilioRatePerMinute: 0.02,
          twilioPriceSource: 'catalog',
          twilioPriceId: 'price_should_be_ignored',
        }}
      />,
    );

    expect(screen.queryByTestId('billing-estimator-twilio-source')).toBeNull();
  });
});
