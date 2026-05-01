// @vitest-environment happy-dom
/**
 * Task #1404 — pin the customer-level Stripe discount preview onto the
 * Marketplace **installed-templates** management view.
 *
 * Background: Task #1380 added the in-app discount preview chip to
 * every surface a buyer sees BEFORE clicking Purchase (browse listing
 * cards, template detail header, Purchase CTA panel). The Marketplace
 * page also has an "Installed" tab (route `/marketplace/installed`)
 * which renders `InstalledView` — the in-app management surface for
 * already-purchased recurring subscriptions. Before this task each
 * installed row showed only version + install-date metadata; for paid
 * recurring templates the buyer had no way to see the discounted
 * recurring figure they were actually being billed at Stripe-side.
 *
 * This component-level test mounts the Marketplace page on the
 * `/marketplace/installed` route, fulfils the relevant `fetch` calls so
 *   - the tenant has an active 25%-off customer-level discount, and
 *   - one paid `$49/mo` installation row exists,
 * then asserts the row renders the discounted `$36.75/mo` price, keeps
 * the original `$49/mo` as a strikethrough sibling, and mounts the
 * "25% off" chip with the same `[data-testid="installed-row-...]`
 * hooks the rest of the Task #1404 wiring relies on. A regression to
 * the renderer (e.g. dropping the `customerDiscount` prop on
 * `<InstalledView />`, or the server route forgetting to surface
 * `price_cents` / `price_model`) would surface here as a missing
 * discount chip rather than a silent buyer-trust gap.
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
      email: 'us@acme.test',
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
        name: 'Acme US',
        slug: 'acme-us',
        plan: 'pro',
        status: 'active',
        billing_currency: 'usd',
      },
    }),
    '/marketplace/categories': () => ({ categories: [] }),
    '/marketplace/customer-discount': () => ({
      discount: {
        couponId: 'coupon_25',
        name: 'Holiday 25',
        promotionCode: 'HOLIDAY25',
        percentOff: 25,
        amountOffCents: null,
        currency: 'usd',
      },
    }),
    '/marketplace/installations': () => ({
      installations: [
        {
          id: 'inst-1',
          tenant_id: 'tenant-1',
          template_id: 'tpl-1',
          installed_version: '1.0.0',
          status: 'active',
          config: {},
          agent_id: null,
          installed_at: new Date('2025-01-01T00:00:00Z').toISOString(),
          updated_at: new Date('2025-01-01T00:00:00Z').toISOString(),
          template_name: 'Paid Pack',
          latest_version: '1.0.0',
          template_slug: 'paid-pack',
          agent_name: null,
          agent_status: null,
          agent_type: 'inbound',
          installed_by: null,
          price_model: 'monthly_subscription',
          price_cents: 4900,
        },
      ],
    }),
    '/phone-numbers': () => ({ phoneNumbers: [] }),
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

function renderInstalledRoute(node: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/marketplace/installed']}>
        {node}
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function loadPage(modulePath: string) {
  vi.resetModules();
  const mod = await import(modulePath);
  return mod.default as React.ComponentType;
}

function normalize(s: string): string {
  return s.replace(/\u00a0/g, ' ');
}

describe('Marketplace installed-row discount preview (task #1404)', () => {
  it('renders the discounted recurring price, strikes through the original, and mounts a "25% off" chip', async () => {
    loginAs('owner');

    const Marketplace = await loadPage('../../client-app/src/pages/Marketplace');
    const { container } = renderInstalledRoute(<Marketplace />);

    await waitFor(() => {
      const txt = normalize(container.textContent ?? '');
      // 25% off $49 → $36.75 — the figure Stripe will actually bill.
      expect(txt).toMatch(/\$36[.,]75\/mo/);
    });

    // Original price remains as a strikethrough sibling so the buyer
    // can see the savings — pinned via testid so a future style refactor
    // can't accidentally drop the strikethrough.
    const original = container.querySelector(
      '[data-testid="installed-row-original-price"]',
    );
    expect(original).not.toBeNull();
    expect(normalize(original!.textContent ?? '')).toMatch(/\$49[.,]00\/mo/);

    // The "X% off" chip carries the full coupon attribution in its
    // aria-label so a buyer hovering the chip understands which coupon
    // is being applied.
    const chip = container.querySelector(
      '[data-testid="installed-row-discount-chip"]',
    );
    expect(chip).not.toBeNull();
    expect(chip!.textContent ?? '').toMatch(/25%\s*off/);
    expect(chip!.getAttribute('aria-label') ?? '').toMatch(/HOLIDAY25/);
  });

  it('renders no price block when no customer-level discount is active (row stays byte-identical to pre-#1404)', async () => {
    loginAs('owner');
    handlers['/marketplace/customer-discount'] = () => ({ discount: null });

    const Marketplace = await loadPage('../../client-app/src/pages/Marketplace');
    const { container } = renderInstalledRoute(<Marketplace />);

    await waitFor(() => {
      // The row itself has rendered (template name visible).
      expect(normalize(container.textContent ?? '')).toMatch(/Paid Pack/);
    });

    // Tenants with no active discount see the same row they saw before
    // Task #1404 — no price block, no discount chip, no strikethrough.
    // Per the task spec: "tenants with no discount render unchanged".
    expect(
      container.querySelector('[data-testid="installed-row-price"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="installed-row-discount-chip"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="installed-row-original-price"]'),
    ).toBeNull();
    // And the undiscounted /mo figure does NOT leak in either.
    expect(normalize(container.textContent ?? '')).not.toMatch(/\$49[.,]00\/mo/);
  });

  it('renders no price block at all for free templates (avoids "$0 was Free" noise)', async () => {
    loginAs('owner');
    handlers['/marketplace/installations'] = () => ({
      installations: [
        {
          id: 'inst-free',
          tenant_id: 'tenant-1',
          template_id: 'tpl-free',
          installed_version: '1.0.0',
          status: 'active',
          config: {},
          agent_id: null,
          installed_at: new Date('2025-01-01T00:00:00Z').toISOString(),
          updated_at: new Date('2025-01-01T00:00:00Z').toISOString(),
          template_name: 'Free Pack',
          latest_version: '1.0.0',
          template_slug: 'free-pack',
          agent_name: null,
          agent_status: null,
          agent_type: 'inbound',
          installed_by: null,
          price_model: 'free',
          price_cents: 0,
        },
      ],
    });

    const Marketplace = await loadPage('../../client-app/src/pages/Marketplace');
    const { container } = renderInstalledRoute(<Marketplace />);

    await waitFor(() => {
      // The row itself has rendered (template name visible).
      expect(normalize(container.textContent ?? '')).toMatch(/Free Pack/);
    });

    // Even with an active discount, free rows skip the price block
    // entirely. We never render "$0 was Free" — that's noise.
    expect(
      container.querySelector('[data-testid="installed-row-price"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="installed-row-discount-chip"]'),
    ).toBeNull();
  });
});
