// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import BillingEstimator, {
  type BillingEstimatorRateOverride,
} from '../../client-app/src/components/BillingEstimator';

void React;

afterEach(() => cleanup());

// Carrier pass-through charges (Twilio per-minute + SMS per-message) were
// removed from QVO pricing — those costs are folded into every plan
// price. The estimator must never render a separate carrier rate row,
// even if a stale caller / legacy API payload still carries the old
// fields with a Stripe provenance flag.
const LEGACY_CARRIER_FIELDS = {
  smsRatePerMessage: 0.0085,
  smsPriceSource: 'stripe',
  smsPriceId: 'price_sms_negotiated_123',
  twilioRatePerMinute: 0.013,
  twilioPriceSource: 'stripe',
  twilioPriceId: 'price_twilio_negotiated_123',
};

const CARRIER_TEST_IDS = [
  'billing-estimator-twilio-rate',
  'billing-estimator-twilio-rate-value',
  'billing-estimator-twilio-source',
  'billing-estimator-sms-rate',
  'billing-estimator-sms-rate-value',
  'billing-estimator-sms-source',
] as const;

function expectNoCarrierRows() {
  for (const id of CARRIER_TEST_IDS) {
    expect(screen.queryByTestId(id)).toBeNull();
  }
}

describe('BillingEstimator carrier rate rows (removed)', () => {
  it('renders no Twilio / SMS rate rows for a legacy Stripe-sourced carrier override', () => {
    const { container } = render(
      <BillingEstimator
        currentPlan="pro"
        monthToDateAiMinutes={0}
        rateOverride={LEGACY_CARRIER_FIELDS as unknown as BillingEstimatorRateOverride}
      />,
    );

    expectNoCarrierRows();
    expect(container.querySelector('[data-twilio-source]')).toBeNull();
    expect(container.querySelector('[data-sms-source]')).toBeNull();
    expect(container.querySelector('[data-twilio-price-id]')).toBeNull();
    expect(container.querySelector('[data-sms-price-id]')).toBeNull();
    expect(container.textContent ?? '').not.toContain('$0.013');
  });

  it('does not treat legacy carrier fields as a Stripe-sourced plan rate', () => {
    // Only base / overage provenance may engage the "Live Stripe rate"
    // badge on the tier card now.
    render(
      <BillingEstimator
        currentPlan="pro"
        monthToDateAiMinutes={0}
        rateOverride={LEGACY_CARRIER_FIELDS as unknown as BillingEstimatorRateOverride}
      />,
    );

    expect(screen.queryByTestId('billing-estimator-source-pro')).toBeNull();
  });

  it('renders no carrier rows with an empty override, and states carrier costs are included', () => {
    const { container } = render(
      <BillingEstimator
        currentPlan="pro"
        monthToDateAiMinutes={0}
        rateOverride={{}}
      />,
    );

    expectNoCarrierRows();
    expect(container.textContent ?? '').toContain(
      'Carrier calling and SMS costs are included in every plan.',
    );
  });
});
