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
  fireEvent,
} from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { MemoryRouter } from 'react-router-dom';
// Type-only import (erased at runtime) so it doesn't defeat the per-test
// `vi.resetModules()` + dynamic `import()` pattern used below.
import type { EffectiveRateResponse } from '../../client-app/src/pages/public/Pricing';

void React;

// Carrier pass-through charges (Twilio per-minute + SMS per-message) were
// removed from QVO pricing: carrier costs are folded into every plan price,
// so `EffectiveRateResponse` no longer carries any sms*/twilio* fields.
// Older API responses (or a stale cache) may still send them — these are
// the legacy fields the regression tests below inject to prove they are
// ignored end-to-end (no calculator row, no callout line, no override).
const LEGACY_STRIPE_CARRIER_FIELDS = {
  smsRatePerMessage: 0.0075,
  smsPriceSource: 'stripe',
  smsPriceId: 'price_sms_negotiated',
  twilioRatePerMinute: 0.0125,
  twilioPriceSource: 'stripe',
  twilioPriceId: 'price_twilio_negotiated',
} as const;

const CARRIER_CALC_TEST_IDS = [
  'calc-sms-rate',
  'calc-sms-rate-value',
  'calc-sms-source',
  'calc-twilio-rate',
  'calc-twilio-rate-value',
  'calc-twilio-source',
] as const;

function expectNoCarrierCalculatorRows(): void {
  for (const id of CARRIER_CALC_TEST_IDS) {
    expect(screen.queryByTestId(id), id).toBeNull();
  }
}

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
  // The Pricing page now reads its initial billing-period selection
  // from a shared marketing preference persisted in `localStorage` (see
  // `client-app/src/lib/billingPeriodPreference.ts`). Without an
  // explicit reset, a test that toggles to Annual leaks that choice
  // into every subsequent test in this file and breaks the
  // monthly-default assumptions in the override-callout cases.
  if (typeof window !== 'undefined') {
    window.localStorage.clear();
  }
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

