// @vitest-environment happy-dom
/**
 * Snapshot / integration coverage for the PhoneNumbers screen honoring
 * the per-tenant `billing_currency` (task #1006).
 *
 * The provisioned-numbers table renders a "$2.00/mo" style cell for
 * every paid number. Before this task the formatter ignored the tenant
 * currency and the cell template was prefixed with a hardcoded
 * <DollarSign /> icon. This test mounts the page with a Euro tenant
 * and one paid number and asserts the cell renders €, not $.
 */
import * as React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';

void React;

// TooltipWalkthrough fires its own /tenants/me/tooltips +
// /tenants/me/activation queries, runs effects against the DOM, and
// throws inside happy-dom because of how it inspects refs. The
// onboarding tooltip is irrelevant to this currency assertion, so stub
// it as a transparent passthrough.
vi.mock('../../client-app/src/components/TooltipWalkthrough', () => ({
  default: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
}));

// SchedulingDriftBanner pulls in toast machinery that doesn't matter
// for this test and may try to render portals.
vi.mock('../../client-app/src/components/SchedulingDriftBanner', () => ({
  default: () => null,
  SchedulingDriftBanner: () => null,
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
    '/phone-numbers': () => ({
      phoneNumbers: [
        {
          id: 'pn-1',
          phone_number: '+18005551234',
          friendly_name: 'Main Line',
          is_free_number: false,
          monthly_cost_cents: 200,
          created_at: new Date().toISOString(),
          agent_id: null,
          scheduling_provider: null,
        },
      ],
      total: 1,
      hasUsedFreeNumber: true,
    }),
    '/agents': () => ({ agents: [] }),
    '/connectors': () => ({ connectors: [] }),
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

describe('PhoneNumbers screen renders the tenant currency (task #1006)', () => {
  it('renders the per-number monthly price with € when billing_currency=eur', async () => {
    loginAs('owner');

    const PhoneNumbers = await loadPage(
      '../../client-app/src/pages/PhoneNumbers',
    );
    const { container } = renderPage(<PhoneNumbers />);

    await waitFor(() => {
      const txt = normalize(container.textContent ?? '');
      // 200 cents -> €2.00 (some locales use a comma decimal separator).
      expect(txt).toMatch(/€\s*2[.,]00\/mo/);
      // No money-shaped $-amount may leak through for a EUR tenant.
      expect(txt).not.toMatch(/\$\s*\d/);
    });
  });
});
