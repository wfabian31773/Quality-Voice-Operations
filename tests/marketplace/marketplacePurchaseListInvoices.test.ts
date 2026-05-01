/**
 * Coverage for `MarketplacePurchaseService.listInvoicesForPurchase`
 * (Task #1389). The Purchases tab now expands a recurring marketplace
 * subscription row to a per-renewal-invoice sub-list so each invoice's
 * own coupon-aware "Discount applied" badge is visible — the parent
 * `marketplace_purchases` row only carries the most recent invoice's
 * discount, hiding renewal-by-renewal drift (e.g. a coupon expiring
 * mid-subscription, or a different one stacking on a renewal).
 *
 * These tests pin the service contract the new
 * `GET /marketplace/purchases/:id/invoices` route depends on:
 *   1. Returns `null` when the purchase id doesn't belong to the
 *      tenant (so the route can 404 without leaking cross-tenant data).
 *   2. Returns `[]` for one-off purchases (no `stripe_subscription_id`),
 *      so the UI never shows an empty Stripe call for non-recurring
 *      buys.
 *   3. For recurring purchases, lists invoices scoped to that
 *      subscription and surfaces every coupon Stripe applied (a
 *      Stripe invoice can stack multiple discounts) using the
 *      historical normalizer.
 *   4. Walks Stripe's `has_more` / `starting_after` cursor so
 *      subscriptions older than one page (>100 invoices) are NOT
 *      silently truncated. The Done criteria require one sub-row per
 *      Stripe invoice tied to the subscription.
 *   5. Preserves the discount badge on a historical invoice even when
 *      the underlying coupon has since been invalidated or its
 *      `discount.end` is in the past — the invoice is immutable, so
 *      the badge must reflect what was applied at the time, not
 *      whether the coupon is still redeemable today.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type QueryRow = Record<string, unknown>;
type QueryHandler = (sql: string, values?: unknown[]) => Promise<{ rows: QueryRow[] }>;

let queryHandler: QueryHandler;
const invoicesList = vi.fn();

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({
    connect: async () => ({
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        return queryHandler(sql, values);
      }),
      release: vi.fn(),
    }),
    query: vi.fn(async () => ({ rows: [] })),
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
  getStripeClient: () => ({
    invoices: { list: invoicesList },
  }),
}));

import {
  listInvoicesForPurchase,
  normalizeHistoricalInvoiceDiscount,
} from '../../platform/marketplace/MarketplacePurchaseService';

const TENANT = 'tenant_invoice_history' as unknown as Parameters<
  typeof listInvoicesForPurchase
>[0];

beforeEach(() => {
  invoicesList.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('listInvoicesForPurchase', () => {
  it('returns null when the purchase does not belong to the tenant', async () => {
    queryHandler = async (sql) => {
      if (sql.trimStart().startsWith('SELECT stripe_subscription_id')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    };

    const result = await listInvoicesForPurchase(TENANT, 'mkt_unknown');
    expect(result).toBeNull();
    // Stripe must not be hit when the purchase is not visible to the
    // tenant — that would leak existence of subscriptions across
    // tenant boundaries.
    expect(invoicesList).not.toHaveBeenCalled();
  });

  it('returns an empty list for one-off purchases (no stripe_subscription_id)', async () => {
    queryHandler = async (sql) => {
      if (sql.trimStart().startsWith('SELECT stripe_subscription_id')) {
        return {
          rows: [{ stripe_subscription_id: null, price_model: 'one_time' }],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    };

    const result = await listInvoicesForPurchase(TENANT, 'mkt_oneoff');
    expect(result).toEqual([]);
    // No need to fan out to Stripe — there's nothing to list.
    expect(invoicesList).not.toHaveBeenCalled();
  });

  it('lists Stripe invoices scoped to the subscription with per-renewal discount badges', async () => {
    queryHandler = async (sql) => {
      if (sql.trimStart().startsWith('SELECT stripe_subscription_id')) {
        return {
          rows: [{
            stripe_subscription_id: 'sub_mkt_recurring',
            price_model: 'monthly_subscription',
          }],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    };

    invoicesList.mockResolvedValue({
      data: [
        {
          id: 'in_renewal_2',
          number: 'INV-0002',
          status: 'paid',
          created: 1714400000,
          amount_paid: 9900,
          amount_due: 9900,
          total: 9900,
          currency: 'usd',
          invoice_pdf: 'https://stripe/in_renewal_2.pdf',
          hosted_invoice_url: 'https://stripe/in_renewal_2',
          description: 'May renewal',
          discounts: [
            {
              coupon: {
                id: 'coupon_loyal20',
                name: 'Loyalty 20% Off',
                percent_off: 20,
                amount_off: null,
                currency: null,
                valid: true,
              },
              promotion_code: {
                id: 'promo_loyal20',
                code: 'LOYAL20',
                active: true,
              },
            },
          ],
          total_discount_amounts: [{ amount: 1980, discount: 'di_2' }],
          lines: { data: [{ description: 'Subscription renewal' }] },
        },
        {
          id: 'in_renewal_1',
          number: 'INV-0001',
          status: 'paid',
          created: 1711721600,
          amount_paid: 9900,
          amount_due: 9900,
          total: 9900,
          currency: 'usd',
          invoice_pdf: 'https://stripe/in_renewal_1.pdf',
          hosted_invoice_url: 'https://stripe/in_renewal_1',
          description: 'April renewal',
          // No discounts on this period — simulates a coupon that
          // expired between renewals so the row should NOT carry a
          // discount badge.
          discounts: [],
          total_discount_amounts: [],
          lines: { data: [{ description: 'Subscription renewal' }] },
        },
      ],
      has_more: false,
    });

    const result = await listInvoicesForPurchase(TENANT, 'mkt_sub');
    expect(invoicesList).toHaveBeenCalledTimes(1);
    const stripeArgs = invoicesList.mock.calls[0][0];
    // Must scope the listing to the purchase's own subscription so
    // we don't bleed the tenant's other recurring invoices into this
    // row's history.
    expect(stripeArgs.subscription).toBe('sub_mkt_recurring');
    // Discount fields must be expanded so the historical normalizer
    // can resolve coupon + promotion code without extra round-trips.
    expect(stripeArgs.expand).toEqual(
      expect.arrayContaining([
        'data.discounts',
        'data.discounts.promotion_code',
      ]),
    );

    expect(result).not.toBeNull();
    expect(result!).toHaveLength(2);

    const [withDiscount, withoutDiscount] = result!;
    expect(withDiscount.id).toBe('in_renewal_2');
    expect(withDiscount.number).toBe('INV-0002');
    expect(withDiscount.amountCents).toBe(9900);
    expect(withDiscount.invoicePdf).toBe('https://stripe/in_renewal_2.pdf');
    expect(withDiscount.discounts).toHaveLength(1);
    expect(withDiscount.discounts[0]).toMatchObject({
      couponId: 'coupon_loyal20',
      name: 'Loyalty 20% Off',
      promotionCode: 'LOYAL20',
      percentOff: 20,
    });

    expect(withoutDiscount.id).toBe('in_renewal_1');
    // The whole point: a renewal where the coupon no longer applies
    // must NOT carry a stale discount badge inherited from the parent
    // row.
    expect(withoutDiscount.discounts).toEqual([]);
  });

  it('paginates through every page so subscriptions older than one page are not truncated', async () => {
    queryHandler = async (sql) => {
      if (sql.trimStart().startsWith('SELECT stripe_subscription_id')) {
        return {
          rows: [{
            stripe_subscription_id: 'sub_long_history',
            price_model: 'monthly_subscription',
          }],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    };

    const makeInvoice = (i: number) => ({
      id: `in_${String(i).padStart(4, '0')}`,
      number: `INV-${String(i).padStart(4, '0')}`,
      status: 'paid',
      created: 1700000000 + i,
      amount_paid: 1999,
      amount_due: 1999,
      total: 1999,
      currency: 'usd',
      invoice_pdf: `https://stripe/in_${i}.pdf`,
      hosted_invoice_url: null,
      description: null,
      discounts: [],
      total_discount_amounts: [],
      lines: { data: [] },
    });

    // First page: 100 invoices, has_more=true. Second page: 50 more,
    // has_more=false. Verifies the cursor walk forwards `starting_after`
    // and consumes both pages.
    const page1 = Array.from({ length: 100 }, (_, i) => makeInvoice(i));
    const page2 = Array.from({ length: 50 }, (_, i) => makeInvoice(i + 100));
    invoicesList
      .mockResolvedValueOnce({ data: page1, has_more: true })
      .mockResolvedValueOnce({ data: page2, has_more: false });

    const result = await listInvoicesForPurchase(TENANT, 'mkt_long');
    expect(invoicesList).toHaveBeenCalledTimes(2);

    // First call: no starting_after.
    expect(invoicesList.mock.calls[0][0].starting_after).toBeUndefined();
    // Second call: starting_after MUST equal the last id of page 1.
    expect(invoicesList.mock.calls[1][0].starting_after).toBe('in_0099');
    // Both calls must keep the subscription scope.
    expect(invoicesList.mock.calls[0][0].subscription).toBe('sub_long_history');
    expect(invoicesList.mock.calls[1][0].subscription).toBe('sub_long_history');

    expect(result).not.toBeNull();
    expect(result!).toHaveLength(150);
    // Sanity: order preserved across page concatenation (Stripe lists
    // newest-first; we keep that order so the UI shows newest renewal
    // at the top).
    expect(result![0].id).toBe('in_0000');
    expect(result![149].id).toBe('in_0149');
  });

  it('preserves the coupon-aware badge on a historical invoice whose coupon has since expired', async () => {
    queryHandler = async (sql) => {
      if (sql.trimStart().startsWith('SELECT stripe_subscription_id')) {
        return {
          rows: [{
            stripe_subscription_id: 'sub_with_expired_coupon',
            price_model: 'monthly_subscription',
          }],
        };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    };

    // A historical renewal whose coupon Stripe has since invalidated
    // (`valid: false`) AND whose `discount.end` is in the past. The
    // active-surface normalizer would suppress this; the historical
    // sub-history MUST keep the chip since the invoice itself was
    // discounted at the time.
    const longExpired = Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 365;
    invoicesList.mockResolvedValue({
      data: [
        {
          id: 'in_expired_coupon',
          number: 'INV-OLD',
          status: 'paid',
          created: longExpired - 60,
          amount_paid: 8000,
          total: 8000,
          currency: 'usd',
          invoice_pdf: 'https://stripe/in_expired_coupon.pdf',
          hosted_invoice_url: null,
          description: 'Older renewal',
          discounts: [
            {
              end: longExpired,
              coupon: {
                id: 'coupon_launch20',
                name: 'Launch 20% Off',
                percent_off: 20,
                amount_off: null,
                currency: null,
                valid: false,
              },
              promotion_code: {
                id: 'promo_launch20',
                code: 'LAUNCH20',
                active: false,
              },
            },
          ],
          total_discount_amounts: [{ amount: 1600, discount: 'di_old' }],
          lines: { data: [{ description: 'Subscription renewal' }] },
        },
      ],
      has_more: false,
    });

    const result = await listInvoicesForPurchase(TENANT, 'mkt_old');
    expect(result).not.toBeNull();
    expect(result!).toHaveLength(1);
    expect(result![0].discounts).toHaveLength(1);
    expect(result![0].discounts[0]).toMatchObject({
      couponId: 'coupon_launch20',
      name: 'Launch 20% Off',
      promotionCode: 'LAUNCH20',
      percentOff: 20,
    });
  });
});

describe('normalizeHistoricalInvoiceDiscount', () => {
  it('returns null for missing coupons', () => {
    expect(normalizeHistoricalInvoiceDiscount(null)).toBeNull();
    expect(normalizeHistoricalInvoiceDiscount(undefined)).toBeNull();
    expect(normalizeHistoricalInvoiceDiscount({})).toBeNull();
  });

  it('returns null for pure-metadata coupons (no percent_off / amount_off)', () => {
    expect(normalizeHistoricalInvoiceDiscount({
      coupon: { id: 'meta', name: 'Meta', percent_off: null, amount_off: null },
    })).toBeNull();
  });

  it('keeps the discount when valid=false (active surfaces would suppress)', () => {
    const out = normalizeHistoricalInvoiceDiscount({
      // No `end` field — the past invoice still legitimately got the
      // discount; the active normalizer would also drop it because of
      // `valid: false`.
      coupon: {
        id: 'expired',
        name: 'Expired Promo',
        percent_off: 10,
        valid: false,
      },
    });
    expect(out).toMatchObject({ couponId: 'expired', percentOff: 10 });
  });

  it('keeps the discount when end is far in the past (active surfaces would suppress)', () => {
    const out = normalizeHistoricalInvoiceDiscount({
      end: 1,
      coupon: {
        id: 'long_done',
        amount_off: 500,
        currency: 'usd',
        valid: true,
      },
    });
    expect(out).toMatchObject({
      couponId: 'long_done',
      amountOffCents: 500,
      currency: 'usd',
    });
  });

  it('reads the modern `source` shape when the top-level coupon is missing', () => {
    const out = normalizeHistoricalInvoiceDiscount({
      source: {
        coupon: {
          id: 'modern',
          percent_off: 5,
        },
        promotion_code: { id: 'promo_modern', code: 'MODERN5' },
      },
    });
    expect(out).toMatchObject({
      couponId: 'modern',
      percentOff: 5,
      promotionCode: 'MODERN5',
    });
  });
});
