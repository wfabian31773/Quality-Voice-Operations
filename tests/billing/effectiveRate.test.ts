/**
 * Unit coverage for `getTenantEffectiveRate` in
 * `platform/billing/stripe/effectiveRate.ts`. The function powers
 * `GET /billing/effective-rate` and the BillingEstimator override path —
 * its contract is that the live Stripe `unit_amount` always wins over
 * the static `PLAN_CATALOG`, while every degraded path (no subscription,
 * no Stripe key, no metered item, retrieval throws…) silently falls
 * back to catalog defaults so the estimator never renders NaN.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type QueryHandler = (
  sql: string,
  values?: unknown[],
) => Promise<{ rows: Array<Record<string, unknown>> }>;

let queryHandler: QueryHandler = async () => ({ rows: [] });
const subscriptionsRetrieve = vi.fn();
const pricesRetrieve = vi.fn();
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
      subscriptions: {
        retrieve: subscriptionsRetrieve,
      },
      prices: {
        retrieve: pricesRetrieve,
      },
    };
  },
}));

import { getTenantEffectiveRate } from '../../platform/billing/stripe/effectiveRate';
import { PLAN_CATALOG } from '../../shared/billing/planCatalog';

const TENANT = 'tenant-eff-rate';

interface SubRow {
  plan?: string | null;
  stripe_subscription_id?: string | null;
  stripe_price_id?: string | null;
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
  subscriptionsRetrieve.mockReset();
  pricesRetrieve.mockReset();
  stripeClientShouldThrow = false;
  queryHandler = async () => ({ rows: [] });
  delete process.env.STRIPE_METER_AI_MINUTES;
  delete process.env.STRIPE_PRICE_STARTER_MONTHLY;
  delete process.env.STRIPE_PRICE_STARTER_ANNUAL;
  delete process.env.STRIPE_PRICE_PRO_MONTHLY;
  delete process.env.STRIPE_PRICE_PRO_ANNUAL;
  delete process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY;
  delete process.env.STRIPE_PRICE_ENTERPRISE_ANNUAL;
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.STRIPE_PRICE_STARTER_MONTHLY;
  delete process.env.STRIPE_PRICE_STARTER_ANNUAL;
  delete process.env.STRIPE_PRICE_PRO_MONTHLY;
  delete process.env.STRIPE_PRICE_PRO_ANNUAL;
  delete process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY;
  delete process.env.STRIPE_PRICE_ENTERPRISE_ANNUAL;
});

describe('getTenantEffectiveRate — Stripe subscription overrides', () => {
  it('overrides catalog with the metered AI-minutes price unit_amount', async () => {
    setSubRow({
      plan: 'pro',
      stripe_subscription_id: 'sub_negotiated',
      stripe_price_id: 'price_pro_base',
    });
    subscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          {
            price: {
              id: 'price_pro_base',
              unit_amount: 29_900, // $299/mo (10% negotiated discount off catalog)
              unit_amount_decimal: '29900',
              currency: 'usd',
              recurring: { usage_type: 'licensed', interval: 'month', interval_count: 1 },
              metadata: {},
            },
          },
          {
            price: {
              id: 'price_ai_minutes_custom',
              unit_amount: 9, // $0.09/min
              unit_amount_decimal: '9',
              currency: 'usd',
              recurring: { usage_type: 'metered', interval: 'month', interval_count: 1 },
              metadata: { metric: 'ai_minutes' },
            },
          },
        ],
      },
    });

    const result = await getTenantEffectiveRate(TENANT);

    expect(subscriptionsRetrieve).toHaveBeenCalledWith(
      'sub_negotiated',
      { expand: ['items.data.price'] },
    );
    expect(result).toMatchObject({
      plan: 'pro',
      basePriceCents: 29_900,
      overageRatePerMinute: 0.09,
      currency: 'usd',
      source: 'stripe',
      basePriceSource: 'stripe',
      overagePriceSource: 'stripe',
      basePriceId: 'price_pro_base',
      overagePriceId: 'price_ai_minutes_custom',
    });
    // Stripe override must beat the published catalog rate (Pro = $0.12/min).
    expect(result.overageRatePerMinute).not.toBe(PLAN_CATALOG.pro.overageRatePerMinute);
    expect(result.basePriceCents).not.toBe(PLAN_CATALOG.pro.monthlyPriceCents);
  });

  it('preserves sub-cent metered pricing via unit_amount_decimal', async () => {
    setSubRow({
      plan: 'pro',
      stripe_subscription_id: 'sub_subcent',
      stripe_price_id: null,
    });
    subscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          {
            price: {
              id: 'price_metered_subcent',
              unit_amount: 8, // would lossily round 7.5 → 8
              unit_amount_decimal: '7.5',
              currency: 'usd',
              recurring: { usage_type: 'metered', interval: 'month' },
              metadata: { metric: 'ai_minutes' },
            },
          },
        ],
      },
    });

    const result = await getTenantEffectiveRate(TENANT);

    // 7.5 cents per minute = $0.075/min — must NOT be rounded to $0.08.
    expect(result.overageRatePerMinute).toBeCloseTo(0.075, 6);
    expect(result.overagePriceSource).toBe('stripe');
  });

  it('matches the AI-minutes meter via STRIPE_METER_AI_MINUTES env when metadata is absent', async () => {
    process.env.STRIPE_METER_AI_MINUTES = 'mtr_ai_min';
    setSubRow({
      plan: 'starter',
      stripe_subscription_id: 'sub_meter_match',
      stripe_price_id: null,
    });
    subscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          // Generic metered line we want to AVOID picking — different meter.
          {
            price: {
              id: 'price_other_meter',
              unit_amount: 5,
              unit_amount_decimal: '5',
              currency: 'usd',
              recurring: { usage_type: 'metered', interval: 'month', meter: 'mtr_calls' },
              metadata: {},
            },
          },
          {
            price: {
              id: 'price_ai_min_via_meter',
              unit_amount: 11,
              unit_amount_decimal: '11',
              currency: 'usd',
              recurring: { usage_type: 'metered', interval: 'month', meter: 'mtr_ai_min' },
              metadata: {},
            },
          },
        ],
      },
    });

    const result = await getTenantEffectiveRate(TENANT);

    expect(result.overagePriceId).toBe('price_ai_min_via_meter');
    expect(result.overageRatePerMinute).toBeCloseTo(0.11, 6);
  });

  it('normalizes annual base prices into a monthly equivalent', async () => {
    setSubRow({
      plan: 'enterprise',
      stripe_subscription_id: 'sub_annual',
      stripe_price_id: null,
    });
    subscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          {
            price: {
              id: 'price_enterprise_annual',
              unit_amount: 1_200_000, // $12,000/yr
              unit_amount_decimal: '1200000',
              currency: 'usd',
              recurring: { usage_type: 'licensed', interval: 'year', interval_count: 1 },
              metadata: {},
            },
          },
        ],
      },
    });

    const result = await getTenantEffectiveRate(TENANT);

    // $12,000 / 12 = $1,000/mo equivalent → 100,000 cents.
    expect(result.basePriceCents).toBe(100_000);
    expect(result.basePriceSource).toBe('stripe');
    // No metered item → overage falls back to catalog (Enterprise).
    expect(result.overageRatePerMinute).toBe(PLAN_CATALOG.enterprise.overageRatePerMinute);
    expect(result.source).toBe('mixed');
  });
});

describe('getTenantEffectiveRate — catalog fallback', () => {
  it('returns catalog defaults when there is no subscription row', async () => {
    setSubRow(null);

    const result = await getTenantEffectiveRate(TENANT);

    expect(subscriptionsRetrieve).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      plan: 'starter',
      basePriceCents: PLAN_CATALOG.starter.monthlyPriceCents,
      overageRatePerMinute: PLAN_CATALOG.starter.overageRatePerMinute,
      source: 'catalog',
      basePriceSource: 'catalog',
      overagePriceSource: 'catalog',
    });
  });

  it('returns catalog defaults when the tenant row has no Stripe subscription id', async () => {
    setSubRow({ plan: 'pro', stripe_subscription_id: null, stripe_price_id: null });

    const result = await getTenantEffectiveRate(TENANT);

    expect(subscriptionsRetrieve).not.toHaveBeenCalled();
    expect(result.plan).toBe('pro');
    expect(result.basePriceCents).toBe(PLAN_CATALOG.pro.monthlyPriceCents);
    expect(result.overageRatePerMinute).toBe(PLAN_CATALOG.pro.overageRatePerMinute);
    expect(result.source).toBe('catalog');
  });

  it('returns catalog defaults when the Stripe client cannot be constructed (no API key)', async () => {
    setSubRow({ plan: 'pro', stripe_subscription_id: 'sub_x', stripe_price_id: null });
    stripeClientShouldThrow = true;

    const result = await getTenantEffectiveRate(TENANT);

    expect(subscriptionsRetrieve).not.toHaveBeenCalled();
    expect(result.source).toBe('catalog');
    expect(result.basePriceCents).toBe(PLAN_CATALOG.pro.monthlyPriceCents);
  });

  it('returns catalog defaults when Stripe.subscriptions.retrieve throws', async () => {
    setSubRow({ plan: 'enterprise', stripe_subscription_id: 'sub_err', stripe_price_id: null });
    subscriptionsRetrieve.mockRejectedValueOnce(new Error('Stripe 503'));

    const result = await getTenantEffectiveRate(TENANT);

    expect(result.source).toBe('catalog');
    expect(result.plan).toBe('enterprise');
    expect(result.overageRatePerMinute).toBe(PLAN_CATALOG.enterprise.overageRatePerMinute);
  });

  it('returns catalog defaults when the subscription has no items', async () => {
    setSubRow({ plan: 'pro', stripe_subscription_id: 'sub_empty', stripe_price_id: null });
    subscriptionsRetrieve.mockResolvedValueOnce({ items: { data: [] } });

    const result = await getTenantEffectiveRate(TENANT);

    expect(result.source).toBe('catalog');
    expect(result.basePriceCents).toBe(PLAN_CATALOG.pro.monthlyPriceCents);
  });

  it('only overrides the field it can resolve (mixed source)', async () => {
    // Subscription has ONLY a metered AI-minutes line — base price stays
    // catalog-sourced because there's no licensed recurring item.
    setSubRow({ plan: 'pro', stripe_subscription_id: 'sub_metered_only', stripe_price_id: null });
    subscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          {
            price: {
              id: 'price_metered_only',
              unit_amount: 7,
              unit_amount_decimal: '7',
              currency: 'usd',
              recurring: { usage_type: 'metered', interval: 'month' },
              metadata: { metric: 'ai_minutes' },
            },
          },
        ],
      },
    });

    const result = await getTenantEffectiveRate(TENANT);

    expect(result.source).toBe('mixed');
    expect(result.basePriceSource).toBe('catalog');
    expect(result.overagePriceSource).toBe('stripe');
    expect(result.basePriceCents).toBe(PLAN_CATALOG.pro.monthlyPriceCents);
    expect(result.overageRatePerMinute).toBeCloseTo(0.07, 6);
  });
});

/**
 * Regression coverage for the monthly/annual interval resolution that
 * powers the public pricing calculator's annual-mode badge. Contract:
 *   - The interval that matches the tenant's subscription reuses the
 *     sub-derived value (so a custom-priced grandfathered tenant keeps
 *     their negotiated rate on that side of the toggle).
 *   - The opposite interval is fetched from
 *     `STRIPE_PRICE_<TIER>_<INTERVAL>` so the calculator can render a
 *     live Stripe rate (with badge) on either side instead of falling
 *     back to the catalog discount.
 *   - Every degraded path (env var unset, fetch throws, sub absent)
 *     silently falls back to catalog defaults — same contract as the
 *     existing fields.
 */