// For negative assertions ("X must NOT render") we need the effective-rate
// fetch to have resolved first, otherwise the assertion could pass merely
// because the payload hasn't landed yet. Wait for the request, then yield
// a few macrotasks so `api.get` can parse the body and React can commit.
async function waitForEffectiveRateSettled(): Promise<void> {
  await waitFor(() => {
    expect(fetchUrls.some((u) => u.includes('/billing/effective-rate'))).toBe(true);
  });
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await waitFor(() => {
    expect(screen.getByTestId('pricing-tier-pro-cta')).toBeTruthy();
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
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

    // The custom-rate callout (task #1210) is gated on an authenticated
    // tenant with a Stripe-sourced delta — anonymous visitors MUST NOT
    // see it.
    expect(screen.queryByTestId('pricing-override-callout')).toBeNull();

    // Carrier (SMS / Twilio) pass-through rate rows were removed from the
    // calculator — carrier costs are included in every plan — so they
    // must never mount, for anonymous visitors or anyone else.
    expectNoCarrierCalculatorRows();

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
            // $329 — deliberately different from the catalog Pro price
            // ($349, see shared/billing/planCatalog.ts) so a regression
            // that ignored the override would surface as a wrong dollar
            // value on the rendered card. The overage rate is also
            // moved off the catalog default ($0.22) for the same reason.
            basePriceCents: 32900,
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

  // -------------------------------------------------------------------------
  // Carrier pass-through removal (replaces tasks #1265 / #1314 / #1356):
  // the calculator used to render a per-message SMS row and a per-minute
  // Twilio row (with a "Live Stripe rate" badge for negotiated rates).
  // Carrier costs are now folded into every plan price, so those rows are
  // gone. A legacy payload that still carries Stripe-sourced carrier
  // fields must neither resurrect the rows nor engage the override.
  // -------------------------------------------------------------------------
  it('renders NO carrier rate rows and NO "Live Stripe rate" badge when a legacy payload only carries Stripe-sourced SMS / Twilio rates', async () => {
    mockUser = { tenantId: 'tenant-legacy-carrier-only' };
    fetchHandler = (url) => {
      if (url.includes('/billing/effective-rate')) {
        return jsonResponse({
          plan: 'pro',
          // Catalog AI/base/overage on Pro — the only Stripe-sourced
          // fields are the legacy carrier ones. Pre-removal this
          // engaged the override and mounted the SMS + Twilio rows.
          basePriceCents: 34900,
          overageRatePerMinute: 0.22,
          currency: 'usd',
          source: 'catalog',
          basePriceSource: 'catalog',
          overagePriceSource: 'catalog',
          monthlyBasePriceCents: 34900,
          monthlyBasePriceSource: 'catalog',
          annualBasePriceCents: 29665,
          annualBasePriceSource: 'catalog',
          ...LEGACY_STRIPE_CARRIER_FIELDS,
        });
      }
      return jsonResponse({});
    };

    await renderUnderPublicBundleProviders();
    await waitForEffectiveRateSettled();

    expectNoCarrierCalculatorRows();
    expect(document.querySelector('[data-sms-source]')).toBeNull();
    expect(document.querySelector('[data-twilio-source]')).toBeNull();

    // Carrier-only Stripe provenance no longer engages the override, so
    // no per-tier "Live Stripe rate" badge may mount.
    expect(screen.queryByTestId('calc-source-starter')).toBeNull();
    expect(screen.queryByTestId('calc-source-pro')).toBeNull();
    expect(screen.queryByTestId('calc-source-enterprise')).toBeNull();

    // And no callout either — nothing plan-related diverges.
    expect(screen.queryByTestId('pricing-override-callout')).toBeNull();
  });

  it('renders NO carrier rate rows when the AI-side override engages alongside legacy SMS / Twilio fields', async () => {
    mockUser = { tenantId: 'tenant-legacy-carrier-with-ai-override' };
    fetchHandler = (url) => {
      if (url.includes('/billing/effective-rate')) {
        return jsonResponse({
          plan: 'pro',
          basePriceCents: 32900,
          overageRatePerMinute: 0.07,
          currency: 'usd',
          source: 'stripe',
          basePriceSource: 'stripe',
          overagePriceSource: 'stripe',
          ...LEGACY_STRIPE_CARRIER_FIELDS,
        });
      }
      return jsonResponse({});
    };

    await renderUnderPublicBundleProviders();

    // Positive anchor: the AI-side override DID land on the calculator…
    await waitFor(() => {
      expect(screen.getByTestId('calc-source-pro')).toBeTruthy();
    });

    // …but the legacy carrier fields rode along without rendering anything.
    expectNoCarrierCalculatorRows();
    const proCard = screen.getByTestId('calc-tier-pro');
    expect(proCard.textContent ?? '').not.toContain('/msg');
    expect(proCard.textContent ?? '').not.toContain('$0.0125');

    // Monthly disclaimer now tells visitors carrier costs are bundled.
    expect(screen.getByTestId('calc-disclaimer').textContent ?? '').toContain(
      'Carrier calling and SMS costs are included in every plan.',
    );
  });

  it('shows the custom-rate callout above the calculator when the tenant pays LESS than catalog (task #1210)', async () => {
    mockUser = { tenantId: 'tenant-grandfathered' };
    fetchHandler = (url) => {
      if (url.includes('/billing/effective-rate')) {
        return new Response(
          JSON.stringify({
            plan: 'pro',
            // Tenant grandfathered at $250/mo for Pro; catalog is $349.
            basePriceCents: 25000,
            overageRatePerMinute: 0.22,
            currency: 'usd',
            source: 'stripe',
            basePriceSource: 'stripe',
            overagePriceSource: 'catalog',
            monthlyBasePriceCents: 25000,
            monthlyBasePriceSource: 'stripe',
            annualBasePriceCents: 20000,
            annualBasePriceSource: 'stripe',
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

    // Wait for the callout to mount.
    const callout = await waitFor(() =>
      screen.getByTestId('pricing-override-callout'),
    );
    expect(callout.getAttribute('data-direction')).toBe('less');

    // Description carries the three core numbers (current, delta, catalog)
    // and the tier name. We assert on the rendered text, not the i18n
    // key, so a future copy tweak surfaces here as a real failure.
    const description = screen.getByTestId('pricing-override-callout-description');
    const text = description.textContent ?? '';
    // $349 catalog − $250 tenant = $99/mo less.
    expect(text).toContain('$250');
    expect(text).toContain('$99');
    expect(text).toContain('$349');
    expect(text.toLowerCase()).toContain('pro');
    expect(text.toLowerCase()).toContain('less');

    // The "Manage subscription" link points to /billing.
    const link = screen.getByTestId('pricing-override-callout-link') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/billing');
  });

  it('shows the callout in the "more" direction when the tenant pays MORE than catalog (task #1210)', async () => {
    mockUser = { tenantId: 'tenant-premium' };
    fetchHandler = (url) => {
      if (url.includes('/billing/effective-rate')) {
        return new Response(
          JSON.stringify({
            plan: 'starter',
            // Custom rate $199/mo for Starter; catalog is $149.
            basePriceCents: 19900,
            overageRatePerMinute: 0.25,
            currency: 'usd',
            source: 'stripe',
            basePriceSource: 'stripe',
            overagePriceSource: 'catalog',
            monthlyBasePriceCents: 19900,
            monthlyBasePriceSource: 'stripe',
            annualBasePriceCents: 16000,
            annualBasePriceSource: 'stripe',
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

    const callout = await waitFor(() =>
      screen.getByTestId('pricing-override-callout'),
    );
    expect(callout.getAttribute('data-direction')).toBe('more');
    const text = screen.getByTestId('pricing-override-callout-description').textContent ?? '';
    expect(text).toContain('$199');
    expect(text).toContain('$50');
    expect(text).toContain('$149');
    expect(text.toLowerCase()).toContain('more');
  });

  it('does NOT render the custom-rate callout for a tenant on the standard published ANNUAL rate (task #1210, regression)', async () => {
    // Regression: an annual-billed tenant on the catalog rate has
    // basePriceCents = catalog × 0.85 (annualised monthly equivalent).
    // A naive comparison against catalog monthly would falsely flag
    // them as paying "less than the published rate" when they're
    // simply on the annual interval. The fix is to compare against the
    // matching catalog interval (annual = catalog × (1 − ANNUAL_DISCOUNT)).
    mockUser = { tenantId: 'tenant-on-published-annual' };
    fetchHandler = (url) => {
      if (url.includes('/billing/effective-rate')) {
        return new Response(
          JSON.stringify({
            plan: 'pro',
            // $349 monthly catalog × (1 - 0.15) = $296.65/mo annualised.
            basePriceCents: 29665,
            overageRatePerMinute: 0.22,
            currency: 'usd',
            source: 'stripe',
            basePriceSource: 'stripe',
            overagePriceSource: 'stripe',
            // The matching (annual) interval reuses the sub-derived
            // value verbatim; the other side comes from env lookup.
            monthlyBasePriceCents: 34900,
            monthlyBasePriceSource: 'stripe',
            annualBasePriceCents: 29665,
            annualBasePriceSource: 'stripe',
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

    await waitFor(() => {
      expect(screen.getByTestId('pricing-tier-pro-cta')).toBeTruthy();
    });

    expect(screen.queryByTestId('pricing-override-callout')).toBeNull();
  });

  it('re-frames the callout to /yr terms when the calculator is toggled to Annual mode', async () => {
    mockUser = { tenantId: 'tenant-grandfathered-annual-toggle' };
    fetchHandler = (url) => {
      if (url.includes('/billing/effective-rate')) {
        return new Response(
          JSON.stringify({
            plan: 'pro',
            // Annual at $3,000/yr ($250/mo); catalog annual =
            // $296.65/mo × 12 ≈ $3,560/yr.
            basePriceCents: 25000,
            overageRatePerMinute: 0.22,
            currency: 'usd',
            source: 'stripe',
            basePriceSource: 'stripe',
            overagePriceSource: 'catalog',
            monthlyBasePriceCents: 34900,
            monthlyBasePriceSource: 'stripe',
            annualBasePriceCents: 25000,
            annualBasePriceSource: 'stripe',
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

    const monthlyCallout = await waitFor(() =>
      screen.getByTestId('pricing-override-callout'),
    );
    expect(monthlyCallout.getAttribute('data-frame')).toBe('monthly');
    expect(monthlyCallout.getAttribute('data-direction')).toBe('less');
    const monthlyText =
      screen.getByTestId('pricing-override-callout-description').textContent ?? '';
    expect(monthlyText).toContain('$250');
    expect(monthlyText).toContain('/mo');

    fireEvent.click(screen.getByTestId('pricing-billing-annual'));

    await waitFor(() => {
      const callout = screen.getByTestId('pricing-override-callout');
      expect(callout.getAttribute('data-frame')).toBe('annual');
    });
    const annualCallout = screen.getByTestId('pricing-override-callout');
    expect(annualCallout.getAttribute('data-direction')).toBe('less');
    const annualText =
      screen.getByTestId('pricing-override-callout-description').textContent ?? '';
    expect(annualText).toContain('$3,000');
    expect(annualText).toContain('$3,560');
    expect(annualText).toContain('$560');
    expect(annualText).toContain('/yr');
    expect(annualText).not.toContain('/mo');
  });

  it('suppresses the callout in Annual mode when the annual side matches catalog', async () => {
    mockUser = { tenantId: 'tenant-custom-monthly-only' };
    fetchHandler = (url) => {
      if (url.includes('/billing/effective-rate')) {
        return new Response(
          JSON.stringify({
            plan: 'pro',
            // Custom $300/mo monthly (vs catalog $349) — but the annual
            // side is the published $296.65/mo annual reference.
            basePriceCents: 30000,
            overageRatePerMinute: 0.22,
            currency: 'usd',
            source: 'stripe',
            basePriceSource: 'stripe',
            overagePriceSource: 'catalog',
            monthlyBasePriceCents: 30000,
            monthlyBasePriceSource: 'stripe',
            annualBasePriceCents: 29665,
            annualBasePriceSource: 'catalog',
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

    await waitFor(() => {
      expect(screen.getByTestId('pricing-override-callout')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('pricing-billing-annual'));

    await waitFor(() => {
      expect(screen.queryByTestId('pricing-override-callout')).toBeNull();
    });
  });

  it('renders the callout against the ANNUAL catalog reference for an annual tenant on a negotiated rate (task #1210)', async () => {
    mockUser = { tenantId: 'tenant-grandfathered-annual' };
    fetchHandler = (url) => {
      if (url.includes('/billing/effective-rate')) {
        return new Response(
          JSON.stringify({
            plan: 'pro',
            // Annual contract at $3,000/yr → $250/mo annualised.
            // Catalog annual reference = $349 × 0.85 = $296.65/mo.
            // Delta = $296.65 - $250 = $46.65 → ~$47/mo less.
            basePriceCents: 25000,
            overageRatePerMinute: 0.22,
            currency: 'usd',
            source: 'stripe',
            basePriceSource: 'stripe',
            overagePriceSource: 'catalog',
            monthlyBasePriceCents: 34900,
            monthlyBasePriceSource: 'stripe',
            // Annual side mirrors basePriceCents for an annual sub.
            annualBasePriceCents: 25000,
            annualBasePriceSource: 'stripe',
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

    const callout = await waitFor(() =>
      screen.getByTestId('pricing-override-callout'),
    );
    expect(callout.getAttribute('data-direction')).toBe('less');
    const text = screen.getByTestId('pricing-override-callout-description').textContent ?? '';
    // Reference should be the ANNUAL catalog price ($297), not monthly $349.
    expect(text).toContain('$250');
    expect(text).toContain('$297');
    expect(text).toContain('$47');
    // And specifically NOT the monthly catalog headline — that would
    // be the regression we're guarding against.
    expect(text).not.toContain('$349');
  });

  // -------------------------------------------------------------------------
  // Task #1270: render-side coverage for the overage line. The pure
  // computeCustomRateDelta tests above lock in the data shape; these
  // mount the page so we also verify the i18n keys exist and the line
  // renders with the expected per-minute numbers.
  // -------------------------------------------------------------------------
  it('renders the overage line on the callout when both base AND overage are custom (task #1270)', async () => {
    mockUser = { tenantId: 'tenant-grandfathered-both' };
    fetchHandler = (url) => {
      if (url.includes('/billing/effective-rate')) {
        return new Response(
          JSON.stringify({
            plan: 'pro',
            // Custom base ($250 vs catalog $349) + custom overage
            // ($0.05/min vs catalog $0.22/min) — banner copy must read
            // cleanly with both lines present.
            basePriceCents: 25000,
            overageRatePerMinute: 0.05,
            currency: 'usd',
            source: 'stripe',
            basePriceSource: 'stripe',
            overagePriceSource: 'stripe',
            monthlyBasePriceCents: 25000,
            monthlyBasePriceSource: 'stripe',
            annualBasePriceCents: 20000,
            annualBasePriceSource: 'stripe',
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

    const callout = await waitFor(() =>
      screen.getByTestId('pricing-override-callout'),
    );
    expect(callout.getAttribute('data-direction')).toBe('less');
    expect(callout.getAttribute('data-has-base')).toBe('true');
    expect(callout.getAttribute('data-has-overage')).toBe('true');

    // Base line still reads cleanly.
    const baseText = screen.getByTestId('pricing-override-callout-description').textContent ?? '';
    expect(baseText).toContain('$250');
    expect(baseText).toContain('$99');
    expect(baseText).toContain('$349');

    // Overage line renders with per-minute numbers and tier name.
    const overageText = screen.getByTestId('pricing-override-callout-overage').textContent ?? '';
    expect(overageText).toContain('$0.05/min');
    expect(overageText).toContain('$0.17/min');
    expect(overageText).toContain('$0.22/min');
    expect(overageText.toLowerCase()).toContain('pro');
    expect(overageText.toLowerCase()).toContain('less');
  });

  it('renders the callout for a tenant with ONLY a custom overage rate (base matches catalog) (task #1270)', async () => {
    mockUser = { tenantId: 'tenant-overage-only' };
    fetchHandler = (url) => {
      if (url.includes('/billing/effective-rate')) {
        return new Response(
          JSON.stringify({
            plan: 'pro',
            // On the published Pro base price ($349) but with a
            // negotiated $0.05/min overage. Pre-#1270 this banner
            // would have stayed hidden — the whole point of the task
            // is that this tenant now sees a per-minute summary.
            basePriceCents: 34900,
            overageRatePerMinute: 0.05,
            currency: 'usd',
            source: 'stripe',
            basePriceSource: 'stripe',
            overagePriceSource: 'stripe',
            monthlyBasePriceCents: 34900,
            monthlyBasePriceSource: 'stripe',
            annualBasePriceCents: 29665,
            annualBasePriceSource: 'stripe',
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

    const callout = await waitFor(() =>
      screen.getByTestId('pricing-override-callout'),
    );
    // Tone derived from the overage direction since base doesn't diverge.
    expect(callout.getAttribute('data-direction')).toBe('less');
    expect(callout.getAttribute('data-has-base')).toBe('false');
    expect(callout.getAttribute('data-has-overage')).toBe('true');

    // Base sentence is suppressed — there's nothing meaningful to say.
    expect(screen.queryByTestId('pricing-override-callout-description')).toBeNull();

    // Overage line stands on its own.
    const overageText = screen.getByTestId('pricing-override-callout-overage').textContent ?? '';
    expect(overageText).toContain('$0.05/min');
    expect(overageText).toContain('$0.22/min');
    expect(overageText.toLowerCase()).toContain('less');
  });

  // -------------------------------------------------------------------------
  // Carrier pass-through removal (replaces tasks #1327 / #1357): the
  // callout used to render a per-message SMS line and a per-minute Twilio
  // carrier line (plus `data-has-sms` / `data-has-twilio` attributes).
  // Carrier costs are now included in every plan, so a legacy payload
  // carrying Stripe-sourced carrier rates must not surface either line,
  // nor mount the callout on its own.
  // -------------------------------------------------------------------------
  it('renders NO SMS / Twilio line on the callout when legacy Stripe-sourced carrier rates ride along with custom base + overage', async () => {
    mockUser = { tenantId: 'tenant-grandfathered-legacy-carrier' };
    fetchHandler = (url) => {
      if (url.includes('/billing/effective-rate')) {
        return jsonResponse({
          plan: 'pro',
          // Custom base ($250 vs catalog $349) + custom overage
          // ($0.05/min vs catalog $0.22/min) + legacy negotiated
          // SMS ($0.0075/msg) and Twilio ($0.0125/min) fields.
          basePriceCents: 25000,
          overageRatePerMinute: 0.05,
          currency: 'usd',
          source: 'stripe',
          basePriceSource: 'stripe',
          overagePriceSource: 'stripe',
          monthlyBasePriceCents: 25000,
          monthlyBasePriceSource: 'stripe',
          annualBasePriceCents: 20000,
          annualBasePriceSource: 'stripe',
          ...LEGACY_STRIPE_CARRIER_FIELDS,
        });
      }
      return jsonResponse({});
    };

    await renderUnderPublicBundleProviders();

    const callout = await waitFor(() =>
      screen.getByTestId('pricing-override-callout'),
    );
    // Base + overage lines still render — that's why the callout mounted.
    expect(callout.getAttribute('data-direction')).toBe('less');
    expect(callout.getAttribute('data-has-base')).toBe('true');
    expect(callout.getAttribute('data-has-overage')).toBe('true');
    expect(screen.getByTestId('pricing-override-callout-description')).toBeTruthy();
    expect(screen.getByTestId('pricing-override-callout-overage')).toBeTruthy();

    // No carrier attributes or lines.
    expect(callout.hasAttribute('data-has-sms')).toBe(false);
    expect(callout.hasAttribute('data-has-twilio')).toBe(false);
    expect(screen.queryByTestId('pricing-override-callout-sms')).toBeNull();
    expect(screen.queryByTestId('pricing-override-callout-twilio')).toBeNull();
    const calloutText = callout.textContent ?? '';
    expect(calloutText).not.toContain('/msg');
    expect(calloutText).not.toContain('$0.0125');
    expect(calloutText).not.toContain('$0.0075');
  });

  it('does NOT mount the callout when the only divergence is a legacy Stripe-sourced SMS / Twilio rate (base + overage match catalog)', async () => {
    mockUser = { tenantId: 'tenant-legacy-carrier-divergence-only' };
    fetchHandler = (url) => {
      if (url.includes('/billing/effective-rate')) {
        return jsonResponse({
          plan: 'pro',
          // On the published Pro base + overage (Stripe-sourced), with
          // legacy negotiated carrier rates. Pre-removal this mounted an
          // SMS-only / Twilio-only callout; now there's nothing to say.
          basePriceCents: 34900,
          overageRatePerMinute: 0.22,
          currency: 'usd',
          source: 'stripe',
          basePriceSource: 'stripe',
          overagePriceSource: 'stripe',
          monthlyBasePriceCents: 34900,
          monthlyBasePriceSource: 'stripe',
          annualBasePriceCents: 29665,
          annualBasePriceSource: 'stripe',
          ...LEGACY_STRIPE_CARRIER_FIELDS,
        });
      }
      return jsonResponse({});
    };

    await renderUnderPublicBundleProviders();

    // The override itself engages (base/overage are Stripe-sourced), which
    // proves the payload landed before we assert on the missing callout.
    await waitFor(() => {
      expect(screen.getByTestId('calc-source-pro')).toBeTruthy();
    });

    expect(screen.queryByTestId('pricing-override-callout')).toBeNull();
    expect(screen.queryByTestId('pricing-override-callout-sms')).toBeNull();
    expect(screen.queryByTestId('pricing-override-callout-twilio')).toBeNull();
    expectNoCarrierCalculatorRows();
  });

  it('does NOT render the overage line when overage matches catalog (task #1270)', async () => {
    mockUser = { tenantId: 'tenant-base-only-custom' };
    fetchHandler = (url) => {
      if (url.includes('/billing/effective-rate')) {
        return new Response(
          JSON.stringify({
            plan: 'pro',
            // Custom base, but overage is catalog-sourced — overage
            // line MUST stay hidden.
            basePriceCents: 25000,
            overageRatePerMinute: 0.22,
            currency: 'usd',
            source: 'stripe',
            basePriceSource: 'stripe',
            overagePriceSource: 'catalog',
            monthlyBasePriceCents: 25000,
            monthlyBasePriceSource: 'stripe',
            annualBasePriceCents: 20000,
            annualBasePriceSource: 'stripe',
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

    const callout = await waitFor(() =>
      screen.getByTestId('pricing-override-callout'),
    );
    expect(callout.getAttribute('data-has-overage')).toBe('false');
    expect(screen.queryByTestId('pricing-override-callout-overage')).toBeNull();
    // Base line still rendered — that's why the callout mounted at all.
    expect(screen.getByTestId('pricing-override-callout-description')).toBeTruthy();
  });

  it('does NOT render the custom-rate callout when the tenant rate matches catalog (task #1210)', async () => {
    mockUser = { tenantId: 'tenant-on-published-rate' };
    fetchHandler = (url) => {
      if (url.includes('/billing/effective-rate')) {
        return new Response(
          JSON.stringify({
            plan: 'pro',
            // Tenant pays the published rate exactly — even though the
            // payload is Stripe-sourced (live subscription), there's no
            // delta to surface, so the callout MUST NOT mount.
            basePriceCents: 34900,
            overageRatePerMinute: 0.22,
            currency: 'usd',
            source: 'stripe',
            basePriceSource: 'stripe',
            overagePriceSource: 'stripe',
            monthlyBasePriceCents: 34900,
            monthlyBasePriceSource: 'stripe',
            annualBasePriceCents: 29665,
            annualBasePriceSource: 'stripe',
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

    // Page mounts cleanly.
    await waitFor(() => {
      expect(screen.getByTestId('pricing-tier-pro-cta')).toBeTruthy();
    });

    expect(screen.queryByTestId('pricing-override-callout')).toBeNull();
  });

  it('does NOT render the badge when the effective rate comes back fully from catalog', async () => {
    mockUser = { tenantId: 'tenant-1' };
    fetchHandler = (url) => {
      if (url.includes('/billing/effective-rate')) {
        return new Response(
          JSON.stringify({
            plan: 'pro',
            basePriceCents: 34900,
            overageRatePerMinute: 0.22,
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
// ($349). The calculator's monthly mode must render the latter, which the
// API now provides via `monthlyBasePriceCents`. These tests pin down the
// mapping in `buildOverride()` so an annual tenant flipping the calculator
// to monthly mode sees the correct $349 published rate, not their own
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
      monthlyBasePriceCents: 34900,
      monthlyBasePriceSource: 'stripe',
      // Annual side reuses the sub-derived value.
      annualBasePriceCents: 30000,
      annualBasePriceSource: 'stripe',
    });
    expect(override).toBeDefined();
    // Calculator's monthly mode must see the published monthly price, not
    // the tenant's annual monthly-equivalent.
    expect(override?.basePriceCents).toBe(34900);
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
      basePriceCents: 32900,
      overageRatePerMinute: 0.2,
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
    });
    expect(override?.basePriceCents).toBe(32900);
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
      basePriceCents: 34900,
      overageRatePerMinute: 0.22,
      basePriceSource: 'catalog',
      overagePriceSource: 'catalog',
      monthlyBasePriceCents: 34900,
      monthlyBasePriceSource: 'catalog',
      annualBasePriceCents: 29665,
      annualBasePriceSource: 'stripe',
    });
    expect(override).toBeDefined();
    expect(override?.basePriceSource).toBe('catalog');
    expect(override?.annualBasePriceSource).toBe('stripe');
    expect(override?.annualBasePriceCents).toBe(29665);
  });

  it('returns undefined when every interval is catalog-sourced', async () => {
    const { buildOverride } = await import('../../client-app/src/pages/public/Pricing');
    // No live Stripe quote anywhere — fall through to anonymous-visitor
    // catalog rendering rather than mounting a misleading badge.
    const override = buildOverride({
      plan: 'pro',
      basePriceCents: 34900,
      overageRatePerMinute: 0.22,
      basePriceSource: 'catalog',
      overagePriceSource: 'catalog',
      monthlyBasePriceCents: 34900,
      monthlyBasePriceSource: 'catalog',
      annualBasePriceCents: 29665,
      annualBasePriceSource: 'catalog',
    });
    expect(override).toBeUndefined();
  });

  // Carrier pass-through removal (replaces tasks #1265 / #1356): an
  // SMS-only or Twilio-only Stripe quote used to engage the override so
  // the calculator could surface the negotiated carrier rate. Carrier
  // costs are now bundled into plan prices, so legacy carrier provenance
  // must NOT engage the override (no misleading "Live Stripe rate" badge).
  it('returns undefined when the only Stripe-sourced fields are legacy SMS / Twilio rates', async () => {
    const { buildOverride } = await import('../../client-app/src/pages/public/Pricing');
    const override = buildOverride({
      plan: 'pro',
      basePriceCents: 34900,
      overageRatePerMinute: 0.22,
      basePriceSource: 'catalog',
      overagePriceSource: 'catalog',
      monthlyBasePriceCents: 34900,
      monthlyBasePriceSource: 'catalog',
      annualBasePriceCents: 29665,
      annualBasePriceSource: 'catalog',
      ...LEGACY_STRIPE_CARRIER_FIELDS,
    } as unknown as EffectiveRateResponse);
    expect(override).toBeUndefined();
  });

  it('never passes legacy SMS / Twilio fields through when the override is engaged for AI reasons', async () => {
    const { buildOverride } = await import('../../client-app/src/pages/public/Pricing');
    const override = buildOverride({
      plan: 'pro',
      basePriceCents: 30000,
      overageRatePerMinute: 0.07,
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
      ...LEGACY_STRIPE_CARRIER_FIELDS,
    } as unknown as EffectiveRateResponse);
    expect(override).toBeDefined();
    expect(override?.basePriceCents).toBe(30000);
    expect(override?.overageRatePerMinute).toBe(0.07);
    for (const key of [
      'smsRatePerMessage',
      'smsPriceSource',
      'smsPriceId',
      'twilioRatePerMinute',
      'twilioPriceSource',
      'twilioPriceId',
    ]) {
      expect(override, key).not.toHaveProperty(key);
    }
  });
});

// ---------------------------------------------------------------------------
// computeCustomRateDelta — see task #1210.
//
// Pure transform so the banner-vs-no-banner decision is unit-testable
// without rendering the whole Pricing page. The tenant reference is the
// interval-agnostic `basePriceCents` (monthly equivalent of whatever
// interval the subscription is on), and the catalog reference is the
// matching catalog interval price — monthly for monthly subs, the
// catalog × (1 - ANNUAL_DISCOUNT) = catalog × 0.85 annual equivalent for
// annual subs.
// ---------------------------------------------------------------------------
describe('computeCustomRateDelta', () => {
  it('returns null for a null/undefined payload', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    expect(computeCustomRateDelta(null)).toBeNull();
    expect(computeCustomRateDelta(undefined)).toBeNull();
  });

  it('returns null when the response is fully catalog-sourced', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    // Pure-catalog payload is identical to what an anonymous visitor
    // would see — the callout would lie, so it must not render.
    const delta = computeCustomRateDelta({
      plan: 'pro',
      basePriceCents: 34900,
      overageRatePerMinute: 0.22,
      basePriceSource: 'catalog',
      overagePriceSource: 'catalog',
    });
    expect(delta).toBeNull();
  });

  it('returns null when Stripe-sourced but the rate matches catalog within 1¢', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    // Stripe sub exists but the customer is on the published price —
    // a 1¢ proration drift from rounding shouldn't trigger the banner.
    const delta = computeCustomRateDelta({
      plan: 'pro',
      basePriceCents: 34901,
      overageRatePerMinute: 0.22,
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
    });
    expect(delta).toBeNull();
  });

  it('flags a tenant paying less than catalog as "less"', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    const delta = computeCustomRateDelta({
      plan: 'pro',
      basePriceCents: 25000,
      overageRatePerMinute: 0.22,
      basePriceSource: 'stripe',
      overagePriceSource: 'catalog',
    });
    expect(delta).toEqual({
      tier: 'pro',
      tierName: 'Pro',
      frame: 'monthly',
      currentMonthlyDollars: 250,
      catalogMonthlyDollars: 349,
      deltaDollars: 99,
      annualCurrentDollars: null,
      annualCatalogDollars: null,
      annualDeltaDollars: null,
      isLess: true,
    });
  });

  it('flags a tenant paying more than catalog as not-less', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    const delta = computeCustomRateDelta({
      plan: 'starter',
      basePriceCents: 19900,
      overageRatePerMinute: 0.25,
      basePriceSource: 'stripe',
      overagePriceSource: 'catalog',
    });
    expect(delta).toEqual({
      tier: 'starter',
      tierName: 'Starter',
      frame: 'monthly',
      currentMonthlyDollars: 199,
      catalogMonthlyDollars: 149,
      deltaDollars: 50,
      annualCurrentDollars: null,
      annualCatalogDollars: null,
      annualDeltaDollars: null,
      isLess: false,
    });
  });

  it('engages even when only the overage side is Stripe-sourced, as long as base diverges', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    // The "is this Stripe-sourced at all" check is permissive — any
    // Stripe field flips it on — but the actual delta is computed from
    // basePriceCents. So a tenant whose overage is negotiated but base
    // is also custom (just labelled by the API differently) still
    // surfaces a banner whenever base differs from catalog.
    const delta = computeCustomRateDelta({
      plan: 'enterprise',
      basePriceCents: 70000,
      overageRatePerMinute: 0.05,
      basePriceSource: 'catalog',
      overagePriceSource: 'stripe',
    });
    expect(delta).not.toBeNull();
    expect(delta?.isLess).toBe(true);
    expect(delta?.currentMonthlyDollars).toBe(700);
    expect(delta?.catalogMonthlyDollars).toBe(799);
  });

  it('does NOT flag a tenant on the standard published ANNUAL rate (regression for #1210)', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    // catalog Pro monthly = $349, annual = $349 × 0.85 = $296.65.
    // A tenant on STRIPE_PRICE_PRO_ANNUAL has basePriceCents = 29665,
    // basePriceSource = 'stripe'. The earlier always-monthly comparison
    // would have returned a ~$52 delta — the fix detects the annual
    // interval and compares against the catalog annual reference,
    // yielding a delta of ~0.
    const delta = computeCustomRateDelta({
      plan: 'pro',
      basePriceCents: 29665,
      overageRatePerMinute: 0.22,
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
      monthlyBasePriceCents: 34900,
      monthlyBasePriceSource: 'stripe',
      annualBasePriceCents: 29665,
      annualBasePriceSource: 'stripe',
    });
    expect(delta).toBeNull();
  });

  it('compares against the ANNUAL catalog reference for an annual-billed tenant on a negotiated rate', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    const delta = computeCustomRateDelta({
      plan: 'pro',
      basePriceCents: 25000,
      overageRatePerMinute: 0.22,
      basePriceSource: 'stripe',
      overagePriceSource: 'catalog',
      monthlyBasePriceCents: 34900,
      monthlyBasePriceSource: 'stripe',
      annualBasePriceCents: 25000,
      annualBasePriceSource: 'stripe',
    });
    expect(delta).not.toBeNull();
    expect(delta?.currentMonthlyDollars).toBe(250);
    // Catalog reference = round(34900 × 0.85 / 100) = 297 (annual, not 349).
    expect(delta?.catalogMonthlyDollars).toBe(297);
    // round((29665 − 25000) / 100) = round(46.65) = 47.
    expect(delta?.deltaDollars).toBe(47);
    expect(delta?.isLess).toBe(true);
  });

  it('skips the callout when the per-interval breakdown is contradictory (interval cannot be inferred)', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    // basePriceCents matches neither monthlyBasePriceCents nor
    // annualBasePriceCents — we have no reliable signal for which
    // interval the tenant is on, so we'd risk picking the wrong
    // catalog reference. Better to skip than mislead.
    const delta = computeCustomRateDelta({
      plan: 'pro',
      basePriceCents: 27000,
      overageRatePerMinute: 0.22,
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
      monthlyBasePriceCents: 34900,
      monthlyBasePriceSource: 'stripe',
      annualBasePriceCents: 29665,
      annualBasePriceSource: 'stripe',
    });
    expect(delta).toBeNull();
  });

  it('skips when the delta is below the whole-dollar render threshold', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    // Sub-dollar drift would print rounded numbers that don't add up
    // ("$349 — that's $1/mo less than $349"). Suppress the callout.
    const delta = computeCustomRateDelta({
      plan: 'pro',
      basePriceCents: 34850,
      overageRatePerMinute: 0.22,
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
      monthlyBasePriceCents: 34850,
      monthlyBasePriceSource: 'stripe',
      annualBasePriceCents: 29665,
      annualBasePriceSource: 'stripe',
    });
    expect(delta).toBeNull();
  });

  it('returns null for an unknown plan tier', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    const delta = computeCustomRateDelta({
      // @ts-expect-error — deliberately invalid; guards against a future
      // server-side schema drift quietly mounting a banner with broken
      // copy.
      plan: 'mythical',
      basePriceCents: 12345,
      overageRatePerMinute: 0.1,
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
    });
    expect(delta).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Task #1270: grandfathered tenants with a custom per-minute overage
  // rate also need the same "you pay $X/min vs the published $Y/min"
  // summary on the callout, not just the base-price line.
  // -------------------------------------------------------------------------
  it('attaches an overage sub-delta when overagePriceSource is stripe and the rate diverges', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    // Pro catalog overage = $0.22/min; tenant negotiated $0.05/min.
    // Base price ALSO diverges (Stripe sub at $250/mo vs catalog $349).
    const delta = computeCustomRateDelta({
      plan: 'pro',
      basePriceCents: 25000,
      overageRatePerMinute: 0.05,
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
    });
    expect(delta).not.toBeNull();
    // Base headline preserved.
    expect(delta?.currentMonthlyDollars).toBe(250);
    expect(delta?.catalogMonthlyDollars).toBe(349);
    expect(delta?.deltaDollars).toBe(99);
    expect(delta?.isLess).toBe(true);
    // Overage sub-delta carries the per-minute breakdown.
    expect(delta?.overage).toBeDefined();
    expect(delta?.overage?.currentRatePerMinute).toBe(0.05);
    expect(delta?.overage?.catalogRatePerMinute).toBe(0.22);
    // Floating-point: 0.22 - 0.05 = 0.17 (within rounding noise).
    expect(delta?.overage?.deltaPerMinute).toBeCloseTo(0.17, 6);
    expect(delta?.overage?.isLess).toBe(true);
  });

  it('omits the overage sub-delta when overagePriceSource is catalog (even if the rate happens to differ)', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    // overagePriceSource is catalog — even though the numeric rate
    // happens to look custom, we trust the source label and skip the
    // overage line so we don't compare catalog-against-catalog.
    const delta = computeCustomRateDelta({
      plan: 'pro',
      basePriceCents: 25000,
      overageRatePerMinute: 0.05,
      basePriceSource: 'stripe',
      overagePriceSource: 'catalog',
    });
    expect(delta).not.toBeNull();
    expect(delta?.overage).toBeUndefined();
  });

  it('omits the overage sub-delta when the tenant rate matches catalog within rounding noise', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    // 0.001/min drift is below the half-cent threshold — almost
    // certainly Stripe pricing-engine rounding rather than a
    // negotiated rate, so suppress the overage line.
    const delta = computeCustomRateDelta({
      plan: 'pro',
      basePriceCents: 25000,
      overageRatePerMinute: 0.221,
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
    });
    expect(delta).not.toBeNull();
    expect(delta?.overage).toBeUndefined();
  });

  it('returns a delta with overage-only when base matches catalog but overage diverges', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    // Tenant on the published Pro base price ($349) but a negotiated
    // $0.05/min overage rate. Base delta is 0; overage delta is real.
    // This is exactly the "tenant negotiating purely on overage"
    // scenario the task calls out — must surface the callout.
    const delta = computeCustomRateDelta({
      plan: 'pro',
      basePriceCents: 34900,
      overageRatePerMinute: 0.05,
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
    });
    expect(delta).not.toBeNull();
    // deltaDollars is zeroed out so the renderer skips the base
    // sentence rather than printing "$0/mo less than $349".
    expect(delta?.deltaDollars).toBe(0);
    // isLess is also normalised so the renderer's tone fall-through
    // can rely on the overage direction instead.
    expect(delta?.isLess).toBe(false);
    expect(delta?.overage).toBeDefined();
    expect(delta?.overage?.currentRatePerMinute).toBe(0.05);
    expect(delta?.overage?.catalogRatePerMinute).toBe(0.22);
    expect(delta?.overage?.isLess).toBe(true);
  });

  it('returns null when both base and overage match catalog within their thresholds (Stripe-sourced)', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    // Sub-dollar base drift + sub-half-cent overage drift — both are
    // rounding noise, so the function must NOT mount a banner with
    // nothing to say.
    const delta = computeCustomRateDelta({
      plan: 'pro',
      basePriceCents: 34950,
      overageRatePerMinute: 0.2201,
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
    });
    expect(delta).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Carrier pass-through removal (replaces tasks #1327 / #1357): the delta
  // used to carry `sms` / `twilio` sub-deltas, and a Stripe-sourced SMS or
  // Twilio price alone was enough to mark the payload "Stripe sourced".
  // Carrier costs are now folded into plan prices, so only base + overage
  // count. Legacy payloads still carrying carrier fields must be ignored.
  // -------------------------------------------------------------------------
  it('returns null when the ONLY Stripe-sourced fields are legacy SMS / Twilio rates', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    // Pre-removal, a Twilio- or SMS-only Stripe price engaged the callout
    // even with catalog base/overage. Now carrier provenance is ignored,
    // so a payload with only catalog plan fields is not "Stripe sourced".
    const delta = computeCustomRateDelta({
      plan: 'pro',
      // Deliberately off-catalog so a regression that re-accepted carrier
      // provenance as "Stripe sourced" would surface a base delta here.
      basePriceCents: 25000,
      overageRatePerMinute: 0.05,
      basePriceSource: 'catalog',
      overagePriceSource: 'catalog',
      ...LEGACY_STRIPE_CARRIER_FIELDS,
    } as unknown as EffectiveRateResponse);
    expect(delta).toBeNull();
  });

  it('returns null when base + overage match catalog even if legacy Stripe-sourced SMS / Twilio rates diverge', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    // Published Pro base + overage via a live Stripe sub, plus legacy
    // negotiated carrier rates. Pre-removal this produced an SMS-only /
    // Twilio-only delta; now there is nothing to say.
    const delta = computeCustomRateDelta({
      plan: 'pro',
      basePriceCents: 34900,
      overageRatePerMinute: 0.22,
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
      ...LEGACY_STRIPE_CARRIER_FIELDS,
    } as unknown as EffectiveRateResponse);
    expect(delta).toBeNull();
  });

  it('never attaches sms / twilio sub-deltas alongside a real base + overage delta', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    const delta = computeCustomRateDelta({
      plan: 'pro',
      basePriceCents: 25000,
      overageRatePerMinute: 0.05,
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
      ...LEGACY_STRIPE_CARRIER_FIELDS,
    } as unknown as EffectiveRateResponse);
    expect(delta).not.toBeNull();
    expect(delta).not.toHaveProperty('sms');
    expect(delta).not.toHaveProperty('twilio');
    // Exact shape: only the base headline + overage sub-delta.
    expect(delta).toEqual({
      tier: 'pro',
      tierName: 'Pro',
      frame: 'monthly',
      currentMonthlyDollars: 250,
      catalogMonthlyDollars: 349,
      deltaDollars: 99,
      annualCurrentDollars: null,
      annualCatalogDollars: null,
      annualDeltaDollars: null,
      isLess: true,
      overage: {
        currentRatePerMinute: 0.05,
        catalogRatePerMinute: 0.22,
        deltaPerMinute: expect.closeTo(0.17, 6),
        isLess: true,
      },
    });
  });
});

describe('computeCustomRateDelta — annual framing', () => {
  it('produces an annual-framed delta for an annual-billed tenant on a negotiated rate', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    const delta = computeCustomRateDelta(
      {
        plan: 'pro',
        // $3,000/yr ($250/mo); catalog annual = $296.65/mo ($3,560/yr rounded).
        basePriceCents: 25000,
        overageRatePerMinute: 0.22,
        basePriceSource: 'stripe',
        overagePriceSource: 'catalog',
        monthlyBasePriceCents: 34900,
        monthlyBasePriceSource: 'stripe',
        annualBasePriceCents: 25000,
        annualBasePriceSource: 'stripe',
      },
      'annual',
    );
    expect(delta).not.toBeNull();
    expect(delta?.frame).toBe('annual');
    expect(delta?.tier).toBe('pro');
    expect(delta?.tierName).toBe('Pro');
    expect(delta?.currentMonthlyDollars).toBe(250);
    expect(delta?.catalogMonthlyDollars).toBe(297);
    expect(delta?.deltaDollars).toBe(47);
    expect(delta?.annualCurrentDollars).toBe(3000);
    // round(29665 × 12 / 100) = round(3559.8) = 3560.
    expect(delta?.annualCatalogDollars).toBe(3560);
    // round(4665 × 12 / 100) = round(559.8) = 560.
    expect(delta?.annualDeltaDollars).toBe(560);
    expect(delta?.isLess).toBe(true);
  });

  it('flips to "more" when the tenant pays above the published annual rate', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    const delta = computeCustomRateDelta(
      {
        plan: 'starter',
        // $1,800/yr ($150/mo); catalog annual = $126.65/mo ($1,520/yr rounded).
        basePriceCents: 15000,
        overageRatePerMinute: 0.25,
        basePriceSource: 'stripe',
        overagePriceSource: 'catalog',
        monthlyBasePriceCents: 14900,
        monthlyBasePriceSource: 'stripe',
        annualBasePriceCents: 15000,
        annualBasePriceSource: 'stripe',
      },
      'annual',
    );
    expect(delta).not.toBeNull();
    expect(delta?.frame).toBe('annual');
    expect(delta?.isLess).toBe(false);
    expect(delta?.annualCurrentDollars).toBe(1800);
    // round(12665 × 12 / 100) = round(1519.8) = 1520.
    expect(delta?.annualCatalogDollars).toBe(1520);
    // round((15000 − 12665) × 12 / 100) = round(280.2) = 280.
    expect(delta?.annualDeltaDollars).toBe(280);
  });

  it('suppresses the callout in annual mode when the annual side matches catalog', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    const delta = computeCustomRateDelta(
      {
        plan: 'pro',
        basePriceCents: 30000,
        overageRatePerMinute: 0.22,
        basePriceSource: 'stripe',
        overagePriceSource: 'catalog',
        monthlyBasePriceCents: 30000,
        monthlyBasePriceSource: 'stripe',
        // Published annual reference: round(34900 × 0.85) = 29665.
        annualBasePriceCents: 29665,
        annualBasePriceSource: 'catalog',
      },
      'annual',
    );
    expect(delta).toBeNull();
  });

  it('falls back to monthly framing when annualBasePriceCents is absent', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    const delta = computeCustomRateDelta(
      {
        plan: 'pro',
        basePriceCents: 25000,
        overageRatePerMinute: 0.22,
        basePriceSource: 'stripe',
        overagePriceSource: 'catalog',
      },
      'annual',
    );
    expect(delta).not.toBeNull();
    expect(delta?.frame).toBe('monthly');
    expect(delta?.currentMonthlyDollars).toBe(250);
    expect(delta?.catalogMonthlyDollars).toBe(349);
    expect(delta?.annualCurrentDollars).toBeNull();
    expect(delta?.annualDeltaDollars).toBeNull();
  });

  it('defaults to monthly framing when billingPeriod is omitted', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    const delta = computeCustomRateDelta({
      plan: 'pro',
      basePriceCents: 25000,
      overageRatePerMinute: 0.22,
      basePriceSource: 'stripe',
      overagePriceSource: 'catalog',
      monthlyBasePriceCents: 25000,
      monthlyBasePriceSource: 'stripe',
      annualBasePriceCents: 29665,
      annualBasePriceSource: 'catalog',
    });
    expect(delta?.frame).toBe('monthly');
    expect(delta?.deltaDollars).toBe(99);
  });
});

// Every plan includes every industry template, tool and feature; tiers differ
// only in minutes and usage caps (docs/shop/tools-spec.md, "Plans and
// entitlements"). Only the volume rows of the comparison table may differ.
describe('Public /pricing comparison table: every plan includes every feature', () => {
  const VOLUME_ROWS = new Set(['ai_minutes', 'overage']);

  it('renders every non-volume row the same on all three tiers, with no "not included" cell', async () => {
    mockUser = null;
    await renderUnderPublicBundleProviders();

    const rows = await waitFor(() => {
      const found = Array.from(document.querySelectorAll<HTMLTableRowElement>('tr[data-feature]'));
      expect(found.length).toBeGreaterThan(VOLUME_ROWS.size);
      return found;
    });

    expect(document.querySelectorAll('[data-included="false"]').length).toBe(0);

    for (const row of rows) {
      const feature = row.getAttribute('data-feature')!;
      const tierCells = Array.from(row.querySelectorAll('td')).slice(1);
      expect(tierCells, feature).toHaveLength(3);
      if (VOLUME_ROWS.has(feature)) continue;
      const rendered = tierCells.map((td) =>
        td.querySelector('[data-included="true"]') ? 'included' : (td.textContent ?? '').trim(),
      );
      expect(new Set(rendered).size, `${feature} differs by tier: ${rendered.join(' / ')}`).toBe(1);
    }

    const byFeature = new Map(rows.map((r) => [r.getAttribute('data-feature'), r]));
    for (const capped of ['phones', 'team']) {
      const cells = Array.from(byFeature.get(capped)!.querySelectorAll('td')).slice(1);
      expect(cells.map((td) => td.textContent)).toEqual(['Unlimited', 'Unlimited', 'Unlimited']);
    }
  });

  it('says every plan includes every industry template, every tool, and carrier calling and SMS costs', async () => {
    mockUser = null;
    await renderUnderPublicBundleProviders();
    const line = await waitFor(() => screen.getByTestId('pricing-all-included'));
    expect(line.textContent).toBe(
      'Every plan includes every industry template, every tool, and carrier calling and SMS costs. 7-day trial on every plan.',
    );
  });
});
