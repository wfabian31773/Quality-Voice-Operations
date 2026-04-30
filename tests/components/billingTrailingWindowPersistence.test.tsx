// @vitest-environment happy-dom
/**
 * Per-user persistence of the Billing trailing-window toggle (3/6/12 mo).
 * The choice lives in `users.preferences.billing_trailing_window_months`
 * via `/me/preferences` so it follows the user across browsers/devices;
 * localStorage is only a pre-hydration cache.
 *
 * Covers: server hydration on a new browser, write-through on toggle,
 * legacy-localStorage migration, and no-op for brand-new tenants.
 */
import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

void React;

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

interface FetchCall {
  path: string;
  method: string;
  body: unknown;
}

let fetchCalls: FetchCall[] = [];
let preferencesGetResponse: { preferences: Record<string, unknown> | null } = {
  preferences: {},
};
let trailingMonthsRequested: number[] = [];
let handlers: Record<string, () => unknown> = {};

beforeEach(() => {
  localStorage.clear();
  fetchCalls = [];
  trailingMonthsRequested = [];
  preferencesGetResponse = { preferences: {} };

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
      let parsedBody: unknown = undefined;
      if (typeof init?.body === 'string' && init.body.length > 0) {
        try {
          parsedBody = JSON.parse(init.body);
        } catch {
          parsedBody = init.body;
        }
      }
      fetchCalls.push({ path, method, body: parsedBody });

      if (path === '/me/preferences' && method === 'GET') {
        return new Response(JSON.stringify(preferencesGetResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (path === '/me/preferences' && method === 'PATCH') {
        const body = (parsedBody ?? {}) as Record<string, unknown>;
        if (typeof body.billing_trailing_window_months === 'number') {
          trailingMonthsRequested.push(body.billing_trailing_window_months);
        }
        // Merge into the stub like the real endpoint does so the next
        // GET (if any) reflects the saved value.
        preferencesGetResponse = {
          preferences: { ...(preferencesGetResponse.preferences ?? {}), ...body },
        };
        return new Response(
          JSON.stringify({ preferences: preferencesGetResponse.preferences }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      // Trailing usage endpoint — capture the months query param so we
      // can prove the page is fetching with the saved value, not the
      // default. Returns enough usage data for the BillingEstimator to
      // actually render the recommendation card (and therefore the
      // trailing-window toggle we're asserting against).
      if (path.startsWith('/billing/usage/trailing')) {
        const m = /[?&]months=(\d+)/.exec(path);
        const months = m ? Number.parseInt(m[1], 10) : 3;
        const monthly = Array.from({ length: months }, (_, i) => ({
          month: `2026-0${(i % 9) + 1}`,
          aiMinutes: 1500,
        }));
        return new Response(
          JSON.stringify({
            months,
            monthsWithData: months,
            monthly,
            averageAiMinutes: 1500,
          }),
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

function trailingUsagePaths(): string[] {
  return fetchCalls
    .filter((c) => c.method === 'GET' && c.path.startsWith('/billing/usage/trailing'))
    .map((c) => c.path);
}

describe('Billing trailing-window persistence', () => {
  it('hydrates the toggle from /me/preferences on mount', async () => {
    loginAsOwner();
    preferencesGetResponse = {
      preferences: { billing_trailing_window_months: 12 },
    };

    await renderBilling();

    // The page loads /me/preferences as part of hydration.
    await waitFor(() => {
      expect(
        fetchCalls.some(
          (c) => c.method === 'GET' && c.path === '/me/preferences',
        ),
      ).toBe(true);
    });

    // The 12-month option ends up selected (aria-pressed=true) once the
    // server preference resolves.
    await waitFor(() => {
      const twelve = screen.getByTestId('billing-estimator-recommendation-window-12');
      expect(twelve.getAttribute('aria-pressed')).toBe('true');
    });

    // The trailing-usage query was eventually fetched with the saved
    // 12-month window — proving the choice follows the user even on a
    // brand-new browser with no localStorage cache.
    await waitFor(() => {
      expect(
        trailingUsagePaths().some((p) => p.includes('months=12')),
      ).toBe(true);
    });
  });

  it('writes the chosen window to /me/preferences when toggled', async () => {
    loginAsOwner();
    await renderBilling();

    // Wait for the toggle to appear (BillingEstimator renders it once
    // the recommendation card is mounted).
    const sixMonth = await waitFor(() =>
      screen.getByTestId('billing-estimator-recommendation-window-6'),
    );

    fireEvent.click(sixMonth);

    await waitFor(() => {
      expect(trailingMonthsRequested).toContain(6);
    });

    // The PATCH body must use the per-user preference key, not a
    // top-level field, so that the server's shallow JSONB merge keeps
    // unrelated keys (e.g. `onboarding_step`) intact.
    const patchCall = fetchCalls.find(
      (c) => c.method === 'PATCH' && c.path === '/me/preferences',
    );
    expect(patchCall).toBeTruthy();
    expect(patchCall?.body).toEqual({ billing_trailing_window_months: 6 });

    // localStorage continues to mirror the choice for fast pre-hydration
    // on the next page load.
    expect(localStorage.getItem('billing.trailingWindow.tenant-1')).toBe('6');
  });

  it('migrates a legacy localStorage value up to the server on first load', async () => {
    loginAsOwner();
    // Simulate a tenant who already chose 12 months in the old
    // localStorage-only world. Server has no record yet.
    localStorage.setItem('billing.trailingWindow.tenant-1', '12');
    preferencesGetResponse = { preferences: {} };

    await renderBilling();

    // Hydration completes and the legacy value gets pushed to the
    // server so the user's other devices will pick it up next time.
    await waitFor(() => {
      expect(trailingMonthsRequested).toContain(12);
    });

    const migrationCall = fetchCalls.find(
      (c) =>
        c.method === 'PATCH' &&
        c.path === '/me/preferences' &&
        (c.body as { billing_trailing_window_months?: number } | undefined)
          ?.billing_trailing_window_months === 12,
    );
    expect(migrationCall).toBeTruthy();

    // The 12-month tab stays selected throughout — the migration must
    // not bounce the UI back to the default while it runs.
    const twelve = screen.getByTestId('billing-estimator-recommendation-window-12');
    expect(twelve.getAttribute('aria-pressed')).toBe('true');
  });

  it('does not write to the server when no value has been chosen yet', async () => {
    loginAsOwner();
    // Brand new tenant: no localStorage, no server preference.
    preferencesGetResponse = { preferences: {} };

    await renderBilling();

    // Wait for at least one trailing-usage fetch, which proves the page
    // has settled (otherwise we'd be checking emptiness too eagerly).
    await waitFor(() => {
      expect(trailingUsagePaths().length).toBeGreaterThan(0);
    });
    // Allow microtasks to drain so any deferred PATCH would have fired.
    await new Promise((r) => setTimeout(r, 0));

    expect(trailingMonthsRequested).toEqual([]);
    // And the trailing-usage call defaults to 3 months.
    expect(trailingUsagePaths().some((p) => p.includes('months=3'))).toBe(true);
  });
});
