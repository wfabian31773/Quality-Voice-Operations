// @vitest-environment happy-dom
/**
 * Snapshot / integration coverage for the tenant Marketplace template
 * grid honoring the per-tenant `billing_currency`.
 *
 * Templates carry a `priceCents` value and a `priceModel`. Before
 * task #1006 the price badge formatted those amounts with a hardcoded
 * USD symbol regardless of the tenant's billing currency. This test
 * mounts the Marketplace page with a EUR tenant and asserts:
 *   - the listing card price badge renders with €, not $
 *   - no leftover dollar amount is rendered for the same tenant
 */
import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
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

function loginAs(role: string = 'owner') {
  localStorage.setItem(
    'auth_token',
    makeFakeJwt({
      sub: 'user-1',
      tenantId: 'tenant-1',
      email: 'eu@acme.test',
      role,
      isPlatformAdmin: false,
      exp: Math.floor(Date.now() / 1000) + 60 * 60,
    }),
  );
}

interface ApiHandlers {
  [pathPrefix: string]: () => unknown;
}

let handlers: ApiHandlers = {};

beforeEach(() => {
  localStorage.clear();
  handlers = {
    '/tenants/me': () => ({
      tenant: {
        id: 'tenant-1',
        name: 'Acme EU',
        slug: 'acme-eu',
        plan: 'pro',
        status: 'active',
        billing_currency: 'eur',
      },
    }),
    '/marketplace/categories': () => ({ categories: [] }),
    '/marketplace/installations': () => ({ installations: [] }),
    '/marketplace/templates': () => ({
      templates: [
        {
          id: 'tpl-1',
          slug: 'paid-pack',
          displayName: 'Paid Pack',
          description: 'A premium template pack.',
          shortDescription: 'A premium pack.',
          iconUrl: null,
          status: 'published',
          currentVersion: '1.0.0',
          minPlan: 'pro',
          agentType: 'inbound',
          defaultVoice: 'alloy',
          defaultLanguage: 'en',
          supportedChannels: ['voice'],
          requiredTools: [],
          optionalTools: [],
          tags: [],
          sortOrder: 0,
          installCount: 5,
          categories: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          marketplaceCategory: 'agent_template',
          priceModel: 'monthly_subscription',
          priceCents: 4900,
          avgRating: 4.5,
          reviewCount: 10,
          featured: false,
          developerName: 'Acme Devs',
        },
      ],
      total: 1,
    }),
  };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const path = url.replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '');
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

function renderPage(node: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );
}

function normalize(s: string): string {
  return s.replace(/\u00a0/g, ' ');
}

async function loadPage(modulePath: string) {
  vi.resetModules();
  const mod = await import(modulePath);
  return mod.default as React.ComponentType;
}

describe('Marketplace template price renders the tenant currency (task #1006)', () => {
  it('PriceBadge formats template price with € when billing_currency=eur', async () => {
    loginAs('owner');

    const Marketplace = await loadPage('../../client-app/src/pages/Marketplace');
    const { container } = renderPage(<Marketplace />);

    await waitFor(() => {
      const txt = normalize(container.textContent ?? '');
      // 4900 cents -> €49.00 (with comma in some locales).
      expect(txt).toMatch(/€\s*49[.,]00/);
      // The /mo suffix is appended for monthly_subscription pricing.
      expect(txt).toMatch(/€\s*49[.,]00\/mo/);
      // Make sure no dollar-formatted price has leaked through.
      expect(txt).not.toMatch(/\$\d/);
    });
  });
});
