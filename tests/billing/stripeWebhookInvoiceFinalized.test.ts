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
} = vi.hoisted(() => ({
  invoicesRetrieveMock: vi.fn(),
  invoicesUpdateMock: vi.fn(),
}));

vi.mock('../../platform/db', () => ({
  getPlatformPool: () => ({
    query: vi.fn(),
    connect: vi.fn(),
  }),
  withTenantContext: vi.fn(
    async (_client: unknown, _tenantId: string, fn: () => Promise<void>) =>
      fn(),
  ),
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
