// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

void React;

vi.mock('../../client-app/src/components/BillingEstimator', () => ({
  default: () => React.createElement('div', { 'data-testid': 'billing-estimator-stub' }),
}));

function makeFakeJwt(payload: Record<string, unknown>): string {
  const b64 = (s: string) =>
    Buffer.from(s, 'utf8').toString('base64').replace(/=+$/, '');
  return [
    b64(JSON.stringify({ alg: 'none', typ: 'JWT' })),
    b64(JSON.stringify(payload)),
    'sig',
  ].join('.');
}

function loginAsOwner() {
  localStorage.setItem(
    'auth_token',
    makeFakeJwt({
      sub: 'user-1',
      tenantId: 'tenant-1',
      email: 'owner@acme.test',
      role: 'owner',
      isPlatformAdmin: false,
      exp: Math.floor(Date.now() / 1000) + 60 * 60,
    }),
  );
}

interface CheckoutBody {
  plan?: string;
  interval?: string;
  successUrl?: string;
  cancelUrl?: string;
}

let lastCheckoutBody: CheckoutBody | null = null;
let handlers: Record<string, () => unknown> = {};

beforeEach(() => {
  localStorage.clear();
  lastCheckoutBody = null;

  handlers = {
    '/tenants/me': () => ({
      tenant: {
        id: 'tenant-1',
        name: 'Acme',
        slug: 'acme',
        plan: 'starter',
        status: 'active',
        billing_currency: 'usd',
      },
    }),
    '/billing/subscription': () => ({
      subscription: {
        plan: 'starter',
        status: 'active',
        billing_interval: 'monthly',
        current_period_start: new Date().toISOString(),
        current_period_end: new Date().toISOString(),
        trial_end: null,
        cancelled_at: null,
        monthly_call_limit: 500,
        monthly_sms_limit: 1000,
        monthly_ai_minute_limit: 250,
        overage_enabled: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    }),
    '/billing/usage': () => ({ usage: {} }),
    '/billing/budget': () => ({
      allowed: true,
      plan: 'starter',
      status: 'active',
      usage: { callsUsed: 0, callLimit: 500, aiMinutesUsed: 0, aiMinuteLimit: 250 },
    }),
    '/billing/invoices': () => ({ invoices: [] }),
    '/billing/effective-rate': () => ({
      basePriceCents: 9900,
      overageRatePerMinute: 0.15,
      basePriceSource: 'catalog',
      overagePriceSource: 'catalog',
    }),
  };

  // happy-dom throws on window.location.href = ...; stub a settable shim.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { href: 'http://localhost/billing', origin: 'http://localhost', search: '' },
  });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '');

      if (path.startsWith('/billing/checkout')) {
        try {
          lastCheckoutBody = JSON.parse((init?.body as string) ?? '{}');
        } catch {
          lastCheckoutBody = {};
        }
        return new Response(JSON.stringify({ url: 'https://stripe.test/checkout' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      for (const prefix of Object.keys(handlers)) {
        if (path.startsWith(prefix)) {
          return new Response(JSON.stringify(handlers[prefix]()), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetModules();
  localStorage.clear();
});

async function renderBilling() {
  vi.resetModules();
  const mod = await import('../../client-app/src/pages/Billing');
  const Billing = mod.default as React.ComponentType;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Billing />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function setSubscription(plan: string, billing_interval: 'monthly' | 'annual') {
  handlers['/billing/subscription'] = () => ({
    subscription: {
      plan,
      status: 'active',
      billing_interval,
      current_period_start: new Date().toISOString(),
      current_period_end: new Date().toISOString(),
      trial_end: null,
      cancelled_at: null,
      monthly_call_limit: 5000,
      monthly_sms_limit: 10_000,
      monthly_ai_minute_limit: 2500,
      overage_enabled: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
  handlers['/billing/budget'] = () => ({
    allowed: true,
    plan,
    status: 'active',
    usage: { callsUsed: 0, callLimit: 5000, aiMinutesUsed: 0, aiMinuteLimit: 2500 },
  });
}

describe('Billing page upgrade interval toggle', () => {
  it('renders a Monthly/Annual toggle near the upgrade buttons', async () => {
    loginAsOwner();
    await renderBilling();
    await waitFor(() => {
      expect(screen.getByTestId('billing-upgrade-interval-toggle')).toBeTruthy();
      expect(screen.getByTestId('billing-upgrade-interval-monthly')).toBeTruthy();
      expect(screen.getByTestId('billing-upgrade-interval-annual')).toBeTruthy();
    });
  });

  it('shows the discounted base price and "billed annually" hint when Annual is selected', async () => {
    loginAsOwner();
    await renderBilling();

    await waitFor(() => screen.getByTestId('billing-upgrade-card-pro'));

    const monthlyPriceText = screen.getByTestId('billing-upgrade-price-pro').textContent ?? '';
    expect(monthlyPriceText).toContain('$399');
    expect(monthlyPriceText).not.toMatch(/billed annually/i);

    fireEvent.click(screen.getByTestId('billing-upgrade-interval-annual'));
    const annualPriceText = screen.getByTestId('billing-upgrade-price-pro').textContent ?? '';
    expect(annualPriceText).toContain('$319');
    expect(annualPriceText).toContain('$399');
    expect(screen.getByTestId('billing-upgrade-annual-note-pro').textContent ?? '').toMatch(/billed annually/i);

    const entAnnualText = screen.getByTestId('billing-upgrade-price-enterprise').textContent ?? '';
    expect(entAnnualText).toContain('$799');
    expect(entAnnualText).toContain('$999');
  });

  it('forwards the selected interval to /billing/checkout when Upgrade is clicked', async () => {
    loginAsOwner();
    await renderBilling();

    await waitFor(() => screen.getByTestId('billing-upgrade-card-pro'));

    fireEvent.click(screen.getByTestId('billing-upgrade-button-pro'));
    await waitFor(() => {
      expect(lastCheckoutBody).toMatchObject({ plan: 'pro', interval: 'monthly' });
    });

    lastCheckoutBody = null;
    fireEvent.click(screen.getByTestId('billing-upgrade-interval-annual'));
    fireEvent.click(screen.getByTestId('billing-upgrade-button-enterprise'));
    await waitFor(() => {
      expect(lastCheckoutBody).toMatchObject({ plan: 'enterprise', interval: 'annual' });
    });
  });

  it('lets a Pro monthly tenant switch to Pro annual', async () => {
    loginAsOwner();
    setSubscription('pro', 'monthly');
    await renderBilling();

    await waitFor(() => screen.getByTestId('billing-upgrade-card-enterprise'));
    expect(screen.queryByTestId('billing-upgrade-card-pro')).toBeNull();

    fireEvent.click(screen.getByTestId('billing-upgrade-interval-annual'));
    await waitFor(() => screen.getByTestId('billing-upgrade-card-pro'));
    const proCard = screen.getByTestId('billing-upgrade-card-pro');
    expect(proCard.getAttribute('data-card-kind')).toBe('switch_annual');
    expect(proCard.textContent ?? '').toMatch(/Switch to annual/i);
    expect(screen.getByTestId('billing-upgrade-price-pro').textContent ?? '').toContain('$319');
    expect(screen.getByTestId('billing-upgrade-annual-note-pro').textContent ?? '').toMatch(/billed annually/i);

    fireEvent.click(screen.getByTestId('billing-upgrade-button-pro'));
    await waitFor(() => {
      expect(lastCheckoutBody).toMatchObject({ plan: 'pro', interval: 'annual' });
    });
  });

  it('lets an Enterprise monthly tenant switch to Enterprise annual', async () => {
    loginAsOwner();
    setSubscription('enterprise', 'monthly');
    await renderBilling();

    await waitFor(() => screen.getByTestId('billing-upgrade-interval-toggle'));
    expect(screen.queryByTestId('billing-upgrade-card-enterprise')).toBeNull();
    expect(screen.queryByTestId('billing-upgrade-card-pro')).toBeNull();

    fireEvent.click(screen.getByTestId('billing-upgrade-interval-annual'));
    await waitFor(() => screen.getByTestId('billing-upgrade-card-enterprise'));
    const entCard = screen.getByTestId('billing-upgrade-card-enterprise');
    expect(entCard.getAttribute('data-card-kind')).toBe('switch_annual');
    expect(entCard.textContent ?? '').toMatch(/Switch to annual/i);
    expect(screen.getByTestId('billing-upgrade-price-enterprise').textContent ?? '').toContain('$799');

    fireEvent.click(screen.getByTestId('billing-upgrade-button-enterprise'));
    await waitFor(() => {
      expect(lastCheckoutBody).toMatchObject({ plan: 'enterprise', interval: 'annual' });
    });
  });

  it('defaults the toggle to Annual when the tenant is already on annual billing', async () => {
    loginAsOwner();
    setSubscription('pro', 'annual');
    await renderBilling();

    await waitFor(() => {
      expect(screen.getByTestId('billing-upgrade-interval-annual').getAttribute('aria-pressed')).toBe('true');
    });
    // Enterprise upgrade card should already show the discounted price + hint.
    expect(screen.getByTestId('billing-upgrade-price-enterprise').textContent ?? '').toContain('$799');

    fireEvent.click(screen.getByTestId('billing-upgrade-button-enterprise'));
    await waitFor(() => {
      expect(lastCheckoutBody).toMatchObject({ plan: 'enterprise', interval: 'annual' });
    });
  });

  it('still shows the "highest plan" message for an Enterprise tenant already on annual billing', async () => {
    loginAsOwner();
    setSubscription('enterprise', 'annual');
    await renderBilling();

    await waitFor(() => screen.getByTestId('billing-upgrade-interval-toggle'));
    fireEvent.click(screen.getByTestId('billing-upgrade-interval-annual'));

    expect(screen.queryByTestId('billing-upgrade-card-enterprise')).toBeNull();
    expect(screen.queryByTestId('billing-upgrade-card-pro')).toBeNull();
    expect(screen.getByText(/highest plan/i)).toBeTruthy();
  });
});
