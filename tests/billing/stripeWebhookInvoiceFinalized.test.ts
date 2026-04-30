/**
 * Coverage for `handleInvoiceFinalized` in
 * `platform/billing/stripe/webhook.ts` (Task #1311).
 *
 * When Stripe finalizes an invoice that has a coupon attached, the
 * webhook must update the invoice with branded `custom_fields` +
 * `footer` so the receipt PDF (which Stripe re-generates on update)
 * carries the same coupon-aware badge tenants already see in the app.
 *
 * Behaviours pinned here:
 *   1. Coupon name + percent_off lands in custom_fields and footer.
 *   2. Promo code is preferred over coupon name when both exist.
 *   3. Amount-off coupons format as "<CUR> <amount> off".
 *   4. Invoices with no discount are left untouched (no PDF noise).
 *   5. Idempotency: re-firing the same finalized event does not
 *      re-stamp an invoice that already carries the marker metadata.
 *   6. Operator-set custom fields are preserved (we only own our slot).
 *   7. Stripe call failures degrade silently (webhook never throws).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const {
  invoicesRetrieveMock,
  invoicesUpdateMock,
  poolQueryMock,
  applyInvoiceDiscountToPurchaseMock,
} = vi.hoisted(() => ({
  invoicesRetrieveMock: vi.fn(),
  invoicesUpdateMock: vi.fn(),
  poolQueryMock: vi.fn(),
  applyInvoiceDiscountToPurchaseMock: vi.fn(),
}));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({
    query: poolQueryMock,
    connect: vi.fn(),
  }),
  withTenantContext: vi.fn(
    async (_client: unknown, _tenantId: string, fn: () => Promise<void>) =>
      fn(),
  ),
}));

vi.mock('../../platform/marketplace/MarketplacePurchaseService', () => ({
  completePurchase: vi.fn(),
  applyInvoiceDiscountToPurchase: applyInvoiceDiscountToPurchaseMock,
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
    invoices: { retrieve: invoicesRetrieveMock, update: invoicesUpdateMock },
  }),
  getWebhookSecret: () => 'whsec_test',
}));

vi.mock('../../platform/tenant/provisioning/TenantProvisioningService', () => ({
  provisionTenant: vi.fn(),
}));

import type Stripe from 'stripe';
import {
  handleInvoiceFinalized,
  formatDiscountBadgeLabel,
  formatDiscountFooter,
} from '../../platform/billing/stripe/webhook';

function makeInvoice(
  overrides: Partial<Stripe.Invoice> & {
    total_discount_amounts?: Array<{ amount: number; discount: string }> | null;
  } = {},
): Stripe.Invoice {
  return {
    id: 'in_123',
    customer: 'cus_1',
    custom_fields: null,
    footer: null,
    metadata: {},
    total_discount_amounts: [{ amount: 500, discount: 'di_1' }],
    ...overrides,
  } as unknown as Stripe.Invoice;
}

beforeEach(() => {
  invoicesRetrieveMock.mockReset();
  invoicesUpdateMock.mockReset();
  invoicesUpdateMock.mockResolvedValue({ id: 'in_123' });
  poolQueryMock.mockReset();
  poolQueryMock.mockResolvedValue({ rows: [] });
  applyInvoiceDiscountToPurchaseMock.mockReset();
  applyInvoiceDiscountToPurchaseMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('handleInvoiceFinalized — discount badge stamping', () => {
  it('stamps coupon name + percent_off into custom_fields and footer', async () => {
    invoicesRetrieveMock.mockResolvedValue({
      id: 'in_123',
      discounts: [
        {
          coupon: {
            id: 'coupon_promo25',
            name: 'Spring Promo',
            percent_off: 25,
            valid: true,
          },
          promotion_code: null,
        },
      ],
    });

    await handleInvoiceFinalized(makeInvoice());

    expect(invoicesUpdateMock).toHaveBeenCalledTimes(1);
    const [invoiceId, args] = invoicesUpdateMock.mock.calls[0];
    expect(invoiceId).toBe('in_123');
    expect(args.custom_fields).toEqual([
      { name: 'Discount applied', value: 'Spring Promo - 25% off' },
    ]);
    expect(args.footer).toContain('Spring Promo');
    expect(args.footer).toContain('25% off');
    expect(args.metadata?.discountBadgeApplied).toBe('true');
    expect(args.metadata?.discountBadgeCouponId).toBe('coupon_promo25');
  });

  it('prefers the promotion code label over the coupon name', async () => {
    invoicesRetrieveMock.mockResolvedValue({
      id: 'in_123',
      discounts: [
        {
          coupon: {
            id: 'coupon_x',
            name: 'Spring Promo',
            percent_off: 10,
            valid: true,
          },
          promotion_code: { id: 'promo_xyz', code: 'PROMO10' },
        },
      ],
    });

    await handleInvoiceFinalized(makeInvoice());

    const [, args] = invoicesUpdateMock.mock.calls[0];
    expect(args.custom_fields[0].value).toBe('PROMO10 - 10% off');
    expect(args.metadata.discountBadgePromotionCode).toBe('PROMO10');
    expect(args.footer).toContain('promo code "PROMO10"');
  });

  it('formats amount-off coupons as "<CUR> <amount> off"', async () => {
    invoicesRetrieveMock.mockResolvedValue({
      id: 'in_123',
      discounts: [
        {
          coupon: {
            id: 'coupon_flat',
            name: 'Flat $10',
            amount_off: 1000,
            currency: 'usd',
            valid: true,
          },
          promotion_code: null,
        },
      ],
    });

    await handleInvoiceFinalized(makeInvoice());

    const [, args] = invoicesUpdateMock.mock.calls[0];
    expect(args.custom_fields[0].value).toContain('USD 10.00 off');
    expect(args.footer).toContain('USD 10.00 off');
  });

  it('does nothing when the invoice has no discount', async () => {
    await handleInvoiceFinalized(makeInvoice({ total_discount_amounts: [] }));
    expect(invoicesRetrieveMock).not.toHaveBeenCalled();
    expect(invoicesUpdateMock).not.toHaveBeenCalled();
  });

  it('skips re-stamping when the marker metadata is already present', async () => {
    await handleInvoiceFinalized(
      makeInvoice({ metadata: { discountBadgeApplied: 'true' } }),
    );
    expect(invoicesRetrieveMock).not.toHaveBeenCalled();
    expect(invoicesUpdateMock).not.toHaveBeenCalled();
  });

  it('preserves operator-set custom fields and only replaces our slot', async () => {
    invoicesRetrieveMock.mockResolvedValue({
      id: 'in_123',
      discounts: [
        {
          coupon: { id: 'c1', percent_off: 15, valid: true },
          promotion_code: null,
        },
      ],
    });

    await handleInvoiceFinalized(
      makeInvoice({
        custom_fields: [
          { name: 'PO Number', value: 'PO-42' },
          { name: 'Discount applied', value: 'stale - 99%' },
        ] as Stripe.Invoice.CustomField[],
      }),
    );

    const [, args] = invoicesUpdateMock.mock.calls[0];
    expect(args.custom_fields).toEqual([
      { name: 'PO Number', value: 'PO-42' },
      { name: 'Discount applied', value: 'c1 - 15% off' },
    ]);
  });

  it('appends the footer line without clobbering an existing footer', async () => {
    invoicesRetrieveMock.mockResolvedValue({
      id: 'in_123',
      discounts: [
        {
          coupon: { id: 'c1', percent_off: 15, valid: true },
          promotion_code: null,
        },
      ],
    });

    await handleInvoiceFinalized(
      makeInvoice({ footer: 'Thank you for your business.' }),
    );

    const [, args] = invoicesUpdateMock.mock.calls[0];
    expect(args.footer).toContain('Thank you for your business.');
    expect(args.footer).toContain('15% off');
  });

  it('caps the badge value at Stripe\'s 30-char custom_field limit', async () => {
    invoicesRetrieveMock.mockResolvedValue({
      id: 'in_123',
      discounts: [
        {
          coupon: {
            id: 'c1',
            name: 'A really very long coupon name that exceeds the limit',
            percent_off: 5,
            valid: true,
          },
          promotion_code: null,
        },
      ],
    });

    await handleInvoiceFinalized(makeInvoice());

    const [, args] = invoicesUpdateMock.mock.calls[0];
    expect(args.custom_fields[0].value.length).toBeLessThanOrEqual(30);
  });

  it('does not throw when the Stripe update call fails', async () => {
    invoicesRetrieveMock.mockResolvedValue({
      id: 'in_123',
      discounts: [
        {
          coupon: { id: 'c1', percent_off: 25, valid: true },
          promotion_code: null,
        },
      ],
    });
    invoicesUpdateMock.mockRejectedValueOnce(new Error('stripe down'));

    await expect(handleInvoiceFinalized(makeInvoice())).resolves.toBeUndefined();
  });

  it('does nothing when no usable discount comes back from the expand', async () => {
    invoicesRetrieveMock.mockResolvedValue({ id: 'in_123', discounts: [] });

    await handleInvoiceFinalized(makeInvoice());

    expect(invoicesUpdateMock).not.toHaveBeenCalled();
  });

  it('drops invalid coupons (Stripe marked them not valid)', async () => {
    invoicesRetrieveMock.mockResolvedValue({
      id: 'in_123',
      discounts: [
        {
          coupon: { id: 'c1', percent_off: 50, valid: false },
          promotion_code: null,
        },
      ],
    });

    await handleInvoiceFinalized(makeInvoice());

    expect(invoicesUpdateMock).not.toHaveBeenCalled();
  });
});

/**
 * One-off invoice coverage (Task #1351).
 *
 * Stripe fires `invoice.finalized` for any invoice it finalizes — not
 * just subscription renewals. Marketplace add-on purchases (and any
 * future `stripe.invoices.create` + manual finalize flow) take the
 * `mode: 'payment'` Checkout path with `invoice_creation: { enabled:
 * true }`, which produces an invoice that has NO `subscription` /
 * `subscription_details` fields but the same `total_discount_amounts`
 * + `discounts` shape as a subscription invoice.
 *
 * These tests pin that the badge stamper:
 *   - Treats those one-off invoices the same as subscription ones.
 *   - Successfully passes the marketplace-purchase coupon shape through
 *     `normalizeDiscount` (i.e. there's no subscription-only field the
 *     handler depends on that would cause the marketplace path to bypass
 *     the badge stamping).
 */
