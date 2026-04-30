import { describe, expect, it, vi } from 'vitest';

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { loadActiveCustomerDiscount } from '../../platform/billing/stripe/effectiveRate';

function makeStripe(retrieveImpl: (id: string, opts?: unknown) => Promise<unknown>) {
  return {
    customers: { retrieve: vi.fn(retrieveImpl) },
  } as unknown as Parameters<typeof loadActiveCustomerDiscount>[0];
}

describe('loadActiveCustomerDiscount', () => {
  it('returns a normalised discount with the promotion code label and id', async () => {
    const stripe = makeStripe(async () => ({
      id: 'cus_active',
      currency: 'usd',
      discount: {
        coupon: {
          id: 'coupon_promo25',
          name: 'Spring Promo',
          percent_off: 25,
          amount_off: null,
          currency: null,
          valid: true,
          redeem_by: null,
        },
        promotion_code: { id: 'promo_xyz', code: 'PROMO25' },
        end: null,
      },
    }));

    const result = await loadActiveCustomerDiscount(stripe, 'cus_active', {
      tenantId: 'tenant-a',
      surface: 'test',
    });

    expect(result).toEqual({
      couponId: 'coupon_promo25',
      name: 'Spring Promo',
      percentOff: 25,
      amountOffCents: null,
      currency: null,
      promotionCode: 'PROMO25',
      promotionCodeId: 'promo_xyz',
    });
  });

  it('returns null when the customer has no discount attached', async () => {
    const stripe = makeStripe(async () => ({
      id: 'cus_no_discount',
      currency: 'usd',
      discount: null,
    }));

    const result = await loadActiveCustomerDiscount(stripe, 'cus_no_discount', {
      tenantId: 'tenant-b',
      surface: 'test',
    });
    expect(result).toBeNull();
  });

  it('returns null when the underlying coupon is no longer valid', async () => {
    const stripe = makeStripe(async () => ({
      id: 'cus_invalid',
      discount: {
        coupon: {
          id: 'coupon_dead',
          percent_off: 50,
          valid: false,
        },
      },
    }));

    const result = await loadActiveCustomerDiscount(stripe, 'cus_invalid', {
      tenantId: 'tenant-c',
      surface: 'test',
    });
    expect(result).toBeNull();
  });

  it("returns null when the discount's `end` is in the past", async () => {
    const stripe = makeStripe(async () => ({
      id: 'cus_expired',
      discount: {
        coupon: { id: 'c1', percent_off: 10, valid: true },
        end: Math.floor(Date.now() / 1000) - 60,
      },
    }));

    const result = await loadActiveCustomerDiscount(stripe, 'cus_expired', {
      tenantId: 'tenant-d',
      surface: 'test',
    });
    expect(result).toBeNull();
  });

  it('returns null when Stripe reports the customer has been deleted', async () => {
    const stripe = makeStripe(async () => ({
      id: 'cus_gone',
      deleted: true,
    }));

    const result = await loadActiveCustomerDiscount(stripe, 'cus_gone', {
      tenantId: 'tenant-e',
      surface: 'test',
    });
    expect(result).toBeNull();
  });

  it('swallows Stripe errors and returns null', async () => {
    const stripe = makeStripe(async () => {
      throw new Error('network down');
    });

    const result = await loadActiveCustomerDiscount(stripe, 'cus_err', {
      tenantId: 'tenant-f',
      surface: 'test',
    });
    expect(result).toBeNull();
  });

  it('expands the promotion code on retrieval', async () => {
    const retrieve = vi.fn(async () => ({
      id: 'cus_expand',
      discount: {
        coupon: { id: 'coup_x', percent_off: 15, valid: true },
        promotion_code: { id: 'promo_x', code: 'WELCOME15' },
      },
    }));
    const stripe = makeStripe(retrieve);

    await loadActiveCustomerDiscount(stripe, 'cus_expand', {
      tenantId: 'tenant-g',
      surface: 'test',
    });

    expect(retrieve).toHaveBeenCalledWith('cus_expand', {
      expand: ['discount.promotion_code'],
    });
  });
});
