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

    // The per-message SMS rate row (task #1265 / #1314) is gated on a
    // logged-in tenant with an SMS override on the effective-rate
    // payload. Anonymous visitors must NOT see an SMS line — they have
    // no negotiated rate to surface and we don't want to leak the
    // existence of an authed-only SMS price field on the marketing page.
    expect(screen.queryByTestId('calc-sms-rate')).toBeNull();
    expect(screen.queryByTestId('calc-sms-rate-value')).toBeNull();
    expect(screen.queryByTestId('calc-sms-source')).toBeNull();

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

  // -------------------------------------------------------------------------
  // Task #1314: a logged-in tenant on a custom Stripe SMS price must see
  // their negotiated $/msg rate on the public /pricing calculator with the
  // "Live Stripe rate" badge. Locks the SMS-rendered case end-to-end so a
  // future regression in the buildOverride → MinutesPricingCalculator
  // wiring (or in the calc-sms-rate render gate) surfaces here.
  // -------------------------------------------------------------------------
  it('renders the negotiated SMS rate with the "Live Stripe rate" badge for a logged-in tenant on a custom Stripe SMS price (task #1314)', async () => {
    mockUser = { tenantId: 'tenant-sms-negotiated' };
    fetchHandler = (url) => {
      if (url.includes('/billing/effective-rate')) {
        return new Response(
          JSON.stringify({
            plan: 'pro',
            // Catalog AI/base/overage on Pro — the only Stripe-sourced
            // override is on the SMS side. This is the exact scenario
            // task #1314 calls out: a tenant on a published AI plan
            // who has separately negotiated a custom per-message SMS
            // rate must still see that SMS rate (and badge) surface
            // on the public calculator.
            basePriceCents: 39900,
            overageRatePerMinute: 0.12,
            currency: 'usd',
            source: 'catalog',
            basePriceSource: 'catalog',
            overagePriceSource: 'catalog',
            monthlyBasePriceCents: 39900,
            monthlyBasePriceSource: 'catalog',
            annualBasePriceCents: 31920,
            annualBasePriceSource: 'catalog',
            // Negotiated $0.0075/msg vs typical env default ~$0.01/msg.
            // Picked deliberately so a regression that fell back to a
            // catalog default (or dropped the override entirely) would
            // surface as a wrong rendered dollar value rather than a
            // silently-passing assertion on a coincidental match.
            smsRatePerMessage: 0.0075,
            smsPriceSource: 'stripe',
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

    // SMS row mounts on the calculator.
    const smsRow = await waitFor(() => screen.getByTestId('calc-sms-rate'));
    expect(smsRow.getAttribute('data-sms-source')).toBe('stripe');

    // Rendered $/msg matches the negotiated rate, formatted to four
    // fraction digits per MinutesPricingCalculator.formatPerMessage so
    // a sub-cent rate is never quietly truncated to "$0.01".
    const valueEl = screen.getByTestId('calc-sms-rate-value');
    const valueText = valueEl.textContent ?? '';
    expect(valueText).toContain('$0.0075');
    expect(valueText).toContain('/msg');

    // "Live Stripe rate" badge engages because smsPriceSource === 'stripe'.
    const badge = screen.getByTestId('calc-sms-source');
    expect(badge.textContent ?? '').toMatch(/live stripe rate/i);

    // The AI side stayed on catalog — none of the per-tier "Live Stripe
    // rate" badges should have mounted just because SMS was Stripe-sourced.
    expect(screen.queryByTestId('calc-source-starter')).toBeNull();
    expect(screen.queryByTestId('calc-source-pro')).toBeNull();
    expect(screen.queryByTestId('calc-source-enterprise')).toBeNull();
  });

  it('renders the SMS row WITHOUT the "Live Stripe rate" badge when the SMS price is catalog-sourced (task #1314)', async () => {
    // Counterpart to the positive test: a tenant on a Stripe-sourced AI
    // plan whose SMS rate IS present on the payload but flagged
    // smsPriceSource === 'catalog' (i.e. the env-default fallback the
    // backend resolved when the tenant has no negotiated Stripe SMS
    // price). MinutesPricingCalculator's render gate is keyed on the
    // numeric rate being present — so the row mounts — but the
    // "Live Stripe rate" badge MUST stay hidden so we don't falsely
    // imply the env-default fallback was a negotiated rate.
    mockUser = { tenantId: 'tenant-sms-catalog' };
    fetchHandler = (url) => {
      if (url.includes('/billing/effective-rate')) {
        return new Response(
          JSON.stringify({
            plan: 'pro',
            basePriceCents: 34900,
            overageRatePerMinute: 0.07,
            currency: 'usd',
            source: 'stripe',
            basePriceSource: 'stripe',
            overagePriceSource: 'stripe',
            // SMS rate value is present (env default), but provenance
            // is catalog. Picked at $0.01/msg so a regression that
            // started rendering the badge for catalog-sourced SMS
            // would surface here instead of silently passing.
            smsRatePerMessage: 0.01,
            smsPriceSource: 'catalog',
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

    // Wait for the AI-side override to engage so we know the page has
    // finished its effective-rate fetch before asserting on the SMS row.
    await waitFor(() => {
      expect(screen.getByTestId('calc-source-pro')).toBeTruthy();
    });

    // Row mounts because the rate value is present, but data-sms-source
    // reflects the catalog provenance and the badge is suppressed.
    const smsRow = screen.getByTestId('calc-sms-rate');
    expect(smsRow.getAttribute('data-sms-source')).toBe('catalog');
    expect(screen.queryByTestId('calc-sms-source')).toBeNull();

    // Rendered $/msg still shows the env-default value so the calculator
    // isn't lying about what the tenant pays — it just isn't claiming
    // the rate came from a negotiated Stripe price.
    const valueText = screen.getByTestId('calc-sms-rate-value').textContent ?? '';
    expect(valueText).toContain('$0.0100');
    expect(valueText).toContain('/msg');
  });

  it('does NOT render the SMS row at all when the override carries no SMS rate value (task #1314)', async () => {
    // Separate guard for the "no SMS rate at all" case (e.g. a tenant
    // whose backend response simply omits smsRatePerMessage). The
    // MinutesPricingCalculator gate is keyed on the numeric value, so
    // missing rate => row is suppressed entirely, regardless of source.
    mockUser = { tenantId: 'tenant-sms-missing' };
    fetchHandler = (url) => {
      if (url.includes('/billing/effective-rate')) {
        return new Response(
          JSON.stringify({
            plan: 'pro',
            basePriceCents: 34900,
            overageRatePerMinute: 0.07,
            currency: 'usd',
            source: 'stripe',
            basePriceSource: 'stripe',
            overagePriceSource: 'stripe',
            // No smsRatePerMessage / smsPriceSource fields at all.
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
      expect(screen.getByTestId('calc-source-pro')).toBeTruthy();
    });

    expect(screen.queryByTestId('calc-sms-rate')).toBeNull();
    expect(screen.queryByTestId('calc-sms-rate-value')).toBeNull();
    expect(screen.queryByTestId('calc-sms-source')).toBeNull();
  });

  it('shows the custom-rate callout above the calculator when the tenant pays LESS than catalog (task #1210)', async () => {
    mockUser = { tenantId: 'tenant-grandfathered' };
    fetchHandler = (url) => {
      if (url.includes('/billing/effective-rate')) {
        return new Response(
          JSON.stringify({
            plan: 'pro',
            // Tenant grandfathered at $250/mo for Pro; catalog is $399.
            basePriceCents: 25000,
            overageRatePerMinute: 0.12,
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
    expect(text).toContain('$250');
    expect(text).toContain('$149');
    expect(text).toContain('$399');
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
            // Custom rate $149/mo for Starter; catalog is $99.
            basePriceCents: 14900,
            overageRatePerMinute: 0.15,
            currency: 'usd',
            source: 'stripe',
            basePriceSource: 'stripe',
            overagePriceSource: 'catalog',
            monthlyBasePriceCents: 14900,
            monthlyBasePriceSource: 'stripe',
            annualBasePriceCents: 12000,
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
    expect(text).toContain('$149');
    expect(text).toContain('$50');
    expect(text).toContain('$99');
    expect(text.toLowerCase()).toContain('more');
  });

  it('does NOT render the custom-rate callout for a tenant on the standard published ANNUAL rate (task #1210, regression)', async () => {
    // Regression: an annual-billed tenant on the catalog rate has
    // basePriceCents = catalog × 0.8 (annualised monthly equivalent).
    // A naive comparison against catalog monthly would falsely flag
    // them as paying "less than the published rate" when they're
    // simply on the annual interval. The fix is to compare against the
    // matching catalog interval (annual = catalog × 0.8).
    mockUser = { tenantId: 'tenant-on-published-annual' };
    fetchHandler = (url) => {
      if (url.includes('/billing/effective-rate')) {
        return new Response(
          JSON.stringify({
            plan: 'pro',
            // $399 monthly catalog × (1 - 0.20) = $319.20/mo annualised.
            basePriceCents: 31920,
            overageRatePerMinute: 0.12,
            currency: 'usd',
            source: 'stripe',
            basePriceSource: 'stripe',
            overagePriceSource: 'stripe',
            // The matching (annual) interval reuses the sub-derived
            // value verbatim; the other side comes from env lookup.
            monthlyBasePriceCents: 39900,
            monthlyBasePriceSource: 'stripe',
            annualBasePriceCents: 31920,
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
            // Annual at $3,000/yr ($250/mo); catalog annual = $3,830/yr.
            basePriceCents: 25000,
            overageRatePerMinute: 0.12,
            currency: 'usd',
            source: 'stripe',
            basePriceSource: 'stripe',
            overagePriceSource: 'catalog',
            monthlyBasePriceCents: 39900,
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
    expect(annualText).toContain('$3,830');
    expect(annualText).toContain('$830');
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
            basePriceCents: 35000,
            overageRatePerMinute: 0.12,
            currency: 'usd',
            source: 'stripe',
            basePriceSource: 'stripe',
            overagePriceSource: 'catalog',
            monthlyBasePriceCents: 35000,
            monthlyBasePriceSource: 'stripe',
            annualBasePriceCents: 31920,
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
            // Catalog annual reference = $399 × 0.8 = $319.20/mo.
            // Delta = $319 - $250 = ~$69/mo less.
            basePriceCents: 25000,
            overageRatePerMinute: 0.12,
            currency: 'usd',
            source: 'stripe',
            basePriceSource: 'stripe',
            overagePriceSource: 'catalog',
            monthlyBasePriceCents: 39900,
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
    // Reference should be the ANNUAL catalog price ($319), not monthly $399.
    expect(text).toContain('$250');
    expect(text).toContain('$319');
    expect(text).toContain('$69');
    // And specifically NOT the monthly catalog headline — that would
    // be the regression we're guarding against.
    expect(text).not.toContain('$399');
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
            // Custom base ($250 vs catalog $399) + custom overage
            // ($0.05/min vs catalog $0.12/min) — banner copy must read
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
    expect(baseText).toContain('$149');
    expect(baseText).toContain('$399');

    // Overage line renders with per-minute numbers and tier name.
    const overageText = screen.getByTestId('pricing-override-callout-overage').textContent ?? '';
    expect(overageText).toContain('$0.05/min');
    expect(overageText).toContain('$0.07/min');
    expect(overageText).toContain('$0.12/min');
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
            // On the published Pro base price ($399) but with a
            // negotiated $0.05/min overage. Pre-#1270 this banner
            // would have stayed hidden — the whole point of the task
            // is that this tenant now sees a per-minute summary.
            basePriceCents: 39900,
            overageRatePerMinute: 0.05,
            currency: 'usd',
            source: 'stripe',
            basePriceSource: 'stripe',
            overagePriceSource: 'stripe',
            monthlyBasePriceCents: 39900,
            monthlyBasePriceSource: 'stripe',
            annualBasePriceCents: 31920,
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
    expect(overageText).toContain('$0.12/min');
    expect(overageText.toLowerCase()).toContain('less');
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
            overageRatePerMinute: 0.12,
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
            basePriceCents: 39900,
            overageRatePerMinute: 0.12,
            currency: 'usd',
            source: 'stripe',
            basePriceSource: 'stripe',
            overagePriceSource: 'stripe',
            monthlyBasePriceCents: 39900,
            monthlyBasePriceSource: 'stripe',
            annualBasePriceCents: 31900,
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

  // Task #1265: an SMS-only Stripe quote (catalog AI/base rates) must
  // still produce an override so the calculator can surface the
  // negotiated $/msg rate. Previously buildOverride bailed out unless
  // an AI-side source was Stripe, which would have hidden the SMS row
  // for tenants on a custom SMS price + catalog AI plan.
  it('engages the override when only the SMS side is Stripe-sourced', async () => {
    const { buildOverride } = await import('../../client-app/src/pages/public/Pricing');
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
      smsRatePerMessage: 0.0075,
      smsPriceSource: 'stripe',
    });
    expect(override).toBeDefined();
    expect(override?.basePriceSource).toBe('catalog');
    expect(override?.smsRatePerMessage).toBe(0.0075);
    expect(override?.smsPriceSource).toBe('stripe');
  });

  it('passes SMS fields through unchanged when the override is engaged for AI reasons', async () => {
    const { buildOverride } = await import('../../client-app/src/pages/public/Pricing');
    const override = buildOverride({
      plan: 'pro',
      basePriceCents: 30000,
      overageRatePerMinute: 0.07,
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
      smsRatePerMessage: 0.012,
      smsPriceSource: 'stripe',
    });
    expect(override?.smsRatePerMessage).toBe(0.012);
    expect(override?.smsPriceSource).toBe('stripe');
  });

  it('normalises missing SMS fields to null on the override', async () => {
    const { buildOverride } = await import('../../client-app/src/pages/public/Pricing');
    const override = buildOverride({
      plan: 'pro',
      basePriceCents: 30000,
      overageRatePerMinute: 0.07,
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
    });
    expect(override?.smsRatePerMessage).toBeNull();
    expect(override?.smsPriceSource).toBeNull();
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
// catalog × (1 - 0.20) annual equivalent for annual subs.
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
      basePriceCents: 39900,
      overageRatePerMinute: 0.12,
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
      basePriceCents: 39901,
      overageRatePerMinute: 0.12,
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
      overageRatePerMinute: 0.12,
      basePriceSource: 'stripe',
      overagePriceSource: 'catalog',
    });
    expect(delta).toEqual({
      tier: 'pro',
      tierName: 'Pro',
      frame: 'monthly',
      currentMonthlyDollars: 250,
      catalogMonthlyDollars: 399,
      deltaDollars: 149,
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
      basePriceCents: 14900,
      overageRatePerMinute: 0.15,
      basePriceSource: 'stripe',
      overagePriceSource: 'catalog',
    });
    expect(delta).toEqual({
      tier: 'starter',
      tierName: 'Starter',
      frame: 'monthly',
      currentMonthlyDollars: 149,
      catalogMonthlyDollars: 99,
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
      basePriceCents: 80000,
      overageRatePerMinute: 0.05,
      basePriceSource: 'catalog',
      overagePriceSource: 'stripe',
    });
    expect(delta).not.toBeNull();
    expect(delta?.isLess).toBe(true);
    expect(delta?.currentMonthlyDollars).toBe(800);
    expect(delta?.catalogMonthlyDollars).toBe(999);
  });

  it('does NOT flag a tenant on the standard published ANNUAL rate (regression for #1210)', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    // catalog Pro monthly = $399, annual = $399 × 0.8 = $319.20.
    // A tenant on STRIPE_PRICE_PRO_ANNUAL has basePriceCents = 31920,
    // basePriceSource = 'stripe'. The earlier always-monthly comparison
    // would have returned a $80 delta — the fix detects the annual
    // interval and compares against the catalog annual reference,
    // yielding a delta of ~0.
    const delta = computeCustomRateDelta({
      plan: 'pro',
      basePriceCents: 31920,
      overageRatePerMinute: 0.12,
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
      monthlyBasePriceCents: 39900,
      monthlyBasePriceSource: 'stripe',
      annualBasePriceCents: 31920,
      annualBasePriceSource: 'stripe',
    });
    expect(delta).toBeNull();
  });

  it('compares against the ANNUAL catalog reference for an annual-billed tenant on a negotiated rate', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    const delta = computeCustomRateDelta({
      plan: 'pro',
      basePriceCents: 25000,
      overageRatePerMinute: 0.12,
      basePriceSource: 'stripe',
      overagePriceSource: 'catalog',
      monthlyBasePriceCents: 39900,
      monthlyBasePriceSource: 'stripe',
      annualBasePriceCents: 25000,
      annualBasePriceSource: 'stripe',
    });
    expect(delta).not.toBeNull();
    expect(delta?.currentMonthlyDollars).toBe(250);
    // Catalog reference = round(39900 × 0.8 / 100) = 319 (annual, not 399).
    expect(delta?.catalogMonthlyDollars).toBe(319);
    expect(delta?.deltaDollars).toBe(69);
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
      overageRatePerMinute: 0.12,
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
      monthlyBasePriceCents: 39900,
      monthlyBasePriceSource: 'stripe',
      annualBasePriceCents: 31920,
      annualBasePriceSource: 'stripe',
    });
    expect(delta).toBeNull();
  });

  it('skips when the delta is below the whole-dollar render threshold', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    // Sub-dollar drift would print rounded numbers that don't add up
    // ("$399 — that's $0/mo less than $399"). Suppress the callout.
    const delta = computeCustomRateDelta({
      plan: 'pro',
      basePriceCents: 39850,
      overageRatePerMinute: 0.12,
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
      monthlyBasePriceCents: 39850,
      monthlyBasePriceSource: 'stripe',
      annualBasePriceCents: 31920,
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
    // Pro catalog overage = $0.12/min; tenant negotiated $0.05/min.
    // Base price ALSO diverges (Stripe sub at $250/mo vs catalog $399).
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
    expect(delta?.catalogMonthlyDollars).toBe(399);
    expect(delta?.deltaDollars).toBe(149);
    expect(delta?.isLess).toBe(true);
    // Overage sub-delta carries the per-minute breakdown.
    expect(delta?.overage).toBeDefined();
    expect(delta?.overage?.currentRatePerMinute).toBe(0.05);
    expect(delta?.overage?.catalogRatePerMinute).toBe(0.12);
    // Floating-point: 0.12 - 0.05 = 0.07 (within rounding noise).
    expect(delta?.overage?.deltaPerMinute).toBeCloseTo(0.07, 6);
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
      overageRatePerMinute: 0.121,
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
    });
    expect(delta).not.toBeNull();
    expect(delta?.overage).toBeUndefined();
  });

  it('returns a delta with overage-only when base matches catalog but overage diverges', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    // Tenant on the published Pro base price ($399) but a negotiated
    // $0.05/min overage rate. Base delta is 0; overage delta is real.
    // This is exactly the "tenant negotiating purely on overage"
    // scenario the task calls out — must surface the callout.
    const delta = computeCustomRateDelta({
      plan: 'pro',
      basePriceCents: 39900,
      overageRatePerMinute: 0.05,
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
    });
    expect(delta).not.toBeNull();
    // deltaDollars is zeroed out so the renderer skips the base
    // sentence rather than printing "$0/mo less than $399".
    expect(delta?.deltaDollars).toBe(0);
    // isLess is also normalised so the renderer's tone fall-through
    // can rely on the overage direction instead.
    expect(delta?.isLess).toBe(false);
    expect(delta?.overage).toBeDefined();
    expect(delta?.overage?.currentRatePerMinute).toBe(0.05);
    expect(delta?.overage?.catalogRatePerMinute).toBe(0.12);
    expect(delta?.overage?.isLess).toBe(true);
  });

  it('returns null when both base and overage match catalog within their thresholds (Stripe-sourced)', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    // Sub-dollar base drift + sub-half-cent overage drift — both are
    // rounding noise, so the function must NOT mount a banner with
    // nothing to say.
    const delta = computeCustomRateDelta({
      plan: 'pro',
      basePriceCents: 39950,
      overageRatePerMinute: 0.1201,
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
    });
    expect(delta).toBeNull();
  });
});

describe('computeCustomRateDelta — annual framing', () => {
  it('produces an annual-framed delta for an annual-billed tenant on a negotiated rate', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    const delta = computeCustomRateDelta(
      {
        plan: 'pro',
        // $3,000/yr ($250/mo); catalog annual ≈ $319/mo ($3,830/yr).
        basePriceCents: 25000,
        overageRatePerMinute: 0.12,
        basePriceSource: 'stripe',
        overagePriceSource: 'catalog',
        monthlyBasePriceCents: 39900,
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
    expect(delta?.catalogMonthlyDollars).toBe(319);
    expect(delta?.deltaDollars).toBe(69);
    expect(delta?.annualCurrentDollars).toBe(3000);
    expect(delta?.annualCatalogDollars).toBe(3830);
    expect(delta?.annualDeltaDollars).toBe(830);
    expect(delta?.isLess).toBe(true);
  });

  it('flips to "more" when the tenant pays above the published annual rate', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    const delta = computeCustomRateDelta(
      {
        plan: 'starter',
        // $1,500/yr ($125/mo); catalog annual ≈ $79.20/mo ($950/yr rounded).
        basePriceCents: 12500,
        overageRatePerMinute: 0.15,
        basePriceSource: 'stripe',
        overagePriceSource: 'catalog',
        monthlyBasePriceCents: 9900,
        monthlyBasePriceSource: 'stripe',
        annualBasePriceCents: 12500,
        annualBasePriceSource: 'stripe',
      },
      'annual',
    );
    expect(delta).not.toBeNull();
    expect(delta?.frame).toBe('annual');
    expect(delta?.isLess).toBe(false);
    expect(delta?.annualCurrentDollars).toBe(1500);
    expect(delta?.annualCatalogDollars).toBe(950);
    expect(delta?.annualDeltaDollars).toBe(550);
  });

  it('suppresses the callout in annual mode when the annual side matches catalog', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    const delta = computeCustomRateDelta(
      {
        plan: 'pro',
        basePriceCents: 35000,
        overageRatePerMinute: 0.12,
        basePriceSource: 'stripe',
        overagePriceSource: 'catalog',
        monthlyBasePriceCents: 35000,
        monthlyBasePriceSource: 'stripe',
        annualBasePriceCents: 31920,
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
        overageRatePerMinute: 0.12,
        basePriceSource: 'stripe',
        overagePriceSource: 'catalog',
      },
      'annual',
    );
    expect(delta).not.toBeNull();
    expect(delta?.frame).toBe('monthly');
    expect(delta?.currentMonthlyDollars).toBe(250);
    expect(delta?.catalogMonthlyDollars).toBe(399);
    expect(delta?.annualCurrentDollars).toBeNull();
    expect(delta?.annualDeltaDollars).toBeNull();
  });

  it('defaults to monthly framing when billingPeriod is omitted', async () => {
    const { computeCustomRateDelta } = await import('../../client-app/src/pages/public/Pricing');
    const delta = computeCustomRateDelta({
      plan: 'pro',
      basePriceCents: 25000,
      overageRatePerMinute: 0.12,
      basePriceSource: 'stripe',
      overagePriceSource: 'catalog',
      monthlyBasePriceCents: 25000,
      monthlyBasePriceSource: 'stripe',
      annualBasePriceCents: 31920,
      annualBasePriceSource: 'catalog',
    });
    expect(delta?.frame).toBe('monthly');
    expect(delta?.deltaDollars).toBe(149);
  });
});
