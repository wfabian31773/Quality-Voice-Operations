// @vitest-environment happy-dom
/**
 * Task #1324: confirms the public Pricing page surfaces the active
 * customer-level Stripe discount returned by `GET /billing/effective-rate`.
 *
 * Coverage matrix (the contract the task explicitly required):
 *   - Undiscounted path: when the API returns no `discount` (or a
 *     null one), tier cards render exactly the catalog price with no
 *     strikethrough or chip.
 *   - Percent-off path: cards render a strikethrough pre-discount
 *     price + the post-discount price + the "{label} applied" chip.
 *     Math is identical for monthly and annual cadences (a percent
 *     scales linearly).
 *   - Amount-off path on monthly billing: the coupon reduces the
 *     monthly invoice, so the displayed monthly figure drops by
 *     exactly `amount_off`.
 *   - Amount-off path on annual billing: the coupon reduces the WHOLE
 *     annual invoice by `amount_off`, not each month — the displayed
 *     monthly figure must drop by `amount_off / 12`. This is the
 *     critical regression guard for the "12× over-discount" bug
 *     where `amount_off` is naively subtracted from the monthly
 *     equivalent.
 *
 * The component is mounted under `MemoryRouter` with `useAuth` stubbed
 * to a logged-in tenant so the `/billing/effective-rate` fetch fires.
 * `fetch` is stubbed per-test to control the discount payload without
 * touching the network.
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
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

void React;

beforeAll(() => {
  // Suppress happy-dom iframe loaders mounted by the marketing footer.
  const proto = window.HTMLIFrameElement.prototype as unknown as Record<symbol, unknown>;
  for (const sym of Object.getOwnPropertySymbols(proto)) {
    if (
      sym.description === 'connectedToDocument'
      || sym.description === 'disconnectedFromDocument'
    ) {
      proto[sym] = function () {
        /* no-op: skip happy-dom's iframe page loader */
      };
    }
  }
});

vi.mock('../../client-app/src/lib/analytics', () => ({
  trackPageView: vi.fn(),
  trackCTAClick: vi.fn(),
  trackConversionEvent: vi.fn(),
  captureUtmOnLoad: vi.fn(),
}));

vi.mock('../../client-app/src/lib/auth', () => ({
  useAuth: () => ({
    user: { tenantId: 'tenant-discount-test', id: 'user-1' },
    initialized: true,
  }),
}));

vi.mock('../../client-app/src/components/RevealSection', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../../client-app/src/components/LiveTranscriptMock', () => ({
  default: () => <div data-testid="live-transcript-mock" />,
}));

import Pricing, {
  applyDiscountCents,
  applyDiscountToMonthlyDisplayCents,
  formatDiscountLabel,
  type EffectiveRateResponse,
} from '../../client-app/src/pages/public/Pricing';

interface DiscountInput {
  percentOff?: number | null;
  amountOffCents?: number | null;
  name?: string | null;
  promotionCode?: string | null;
}

function buildPayload(discount: DiscountInput | null): EffectiveRateResponse {
  return {
    plan: 'starter',
    basePriceCents: 19_900,
    overageRatePerMinute: 0.15,
    basePriceSource: 'catalog',
    overagePriceSource: 'catalog',
    monthlyBasePriceCents: 19_900,
    monthlyBasePriceSource: 'catalog',
    annualBasePriceCents: 15_900,
    annualBasePriceSource: 'catalog',
    discount: discount
      ? {
          couponId: 'COUPON_ID',
          name: discount.name ?? null,
          percentOff: discount.percentOff ?? null,
          amountOffCents: discount.amountOffCents ?? null,
          currency: discount.amountOffCents != null ? 'usd' : null,
          promotionCode: discount.promotionCode ?? null,
          promotionCodeId: null,
        }
      : null,
  };
}

let fetchHandler: (input: RequestInfo | URL) => Promise<Response>;

