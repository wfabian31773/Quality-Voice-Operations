/**
 * Task #1380 — pin the math + label helpers that drive the in-app
 * marketplace customer-discount preview.
 *
 * Server-side, `createMarketplacePurchase` already forwards the
 * customer-level Stripe discount onto the Checkout session via
 * `loadActiveCustomerDiscount` (Task #1372). These client-side helpers
 * mirror the same discount math so the listing card, detail-view
 * header, and Purchase CTA preview the SAME discounted figure Stripe
 * will collect — a regression here would make the in-app price
 * disagree with the hosted Checkout total, exactly the trust gap
 * Task #1380 set out to close.
 *
 * What this test covers:
 *   1. `applyDiscountToCents` matches the server-side
 *      `applyDiscountToBaseCents` math: percent-off rounds, amount-off
 *      subtracts, both floor at zero, and free templates / no-discount
 *      inputs return the price untouched (so we never render
 *      "$0 was Free" noise on a free template).
 *   2. `discountReducesPrice` skips no-op discounts (`percentOff: 0`,
 *      `amountOffCents: 0`, malformed) so the strikethrough chip never
 *      renders for a coupon that wouldn't change the buyer's total.
 *   3. `formatDiscountChipLabel` renders the compact "X% off" /
 *      "$5.00 off" form used on the chip.
 *   4. `buildDiscountChipTooltip` carries the full coupon attribution
 *      (name + promo code + the "applied at checkout" assurance) so a
 *      buyer hovering the chip understands exactly which coupon is
 *      being used. The tooltip is the contract that lets buyers
 *      reconcile the in-app preview with the hosted Checkout total.
 */
import { describe, expect, it } from 'vitest';
import {
  applyDiscountToCents,
  buildDiscountChipTooltip,
  discountReducesPrice,
  formatDiscountChipLabel,
  type MarketplaceCustomerDiscount,
} from '../../client-app/src/lib/marketplaceDiscount';

const PERCENT_OFF: MarketplaceCustomerDiscount = {
  couponId: 'coupon_promo25',
  name: 'Spring Promo',
  promotionCode: 'PROMO25',
  percentOff: 25,
  amountOffCents: null,
  currency: null,
};

const AMOUNT_OFF: MarketplaceCustomerDiscount = {
  couponId: 'coupon_loyal_flat',
  name: 'Loyalty Flat $5',
  promotionCode: null,
  percentOff: null,
  amountOffCents: 500,
  currency: 'usd',
};

describe('applyDiscountToCents', () => {
  it('returns price unchanged when discount is null', () => {
    expect(applyDiscountToCents(4900, null)).toBe(4900);
    expect(applyDiscountToCents(4900, undefined)).toBe(4900);
  });

  it('returns price unchanged for free templates regardless of discount', () => {
    expect(applyDiscountToCents(0, PERCENT_OFF)).toBe(0);
    expect(applyDiscountToCents(0, AMOUNT_OFF)).toBe(0);
  });

  it('applies percent-off with rounded math (matches server effectiveRate.applyDiscountToBaseCents)', () => {
    // 4900 * (1 - 0.25) = 3675
    expect(applyDiscountToCents(4900, PERCENT_OFF)).toBe(3675);
    // 4999 * 0.75 = 3749.25 → rounds to 3749
    expect(applyDiscountToCents(4999, PERCENT_OFF)).toBe(3749);
  });

  it('clamps percent-off to 0..100 so a malformed 150% coupon never returns a negative price', () => {
    const overshoot: MarketplaceCustomerDiscount = { ...PERCENT_OFF, percentOff: 150 };
    expect(applyDiscountToCents(4900, overshoot)).toBe(0);
    const negative: MarketplaceCustomerDiscount = { ...PERCENT_OFF, percentOff: -25 };
    expect(applyDiscountToCents(4900, negative)).toBe(4900);
  });

  it('applies amount-off and floors at zero so a $50 amount-off on a $40 template renders $0 not -$10', () => {
    expect(applyDiscountToCents(4900, AMOUNT_OFF)).toBe(4400);
    const oversize: MarketplaceCustomerDiscount = { ...AMOUNT_OFF, amountOffCents: 10_000 };
    expect(applyDiscountToCents(4900, oversize)).toBe(0);
  });

  it('returns price unchanged when discount carries neither percent nor amount', () => {
    const empty: MarketplaceCustomerDiscount = {
      couponId: 'coupon_blank',
      name: null,
      promotionCode: null,
      percentOff: null,
      amountOffCents: null,
      currency: null,
    };
    expect(applyDiscountToCents(4900, empty)).toBe(4900);
  });
});

