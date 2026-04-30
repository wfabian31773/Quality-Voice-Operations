import { describe, expect, it, vi } from 'vitest';

vi.mock('../../platform/core/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { loadActiveSubscriptionDiscounts } from '../../platform/billing/stripe/effectiveRate';

describe('loadActiveSubscriptionDiscounts', () => {
  it('hydrates a bare discounts[].source.promotion_code id and normalises it', async () => {
    const subscriptionsRetrieve = vi.fn(async () => ({
      id: 'sub_modern',
      discounts: [
        {
          source: { type: 'promotion_code', promotion_code: 'promo_sub_bare' },
        },
      ],
    }));
    const promotionCodesRetrieve = vi.fn(async () => ({
      id: 'promo_sub_bare',
      code: 'WELCOME40',
      coupon: { id: 'coup_sub', percent_off: 40, valid: true, name: 'WELCOME40' },
    }));
    const stripe = {
      subscriptions: { retrieve: subscriptionsRetrieve },
      promotionCodes: { retrieve: promotionCodesRetrieve },
    } as unknown as Parameters<typeof loadActiveSubscriptionDiscounts>[0];

    const result = await loadActiveSubscriptionDiscounts(stripe, 'sub_modern', {
      tenantId: 'tenant-sub',
      surface: 'test',
    });

    expect(subscriptionsRetrieve).toHaveBeenCalledWith('sub_modern', {
      expand: ['discounts.promotion_code', 'discounts.source.coupon'],
    });
    expect(promotionCodesRetrieve).toHaveBeenCalledWith('promo_sub_bare', {
      expand: ['coupon'],
    });
    expect(result).toEqual([
      {
        couponId: 'coup_sub',
        name: 'WELCOME40',
        percentOff: 40,
        amountOffCents: null,
        currency: null,
        promotionCode: 'WELCOME40',
        promotionCodeId: 'promo_sub_bare',
      },
    ]);
  });

  it('falls back to the legacy single discount field when discounts[] is empty', async () => {
    const subscriptionsRetrieve = vi.fn(async () => ({
      id: 'sub_legacy',
      discounts: [],
      discount: {
        coupon: { id: 'coup_legacy', percent_off: 10, valid: true, name: 'LEGACY10' },
      },
    }));
    const stripe = {
      subscriptions: { retrieve: subscriptionsRetrieve },
      promotionCodes: { retrieve: vi.fn() },
    } as unknown as Parameters<typeof loadActiveSubscriptionDiscounts>[0];

    const result = await loadActiveSubscriptionDiscounts(stripe, 'sub_legacy', {
      tenantId: 'tenant-sub-legacy',
      surface: 'test',
    });
    expect(result).toEqual([
      {
        couponId: 'coup_legacy',
        name: 'LEGACY10',
        percentOff: 10,
        amountOffCents: null,
        currency: null,
        promotionCode: null,
        promotionCodeId: null,
      },
    ]);
  });

  it('returns [] when the subscription retrieve throws', async () => {
    const stripe = {
      subscriptions: {
        retrieve: vi.fn(async () => {
          throw new Error('not found');
        }),
      },
      promotionCodes: { retrieve: vi.fn() },
    } as unknown as Parameters<typeof loadActiveSubscriptionDiscounts>[0];

    const result = await loadActiveSubscriptionDiscounts(stripe, 'sub_dead', {
      tenantId: 'tenant-sub-fail',
      surface: 'test',
    });
    expect(result).toEqual([]);
  });
});
