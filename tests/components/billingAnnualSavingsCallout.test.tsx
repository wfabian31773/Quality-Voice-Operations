// @vitest-environment happy-dom
import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

void React;

// The Subscription card is the surface under test — stub the Billing
// Estimator so its async data fetches can't race the render assertions.
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

function loginAsViewer() {
  localStorage.setItem(
    'auth_token',
    makeFakeJwt({
      sub: 'user-2',
      tenantId: 'tenant-1',
      email: 'viewer@acme.test',
      role: 'viewer',
      isPlatformAdmin: false,
      exp: Math.floor(Date.now() / 1000) + 60 * 60,
    }),
  );
}

interface SubscriptionFixture {
  plan: 'starter' | 'pro' | 'enterprise';
  billing_interval: 'monthly' | 'annual';
  status?: 'active' | 'trialing' | 'past_due' | 'incomplete' | 'cancelled';
}

interface EffectiveRateFixture {
  basePriceCents: number;
  overageRatePerMinute: number;
  basePriceSource: 'stripe' | 'catalog';
  overagePriceSource: 'stripe' | 'catalog';
  monthlyBasePriceCents?: number;
  monthlyBasePriceSource?: 'stripe' | 'catalog';
  annualBasePriceCents?: number;
  annualBasePriceSource?: 'stripe' | 'catalog';
}

let handlers: Record<string, () => unknown> = {};
let checkoutCalls: Array<{ method: string; body: unknown }> = [];