describe('discountReducesPrice', () => {
  it('returns false for null/undefined discount', () => {
    expect(discountReducesPrice(null)).toBe(false);
    expect(discountReducesPrice(undefined)).toBe(false);
  });

  it('returns false for no-op zero coupons (would not change the buyer\u2019s total)', () => {
    const zeroPct: MarketplaceCustomerDiscount = { ...PERCENT_OFF, percentOff: 0 };
    const zeroAmt: MarketplaceCustomerDiscount = { ...AMOUNT_OFF, amountOffCents: 0 };
    expect(discountReducesPrice(zeroPct)).toBe(false);
    expect(discountReducesPrice(zeroAmt)).toBe(false);
  });

  it('returns true for a real percent-off coupon', () => {
    expect(discountReducesPrice(PERCENT_OFF)).toBe(true);
  });

  it('returns true for a real amount-off coupon', () => {
    expect(discountReducesPrice(AMOUNT_OFF)).toBe(true);
  });
});

describe('formatDiscountChipLabel', () => {
  it('renders "X% off" for percent-off coupons', () => {
    expect(formatDiscountChipLabel(PERCENT_OFF, 'usd')).toBe('25% off');
  });

  it('renders fractional percents to 2dp without trailing noise', () => {
    const fractional: MarketplaceCustomerDiscount = { ...PERCENT_OFF, percentOff: 12.5 };
    expect(formatDiscountChipLabel(fractional, 'usd')).toBe('12.5% off');
  });

  it('renders amount-off in the discount\u2019s own currency, not the row currency', () => {
    expect(formatDiscountChipLabel(AMOUNT_OFF, 'usd')).toBe('$5.00 off');
    const eurDiscount: MarketplaceCustomerDiscount = { ...AMOUNT_OFF, currency: 'eur' };
    expect(formatDiscountChipLabel(eurDiscount, 'usd')).toBe('\u20AC5.00 off');
  });

  it('falls back to a generic "Discount applied" when neither field is populated', () => {
    const empty: MarketplaceCustomerDiscount = {
      couponId: 'coupon_blank',
      name: null,
      promotionCode: null,
      percentOff: null,
      amountOffCents: null,
      currency: null,
    };
    expect(formatDiscountChipLabel(empty, 'usd')).toBe('Discount applied');
  });
});

describe('buildDiscountChipTooltip', () => {
  it('prefers the promotion code as the attribution tail', () => {
    expect(buildDiscountChipTooltip(PERCENT_OFF, 'usd')).toBe(
      '25% off \u2014 PROMO25 applied at checkout',
    );
  });

  it('falls back to the coupon name when no promotion code exists', () => {
    expect(buildDiscountChipTooltip(AMOUNT_OFF, 'usd')).toBe(
      '$5.00 off \u2014 Loyalty Flat $5 applied at checkout',
    );
  });

  it('omits the attribution dash when neither name nor code is present', () => {
    const anon: MarketplaceCustomerDiscount = {
      couponId: 'coupon_anon',
      name: null,
      promotionCode: null,
      percentOff: 10,
      amountOffCents: null,
      currency: null,
    };
    expect(buildDiscountChipTooltip(anon, 'usd')).toBe('10% off applied at checkout');
  });
});
