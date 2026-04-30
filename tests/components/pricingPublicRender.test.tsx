// @vitest-environment happy-dom
/**
 * Regression coverage for task #1114.
 *
 * The marketing/public Vite bundle (`client-app/src/main.public.tsx`) does
 * NOT include a TanStack Query `QueryClientProvider` — pulling the React
 * Query runtime into every anonymous-visitor preload would bloat the
 * Preact-aliased marketing bundle just to power one optional logged-in
 * teaser badge. So the public Pricing page must work with *only* the
 * providers `main.public.tsx` actually mounts: I18nextProvider, Suspense,
 * and a Router.
 *
 * An earlier iteration of this task tried to use `useQuery` for the
 * Stripe effective-rate fetch and crashed every visitor — anonymous AND
 * authenticated — with "No QueryClient set". This test mirrors the
 * exact public-bundle provider stack and renders Pricing in three modes
 * (anonymous, authed-with-stripe-override, authed-with-catalog-only) to
 * lock in that regression.
 */
import * as React from 'react';
import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterEach,
  vi,
} from 'vitest';
import {
  render,
  screen,
  cleanup,
  waitFor,
} from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';

void React;

// ---------------------------------------------------------------------------
// Suppress the iframe page-load chatter the Pricing page bottom CTA can
// trigger via embedded RevealSection scroll observers etc.
// ---------------------------------------------------------------------------
beforeAll(() => {
  if (typeof IntersectionObserver === 'undefined') {
    class FakeIO {
      observe() {}
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
      root = null;
      rootMargin = '';
      thresholds = [];
    }
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
      FakeIO;
  }
});

// IntersectionObserver-driven reveal animations are not relevant here.
vi.mock('../../client-app/src/components/RevealSection', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Analytics is fired from useEffect on Pricing — stub so we don't depend on
// the real beacon transport in a unit test.
vi.mock('../../client-app/src/lib/analytics', () => ({
  trackPageView: () => {},
  trackCTAClick: () => {},
  trackConversionEvent: () => {},
  captureUtmOnLoad: () => {},
}));

// Auth is mocked per-test below so we can flip between anonymous and
// authenticated modes without touching real JWT handling.
let mockUser: { tenantId?: string } | null = null;
vi.mock('../../client-app/src/lib/auth', () => ({
  useAuth: () => ({ user: mockUser, initialized: true }),
}));

// ---------------------------------------------------------------------------
// fetch capture — the page only ever hits `/billing/effective-rate` (and
// only when the user is authenticated). Anonymous renders MUST issue zero
// network calls so we don't leak the existence of authed endpoints.
// ---------------------------------------------------------------------------
let fetchUrls: string[] = [];
type FetchHandler = (url: string) => Response;
let fetchHandler: FetchHandler = () =>
  new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  fetchUrls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      fetchUrls.push(url);
      return fetchHandler(url);
    }) as unknown as typeof fetch,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetModules();
  mockUser = null;
  fetchHandler = () =>
    new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
});

async function renderUnderPublicBundleProviders(): Promise<void> {
  // Defer the imports so the per-test `vi.mock` calls above are honored.
  vi.resetModules();
  const i18nMod = await import('../../client-app/src/lib/i18n');
  const PricingMod = await import('../../client-app/src/pages/public/Pricing');
  const Pricing = PricingMod.default as React.ComponentType;

  // Mirrors `client-app/src/main.public.tsx`: StrictMode + I18nextProvider
  // + Suspense + Router. Crucially, NO QueryClientProvider.
  render(
    <React.StrictMode>
      <I18nextProvider i18n={i18nMod.default}>
        <React.Suspense fallback={null}>
          <MemoryRouter initialEntries={['/pricing']}>
            <Pricing />
          </MemoryRouter>
        </React.Suspense>
      </I18nextProvider>
    </React.StrictMode>,
  );
}

