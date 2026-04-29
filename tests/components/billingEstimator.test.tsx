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
});
