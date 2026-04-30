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

  it('expands both legacy and modern discount shapes on retrieval', async () => {
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
      expand: ['discount.promotion_code', 'discount.source.coupon'],
    });
  });

  it('normalizes the modern discount.source shape (>= 2025-04-30.basil)', async () => {
    const retrieve = vi.fn(async () => ({
      id: 'cus_modern',
      discount: {
        source: {
          type: 'coupon',
          coupon: { id: 'coup_modern', percent_off: 25, valid: true, name: 'WELCOME25' },
        },
      },
    }));
    const stripe = makeStripe(retrieve);

    const result = await loadActiveCustomerDiscount(stripe, 'cus_modern', {
      tenantId: 'tenant-h',
      surface: 'test',
    });

    expect(result).toEqual({
      couponId: 'coup_modern',
      name: 'WELCOME25',
      percentOff: 25,
      amountOffCents: null,
      currency: null,
      promotionCode: null,
      promotionCodeId: null,
    });
  });

  it('hydrates a bare source.promotion_code id by retrieving the promotion code', async () => {
    const retrieve = vi.fn(async () => ({
      id: 'cus_promo_source',
      discount: {
        source: { type: 'promotion_code', promotion_code: 'promo_bare' },
      },
    }));
    const promotionCodesRetrieve = vi.fn(async () => ({
      id: 'promo_bare',
      code: 'WELCOME30',
      coupon: { id: 'coup_h', percent_off: 30, valid: true, name: 'WELCOME30' },
    }));
    const stripe = {
      customers: { retrieve },
      promotionCodes: { retrieve: promotionCodesRetrieve },
    } as unknown as Parameters<typeof loadActiveCustomerDiscount>[0];

    const result = await loadActiveCustomerDiscount(stripe, 'cus_promo_source', {
      tenantId: 'tenant-i',
      surface: 'test',
    });

    expect(promotionCodesRetrieve).toHaveBeenCalledWith('promo_bare', {
      expand: ['coupon'],
    });
    expect(result).toEqual({
      couponId: 'coup_h',
      name: 'WELCOME30',
      percentOff: 30,
      amountOffCents: null,
      currency: null,
      promotionCode: 'WELCOME30',
      promotionCodeId: 'promo_bare',
    });
  });

  it('returns null (and warns) when the promotion-code hydration fetch fails', async () => {
    const retrieve = vi.fn(async () => ({
      id: 'cus_fail_hydrate',
      discount: {
        source: { type: 'promotion_code', promotion_code: 'promo_dead' },
      },
    }));
    const promotionCodesRetrieve = vi.fn(async () => {
      throw new Error('promotion code not found');
    });
    const stripe = {
      customers: { retrieve },
      promotionCodes: { retrieve: promotionCodesRetrieve },
    } as unknown as Parameters<typeof loadActiveCustomerDiscount>[0];

    const result = await loadActiveCustomerDiscount(stripe, 'cus_fail_hydrate', {
      tenantId: 'tenant-j',
      surface: 'test',
    });
    expect(result).toBeNull();
  });
});
