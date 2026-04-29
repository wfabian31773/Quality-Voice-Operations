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

  it('shows current plan and the next tier up side-by-side', () => {
    render(<BillingEstimator currentPlan="starter" monthToDateAiMinutes={500} />);
    expect(screen.getByTestId('billing-estimator-tier-starter')).toBeTruthy();
    expect(screen.getByTestId('billing-estimator-tier-pro')).toBeTruthy();
    expect(screen.queryByTestId('billing-estimator-tier-enterprise')).toBeNull();
  });

  it('shows next-tier card for pro tenants and hides starter', () => {
    render(<BillingEstimator currentPlan="pro" monthToDateAiMinutes={1000} />);
    expect(screen.getByTestId('billing-estimator-tier-pro')).toBeTruthy();
    expect(screen.getByTestId('billing-estimator-tier-enterprise')).toBeTruthy();
    expect(screen.queryByTestId('billing-estimator-tier-starter')).toBeNull();
  });

  it('renders an "already on top tier" hint for enterprise tenants', () => {
    render(<BillingEstimator currentPlan="enterprise" monthToDateAiMinutes={5000} />);
    expect(screen.getByTestId('billing-estimator-tier-enterprise')).toBeTruthy();
    expect(screen.getByTestId('billing-estimator-top-tier')).toBeTruthy();
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
});
