/**
 * Unit coverage for `platform/billing/stripe/verifyPrices.ts` — the shared
 * verifier that powers both the `npm run verify:stripe-prices` deploy gate
 * and the in-app "Billing config health" admin tile.
 *
 * The contract these tests protect:
 *   1. With no `STRIPE_SECRET_KEY` the verifier short-circuits with a
 *      `no-stripe-key` summary instead of throwing — that's what lets the
 *      admin tile render a clear "not configured" state in dev.
 *   2. A correctly-wired set of monthly + annual prices passes (status
 *      `ok`, summary `ok`, `monthlyEquivalentCents` divides annual by 12).
 *   3. A wrong-interval wiring (e.g. `_ANNUAL` env pointed at a `month`
 *      Stripe price) is reported as `wrong-interval` and the summary fails
 *      — the exact failure mode the deploy gate is supposed to catch.
 *   4. A missing env var is reported as `missing-env` without ever calling
 *      Stripe.
 *   5. A Stripe error (deleted price, network failure) is reported as
 *      `stripe-error` so the gate fails closed instead of silently passing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const retrieveMock = vi.fn();

vi.mock('stripe', () => {
  class StripeMock {
    prices = { retrieve: retrieveMock };
    constructor(_apiKey: string, _opts?: unknown) {}
  }
  return { default: StripeMock };
});

import { verifyStripePrices } from '../../platform/billing/stripe/verifyPrices';

const PRICE_ENV_KEYS = [
  'STRIPE_PRICE_STARTER_MONTHLY',
  'STRIPE_PRICE_STARTER_ANNUAL',
  'STRIPE_PRICE_PRO_MONTHLY',
  'STRIPE_PRICE_PRO_ANNUAL',
  'STRIPE_PRICE_ENTERPRISE_MONTHLY',
  'STRIPE_PRICE_ENTERPRISE_ANNUAL',
] as const;

const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const key of [...PRICE_ENV_KEYS, 'STRIPE_SECRET_KEY']) {
  ORIGINAL_ENV[key] = process.env[key];
}

beforeEach(() => {
  retrieveMock.mockReset();
  for (const key of [...PRICE_ENV_KEYS, 'STRIPE_SECRET_KEY']) {
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

function setPriceEnvVars(): void {
  process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_starter_m';
  process.env.STRIPE_PRICE_STARTER_ANNUAL = 'price_starter_a';
  process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_m';
  process.env.STRIPE_PRICE_PRO_ANNUAL = 'price_pro_a';
  process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY = 'price_enterprise_m';
  process.env.STRIPE_PRICE_ENTERPRISE_ANNUAL = 'price_enterprise_a';
}

function makePrice(interval: 'month' | 'year', unitAmount: number) {
  return {
    id: 'price_x',
    recurring: { interval, interval_count: 1 },
    unit_amount: unitAmount,
  };
}

describe('verifyStripePrices', () => {
  it('returns no-stripe-key when STRIPE_SECRET_KEY is unset', async () => {
    setPriceEnvVars();
    const report = await verifyStripePrices();
    expect(report.summary.status).toBe('no-stripe-key');
    expect(report.summary.total).toBe(0);
    expect(report.results).toHaveLength(0);
    expect(retrieveMock).not.toHaveBeenCalled();
  });

  it('passes when every price is wired to the right interval', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    setPriceEnvVars();
    retrieveMock.mockImplementation(async (priceId: string) => {
      const isAnnual = priceId.endsWith('_a');
      return makePrice(isAnnual ? 'year' : 'month', isAnnual ? 1_200_00 : 100_00);
    });

    const report = await verifyStripePrices();
    expect(report.summary.status).toBe('ok');
    expect(report.summary.total).toBe(6);
    expect(report.summary.ok).toBe(6);
    expect(report.summary.failed).toBe(0);

    const annual = report.results.find((r) => r.envKey === 'STRIPE_PRICE_PRO_ANNUAL');
    expect(annual?.status).toBe('ok');
    expect(annual?.actualInterval).toBe('year');
    // 1_200_00 / 12 = 10_000 cents/month (annual ÷ 12)
    expect(annual?.monthlyEquivalentCents).toBe(10_000);

    const monthly = report.results.find((r) => r.envKey === 'STRIPE_PRICE_STARTER_MONTHLY');
    expect(monthly?.monthlyEquivalentCents).toBe(100_00);
  });

  it('fails when an _ANNUAL env points at a month-interval Stripe price', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    setPriceEnvVars();
    retrieveMock.mockImplementation(async (priceId: string) => {
      // Bug: someone wired STRIPE_PRICE_PRO_ANNUAL to a monthly Stripe price.
      if (priceId === 'price_pro_a') return makePrice('month', 100_00);
      const isAnnual = priceId.endsWith('_a');
      return makePrice(isAnnual ? 'year' : 'month', isAnnual ? 1_200_00 : 100_00);
    });

    const report = await verifyStripePrices();
    expect(report.summary.status).toBe('failed');
    expect(report.summary.failed).toBe(1);
    const broken = report.results.find((r) => r.envKey === 'STRIPE_PRICE_PRO_ANNUAL');
    expect(broken?.status).toBe('wrong-interval');
    expect(broken?.actualInterval).toBe('month');
    expect(broken?.message).toMatch(/expected year/);
  });

  it('reports missing-env without calling Stripe when an env var is unset', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    setPriceEnvVars();
    delete process.env.STRIPE_PRICE_ENTERPRISE_ANNUAL;

    retrieveMock.mockImplementation(async (priceId: string) => {
      const isAnnual = priceId.endsWith('_a');
      return makePrice(isAnnual ? 'year' : 'month', isAnnual ? 1_200_00 : 100_00);
    });

    const report = await verifyStripePrices();
    expect(report.summary.status).toBe('failed');
    const missing = report.results.find((r) => r.envKey === 'STRIPE_PRICE_ENTERPRISE_ANNUAL');
    expect(missing?.status).toBe('missing-env');
    expect(missing?.priceId).toBeNull();
    // Stripe should never be called for the unset env var.
    const callsForMissing = retrieveMock.mock.calls.filter(
      (c) => c[0] === 'price_enterprise_a',
    );
    expect(callsForMissing).toHaveLength(0);
  });

  it('reports stripe-error when Stripe throws (e.g. deleted price)', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    setPriceEnvVars();
    retrieveMock.mockImplementation(async (priceId: string) => {
      if (priceId === 'price_starter_m') {
        throw new Error('No such price: price_starter_m');
      }
      const isAnnual = priceId.endsWith('_a');
      return makePrice(isAnnual ? 'year' : 'month', isAnnual ? 1_200_00 : 100_00);
    });

    const report = await verifyStripePrices();
    expect(report.summary.status).toBe('failed');
    const broken = report.results.find((r) => r.envKey === 'STRIPE_PRICE_STARTER_MONTHLY');
    expect(broken?.status).toBe('stripe-error');
    expect(broken?.message).toMatch(/No such price/);
  });

  it('flags prices with no unit_amount as no-amount', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_dummy';
    setPriceEnvVars();
    retrieveMock.mockImplementation(async (priceId: string) => {
      if (priceId === 'price_pro_m') {
        return { id: priceId, recurring: { interval: 'month', interval_count: 1 }, unit_amount: null };
      }
      const isAnnual = priceId.endsWith('_a');
      return makePrice(isAnnual ? 'year' : 'month', isAnnual ? 1_200_00 : 100_00);
    });

    const report = await verifyStripePrices();
    expect(report.summary.status).toBe('failed');
    const broken = report.results.find((r) => r.envKey === 'STRIPE_PRICE_PRO_MONTHLY');
    expect(broken?.status).toBe('no-amount');
    expect(broken?.unitAmountCents).toBeNull();
  });
});