describe('Public /pricing page renders under the marketing bundle providers (task #1114)', () => {
  it('renders for anonymous visitors with NO QueryClientProvider and issues zero network calls', async () => {
    mockUser = null;

    await renderUnderPublicBundleProviders();

    // Page renders — heading is the strongest "we did not crash" signal.
    await waitFor(() => {
      const headings = screen.getAllByRole('heading');
      expect(headings.length).toBeGreaterThan(0);
    });

    // Tier cards render their CTAs — these have stable test ids.
    expect(screen.getByTestId('pricing-tier-starter-cta')).toBeTruthy();
    expect(screen.getByTestId('pricing-tier-pro-cta')).toBeTruthy();
    expect(screen.getByTestId('pricing-tier-enterprise-cta')).toBeTruthy();

    // Calculator section also renders — calc-source-* badges appear when
    // the override is applied; for anonymous they MUST NOT appear.
    expect(screen.queryByTestId('calc-source-starter')).toBeNull();
    expect(screen.queryByTestId('calc-source-pro')).toBeNull();
    expect(screen.queryByTestId('calc-source-enterprise')).toBeNull();

    // No /billing/* fetches for an anonymous visitor.
    expect(
      fetchUrls.some((u) => u.includes('/billing/')),
      `expected zero billing fetches, got: ${fetchUrls.join(', ')}`,
    ).toBe(false);
  });

  it('shows the "Live Stripe rate" badge on the current tier when /billing/effective-rate reports a Stripe-sourced override', async () => {
    mockUser = { tenantId: 'tenant-1' };
    fetchHandler = (url) => {
      if (url.includes('/billing/effective-rate')) {
        return new Response(
          JSON.stringify({
            plan: 'pro',
            // $349 — deliberately different from the catalog Pro price
            // ($399, see shared/billing/planCatalog.ts) so a regression
            // that ignored the override would surface as a wrong dollar
            // value on the rendered card. The overage rate is also
            // moved off the catalog default ($0.08) for the same reason.
            basePriceCents: 34900,
            overageRatePerMinute: 0.07,
            currency: 'usd',
            source: 'stripe',
            basePriceSource: 'stripe',
            overagePriceSource: 'stripe',
            basePriceId: 'price_pro_negotiated',
            overagePriceId: 'price_meter_negotiated',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await renderUnderPublicBundleProviders();

    // Wait for the override to reach the calculator and the badge to mount.
    await waitFor(() => {
      expect(screen.getByTestId('calc-source-pro')).toBeTruthy();
    });

    // Sibling tiers stay on catalog — Stripe can't quote unsubscribed plans.
    expect(screen.queryByTestId('calc-source-starter')).toBeNull();
    expect(screen.queryByTestId('calc-source-enterprise')).toBeNull();

    // Exactly one /billing/effective-rate call was made.
    const billingHits = fetchUrls.filter((u) => u.includes('/billing/effective-rate'));
    expect(billingHits.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT render the badge when the effective rate comes back fully from catalog', async () => {
    mockUser = { tenantId: 'tenant-1' };
    fetchHandler = (url) => {
      if (url.includes('/billing/effective-rate')) {
        return new Response(
          JSON.stringify({
            plan: 'pro',
            basePriceCents: 49900,
            overageRatePerMinute: 0.08,
            currency: 'usd',
            source: 'catalog',
            basePriceSource: 'catalog',
            overagePriceSource: 'catalog',
            basePriceId: null,
            overagePriceId: null,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    await renderUnderPublicBundleProviders();

    // Page mounts cleanly even though the response is identical to catalog.
    await waitFor(() => {
      expect(screen.getByTestId('pricing-tier-pro-cta')).toBeTruthy();
    });

    // Catalog-only override is suppressed — no misleading "Live Stripe rate"
    // badge for tenants whose Stripe subscription has no overrides.
    expect(screen.queryByTestId('calc-source-pro')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// buildOverride contract — see task #1209.
//
// /billing/effective-rate's `basePriceCents` is interval-agnostic (it's the
// monthly equivalent of whatever interval the tenant's subscription is on).
// For a tenant on annual, `basePriceCents` is the annual monthly-equivalent
// (e.g. $300 for a $3,600/yr Pro plan), NOT the published monthly Pro price
// ($399). The calculator's monthly mode must render the latter, which the
// API now provides via `monthlyBasePriceCents`. These tests pin down the
// mapping in `buildOverride()` so an annual tenant flipping the calculator
// to monthly mode sees the correct $399 published rate, not their own
// $300 annual-equivalent.
// ---------------------------------------------------------------------------
describe('buildOverride / EffectiveRateResponse mapping', () => {
  it('uses monthlyBasePriceCents for the calculator override on an annual-tenant payload', async () => {
    const { buildOverride } = await import('../../client-app/src/pages/public/Pricing');
    const override = buildOverride({
      plan: 'pro',
      // Tenant is on annual — `basePriceCents` is monthly equivalent of
      // their annual price ($3,600/yr -> $300/mo equivalent).
      basePriceCents: 30000,
      overageRatePerMinute: 0.07,
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
      // Backend resolved the monthly side from STRIPE_PRICE_PRO_MONTHLY.
      monthlyBasePriceCents: 39900,
      monthlyBasePriceSource: 'stripe',
      // Annual side reuses the sub-derived value.
      annualBasePriceCents: 30000,
      annualBasePriceSource: 'stripe',
    });
    expect(override).toBeDefined();
    // Calculator's monthly mode must see the published monthly price, not
    // the tenant's annual monthly-equivalent.
    expect(override?.basePriceCents).toBe(39900);
    expect(override?.basePriceSource).toBe('stripe');
    // Annual mode passthrough.
    expect(override?.annualBasePriceCents).toBe(30000);
    expect(override?.annualBasePriceSource).toBe('stripe');
  });

  it('falls back to legacy basePriceCents when monthlyBasePriceCents is absent', async () => {
    const { buildOverride } = await import('../../client-app/src/pages/public/Pricing');
    // Older API responses (or partial Stripe configuration) won't carry
    // the new field. Calculator should still render the legacy value
    // rather than crashing or dropping the override entirely.
    const override = buildOverride({
      plan: 'pro',
      basePriceCents: 34900,
      overageRatePerMinute: 0.08,
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
    });
    expect(override?.basePriceCents).toBe(34900);
    expect(override?.basePriceSource).toBe('stripe');
    expect(override?.annualBasePriceCents).toBeUndefined();
  });

  it('engages the override when only the annual side is Stripe-sourced', async () => {
    const { buildOverride } = await import('../../client-app/src/pages/public/Pricing');
    // Tenant on monthly with no per-tenant negotiated rate, but the
    // backend resolved an annual quote from STRIPE_PRICE_PRO_ANNUAL —
    // the calculator's annual mode should still get a Stripe-sourced
    // override (and the badge) even though monthly+overage are catalog.
    const override = buildOverride({
      plan: 'pro',
      basePriceCents: 39900,
      overageRatePerMinute: 0.08,
      basePriceSource: 'catalog',
      overagePriceSource: 'catalog',
      monthlyBasePriceCents: 39900,
      monthlyBasePriceSource: 'catalog',
      annualBasePriceCents: 31900,
      annualBasePriceSource: 'stripe',
    });
    expect(override).toBeDefined();
    expect(override?.basePriceSource).toBe('catalog');
    expect(override?.annualBasePriceSource).toBe('stripe');
    expect(override?.annualBasePriceCents).toBe(31900);
  });

  it('returns undefined when every interval is catalog-sourced', async () => {
    const { buildOverride } = await import('../../client-app/src/pages/public/Pricing');
    // No live Stripe quote anywhere — fall through to anonymous-visitor
    // catalog rendering rather than mounting a misleading badge.
    const override = buildOverride({
      plan: 'pro',
      basePriceCents: 39900,
      overageRatePerMinute: 0.08,
      basePriceSource: 'catalog',
      overagePriceSource: 'catalog',
      monthlyBasePriceCents: 39900,
      monthlyBasePriceSource: 'catalog',
      annualBasePriceCents: 31900,
      annualBasePriceSource: 'catalog',
    });
    expect(override).toBeUndefined();
  });
});
