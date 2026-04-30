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
  // Per-tier metered AI-minutes prices are intentionally unset by default
  // so the existing test cases continue to assert the catalog-fallback
  // behavior for the overage. Tests that exercise the metered Stripe path
  // opt-in by setting the env var explicitly.
  delete process.env.STRIPE_PRICE_PRO_AI_MINUTES;
  delete process.env.STRIPE_PRICE_ENTERPRISE_AI_MINUTES;
  delete process.env.STRIPE_PRICE_STARTER_AI_MINUTES;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.STRIPE_PRICE_PRO_MONTHLY;
  delete process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY;
  delete process.env.STRIPE_PRICE_PRO_AI_MINUTES;
  delete process.env.STRIPE_PRICE_ENTERPRISE_AI_MINUTES;
  delete process.env.STRIPE_PRICE_STARTER_AI_MINUTES;
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
      // Unexpanded promotion_code arrives as a bare id string, so it
      // populates the forwardable id, not the human-readable label.
      promotionCode: null,
      promotionCodeId: 'promo_string_only',
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

describe('getTenantUpgradePreview — metered AI-minutes price override', () => {
  it('quotes the upgrade overage from the Stripe metered price (not the catalog) when STRIPE_PRICE_<TIER>_AI_MINUTES is configured', async () => {
    // Wire the per-tier metered price id the way ops would in production.
    process.env.STRIPE_PRICE_PRO_AI_MINUTES = 'price_pro_ai_minutes_metered';

    setSubRow({
      plan: 'starter',
      stripe_subscription_id: 'sub_starter',
      stripe_price_id: null,
      stripe_customer_id: 'cus_with_metered_pro',
    });

    // Route prices.retrieve calls by id so we can serve BOTH the licensed
    // base price AND the metered overage price in the same test — the
    // production code path now retrieves both. Sub-cent precision (the
    // whole reason we read `unit_amount_decimal`) is exercised here:
    // 7.5 cents/minute = $0.075, which must NOT round to $0.08.
    pricesRetrieve.mockImplementation(async (priceId: string) => {
      if (priceId === 'price_pro_monthly_published') {
        return {
          id: 'price_pro_monthly_published',
          unit_amount: 39_900,
          unit_amount_decimal: '39900',
          currency: 'usd',
          recurring: { usage_type: 'licensed', interval: 'month', interval_count: 1 },
          metadata: {},
        };
      }
      if (priceId === 'price_pro_ai_minutes_metered') {
        return {
          id: 'price_pro_ai_minutes_metered',
          unit_amount: null,
          unit_amount_decimal: '7.5', // $0.075/min — sub-cent, MUST NOT round
          currency: 'usd',
          recurring: {
            usage_type: 'metered',
            interval: 'month',
            interval_count: 1,
            meter: 'mtr_ai_min',
          },
          metadata: { metric: 'ai_minutes' },
        };
      }
      throw new Error(`unexpected prices.retrieve call: ${priceId}`);
    });

    customersRetrieve.mockResolvedValueOnce({
      id: 'cus_with_metered_pro',
      deleted: false,
      discount: null,
    });

    const result = await getTenantUpgradePreview(TENANT, 'pro');

    // The metered Stripe price was retrieved by the configured env-keyed id.
    expect(pricesRetrieve).toHaveBeenCalledWith('price_pro_ai_minutes_metered');
    // Overage now reflects the live Stripe rate ($0.075/min), NOT the
    // catalog default — and the precision survives intact (no cent-rounding).
    expect(result.overageRatePerMinute).toBeCloseTo(0.075, 6);
    expect(result.overageRatePerMinute).not.toBe(PLAN_CATALOG.pro.overageRatePerMinute);
    // Provenance breadcrumbs flip to `stripe` so the BillingEstimator can
    // render the "Live Stripe rate" badge on the upgrade card.
    expect(result.overagePriceSource).toBe('stripe');
    expect(result.overagePriceId).toBe('price_pro_ai_minutes_metered');
    // Base is also from Stripe → the whole quote is `stripe`-sourced now.
    expect(result.basePriceSource).toBe('stripe');
    expect(result.source).toBe('stripe');
    // No discount means the base stays at the published Stripe value.
    expect(result.basePriceCents).toBe(39_900);
    expect(result.discount).toBeNull();
  });

  it('applies a percent-off customer discount on top of the Stripe-sourced metered overage', async () => {
    process.env.STRIPE_PRICE_PRO_AI_MINUTES = 'price_pro_ai_minutes_metered';

    setSubRow({
      plan: 'starter',
      stripe_subscription_id: 'sub_starter',
      stripe_price_id: null,
      stripe_customer_id: 'cus_metered_with_discount',
    });

    pricesRetrieve.mockImplementation(async (priceId: string) => {
      if (priceId === 'price_pro_monthly_published') {
        return {
          id: 'price_pro_monthly_published',
          unit_amount: 39_900,
          unit_amount_decimal: '39900',
          currency: 'usd',
          recurring: { usage_type: 'licensed', interval: 'month' },
          metadata: {},
        };
      }
      if (priceId === 'price_pro_ai_minutes_metered') {
        return {
          id: 'price_pro_ai_minutes_metered',
          unit_amount: 10, // $0.10/min metered Stripe rate
          unit_amount_decimal: '10',
          currency: 'usd',
          recurring: { usage_type: 'metered', interval: 'month' },
          metadata: { metric: 'ai_minutes' },
        };
      }
      throw new Error(`unexpected prices.retrieve call: ${priceId}`);
    });

    customersRetrieve.mockResolvedValueOnce({
      id: 'cus_metered_with_discount',
      deleted: false,
      discount: {
        coupon: {
          id: 'coupon_20',
          percent_off: 20,
          valid: true,
        },
      },
    });

    const result = await getTenantUpgradePreview(TENANT, 'pro');

    // Stripe metered rate ($0.10/min) - 20% = $0.08/min.
    expect(result.overageRatePerMinute).toBeCloseTo(0.08, 6);
    expect(result.overagePriceSource).toBe('stripe');
    expect(result.overagePriceId).toBe('price_pro_ai_minutes_metered');
  });

  it('rejects a non-metered price wired into STRIPE_PRICE_<TIER>_AI_MINUTES and falls back to catalog (guards against operator misconfiguration)', async () => {
    // Operator points the AI minutes env var at a *licensed* monthly
    // price by mistake. Without the metered guard we'd quote $399/min
    // — instead the function must ignore it and fall back to catalog.
    process.env.STRIPE_PRICE_PRO_AI_MINUTES = 'price_oops_licensed';

    setSubRow({
      plan: 'starter',
      stripe_subscription_id: 'sub_starter',
      stripe_price_id: null,
      stripe_customer_id: 'cus_misconfigured',
    });

    pricesRetrieve.mockImplementation(async (priceId: string) => {
      if (priceId === 'price_pro_monthly_published') {
        return {
          id: 'price_pro_monthly_published',
          unit_amount: 39_900,
          unit_amount_decimal: '39900',
          currency: 'usd',
          recurring: { usage_type: 'licensed', interval: 'month' },
          metadata: {},
        };
      }
      if (priceId === 'price_oops_licensed') {
        // The wrong-shape price: a recurring LICENSED line, NOT metered.
        return {
          id: 'price_oops_licensed',
          unit_amount: 39_900, // Would be $399/min if naively trusted
          unit_amount_decimal: '39900',
          currency: 'usd',
          recurring: { usage_type: 'licensed', interval: 'month' },
          metadata: {},
        };
      }
      throw new Error(`unexpected prices.retrieve call: ${priceId}`);
    });

    customersRetrieve.mockResolvedValueOnce({
      id: 'cus_misconfigured',
      deleted: false,
      discount: null,
    });

    const result = await getTenantUpgradePreview(TENANT, 'pro');

    // The guard kicked in: we did NOT quote $399/min from the licensed
    // price — overage stays at the catalog Pro rate.
    expect(result.overageRatePerMinute).toBe(PLAN_CATALOG.pro.overageRatePerMinute);
    expect(result.overagePriceSource).toBe('catalog');
    expect(result.overagePriceId).toBeNull();
    // Base still came from the (correctly configured) Stripe monthly
    // price, but the metered lookup attempted+failed, so source = 'mixed'.
    expect(result.basePriceSource).toBe('stripe');
    expect(result.source).toBe('mixed');
  });

  it('falls back to the catalog overage rate when the metered price retrieval throws, and marks the source as mixed', async () => {
    process.env.STRIPE_PRICE_PRO_AI_MINUTES = 'price_pro_ai_minutes_metered';

    setSubRow({
      plan: 'starter',
      stripe_subscription_id: 'sub_starter',
      stripe_price_id: null,
      stripe_customer_id: 'cus_metered_503',
    });

    pricesRetrieve.mockImplementation(async (priceId: string) => {
      if (priceId === 'price_pro_monthly_published') {
        return {
          id: 'price_pro_monthly_published',
          unit_amount: 39_900,
          unit_amount_decimal: '39900',
          currency: 'usd',
          recurring: { usage_type: 'licensed', interval: 'month' },
          metadata: {},
        };
      }
      if (priceId === 'price_pro_ai_minutes_metered') {
        throw new Error('Stripe 503');
      }
      throw new Error(`unexpected prices.retrieve call: ${priceId}`);
    });

    customersRetrieve.mockResolvedValueOnce({
      id: 'cus_metered_503',
      deleted: false,
      discount: null,
    });

    const result = await getTenantUpgradePreview(TENANT, 'pro');

    // Overage falls back to the catalog default for the target tier.
    expect(result.overageRatePerMinute).toBe(PLAN_CATALOG.pro.overageRatePerMinute);
    expect(result.overagePriceSource).toBe('catalog');
    expect(result.overagePriceId).toBeNull();
    // Base still came from Stripe, but overage failed → mixed (not stripe).
    expect(result.basePriceSource).toBe('stripe');
    expect(result.source).toBe('mixed');
  });
});
