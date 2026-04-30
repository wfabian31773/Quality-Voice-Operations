/**
 * Unit coverage for `getTenantDowngradePreview` (Task #1257).
 *
 * The preview powers `GET /billing/downgrade-preview`. It shares
 * `DOWNGRADE_PRORATION_BEHAVIOR` with `scheduleDowngrade` so the
 * `proration_behavior` value handed to Stripe in both paths cannot
 * drift. Asserts:
 *   - the preview hands Stripe the shared constant
 *   - only `proration: true` negative lines count toward the credit
 *   - `nextInvoiceTotalCents` honors any customer-level coupon
 *   - Stripe errors degrade to the catalog fallback
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
const invoicesCreatePreview = vi.fn();
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
      invoices: { createPreview: invoicesCreatePreview },
    };
  },
}));

import { getTenantDowngradePreview } from '../../platform/billing/stripe/effectiveRate';
import { DOWNGRADE_PRORATION_BEHAVIOR } from '../../platform/billing/stripe/planChange';
import { PLAN_CATALOG } from '../../shared/billing/planCatalog';

const TENANT = 'tenant-downgrade-preview';

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
  invoicesCreatePreview.mockReset();
  stripeClientShouldThrow = false;
  queryHandler = async () => ({ rows: [] });
  process.env.STRIPE_PRICE_STARTER_MONTHLY = 'price_starter_monthly_published';
  process.env.STRIPE_PRICE_STARTER_ANNUAL = 'price_starter_annual_published';
  process.env.STRIPE_PRICE_PRO_MONTHLY = 'price_pro_monthly_published';
  process.env.STRIPE_PRICE_PRO_ANNUAL = 'price_pro_annual_published';
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.STRIPE_PRICE_STARTER_MONTHLY;
  delete process.env.STRIPE_PRICE_STARTER_ANNUAL;
  delete process.env.STRIPE_PRICE_PRO_MONTHLY;
  delete process.env.STRIPE_PRICE_PRO_ANNUAL;
});

describe('getTenantDowngradePreview — preview mirrors scheduleDowngrade', () => {
  it('asks Stripe for the preview with the shared DOWNGRADE_PRORATION_BEHAVIOR and surfaces invoice.total as the next-invoice quote', async () => {
    setSubRow({
      plan: 'enterprise',
      stripe_subscription_id: 'sub_ent',
      stripe_price_id: 'price_ent_base',
      stripe_customer_id: 'cus_ent',
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
      id: 'cus_ent',
      deleted: false,
      currency: 'usd',
      discount: null,
    });
    subscriptionsRetrieve.mockResolvedValueOnce({
      id: 'sub_ent',
      items: {
        data: [
          {
            id: 'si_licensed_ent',
            price: {
              id: 'price_ent_monthly',
              recurring: { usage_type: 'licensed', interval: 'month' },
            },
          },
          {
            id: 'si_metered_ai',
            price: {
              id: 'price_ent_ai',
              recurring: { usage_type: 'metered', interval: 'month' },
            },
          },
        ],
      },
    });
    invoicesCreatePreview.mockResolvedValueOnce({
      total: 39_900,
      amount_due: 39_900,
      currency: 'usd',
      next_payment_attempt: 1_770_000_000,
      period_end: 1_770_000_000,
      lines: {
        data: [
          // Recurring charge for the new tier, NOT a proration line.
          { amount: 39_900, proration: false },
        ],
      },
    });

    const result = await getTenantDowngradePreview(TENANT, 'pro', 'monthly');

    expect(invoicesCreatePreview).toHaveBeenCalledTimes(1);
    const previewCall = invoicesCreatePreview.mock.calls[0]![0] as {
      subscription: string;
      subscription_details: {
        items: Array<{ id: string; price: string }>;
        proration_behavior: string;
        proration_date?: number;
      };
    };
    expect(previewCall.subscription).toBe('sub_ent');
    expect(previewCall.subscription_details.items).toEqual([
      { id: 'si_licensed_ent', price: 'price_pro_monthly_published' },
    ]);
    // Must match the value scheduleDowngrade applies to phase 1.
    expect(previewCall.subscription_details.proration_behavior).toBe(
      DOWNGRADE_PRORATION_BEHAVIOR,
    );
    expect(previewCall.subscription_details.proration_date).toBeUndefined();

    expect(result.plan).toBe('pro');
    expect(result.interval).toBe('monthly');
    expect(result.prorationCreditCents).toBe(0);
    expect(result.nextInvoiceTotalCents).toBe(39_900);
    expect(result.nextInvoiceAt).toBe(new Date(1_770_000_000 * 1000).toISOString());
    expect(result.basePriceCents).toBe(39_900);
    expect(result.basePriceSource).toBe('stripe');
    expect(result.basePriceId).toBe('price_pro_monthly_published');
    expect(result.source).toBe('stripe');
    expect(result.discount).toBeNull();
  });

  it('honors an active customer-level coupon by discounting the quoted base AND letting Stripe apply the same coupon to the next-invoice total', async () => {
    setSubRow({
      plan: 'enterprise',
      stripe_subscription_id: 'sub_ent_promo',
      stripe_price_id: null,
      stripe_customer_id: 'cus_ent_promo',
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
      id: 'cus_ent_promo',
      deleted: false,
      discount: {
        coupon: {
          id: 'coupon_pro_25',
          name: 'Sales 25% off',
          percent_off: 25,
          amount_off: null,
          currency: null,
          valid: true,
        },
        promotion_code: { id: 'promo_25', code: 'PROMO25', active: true },
      },
    });
    subscriptionsRetrieve.mockResolvedValueOnce({
      id: 'sub_ent_promo',
      items: {
        data: [
          {
            id: 'si_licensed_ent_promo',
            price: { id: 'price_ent_monthly', recurring: { usage_type: 'licensed' } },
          },
        ],
      },
    });
    // 25% off $399 → Stripe-side total of $299.25.
    invoicesCreatePreview.mockResolvedValueOnce({
      total: 29_925,
      amount_due: 29_925,
      currency: 'usd',
      next_payment_attempt: 1_770_000_000,
      period_end: 1_770_000_000,
      lines: {
        data: [
          { amount: 39_900, proration: false },
          { amount: -9_975, proration: false }, // discount line — NOT proration
        ],
      },
    });

    const result = await getTenantDowngradePreview(TENANT, 'pro', 'monthly');

    expect(customersRetrieve).toHaveBeenCalledWith(
      'cus_ent_promo',
      { expand: ['discount.promotion_code'] },
    );
    expect(result.basePriceCents).toBe(29_925);
    expect(result.nextInvoiceTotalCents).toBe(29_925);
    // Coupon discount line is negative but `proration: false`, so it
    // must NOT count as downgrade credit.
    expect(result.prorationCreditCents).toBe(0);
    expect(result.discount).toMatchObject({
      couponId: 'coupon_pro_25',
      percentOff: 25,
      promotionCode: 'PROMO25',
    });
    expect(result.source).toBe('stripe');
  });

  it('passes the annual published price into the preview when interval=annual so monthly→annual downgrade quotes the right next-invoice total', async () => {
    setSubRow({
      plan: 'enterprise',
      stripe_subscription_id: 'sub_ent_annual',
      stripe_price_id: null,
      stripe_customer_id: 'cus_ent_annual',
    });
    pricesRetrieve.mockResolvedValueOnce({
      id: 'price_pro_annual_published',
      unit_amount: 383_040,
      unit_amount_decimal: '383040',
      currency: 'usd',
      recurring: { usage_type: 'licensed', interval: 'year', interval_count: 1 },
      metadata: {},
    });
    customersRetrieve.mockResolvedValueOnce({
      id: 'cus_ent_annual',
      deleted: false,
      discount: null,
    });
    subscriptionsRetrieve.mockResolvedValueOnce({
      id: 'sub_ent_annual',
      items: {
        data: [
          {
            id: 'si_licensed_ent_annual',
            price: { id: 'price_ent_monthly', recurring: { usage_type: 'licensed' } },
          },
        ],
      },
    });
    invoicesCreatePreview.mockResolvedValueOnce({
      total: 383_040,
      amount_due: 383_040,
      currency: 'usd',
      next_payment_attempt: null,
      period_end: 1_780_000_000,
      lines: { data: [{ amount: 383_040, proration: false }] },
    });

    const result = await getTenantDowngradePreview(TENANT, 'pro', 'annual');

    const previewCall = invoicesCreatePreview.mock.calls[0]![0] as {
      subscription_details: { items: Array<{ price: string }>; proration_behavior: string };
    };
    expect(previewCall.subscription_details.items[0]!.price).toBe('price_pro_annual_published');
    expect(previewCall.subscription_details.proration_behavior).toBe(
      DOWNGRADE_PRORATION_BEHAVIOR,
    );

    expect(result.interval).toBe('annual');
    expect(result.prorationCreditCents).toBe(0);
    expect(result.nextInvoiceTotalCents).toBe(383_040);
    // Falls back to period_end when next_payment_attempt is null.
    expect(result.nextInvoiceAt).toBe(new Date(1_780_000_000 * 1000).toISOString());
    // Annual base normalised to monthly: 383 040 / 12 = 31 920c.
    expect(result.basePriceCents).toBe(31_920);
  });

  it('only counts proration:true negative lines toward prorationCreditCents (so unrelated credit notes are not surfaced as downgrade credit)', async () => {
    setSubRow({
      plan: 'enterprise',
      stripe_subscription_id: 'sub_ent',
      stripe_price_id: null,
      stripe_customer_id: 'cus_ent',
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
      id: 'cus_ent',
      deleted: false,
      discount: null,
    });
    subscriptionsRetrieve.mockResolvedValueOnce({
      id: 'sub_ent',
      items: {
        data: [
          {
            id: 'si_licensed_ent',
            price: { id: 'price_ent_monthly', recurring: { usage_type: 'licensed' } },
          },
        ],
      },
    });
    invoicesCreatePreview.mockResolvedValueOnce({
      total: 19_900,
      amount_due: 19_900,
      currency: 'usd',
      next_payment_attempt: 1_770_000_000,
      period_end: 1_770_000_000,
      lines: {
        data: [
          { amount: 39_900, proration: false },
          { amount: -20_000, proration: false }, // unrelated credit note, must be ignored
          { amount: -10_000, proration: true }, // legitimate proration credit, would count
        ],
      },
    });

    const result = await getTenantDowngradePreview(TENANT, 'pro', 'monthly');

    // Only the `proration: true` negative line counts toward credit.
    expect(result.prorationCreditCents).toBe(10_000);
    expect(result.nextInvoiceTotalCents).toBe(19_900);
  });
});

describe('getTenantDowngradePreview — graceful degradation', () => {
  it('returns catalog defaults with $0 credit when the Stripe client cannot be constructed', async () => {
    setSubRow({
      plan: 'enterprise',
      stripe_subscription_id: 'sub_ent',
      stripe_price_id: null,
      stripe_customer_id: 'cus_ent',
    });
    stripeClientShouldThrow = true;

    const result = await getTenantDowngradePreview(TENANT, 'pro', 'monthly');

    expect(invoicesCreatePreview).not.toHaveBeenCalled();
    expect(result.prorationCreditCents).toBe(0);
    expect(result.basePriceCents).toBe(PLAN_CATALOG.pro.monthlyPriceCents);
    expect(result.nextInvoiceTotalCents).toBe(PLAN_CATALOG.pro.monthlyPriceCents);
    expect(result.source).toBe('catalog');
  });

  it('returns $0 credit when the tenant has no Stripe subscription to preview against', async () => {
    setSubRow({
      plan: 'starter',
      stripe_subscription_id: null,
      stripe_price_id: null,
      stripe_customer_id: 'cus_no_sub',
    });
    pricesRetrieve.mockResolvedValueOnce({
      id: 'price_starter_monthly_published',
      unit_amount: 9_900,
      unit_amount_decimal: '9900',
      currency: 'usd',
      recurring: { usage_type: 'licensed', interval: 'month' },
      metadata: {},
    });
    customersRetrieve.mockResolvedValueOnce({
      id: 'cus_no_sub',
      deleted: false,
      discount: null,
    });

    const result = await getTenantDowngradePreview(TENANT, 'starter', 'monthly');

    expect(invoicesCreatePreview).not.toHaveBeenCalled();
    expect(result.prorationCreditCents).toBe(0);
    expect(result.basePriceCents).toBe(9_900);
    expect(result.basePriceSource).toBe('stripe');
  });

  it('falls back to a catalog quote when invoices.createPreview throws', async () => {
    setSubRow({
      plan: 'enterprise',
      stripe_subscription_id: 'sub_ent',
      stripe_price_id: null,
      stripe_customer_id: 'cus_ent',
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
      id: 'cus_ent',
      deleted: false,
      discount: null,
    });
    subscriptionsRetrieve.mockResolvedValueOnce({
      id: 'sub_ent',
      items: {
        data: [
          {
            id: 'si_licensed_ent',
            price: { id: 'price_ent_monthly', recurring: { usage_type: 'licensed' } },
          },
        ],
      },
    });
    invoicesCreatePreview.mockRejectedValueOnce(new Error('Stripe 503'));

    const result = await getTenantDowngradePreview(TENANT, 'pro', 'monthly');

    expect(result.prorationCreditCents).toBe(0);
    expect(result.basePriceCents).toBe(39_900);
    expect(result.basePriceSource).toBe('stripe');
    expect(result.nextInvoiceTotalCents).toBe(PLAN_CATALOG.pro.monthlyPriceCents);
  });
});