function defaultHandlers(
  sub: SubscriptionFixture,
  rate: EffectiveRateFixture,
): Record<string, () => unknown> {
  return {
    '/tenants/me': () => ({
      tenant: {
        id: 'tenant-1',
        name: 'Acme',
        slug: 'acme',
        plan: sub.plan,
        status: 'active',
        billing_currency: 'usd',
      },
    }),
    '/billing/subscription': () => ({
      subscription: {
        plan: sub.plan,
        status: sub.status ?? 'active',
        billing_interval: sub.billing_interval,
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
    }),
    '/billing/usage': () => ({ usage: {} }),
    '/billing/budget': () => ({
      allowed: true,
      plan: sub.plan,
      status: sub.status ?? 'active',
      usage: { callsUsed: 0, callLimit: 5000, aiMinutesUsed: 0, aiMinuteLimit: 2500 },
    }),
    '/billing/invoices': () => ({ invoices: [] }),
    '/billing/effective-rate': () => rate,
  };
}

beforeEach(() => {
  localStorage.clear();
  handlers = {};
  checkoutCalls = [];

  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { href: 'http://localhost/billing', origin: 'http://localhost', search: '' },
  });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '');
      const method = (init?.method ?? 'GET').toUpperCase();

      if (path === '/me/preferences' && method === 'GET') {
        return new Response(JSON.stringify({ preferences: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/me/preferences' && method === 'PATCH') {
        return new Response(JSON.stringify({ preferences: {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (path === '/billing/checkout' && method === 'POST') {
        let parsed: unknown = null;
        try {
          parsed = init?.body ? JSON.parse(String(init.body)) : null;
        } catch {
          parsed = null;
        }
        checkoutCalls.push({ method, body: parsed });
        return new Response(
          JSON.stringify({ url: 'https://checkout.stripe.test/session-1' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
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

describe('Billing annual-savings callout', () => {
  it('renders a Save $X/yr callout for tenants on monthly billing when annual is cheaper', async () => {
    handlers = defaultHandlers(
      { plan: 'pro', billing_interval: 'monthly' },
      {
        basePriceCents: 39_900,
        overageRatePerMinute: 0.12,
        basePriceSource: 'stripe',
        overagePriceSource: 'stripe',
        monthlyBasePriceCents: 39_900,
        monthlyBasePriceSource: 'stripe',
        annualBasePriceCents: 31_900,
        annualBasePriceSource: 'stripe',
      },
    );
    loginAsOwner();
    await renderBilling();

    await waitFor(() => {
      expect(screen.getByTestId('billing-annual-savings-callout')).toBeTruthy();
    });

    // Savings line: ($39,900 - $31,900) × 12 = $96,000 cents = $960/yr.
    const savings = screen.getByTestId('billing-annual-savings-amount');
    expect(savings.textContent).toMatch(/\$960\.00\/yr/);

    // Annual-equivalent monthly price ($319.00) and the current monthly
    // base ($399.00) both surface so the tenant can compare side by side.
    expect(
      screen.getByTestId('billing-annual-savings-monthly-base').textContent,
    ).toMatch(/\$399\.00\/mo/);
    expect(
      screen.getByTestId('billing-annual-savings-annual-equivalent').textContent,
    ).toMatch(/\$319\.00\/mo/);

    // "Live rate" badge appears because both sources came from Stripe.
    expect(screen.getByTestId('billing-annual-savings-live-rate')).toBeTruthy();
  });

  it('hides the callout for tenants already on annual billing', async () => {
    handlers = defaultHandlers(
      { plan: 'pro', billing_interval: 'annual' },
      {
        basePriceCents: 31_900,
        overageRatePerMinute: 0.10,
        basePriceSource: 'stripe',
        overagePriceSource: 'stripe',
        monthlyBasePriceCents: 39_900,
        monthlyBasePriceSource: 'stripe',
        annualBasePriceCents: 31_900,
        annualBasePriceSource: 'stripe',
      },
    );
    loginAsOwner();
    await renderBilling();

    // Wait for the page to settle (effective-rate query resolved).
    await waitFor(() => {
      expect(screen.getByText('Subscription')).toBeTruthy();
    });

    expect(screen.queryByTestId('billing-annual-savings-callout')).toBeNull();
  });

  it('omits the Live rate badge when both prices fall back to the catalog', async () => {
    handlers = defaultHandlers(
      { plan: 'starter', billing_interval: 'monthly' },
      {
        basePriceCents: 9_900,
        overageRatePerMinute: 0.15,
        basePriceSource: 'catalog',
        overagePriceSource: 'catalog',
        monthlyBasePriceCents: 9_900,
        monthlyBasePriceSource: 'catalog',
        annualBasePriceCents: 7_920,
        annualBasePriceSource: 'catalog',
      },
    );
    loginAsOwner();
    await renderBilling();

    await waitFor(() => {
      expect(screen.getByTestId('billing-annual-savings-callout')).toBeTruthy();
    });

    expect(screen.queryByTestId('billing-annual-savings-live-rate')).toBeNull();
    // Savings: ($99 - $79.20) × 12 = $237.60/yr.
    expect(
      screen.getByTestId('billing-annual-savings-amount').textContent,
    ).toMatch(/\$237\.60\/yr/);
  });

  it('hides the callout when the annual price is not cheaper than monthly', async () => {
    // Could happen for a grandfathered tenant whose monthly rate is
    // already discounted to the annual list price — there is nothing
    // to save by switching.
    handlers = defaultHandlers(
      { plan: 'pro', billing_interval: 'monthly' },
      {
        basePriceCents: 31_900,
        overageRatePerMinute: 0.10,
        basePriceSource: 'stripe',
        overagePriceSource: 'stripe',
        monthlyBasePriceCents: 31_900,
        monthlyBasePriceSource: 'stripe',
        annualBasePriceCents: 31_900,
        annualBasePriceSource: 'stripe',
      },
    );
    loginAsOwner();
    await renderBilling();

    await waitFor(() => {
      expect(screen.getByText('Subscription')).toBeTruthy();
    });

    expect(screen.queryByTestId('billing-annual-savings-callout')).toBeNull();
  });

  it('hides the callout when the effective-rate response omits the new fields (legacy/partial server)', async () => {
    handlers = defaultHandlers(
      { plan: 'pro', billing_interval: 'monthly' },
      {
        basePriceCents: 39_900,
        overageRatePerMinute: 0.12,
        basePriceSource: 'catalog',
        overagePriceSource: 'catalog',
        // monthlyBasePriceCents / annualBasePriceCents intentionally
        // omitted so we exercise the defence-in-depth guard.
      },
    );
    loginAsOwner();
    await renderBilling();

    await waitFor(() => {
      expect(screen.getByText('Subscription')).toBeTruthy();
    });

    expect(screen.queryByTestId('billing-annual-savings-callout')).toBeNull();
  });

  it('hides the callout when the monthly subscription is past_due (not in good standing)', async () => {
    handlers = defaultHandlers(
      { plan: 'pro', billing_interval: 'monthly', status: 'past_due' },
      {
        basePriceCents: 39_900,
        overageRatePerMinute: 0.12,
        basePriceSource: 'stripe',
        overagePriceSource: 'stripe',
        monthlyBasePriceCents: 39_900,
        monthlyBasePriceSource: 'stripe',
        annualBasePriceCents: 31_900,
        annualBasePriceSource: 'stripe',
      },
    );
    loginAsOwner();
    await renderBilling();

    await waitFor(() => {
      expect(screen.getByText('Subscription')).toBeTruthy();
    });

    expect(screen.queryByTestId('billing-annual-savings-callout')).toBeNull();
  });

  it('renders the callout for trialing monthly subscriptions (still good standing)', async () => {
    handlers = defaultHandlers(
      { plan: 'pro', billing_interval: 'monthly', status: 'trialing' },
      {
        basePriceCents: 39_900,
        overageRatePerMinute: 0.12,
        basePriceSource: 'stripe',
        overagePriceSource: 'stripe',
        monthlyBasePriceCents: 39_900,
        monthlyBasePriceSource: 'stripe',
        annualBasePriceCents: 31_900,
        annualBasePriceSource: 'stripe',
      },
    );
    loginAsOwner();
    await renderBilling();

    await waitFor(() => {
      expect(screen.getByTestId('billing-annual-savings-callout')).toBeTruthy();
    });
  });

  it('hides the callout for free-tier tenants without a subscription', async () => {
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
      '/billing/subscription': () => ({ subscription: null, plan: 'starter', status: 'none' }),
      '/billing/usage': () => ({ usage: {} }),
      '/billing/budget': () => ({
        allowed: true,
        plan: 'starter',
        status: 'none',
        usage: { callsUsed: 0, callLimit: 500, aiMinutesUsed: 0, aiMinuteLimit: 250 },
      }),
      '/billing/invoices': () => ({ invoices: [] }),
      '/billing/effective-rate': () => ({
        basePriceCents: 9_900,
        overageRatePerMinute: 0.15,
        basePriceSource: 'catalog',
        overagePriceSource: 'catalog',
        monthlyBasePriceCents: 9_900,
        monthlyBasePriceSource: 'catalog',
        annualBasePriceCents: 7_920,
        annualBasePriceSource: 'catalog',
      }),
    };
    loginAsOwner();
    await renderBilling();

    await waitFor(() => {
      expect(screen.getByText('Subscription')).toBeTruthy();
    });

    expect(screen.queryByTestId('billing-annual-savings-callout')).toBeNull();
  });

  it('clicking the in-callout "Switch to annual" button kicks off Stripe Checkout for the same tier on annual', async () => {
    handlers = defaultHandlers(
      { plan: 'pro', billing_interval: 'monthly' },
      {
        basePriceCents: 39_900,
        overageRatePerMinute: 0.12,
        basePriceSource: 'stripe',
        overagePriceSource: 'stripe',
        monthlyBasePriceCents: 39_900,
        monthlyBasePriceSource: 'stripe',
        annualBasePriceCents: 31_900,
        annualBasePriceSource: 'stripe',
      },
    );
    loginAsOwner();
    await renderBilling();

    const button = await screen.findByTestId('billing-annual-savings-switch-button');
    expect(button.textContent).toMatch(/Switch to annual/);

    fireEvent.click(button);

    await waitFor(() => {
      expect(checkoutCalls.length).toBe(1);
    });

    const body = checkoutCalls[0].body as Record<string, unknown>;
    expect(body.plan).toBe('pro');
    expect(body.interval).toBe('annual');
    // Stripe Checkout flow uses the same success/cancel URLs the
    // existing same-tier annual switch card relies on.
    expect(typeof body.successUrl).toBe('string');
    expect(typeof body.cancelUrl).toBe('string');
    // Browser is redirected to the Stripe-hosted checkout URL the
    // server returned.
    await waitFor(() => {
      expect(window.location.href).toBe('https://checkout.stripe.test/session-1');
    });
  });

  it('hides the "Switch to annual" button for read-only roles (viewer)', async () => {
    handlers = defaultHandlers(
      { plan: 'pro', billing_interval: 'monthly' },
      {
        basePriceCents: 39_900,
        overageRatePerMinute: 0.12,
        basePriceSource: 'stripe',
        overagePriceSource: 'stripe',
        monthlyBasePriceCents: 39_900,
        monthlyBasePriceSource: 'stripe',
        annualBasePriceCents: 31_900,
        annualBasePriceSource: 'stripe',
      },
    );
    loginAsViewer();
    await renderBilling();

    // The callout itself still renders for viewers — they should see the
    // savings opportunity — but the CTA stays hidden until an admin acts.
    await waitFor(() => {
      expect(screen.getByTestId('billing-annual-savings-callout')).toBeTruthy();
    });
    expect(screen.queryByTestId('billing-annual-savings-switch-button')).toBeNull();
  });
});
