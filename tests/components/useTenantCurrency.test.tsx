// @vitest-environment happy-dom
/**
 * Unit tests for the `useTenantCurrency` hook (task #634).
 *
 * The hook reads `tenant.billing_currency` from `/tenants/me`, normalizes
 * the value (uppercase, 3 letters, fallback to USD) so it can be passed
 * to `Intl.NumberFormat`, and accepts an explicit override for views
 * that already received a currency code from another endpoint (e.g. the
 * per-tenant admin views).
 *
 * The cases below cover:
 *   1. The default-USD fallback while `/tenants/me` is still loading.
 *   2. Lower-case codes coming back from the API are returned uppercased.
 *   3. The override argument always wins, regardless of API state.
 *   4. Garbage codes (wrong length, non-string) fall back to USD.
 */
import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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

function loginAs() {
  localStorage.setItem(
    'auth_token',
    makeFakeJwt({
      sub: 'user-1',
      tenantId: 'tenant-1',
      email: 'user@acme.test',
      role: 'owner',
      isPlatformAdmin: false,
      exp: Math.floor(Date.now() / 1000) + 60 * 60,
    }),
  );
}

let tenantResponse: { tenant: { id: string; billing_currency?: string | null } | null } = {
  tenant: { id: 'tenant-1', billing_currency: 'eur' },
};

beforeEach(() => {
  localStorage.clear();
  tenantResponse = { tenant: { id: 'tenant-1', billing_currency: 'eur' } };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '');
      if (path.startsWith('/tenants/me')) {
        return new Response(JSON.stringify(tenantResponse), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
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

interface ProbeProps {
  override?: string | null;
}

async function loadHook() {
  vi.resetModules();
  const mod = await import('../../client-app/src/hooks/useTenantCurrency');
  return mod.useTenantCurrency;
}

async function renderProbe(props: ProbeProps) {
  const useTenantCurrency = await loadHook();

  function Probe({ override }: ProbeProps) {
    const value = useTenantCurrency(override ?? undefined);
    return <span data-testid="currency">{value}</span>;
  }

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={client}>
      <Probe {...props} />
    </QueryClientProvider>,
  );
}

describe('useTenantCurrency', () => {
  it('falls back to USD before the user has signed in', async () => {
    // No JWT in storage -> useAuth returns user=null, query disabled,
    // the hook should still return a safe USD default.
    const { container } = await renderProbe({});
    expect(container.querySelector('[data-testid="currency"]')!.textContent).toBe('USD');
  });

  it('returns the tenant billing currency uppercased once /tenants/me resolves', async () => {
    loginAs();
    tenantResponse = { tenant: { id: 'tenant-1', billing_currency: 'eur' } };

    const { container } = await renderProbe({});

    await waitFor(() =>
      expect(container.querySelector('[data-testid="currency"]')!.textContent).toBe('EUR'),
    );
  });

  it('respects the override argument and skips the API value', async () => {
    loginAs();
    tenantResponse = { tenant: { id: 'tenant-1', billing_currency: 'eur' } };

    const { container } = await renderProbe({ override: 'gbp' });

    // Override is synchronous: even before the network resolves the
    // hook should already report the override (uppercased).
    expect(container.querySelector('[data-testid="currency"]')!.textContent).toBe('GBP');

    // And it should keep winning after the API settles, too.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.querySelector('[data-testid="currency"]')!.textContent).toBe('GBP');
  });

  it('falls back to USD when the API returns a malformed currency code', async () => {
    loginAs();
    tenantResponse = { tenant: { id: 'tenant-1', billing_currency: 'EU' } };

    const { container } = await renderProbe({});

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    // Two-letter input is rejected by the normalizer.
    expect(container.querySelector('[data-testid="currency"]')!.textContent).toBe('USD');
  });

  it('falls back to USD when billing_currency is null', async () => {
    loginAs();
    tenantResponse = { tenant: { id: 'tenant-1', billing_currency: null } };

    const { container } = await renderProbe({});

    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.querySelector('[data-testid="currency"]')!.textContent).toBe('USD');
  });
});