describe('getTenantEffectiveRate — monthly/annual interval resolution', () => {
  it('quotes annual from the published Stripe price for a tenant on a custom monthly sub', async () => {
    process.env.STRIPE_PRICE_PRO_ANNUAL = 'price_pro_annual_published';
    setSubRow({
      plan: 'pro',
      stripe_subscription_id: 'sub_pro_custom_monthly',
      stripe_price_id: 'price_pro_custom_monthly',
    });
    subscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          {
            price: {
              id: 'price_pro_custom_monthly',
              unit_amount: 25_000, // $250/mo (negotiated discount off $399)
              unit_amount_decimal: '25000',
              currency: 'usd',
              recurring: { usage_type: 'licensed', interval: 'month', interval_count: 1 },
              metadata: {},
            },
          },
        ],
      },
    });
    pricesRetrieve.mockResolvedValueOnce({
      id: 'price_pro_annual_published',
      unit_amount: 3_828_00, // $3,828/yr → $319/mo equivalent
      unit_amount_decimal: '382800',
      currency: 'usd',
      recurring: { usage_type: 'licensed', interval: 'year', interval_count: 1 },
      metadata: {},
    });

    const result = await getTenantEffectiveRate(TENANT);

    expect(pricesRetrieve).toHaveBeenCalledWith('price_pro_annual_published');
    // Existing field unchanged — still the sub-derived monthly rate.
    expect(result.basePriceCents).toBe(25_000);
    // Monthly side reuses the sub-derived custom price.
    expect(result.monthlyBasePriceCents).toBe(25_000);
    expect(result.monthlyBasePriceSource).toBe('stripe');
    expect(result.monthlyBasePriceId).toBe('price_pro_custom_monthly');
    // Annual side comes from the published env-var price, normalised to
    // a per-month figure ($3,828 / 12 = $319).
    expect(result.annualBasePriceCents).toBe(31_900);
    expect(result.annualBasePriceSource).toBe('stripe');
    expect(result.annualBasePriceId).toBe('price_pro_annual_published');
  });

  it('quotes monthly from the published Stripe price for a tenant on an annual sub', async () => {
    process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY = 'price_ent_monthly_published';
    setSubRow({
      plan: 'enterprise',
      stripe_subscription_id: 'sub_ent_annual',
      stripe_price_id: 'price_ent_annual_custom',
    });
    subscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          {
            price: {
              id: 'price_ent_annual_custom',
              unit_amount: 1_200_000, // $12,000/yr → $1,000/mo
              unit_amount_decimal: '1200000',
              currency: 'usd',
              recurring: { usage_type: 'licensed', interval: 'year', interval_count: 1 },
              metadata: {},
            },
          },
        ],
      },
    });
    pricesRetrieve.mockResolvedValueOnce({
      id: 'price_ent_monthly_published',
      unit_amount: 99_900, // $999/mo
      unit_amount_decimal: '99900',
      currency: 'usd',
      recurring: { usage_type: 'licensed', interval: 'month', interval_count: 1 },
      metadata: {},
    });

    const result = await getTenantEffectiveRate(TENANT);

    expect(pricesRetrieve).toHaveBeenCalledWith('price_ent_monthly_published');
    // Annual side reuses the sub-derived value (already monthly-equiv).
    expect(result.annualBasePriceCents).toBe(100_000);
    expect(result.annualBasePriceSource).toBe('stripe');
    expect(result.annualBasePriceId).toBe('price_ent_annual_custom');
    // Monthly side comes from published env-var price.
    expect(result.monthlyBasePriceCents).toBe(99_900);
    expect(result.monthlyBasePriceSource).toBe('stripe');
    expect(result.monthlyBasePriceId).toBe('price_ent_monthly_published');
  });

  it('falls back to catalog for the opposite interval when env var is unset', async () => {
    // Only monthly env var configured → annual resolves to the catalog
    // 20%-off floor so the calculator still renders a sensible number.
    setSubRow({
      plan: 'starter',
      stripe_subscription_id: 'sub_starter',
      stripe_price_id: null,
    });
    subscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          {
            price: {
              id: 'price_starter_monthly',
              unit_amount: PLAN_CATALOG.starter.monthlyPriceCents,
              unit_amount_decimal: String(PLAN_CATALOG.starter.monthlyPriceCents),
              currency: 'usd',
              recurring: { usage_type: 'licensed', interval: 'month', interval_count: 1 },
              metadata: {},
            },
          },
        ],
      },
    });

    const result = await getTenantEffectiveRate(TENANT);

    expect(pricesRetrieve).not.toHaveBeenCalled();
    expect(result.monthlyBasePriceSource).toBe('stripe');
    expect(result.monthlyBasePriceCents).toBe(PLAN_CATALOG.starter.monthlyPriceCents);
    expect(result.annualBasePriceSource).toBe('catalog');
    // Catalog-fallback annual = monthly × 0.8 (20% off).
    expect(result.annualBasePriceCents).toBe(
      Math.round(PLAN_CATALOG.starter.monthlyPriceCents * 0.8),
    );
    expect(result.annualBasePriceId).toBeNull();
  });

  it('degrades to catalog annual when the published price retrieve throws', async () => {
    process.env.STRIPE_PRICE_PRO_ANNUAL = 'price_pro_annual_broken';
    setSubRow({
      plan: 'pro',
      stripe_subscription_id: 'sub_pro_monthly',
      stripe_price_id: 'price_pro_monthly_sub',
    });
    subscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          {
            price: {
              id: 'price_pro_monthly_sub',
              unit_amount: PLAN_CATALOG.pro.monthlyPriceCents,
              unit_amount_decimal: String(PLAN_CATALOG.pro.monthlyPriceCents),
              currency: 'usd',
              recurring: { usage_type: 'licensed', interval: 'month' },
              metadata: {},
            },
          },
        ],
      },
    });
    pricesRetrieve.mockRejectedValueOnce(new Error('Stripe 503'));

    const result = await getTenantEffectiveRate(TENANT);

    // Annual silently falls back to catalog so the UI never renders NaN.
    expect(result.annualBasePriceSource).toBe('catalog');
    expect(result.annualBasePriceCents).toBe(
      Math.round(PLAN_CATALOG.pro.monthlyPriceCents * 0.8),
    );
    expect(result.annualBasePriceId).toBeNull();
  });

  it('rejects a published price whose recurring.interval crosses the wires', async () => {
    // Defence-in-depth: STRIPE_PRICE_PRO_ANNUAL is misconfigured to point
    // at a `recurring.interval === 'month'` price. Without the interval
    // check, this would normalise as a $X/mo "live annual quote" and
    // mislead tenants. Fail closed and use the catalog instead.
    process.env.STRIPE_PRICE_PRO_ANNUAL = 'price_pro_misconfigured';
    setSubRow({
      plan: 'pro',
      stripe_subscription_id: 'sub_pro_monthly',
      stripe_price_id: 'price_pro_monthly_sub',
    });
    subscriptionsRetrieve.mockResolvedValueOnce({
      items: {
        data: [
          {
            price: {
              id: 'price_pro_monthly_sub',
              unit_amount: PLAN_CATALOG.pro.monthlyPriceCents,
              unit_amount_decimal: String(PLAN_CATALOG.pro.monthlyPriceCents),
              currency: 'usd',
              recurring: { usage_type: 'licensed', interval: 'month' },
              metadata: {},
            },
          },
        ],
      },
    });
    pricesRetrieve.mockResolvedValueOnce({
      id: 'price_pro_misconfigured',
      unit_amount: 39_900,
      unit_amount_decimal: '39900',
      currency: 'usd',
      // ⚠ wrong interval — env var named _ANNUAL but price is monthly.
      recurring: { usage_type: 'licensed', interval: 'month', interval_count: 1 },
      metadata: {},
    });

    const result = await getTenantEffectiveRate(TENANT);

    // Wired-wrong env var rejected → annual side falls back to catalog.
    expect(result.annualBasePriceSource).toBe('catalog');
    expect(result.annualBasePriceCents).toBe(
      Math.round(PLAN_CATALOG.pro.monthlyPriceCents * 0.8),
    );
    expect(result.annualBasePriceId).toBeNull();
  });

  it('returns catalog monthly + annual when there is no subscription at all', async () => {
    // Even with both env vars set, the absence of a sub short-circuits
    // before the Stripe client is even constructed (consistent with the
    // existing catalog-fallback contract).
    process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly_published';
    process.env.STRIPE_PRICE_PRO_ANNUAL = 'price_pro_annual_published';
    setSubRow({ plan: 'pro', stripe_subscription_id: null, stripe_price_id: null });

    const result = await getTenantEffectiveRate(TENANT);

    expect(pricesRetrieve).not.toHaveBeenCalled();
    expect(result.monthlyBasePriceSource).toBe('catalog');
    expect(result.monthlyBasePriceCents).toBe(PLAN_CATALOG.pro.monthlyPriceCents);
    expect(result.annualBasePriceSource).toBe('catalog');
    expect(result.annualBasePriceCents).toBe(
      Math.round(PLAN_CATALOG.pro.monthlyPriceCents * 0.8),
    );
  });
});
