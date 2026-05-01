// @vitest-environment happy-dom
/**
 * Regression coverage for task #1157.
 *
 * The website chat widget's `recommend_plan` card must surface the
 * 20%-off annual-billing price alongside the catalog monthly price, and
 * its "Start [Plan] Trial" CTA must preserve the visitor's billing
 * choice as `?interval=annual` the same way the public Pricing page CTA
 * does. Previously the card only showed the monthly price, so a visitor
 * who toggled "Annual" on Pricing saw a different number in the chat
 * card and lost their interval choice on signup.
 */
import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import WebsiteSalesWidget from '../../client-app/src/components/WebsiteSalesWidget';
import { ANNUAL_DISCOUNT } from '../../client-app/src/components/MinutesPricingCalculator';
import { writeBillingPeriodPreference } from '../../client-app/src/lib/billingPeriodPreference';

void React;

let lastNavigation: string | null = null;

beforeEach(() => {
  lastNavigation = null;
  // Always start tests from a clean preference state so the default
  // monthly behavior is deterministic.
  if (typeof window !== 'undefined') {
    window.localStorage.clear();
  }

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/website-agent/greeting')) {
      return new Response(JSON.stringify({ greeting: 'Hi from QVO' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/api/website-agent/chat')) {
      const body = init?.body ? JSON.parse(init.body as string) : {};
      // Suppress side-channel page-context updates by returning a noop.
      if (typeof body.message === 'string' && body.message.startsWith('[System:')) {
        return new Response(JSON.stringify({ message: '', actions: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          conversationId: 'conv-1',
          message: 'Based on what you described, I recommend the Pro plan.',
          actions: [
            {
              type: 'recommend_plan',
              data: {
                plan: 'pro',
                reason: 'Recommended for growing teams',
                monthlyPriceCents: 39900,
                includedMinutes: 2500,
                overageRatePerMinute: 0.12,
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function NavigationProbe() {
  // Capture the active path so we can assert the trial CTA preserves
  // the visitor's interval choice as ?interval=annual.
  return (
    <Routes>
      <Route
        path="*"
        element={
          <CapturePath onPath={(p) => (lastNavigation = p)} />
        }
      />
    </Routes>
  );
}

function CapturePath({ onPath }: { onPath: (path: string) => void }) {
  const loc = useLocation();
  React.useEffect(() => {
    onPath(`${loc.pathname}${loc.search}`);
  }, [loc.pathname, loc.search, onPath]);
  return null;
}

function renderWidget() {
  return render(
    <MemoryRouter initialEntries={['/pricing']}>
      <WebsiteSalesWidget />
      <NavigationProbe />
    </MemoryRouter>,
  );
}

async function openWidgetAndAskForRecommendation() {
  fireEvent.click(screen.getByRole('button', { name: /open chat/i }));
  await waitFor(() => expect(screen.getByPlaceholderText(/type a message/i)).toBeTruthy());
  const input = screen.getByPlaceholderText(/type a message/i) as HTMLInputElement;
  fireEvent.change(input, { target: { value: 'Which plan do you recommend?' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  await waitFor(() => expect(screen.getByTestId('recommend-plan-price-pro')).toBeTruthy());
}

describe('WebsiteSalesWidget recommend_plan annual variant', () => {
  it('shows the catalog monthly price and the annual-equivalent monthly savings line', async () => {
    renderWidget();
    await openWidgetAndAskForRecommendation();

    const priceEl = screen.getByTestId('recommend-plan-price-pro');
    // Default render is monthly: $399/month
    expect(priceEl.textContent).toContain('$399/month');

    const altPriceEl = screen.getByTestId('recommend-plan-alt-price-pro');
    // Discounted annual-equivalent monthly using ANNUAL_DISCOUNT (399 * 0.8 = 319.20)
    const annualMonthlyCents = Math.round(39900 * (1 - ANNUAL_DISCOUNT));
    const expectedAnnualDollars = (annualMonthlyCents / 100).toFixed(0);
    expect(altPriceEl.textContent).toContain(`$${expectedAnnualDollars}/mo billed annually`);
    expect(altPriceEl.textContent).toContain(`save ${Math.round(ANNUAL_DISCOUNT * 100)}%`);
  });

  it('toggling Annual swaps the displayed price and CTA carries ?interval=annual', async () => {
    renderWidget();
    await openWidgetAndAskForRecommendation();

    const annualToggle = screen.getByTestId('recommend-plan-interval-annual-pro');
    act(() => {
      fireEvent.click(annualToggle);
    });

    const priceEl = screen.getByTestId('recommend-plan-price-pro');
    const annualMonthlyDollars = Math.round(39900 * (1 - ANNUAL_DISCOUNT) / 100);
    expect(priceEl.textContent).toContain(`$${annualMonthlyDollars}/month`);

    // Alt price now shows the strikethrough monthly equivalent
    const altPriceEl = screen.getByTestId('recommend-plan-alt-price-pro');
    expect(altPriceEl.textContent).toContain('$399/mo billed monthly');

    const cta = screen.getByTestId('recommend-plan-cta-pro');
    act(() => {
      fireEvent.click(cta);
    });
    await waitFor(() =>
      expect(lastNavigation).toBe('/signup?plan=pro&interval=annual'),
    );
  });

  it('monthly toggle keeps the legacy CTA href without an interval query param', async () => {
    renderWidget();
    await openWidgetAndAskForRecommendation();

    const cta = screen.getByTestId('recommend-plan-cta-pro');
    act(() => {
      fireEvent.click(cta);
    });
    await waitFor(() => expect(lastNavigation).toBe('/signup?plan=pro'));
  });

  it('honors the Pricing-page annual selection on first render (no extra clicks)', async () => {
    // Simulates a visitor who toggled "Annual" on /pricing, then
    // opened the chat. The shared marketing preference is set before
    // the widget mounts.
    writeBillingPeriodPreference('annual');

    renderWidget();
    await openWidgetAndAskForRecommendation();

    // Card should default to annual without any in-chat toggling.
    const annualToggle = screen.getByTestId('recommend-plan-interval-annual-pro');
    expect(annualToggle.getAttribute('aria-pressed')).toBe('true');

    const priceEl = screen.getByTestId('recommend-plan-price-pro');
    const annualMonthlyDollars = Math.round((39900 * (1 - ANNUAL_DISCOUNT)) / 100);
    expect(priceEl.textContent).toContain(`$${annualMonthlyDollars}/month`);

    const cta = screen.getByTestId('recommend-plan-cta-pro');
    act(() => {
      fireEvent.click(cta);
    });
    await waitFor(() =>
      expect(lastNavigation).toBe('/signup?plan=pro&interval=annual'),
    );
  });

  it('responds live to a billing-period change broadcast from the Pricing page', async () => {
    renderWidget();
    await openWidgetAndAskForRecommendation();

    // Default is monthly.
    const monthlyToggle = screen.getByTestId('recommend-plan-interval-monthly-pro');
    expect(monthlyToggle.getAttribute('aria-pressed')).toBe('true');

    // Pricing page (or another tab) toggles to annual.
    act(() => {
      writeBillingPeriodPreference('annual');
    });

    const annualToggle = screen.getByTestId('recommend-plan-interval-annual-pro');
    expect(annualToggle.getAttribute('aria-pressed')).toBe('true');

    const cta = screen.getByTestId('recommend-plan-cta-pro');
    act(() => {
      fireEvent.click(cta);
    });
    await waitFor(() =>
      expect(lastNavigation).toBe('/signup?plan=pro&interval=annual'),
    );
  });
});
