/**
 * Unit coverage for `getTenantUpgradePreview` in
 * `platform/billing/stripe/effectiveRate.ts`. The function powers
 * `GET /billing/upgrade-preview` and the BillingEstimator's "Next tier
 * up" card — its contract is that any active customer-level discount
 * (coupon or promotion code attached to the tenant's Stripe customer
 * record) wins over the published `PLAN_CATALOG` price for the upgrade
 * tier, while every degraded path (no customer, no Stripe key, retrieval
 * throws, expired coupon…) silently falls back to catalog defaults so
 * the comparison card never renders NaN.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type QueryHandler = (
  sql: string,
  values?: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

let queryHandler: QueryHandler = async () => ({ rows: [] });
const customersRetrieve = vi.fn();
const pricesRetrieve = vi.fn();
const subscriptionsRetrieve = vi.fn();
let stripeClientShouldThrow = false;

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({
    connect: async () => ({
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        const trimmed = sql.trimStart();
        if (
          trimmed.startsWith('BEGIN')
          || trimmed.startsWith('COMMIT')
          || trimmed.startsWith('ROLLBACK')
        ) {
          return { rows: [] };
        }
        return queryHandler(sql, values);
      }),
      release: vi.fn(),
    }),
  }),
  withTenantContext: vi.fn(async () => undefined),
}));

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('../../platform/billing/stripe/client', () => ({
  getStripeClient: () => {
    if (stripeClientShouldThrow) {
      throw new Error('STRIPE_SECRET_KEY is not configured.');
    }
    return {
      customers: { retrieve: customersRetrieve },
      prices: { retrieve: pricesRetrieve },
      subscriptions: { retrieve: subscriptionsRetrieve },
    };
  },
}));

import { getTenantUpgradePreview } from '../../platform/billing/stripe/effectiveRate';
import { PLAN_CATALOG } from '../../shared/billing/planCatalog';

const TENANT = 'tenant-upgrade-preview';

interface SubRow {
  plan?: string | null;
  stripe_subscription_id?: string | null;
  stripe_price_id?: string | null;
  stripe_customer_id?: string | null;
}

function setSubRow(row: SubRow | null) {
  queryHandler = async (sql: string) => {
    const trimmed = sql.trimStart();
    if (trimmed.startsWith('SELECT plan, stripe_subscription_id')) {
      return { rows: row ? [row as Record<string, unknown>] : [] };
    }
    return { rows: [] };
  };
}

beforeEach(() => {
  customersRetrieve.mockReset();
  pricesRetrieve.mockReset();
  subscriptionsRetrieve.mockReset();
  stripeClientShouldThrow = false;
  queryHandler = async () => ({ rows: [] });
  process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly_published';
  process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY = 'price_ent_monthly_published';
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.STRIPE_PRICE_PRO_MONTHLY;
  delete process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY;
});

describe('getTenantUpgradePreview — Stripe customer discount overrides', () => {
  it('quotes the Pro upgrade at the discounted price when the customer has an active percent-off coupon', async () => {
    setSubRow({
      plan: 'starter',
      stripe_subscription_id: 'sub_starter',
      stripe_price_id: 'price_starter_base',
      stripe_customer_id: 'cus_with_discount',
    });
    pricesRetrieve.mockResolvedValueOnce({
      id: 'price_pro_monthly_published',
      unit_amount: 39_900,
      unit_amount_decimal: '39900',
      currency: 'usd',
      recurring: { usage_type: 'licensed', interval: 'month', interval_count: 1 },
      metadata: {},
    });
    customersRetrieve.mockResolvedValueOnce({
      id: 'cus_with_discount',
      deleted: false,
      currency: 'usd',
      discount: {
        coupon: {
          id: 'coupon_pro_25',
          name: 'Sales 25% off',
          percent_off: 25,
          amount_off: null,
          currency: null,
          valid: true,
        },
        promotion_code: { id: 'promo_pro_25', code: 'PROMO25', active: true },
      },
    });

    const result = await getTenantUpgradePreview(TENANT, 'pro');

    // The customer was looked up with the promotion code expanded so the
    // human-readable code makes it back to the UI.
    expect(customersRetrieve).toHaveBeenCalledWith(
      'cus_with_discount',
      { expand: ['discount.promotion_code'] },
    );
    // Catalog list is $399; 25% off → $299.25 → 29 925 cents.
    expect(result.basePriceCents).toBe(29_925);
    // The discount must beat the published catalog price.
    expect(result.basePriceCents).toBeLessThan(PLAN_CATALOG.pro.monthlyPriceCents);
    // percent_off applies to overages too — Pro catalog is $0.12/min,
    // 25% off → $0.09/min.
    expect(result.overageRatePerMinute).toBeCloseTo(0.09, 6);
    expect(result.overageRatePerMinute).toBeLessThan(
      PLAN_CATALOG.pro.overageRatePerMinute,
    );
    expect(result.plan).toBe('pro');
    expect(result.basePriceSource).toBe('stripe');
    expect(result.basePriceId).toBe('price_pro_monthly_published');
    expect(result.source).toBe('stripe');
    expect(result.discount).toMatchObject({
      couponId: 'coupon_pro_25',
      name: 'Sales 25% off',
      percentOff: 25,
      amountOffCents: null,
      promotionCode: 'PROMO25',
    });
  });

  it('subtracts a flat amount_off coupon from the published base but leaves the metered rate alone', async () => {
    setSubRow({
      plan: 'starter',
      stripe_subscription_id: 'sub_starter',
      stripe_price_id: null,
      stripe_customer_id: 'cus_amount_off',
    });
    pricesRetrieve.mockResolvedValueOnce({
      id: 'price_pro_monthly_published',
      unit_amount: 39_900,
      unit_amount_decimal: '39900',
      currency: 'usd',
      recurring: { usage_type: 'licensed', interval: 'month' },
      metadata: {},
    });
    customersRetrieve.mockResolvedValueOnce({
      id: 'cus_amount_off',
      deleted: false,
      discount: {
        coupon: {
          id: 'coupon_50_off',
          name: '$50 off promo',
          percent_off: null,
          amount_off: 5_000, // $50.00
          currency: 'usd',
          valid: true,
        },
        promotion_code: 'promo_string_only',
      },
    });

    const result = await getTenantUpgradePreview(TENANT, 'pro');

    // $399 published → $349 after $50 amount_off coupon.
    expect(result.basePriceCents).toBe(34_900);
    // amount_off is a flat invoice credit — overage stays at catalog Pro.
    expect(result.overageRatePerMinute).toBe(PLAN_CATALOG.pro.overageRatePerMinute);
    expect(result.discount).toMatchObject({
      couponId: 'coupon_50_off',
      amountOffCents: 5_000,
      percentOff: null,
      promotionCode: 'promo_string_only',
    });
  });

  it('uses the published Stripe price even when the customer has no discount', async () => {
    setSubRow({
      plan: 'starter',
      stripe_subscription_id: 'sub_no_discount',
      stripe_price_id: null,
      stripe_customer_id: 'cus_no_discount',
    });
    pricesRetrieve.mockResolvedValueOnce({
      id: 'price_pro_monthly_published',
      unit_amount: 35_000, // Custom-priced Pro: $350 (not the catalog $399)
      unit_amount_decimal: '35000',
      currency: 'usd',
      recurring: { usage_type: 'licensed', interval: 'month' },
      metadata: {},
    });
    customersRetrieve.mockResolvedValueOnce({
      id: 'cus_no_discount',
      deleted: false,
      discount: null,
    });

    const result = await getTenantUpgradePreview(TENANT, 'pro');

    // Stripe's published price (35 000c) overrides catalog (39 900c)
    // even when there's no discount.
    expect(result.basePriceCents).toBe(35_000);
    expect(result.basePriceSource).toBe('stripe');
    expect(result.discount).toBeNull();
    expect(result.source).toBe('stripe');
  });

  it('clamps to zero if a discount is larger than the base price', async () => {
    setSubRow({
      plan: 'starter',
      stripe_subscription_id: 'sub_huge_discount',
      stripe_price_id: null,
      stripe_customer_id: 'cus_huge_discount',
    });
    pricesRetrieve.mockResolvedValueOnce({
      id: 'price_pro_monthly_published',
      unit_amount: 10_000, // $100 base
      unit_amount_decimal: '10000',
      currency: 'usd',
      recurring: { usage_type: 'licensed', interval: 'month' },
      metadata: {},
    });
    customersRetrieve.mockResolvedValueOnce({
      id: 'cus_huge_discount',
      discount: {
        coupon: {
          id: 'coupon_huge',
          amount_off: 25_000, // $250 off — bigger than the base
          currency: 'usd',
          valid: true,
        },
      },
    });

    const result = await getTenantUpgradePreview(TENANT, 'pro');

    expect(result.basePriceCents).toBe(0);
  });
});

describe('getTenantUpgradePreview — graceful degradation', () => {
  it('returns catalog defaults when the Stripe client cannot be constructed', async () => {
    setSubRow({
      plan: 'starter',
      stripe_subscription_id: 'sub_starter',
      stripe_price_id: null,
      stripe_customer_id: 'cus_x',
    });
    stripeClientShouldThrow = true;

    const result = await getTenantUpgradePreview(TENANT, 'pro');

    expect(pricesRetrieve).not.toHaveBeenCalled();
    expect(customersRetrieve).not.toHaveBeenCalled();
    expect(result.basePriceCents).toBe(PLAN_CATALOG.pro.monthlyPriceCents);
    expect(result.overageRatePerMinute).toBe(PLAN_CATALOG.pro.overageRatePerMinute);
    expect(result.source).toBe('catalog');
    expect(result.discount).toBeNull();
  });

  it('falls back to the catalog when prices.retrieve fails but still applies any discount it can read off the customer', async () => {
    setSubRow({
      plan: 'starter',
      stripe_subscription_id: 'sub_starter',
      stripe_price_id: null,
      stripe_customer_id: 'cus_resilient',
    });
    pricesRetrieve.mockRejectedValueOnce(new Error('Stripe 503'));
    customersRetrieve.mockResolvedValueOnce({
      id: 'cus_resilient',
      discount: {
        coupon: {
          id: 'coupon_10',
          percent_off: 10,
          valid: true,
        },
      },
    });

    const result = await getTenantUpgradePreview(TENANT, 'pro');

    // 10% off the catalog Pro base ($399 → $359.10 → 35 910c).
    expect(result.basePriceCents).toBe(35_910);
    expect(result.basePriceSource).toBe('catalog');
    // Mixed: catalog base + stripe-discount overlay.
    expect(result.source).toBe('mixed');
    expect(result.discount?.percentOff).toBe(10);
  });

  it('ignores invalidated coupons (valid === false)', async () => {
    setSubRow({
      plan: 'starter',
      stripe_subscription_id: 'sub_starter',
      stripe_price_id: null,
      stripe_customer_id: 'cus_invalid_coupon',
    });
    pricesRetrieve.mockResolvedValueOnce({
      id: 'price_pro_monthly_published',
      unit_amount: 39_900,
      unit_amount_decimal: '39900',
      currency: 'usd',
      recurring: { usage_type: 'licensed', interval: 'month' },
      metadata: {},
    });
    customersRetrieve.mockResolvedValueOnce({
      id: 'cus_invalid_coupon',
      discount: {
        coupon: {
          id: 'coupon_expired',
          percent_off: 50,
          valid: false,
        },
      },
    });

    const result = await getTenantUpgradePreview(TENANT, 'pro');

    expect(result.basePriceCents).toBe(39_900);
    expect(result.discount).toBeNull();
  });

  it('ignores discounts whose end date has already passed', async () => {
    setSubRow({
      plan: 'starter',
      stripe_subscription_id: 'sub_starter',
      stripe_price_id: null,
      stripe_customer_id: 'cus_expired_discount',
    });
    pricesRetrieve.mockResolvedValueOnce({
      id: 'price_pro_monthly_published',
      unit_amount: 39_900,
      unit_amount_decimal: '39900',
      currency: 'usd',
      recurring: { usage_type: 'licensed', interval: 'month' },
      metadata: {},
    });
    customersRetrieve.mockResolvedValueOnce({
      id: 'cus_expired_discount',
      discount: {
        coupon: {
          id: 'coupon_was_valid',
          percent_off: 30,
          valid: true,
        },
        // Unix seconds — set well in the past so the discount is stale.
        end: Math.floor(Date.now() / 1000) - 60 * 60,
      },
    });

    const result = await getTenantUpgradePreview(TENANT, 'pro');

    expect(result.basePriceCents).toBe(39_900);
    expect(result.discount).toBeNull();
  });

  it('treats deleted Stripe customers as if there were no discount', async () => {
    setSubRow({
      plan: 'starter',
      stripe_subscription_id: 'sub_starter',
      stripe_price_id: null,
      stripe_customer_id: 'cus_deleted',
    });
    pricesRetrieve.mockResolvedValueOnce({
      id: 'price_pro_monthly_published',
      unit_amount: 39_900,
      unit_amount_decimal: '39900',
      currency: 'usd',
      recurring: { usage_type: 'licensed', interval: 'month' },
      metadata: {},
    });
    customersRetrieve.mockResolvedValueOnce({
      id: 'cus_deleted',
      deleted: true,
    });

    const result = await getTenantUpgradePreview(TENANT, 'pro');

    expect(result.basePriceCents).toBe(39_900);
    expect(result.discount).toBeNull();
  });

  it('falls back to the catalog when the published price env var is unset', async () => {
    delete process.env.STRIPE_PRICE_PRO_MONTHLY;
    setSubRow({
      plan: 'starter',
      stripe_subscription_id: 'sub_starter',
      stripe_price_id: null,
      stripe_customer_id: 'cus_no_env',
    });
    customersRetrieve.mockResolvedValueOnce({
      id: 'cus_no_env',
      discount: null,
    });

    const result = await getTenantUpgradePreview(TENANT, 'pro');

    expect(pricesRetrieve).not.toHaveBeenCalled();
    expect(result.basePriceCents).toBe(PLAN_CATALOG.pro.monthlyPriceCents);
    expect(result.basePriceSource).toBe('catalog');
    expect(result.source).toBe('catalog');
  });
});