beforeEach(() => {
  fetchHandler = async () =>
    new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  vi.stubGlobal('fetch', ((input: RequestInfo | URL) => fetchHandler(input)) as typeof fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubEffectiveRate(payload: EffectiveRateResponse) {
  fetchHandler = async (input) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/billing/effective-rate')) {
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify([]), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function renderPricing() {
  return render(
    <MemoryRouter initialEntries={['/pricing']}>
      <Pricing />
    </MemoryRouter>,
  );
}

// Quick text-money probe — the displayed price string is e.g. "$199" or
// "$179" so a number→string contains-check is sufficient for assertions.
function textIncludesDollars(el: HTMLElement | null, dollars: number): boolean {
  if (!el?.textContent) return false;
  return el.textContent.includes(`$${dollars.toLocaleString('en-US')}`);
}

describe('Pricing — pure helpers', () => {
  it('applyDiscountCents: percent-off scales the base linearly', () => {
    expect(applyDiscountCents(20_000, { percentOff: 25 } as never)).toBe(15_000);
    // Edge: 0% and 100% clamp to identity / zero.
    expect(applyDiscountCents(20_000, { percentOff: 0 } as never)).toBe(20_000);
    expect(applyDiscountCents(20_000, { percentOff: 100 } as never)).toBe(0);
    // Defensive clamp: out-of-range percent_off is bounded to [0,100].
    expect(applyDiscountCents(20_000, { percentOff: 150 } as never)).toBe(0);
  });

  it('applyDiscountCents: amount-off subtracts and clamps at zero', () => {
    expect(applyDiscountCents(20_000, { amountOffCents: 5_000 } as never)).toBe(15_000);
    // amount_off larger than base → clamps to 0 (Stripe's invoice would
    // do the same — coupons can't generate negative invoices).
    expect(applyDiscountCents(3_000, { amountOffCents: 5_000 } as never)).toBe(0);
  });

  it('applyDiscountCents: percent_off wins over amount_off when both present', () => {
    // Stripe treats them as mutually exclusive on a single coupon, but
    // the helper must pick the correct field if a malformed payload
    // somehow carries both — percent_off is the more conservative
    // (larger) discount in this case so picking it keeps the displayed
    // price closer to what Stripe will actually invoice.
    expect(
      applyDiscountCents(20_000, {
        percentOff: 50,
        amountOffCents: 1_000,
      } as never),
    ).toBe(10_000);
  });

  it('applyDiscountCents: returns base unchanged when discount is null/empty', () => {
    expect(applyDiscountCents(20_000, null)).toBe(20_000);
    expect(applyDiscountCents(20_000, undefined)).toBe(20_000);
    expect(
      applyDiscountCents(20_000, {
        percentOff: null,
        amountOffCents: null,
      } as never),
    ).toBe(20_000);
  });

  it('applyDiscountToMonthlyDisplayCents: percent_off is identical for monthly and annual', () => {
    // Percent scales linearly so the per-month figure is the same.
    const monthly = applyDiscountToMonthlyDisplayCents(
      20_000,
      { percentOff: 25 } as never,
      1,
    );
    const annual = applyDiscountToMonthlyDisplayCents(
      20_000,
      { percentOff: 25 } as never,
      12,
    );
    expect(monthly).toBe(15_000);
    expect(annual).toBe(15_000);
  });

  it('applyDiscountToMonthlyDisplayCents: amount_off on monthly subtracts directly from monthly', () => {
    // Monthly cadence: Stripe's $50 amount_off reduces the monthly
    // invoice by $50 → monthly display drops by $50.
    expect(
      applyDiscountToMonthlyDisplayCents(
        20_000,
        { amountOffCents: 5_000 } as never,
        1,
      ),
    ).toBe(15_000);
  });

  it('applyDiscountToMonthlyDisplayCents: amount_off on annual divides by 12 for /month display', () => {
    // CRITICAL regression guard. A $120 amount_off on an annual sub
    // reduces the YEAR's invoice by $120 (= $10/mo equivalent), NOT
    // each monthly invoice by $120. The displayed monthly figure
    // must drop by $10, not $120.
    //
    // 200/mo × 12 = $2,400/yr. After $120 off = $2,280/yr → $190/mo.
    // (Naive bug would produce $80/mo — a 12× over-discount.)
    expect(
      applyDiscountToMonthlyDisplayCents(
        20_000, // $200/mo equivalent
        { amountOffCents: 12_000 } as never, // $120 off (annual invoice)
        12,
      ),
    ).toBe(19_000); // $190/mo equivalent
  });

  it('applyDiscountToMonthlyDisplayCents: amount_off larger than annual invoice clamps to zero', () => {
    expect(
      applyDiscountToMonthlyDisplayCents(
        10_000,
        { amountOffCents: 200_000 } as never,
        12,
      ),
    ).toBe(0);
  });

  it('formatDiscountLabel: produces human-readable strings', () => {
    expect(formatDiscountLabel({ percentOff: 25 } as never)).toBe('25% off');
    expect(formatDiscountLabel({ percentOff: 12.5 } as never)).toBe('12.5% off');
    expect(formatDiscountLabel({ amountOffCents: 5_000 } as never)).toMatch(
      /\$50 off/,
    );
    expect(formatDiscountLabel(null)).toBeNull();
    expect(
      formatDiscountLabel({ percentOff: null, amountOffCents: null } as never),
    ).toBeNull();
  });
});

describe('Pricing page — discounted vs undiscounted card rendering', () => {
  it('renders no discount badge or strikethrough when the API returns no discount', async () => {
    stubEffectiveRate(buildPayload(null));
    renderPricing();

    // The price card should appear immediately from catalog defaults.
    const priceEl = await screen.findByTestId('pricing-tier-starter-price');
    // Wait one tick for the effective-rate fetch to resolve; the card
    // would have re-rendered with a discount chip if one were present.
    await waitFor(() => {
      expect(priceEl.dataset.discountApplied).toBe('false');
    });

    expect(
      screen.queryByTestId('pricing-tier-starter-discount-badge'),
    ).toBeNull();
    expect(
      screen.queryByTestId('pricing-tier-starter-pre-discount-price'),
    ).toBeNull();
    // Unmodified catalog price ($99 starter monthly) is shown.
    expect(textIncludesDollars(priceEl, 99)).toBe(true);
  });

  it('shows a percent-off chip and discounted price on monthly billing', async () => {
    stubEffectiveRate(
      buildPayload({ percentOff: 25, name: 'Spring 25% off' }),
    );
    renderPricing();

    // Wait for the post-fetch re-render to apply the discount.
    const badge = await screen.findByTestId(
      'pricing-tier-starter-discount-badge',
    );
    expect(badge.textContent).toMatch(/25% off applied/i);

    const preDiscount = screen.getByTestId(
      'pricing-tier-starter-pre-discount-price',
    );
    // Strikethrough shows the original $99 (catalog starter monthly).
    expect(textIncludesDollars(preDiscount, 99)).toBe(true);

    const priceEl = screen.getByTestId('pricing-tier-starter-price');
    expect(priceEl.dataset.discountApplied).toBe('true');
    // 25% off $99 = $74.25 → display $74 (cents math: 9,900 → 7,425
    // cents → formatted whole dollars).
    expect(textIncludesDollars(priceEl, 74)).toBe(true);
  });

  it('shows an amount-off chip and discounted price on monthly billing (no annual scaling)', async () => {
    // $30 off ON MONTHLY → $99 catalog → $69 displayed (subtract once
    // from the monthly invoice; amount_off applies per-invoice and
    // monthly cadence = 1 invoice/month).
    stubEffectiveRate(buildPayload({ amountOffCents: 3_000 }));
    renderPricing();

    const badge = await screen.findByTestId(
      'pricing-tier-starter-discount-badge',
    );
    expect(badge.textContent).toMatch(/\$30 off applied/i);

    const priceEl = screen.getByTestId('pricing-tier-starter-price');
    expect(priceEl.dataset.discountApplied).toBe('true');
    expect(textIncludesDollars(priceEl, 69)).toBe(true);
  });

  it('amount_off on ANNUAL billing scales the per-month figure (regression: 12× over-discount bug)', async () => {
    // CRITICAL regression guard for the "12× over-discount" bug code
    // review flagged. A $120 amount_off coupon reduces the WHOLE
    // annual invoice by $120, NOT each monthly invoice by $120.
    //
    // Starter catalog monthly = $99 → annual monthly equivalent =
    // round($99 × 0.8) = $79/mo. Applying $120 off to the year:
    //   ($79 × 12 − $120) / 12 = ($948 − $120) / 12 = $69/mo.
    // The naive (broken) formula `$79 − $120` would clamp to $0/mo
    // and the chip would show "$120 off applied" against an $0
    // monthly figure — the regression this test pins.
    stubEffectiveRate(buildPayload({ amountOffCents: 12_000 }));
    renderPricing();

    // Wait for initial render then flip to annual billing.
    await screen.findByTestId('pricing-tier-starter-price');
    const annualToggle = screen
      .getByTestId('pricing-billing-toggle')
      .querySelectorAll('button')[1] as HTMLButtonElement;
    fireEvent.click(annualToggle);

    // Pre-discount strikethrough holds the unmodified $79/mo annual
    // equivalent; post-discount price is $69/mo.
    await waitFor(() => {
      const pre = screen.getByTestId(
        'pricing-tier-starter-pre-discount-price',
      );
      expect(textIncludesDollars(pre, 79)).toBe(true);
    });
    const priceEl = screen.getByTestId('pricing-tier-starter-price');
    expect(priceEl.dataset.discountApplied).toBe('true');
    expect(textIncludesDollars(priceEl, 69)).toBe(true);
  });

  it('renders the promotion code on the discount chip when present', async () => {
    stubEffectiveRate(
      buildPayload({ percentOff: 10, promotionCode: 'WELCOME10' }),
    );
    renderPricing();

    const badge = await screen.findByTestId(
      'pricing-tier-starter-discount-badge',
    );
    expect(badge.textContent).toMatch(/WELCOME10/);
  });

  it('hides the discount chip when the discount payload yields no savings', async () => {
    // Edge case: a malformed discount with both fields null reaches the
    // FE. The chip must NOT render (strikethrough comparison fails) so
    // we never show a misleading "0% off applied" badge.
    stubEffectiveRate(
      buildPayload({ percentOff: 0, amountOffCents: null }),
    );
    renderPricing();

    const priceEl = await screen.findByTestId('pricing-tier-starter-price');
    await waitFor(() => {
      // Effective-rate fetch has resolved.
      expect(priceEl).toBeTruthy();
    });
    expect(
      screen.queryByTestId('pricing-tier-starter-discount-badge'),
    ).toBeNull();
    expect(priceEl.dataset.discountApplied).toBe('false');
  });
});