describe('handleInvoiceFinalized — one-off / marketplace invoices', () => {
  function makeOneOffInvoice(
    overrides: Partial<Stripe.Invoice> & {
      total_discount_amounts?: Array<{ amount: number; discount: string }> | null;
    } = {},
  ): Stripe.Invoice {
    return {
      id: 'in_oneoff_123',
      customer: 'cus_marketplace_buyer',
      // The two fields that mark a Stripe invoice as "one-off" rather
      // than subscription-driven. Pinned explicitly so a future change
      // that accidentally reads `invoice.subscription` would fail this
      // test.
      subscription: null,
      subscription_details: null,
      billing_reason: 'manual',
      custom_fields: null,
      footer: null,
      metadata: {},
      total_discount_amounts: [{ amount: 750, discount: 'di_oneoff_1' }],
      ...overrides,
    } as unknown as Stripe.Invoice;
  }

  it('stamps the badge on a one-off invoice (no subscription) with a coupon', async () => {
    invoicesRetrieveMock.mockResolvedValue({
      id: 'in_oneoff_123',
      // Mirror the shape Stripe returns for a one-off invoice — no
      // `subscription` / `subscription_details`, just discounts.
      subscription: null,
      subscription_details: null,
      discounts: [
        {
          coupon: {
            id: 'coupon_launch15',
            name: 'Launch Discount',
            percent_off: 15,
            valid: true,
          },
          promotion_code: { id: 'promo_launch', code: 'LAUNCH15' },
        },
      ],
    });

    await handleInvoiceFinalized(makeOneOffInvoice());

    expect(invoicesUpdateMock).toHaveBeenCalledTimes(1);
    const [invoiceId, args] = invoicesUpdateMock.mock.calls[0];
    expect(invoiceId).toBe('in_oneoff_123');
    expect(args.custom_fields).toEqual([
      { name: 'Discount applied', value: 'LAUNCH15 - 15% off' },
    ]);
    expect(args.footer).toContain('LAUNCH15');
    expect(args.footer).toContain('15% off');
    expect(args.metadata?.discountBadgeApplied).toBe('true');
    expect(args.metadata?.discountBadgePromotionCode).toBe('LAUNCH15');
  });

  it('stamps the badge on a marketplace-purchase invoice and preserves marketplace metadata', async () => {
    invoicesRetrieveMock.mockResolvedValue({
      id: 'in_oneoff_123',
      subscription: null,
      subscription_details: null,
      discounts: [
        {
          coupon: {
            id: 'coupon_market10',
            name: 'Marketplace Promo',
            amount_off: 1000,
            currency: 'usd',
            valid: true,
          },
          promotion_code: { id: 'promo_market', code: 'MARKET10' },
        },
      ],
    });

    await handleInvoiceFinalized(
      makeOneOffInvoice({
        // The metadata `MarketplacePurchaseService` stamps onto the
        // invoice via `invoice_creation.invoice_data.metadata`.
        metadata: {
          tenantId: 'tenant_42',
          templateId: 'tmpl_dispatch_addon',
          purchaseId: 'mkt_purchase_abc',
          type: 'marketplace_purchase',
        },
      }),
    );

    expect(invoicesUpdateMock).toHaveBeenCalledTimes(1);
    const [, args] = invoicesUpdateMock.mock.calls[0];
    expect(args.custom_fields[0].name).toBe('Discount applied');
    expect(args.custom_fields[0].value).toContain('MARKET10');
    expect(args.custom_fields[0].value).toContain('USD 10.00 off');
    expect(args.footer).toContain('promo code "MARKET10"');
    expect(args.footer).toContain('USD 10.00 off');
    // Critically: the marketplace breadcrumb metadata must survive the
    // update — Finance reconciles the receipt PDF back to the purchase
    // row through these fields, so clobbering them here would break the
    // very workflow this badge exists to support.
    expect(args.metadata).toMatchObject({
      tenantId: 'tenant_42',
      templateId: 'tmpl_dispatch_addon',
      purchaseId: 'mkt_purchase_abc',
      type: 'marketplace_purchase',
      discountBadgeApplied: 'true',
      discountBadgeCouponId: 'coupon_market10',
      discountBadgePromotionCode: 'MARKET10',
    });
  });

  it('honours the marker on a marketplace invoice that was already stamped (idempotent retry)', async () => {
    await handleInvoiceFinalized(
      makeOneOffInvoice({
        metadata: {
          tenantId: 'tenant_42',
          purchaseId: 'mkt_purchase_abc',
          type: 'marketplace_purchase',
          discountBadgeApplied: 'true',
        },
      }),
    );
    expect(invoicesRetrieveMock).not.toHaveBeenCalled();
    expect(invoicesUpdateMock).not.toHaveBeenCalled();
  });

  it('skips a one-off invoice with no discount (charge-only marketplace purchases)', async () => {
    await handleInvoiceFinalized(
      makeOneOffInvoice({
        total_discount_amounts: null,
        metadata: { type: 'marketplace_purchase', purchaseId: 'mkt_p_2' },
      }),
    );
    expect(invoicesRetrieveMock).not.toHaveBeenCalled();
    expect(invoicesUpdateMock).not.toHaveBeenCalled();
  });

  it('mirrors the discount onto the marketplace_purchases row via metadata.purchaseId (Task #1373)', async () => {
    invoicesRetrieveMock.mockResolvedValue({
      id: 'in_oneoff_123',
      subscription: null,
      discounts: [
        {
          coupon: {
            id: 'coupon_market10',
            name: 'Marketplace Promo',
            percent_off: 10,
            valid: true,
          },
          promotion_code: { id: 'promo_market', code: 'MARKET10' },
        },
      ],
    });

    await handleInvoiceFinalized(
      makeOneOffInvoice({
        metadata: {
          tenantId: 'tenant_42',
          purchaseId: 'mkt_purchase_abc',
          type: 'marketplace_purchase',
        },
      }),
    );

    expect(applyInvoiceDiscountToPurchaseMock).toHaveBeenCalledTimes(1);
    const [purchaseId, discount] = applyInvoiceDiscountToPurchaseMock.mock.calls[0];
    expect(purchaseId).toBe('mkt_purchase_abc');
    expect(discount).toMatchObject({
      couponId: 'coupon_market10',
      name: 'Marketplace Promo',
      percentOff: 10,
      promotionCode: 'MARKET10',
    });
    // The subscription-id fallback lookup must NOT fire when the
    // one-off purchaseId metadata already resolves the row — otherwise
    // every marketplace invoice would issue an extra DB round-trip.
    expect(poolQueryMock).not.toHaveBeenCalled();
  });

  it('mirrors the discount onto a subscription marketplace purchase via stripe_subscription_id', async () => {
    invoicesRetrieveMock.mockResolvedValue({
      id: 'in_sub_456',
      subscription: 'sub_marketplace_xyz',
      discounts: [
        {
          coupon: {
            id: 'coupon_loyal',
            name: 'Loyalty 20',
            percent_off: 20,
            valid: true,
          },
          promotion_code: null,
        },
      ],
    });
    poolQueryMock.mockResolvedValueOnce({
      rows: [{ id: 'mkt_sub_purchase_999' }],
    });

    await handleInvoiceFinalized({
      ...makeOneOffInvoice({ id: 'in_sub_456' }),
      // Subscription invoices carry no `purchaseId` metadata — the
      // mirror must fall back to the subscription-id join key.
      subscription: 'sub_marketplace_xyz',
      subscription_details: { metadata: null },
      billing_reason: 'subscription_cycle',
      metadata: {},
    } as unknown as Stripe.Invoice);

    expect(poolQueryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = poolQueryMock.mock.calls[0];
    expect(String(sql)).toContain('stripe_subscription_id');
    expect(params).toEqual(['sub_marketplace_xyz']);

    expect(applyInvoiceDiscountToPurchaseMock).toHaveBeenCalledTimes(1);
    const [purchaseId, discount] = applyInvoiceDiscountToPurchaseMock.mock.calls[0];
    expect(purchaseId).toBe('mkt_sub_purchase_999');
    expect(discount).toMatchObject({
      couponId: 'coupon_loyal',
      percentOff: 20,
    });
  });

  it('does not mirror when no purchaseId metadata and no matching subscription row exists', async () => {
    invoicesRetrieveMock.mockResolvedValue({
      id: 'in_sub_orphan',
      subscription: 'sub_unknown',
      discounts: [
        {
          coupon: { id: 'c1', percent_off: 10, valid: true },
          promotion_code: null,
        },
      ],
    });
    poolQueryMock.mockResolvedValueOnce({ rows: [] });

    await handleInvoiceFinalized({
      ...makeOneOffInvoice({ id: 'in_sub_orphan' }),
      subscription: 'sub_unknown',
      metadata: {},
    } as unknown as Stripe.Invoice);

    // The PDF stamp still happens — but the mirror is a no-op because
    // there's no marketplace_purchases row to update.
    expect(invoicesUpdateMock).toHaveBeenCalledTimes(1);
    expect(applyInvoiceDiscountToPurchaseMock).not.toHaveBeenCalled();
  });

  it('does not throw when the marketplace mirror call fails (PDF stamp is the source of truth)', async () => {
    invoicesRetrieveMock.mockResolvedValue({
      id: 'in_oneoff_123',
      discounts: [
        {
          coupon: { id: 'coupon_x', percent_off: 5, valid: true },
          promotion_code: null,
        },
      ],
    });
    applyInvoiceDiscountToPurchaseMock.mockRejectedValueOnce(
      new Error('db down'),
    );

    await expect(
      handleInvoiceFinalized(
        makeOneOffInvoice({
          metadata: { purchaseId: 'mkt_p_99', type: 'marketplace_purchase' },
        }),
      ),
    ).resolves.toBeUndefined();
    // PDF still got stamped — mirror failure must never poison the
    // primary receipt-PDF flow.
    expect(invoicesUpdateMock).toHaveBeenCalledTimes(1);
  });

  it('handles an unexpanded promotion_code (string id only) on a marketplace invoice', async () => {
    // When the marketplace Checkout session forwards a promo code via
    // `allow_promotion_codes`, Stripe sometimes returns the discount
    // with `promotion_code` as the bare `promo_*` id (unexpanded) rather
    // than the full object. `normalizeDiscount` treats that as the
    // forwardable id with no human label — we still want to stamp the
    // coupon name so the badge isn't blank.
    invoicesRetrieveMock.mockResolvedValue({
      id: 'in_oneoff_123',
      subscription: null,
      discounts: [
        {
          coupon: {
            id: 'coupon_x',
            name: 'Friends and Family',
            percent_off: 20,
            valid: true,
          },
          promotion_code: 'promo_unexpanded_xyz',
        },
      ],
    });

    await handleInvoiceFinalized(makeOneOffInvoice());

    expect(invoicesUpdateMock).toHaveBeenCalledTimes(1);
    const [, args] = invoicesUpdateMock.mock.calls[0];
    // Falls back to the coupon name when there's no human-readable
    // promo code on the discount object.
    expect(args.custom_fields[0].value).toBe('Friends and Family - 20% off');
    expect(args.metadata.discountBadgeCouponId).toBe('coupon_x');
    expect(args.metadata.discountBadgePromotionCode).toBe('');
  });
});

describe('formatDiscountBadgeLabel / formatDiscountFooter', () => {
  it('uses promo code in label when available', () => {
    expect(
      formatDiscountBadgeLabel({
        couponId: 'c',
        name: 'Promo',
        percentOff: 25,
        amountOffCents: null,
        currency: null,
        promotionCode: 'PROMO25',
        promotionCodeId: 'promo_x',
      }),
    ).toBe('PROMO25 - 25% off');
  });

  it('falls back to coupon name then id', () => {
    expect(
      formatDiscountBadgeLabel({
        couponId: 'c',
        name: 'Promo',
        percentOff: null,
        amountOffCents: null,
        currency: null,
        promotionCode: null,
        promotionCodeId: null,
      }),
    ).toBe('Promo');
    expect(
      formatDiscountBadgeLabel({
        couponId: 'coupon_x',
        name: null,
        percentOff: null,
        amountOffCents: null,
        currency: null,
        promotionCode: null,
        promotionCodeId: null,
      }),
    ).toBe('coupon_x');
  });

  it('formats footer with "promo code" vs "coupon" labels', () => {
    expect(
      formatDiscountFooter({
        couponId: 'c',
        name: 'Spring',
        percentOff: 25,
        amountOffCents: null,
        currency: null,
        promotionCode: 'PROMO25',
        promotionCodeId: 'promo_x',
      }),
    ).toContain('promo code "PROMO25"');
    expect(
      formatDiscountFooter({
        couponId: 'c',
        name: 'Spring',
        percentOff: 25,
        amountOffCents: null,
        currency: null,
        promotionCode: null,
        promotionCodeId: null,
      }),
    ).toContain('coupon "Spring"');
  });
});
