/**
 * Unit coverage for the Stripe price helpers in
 * `shared/billing/stripeUnitAmount.ts`.
 *
 * The contract these helpers protect:
 *   1. `unit_amount_decimal` always wins over `unit_amount` when both
 *      are present (Stripe lossily rounds the integer field for sub-cent
 *      metered prices, e.g. `unit_amount_decimal: "7.5"` shows up as
 *      `unit_amount: 8`, biasing the quote ~7% high).
 *   2. The dollars helper preserves sub-cent precision (no `Math.round`).
 *   3. The whole-cents helper rounds to the nearest integer cent (for
 *      columns that store integer cents).
 *   4. Missing / empty / non-finite inputs return `null` so callers can
 *      fall back to catalog defaults instead of rendering NaN.
 */
import { describe, expect, it } from 'vitest';
import {
  stripeUnitAmountToCents,
  stripeUnitAmountToDollars,
  stripeUnitAmountToWholeCents,
} from '../../shared/billing/stripeUnitAmount';

describe('stripeUnitAmountToDollars', () => {
  it('prefers unit_amount_decimal so sub-cent precision survives', () => {
    // Stripe stores 7.5¢/min as `unit_amount_decimal: "7.5"` and lossily
    // rounds `unit_amount` to 8. The integer field would over-quote the
    // tenant by 6.7% — the decimal field is the source of truth.
    expect(
      stripeUnitAmountToDollars({ unit_amount: 8, unit_amount_decimal: '7.5' }),
    ).toBeCloseTo(0.075, 6);
  });

  it('handles whole-cent decimal strings', () => {
    expect(
      stripeUnitAmountToDollars({ unit_amount: 9, unit_amount_decimal: '9' }),
    ).toBeCloseTo(0.09, 6);
  });

  it('handles deeply fractional cents (multiple decimal places)', () => {
    // Stripe permits up to 12 decimal places on `unit_amount_decimal`.
    expect(
      stripeUnitAmountToDollars({
        unit_amount: 0,
        unit_amount_decimal: '0.001',
      }),
    ).toBeCloseTo(0.00001, 10);
    expect(
      stripeUnitAmountToDollars({
        unit_amount: 1,
        unit_amount_decimal: '1.234567',
      }),
    ).toBeCloseTo(0.01234567, 10);
  });

  it('handles large integer prices (e.g. annual base price in cents)', () => {
    // $12,000/yr stored as 1,200,000 cents.
    expect(
      stripeUnitAmountToDollars({
        unit_amount: 1_200_000,
        unit_amount_decimal: '1200000',
      }),
    ).toBeCloseTo(12_000, 6);
  });

  it('falls back to unit_amount when unit_amount_decimal is null', () => {
    expect(
      stripeUnitAmountToDollars({ unit_amount: 250, unit_amount_decimal: null }),
    ).toBeCloseTo(2.5, 6);
  });

  it('falls back to unit_amount when unit_amount_decimal is empty string', () => {
    // Stripe sometimes returns "" rather than null on legacy prices.
    expect(
      stripeUnitAmountToDollars({ unit_amount: 250, unit_amount_decimal: '' }),
    ).toBeCloseTo(2.5, 6);
  });

  it('falls back to unit_amount when unit_amount_decimal is unparseable', () => {
    expect(
      stripeUnitAmountToDollars({
        unit_amount: 7,
        unit_amount_decimal: 'NaN',
      }),
    ).toBeCloseTo(0.07, 6);
    expect(
      stripeUnitAmountToDollars({
        unit_amount: 7,
        unit_amount_decimal: 'abc',
      }),
    ).toBeCloseTo(0.07, 6);
  });

  it('returns 0 for explicit zero unit_amount_decimal (e.g. free tier)', () => {
    // "0" must NOT trip the empty-string fallback — a $0 metered tier
    // is a real Stripe configuration (free overage on a grandfathered
    // plan).
    expect(
      stripeUnitAmountToDollars({ unit_amount: 99, unit_amount_decimal: '0' }),
    ).toBe(0);
  });

  it('handles unit_amount of 0', () => {
    expect(
      stripeUnitAmountToDollars({ unit_amount: 0, unit_amount_decimal: null }),
    ).toBe(0);
  });

  it('returns null when both fields are null/undefined', () => {
    expect(stripeUnitAmountToDollars({ unit_amount: null, unit_amount_decimal: null }))
      .toBeNull();
    expect(stripeUnitAmountToDollars({})).toBeNull();
  });

  it('returns null when unit_amount is non-finite (Infinity/NaN)', () => {
    expect(
      stripeUnitAmountToDollars({
        unit_amount: Number.POSITIVE_INFINITY,
        unit_amount_decimal: null,
      }),
    ).toBeNull();
    expect(
      stripeUnitAmountToDollars({
        unit_amount: Number.NaN,
        unit_amount_decimal: null,
      }),
    ).toBeNull();
  });

  it('returns null for null/undefined input', () => {
    expect(stripeUnitAmountToDollars(null)).toBeNull();
    expect(stripeUnitAmountToDollars(undefined)).toBeNull();
  });
});

describe('stripeUnitAmountToCents', () => {
  it('returns the precise (possibly fractional) cents value', () => {
    expect(
      stripeUnitAmountToCents({ unit_amount: 8, unit_amount_decimal: '7.5' }),
    ).toBeCloseTo(7.5, 10);
    expect(
      stripeUnitAmountToCents({ unit_amount: 1, unit_amount_decimal: '1.234567' }),
    ).toBeCloseTo(1.234567, 10);
  });

  it('returns the integer when only unit_amount is present', () => {
    expect(
      stripeUnitAmountToCents({ unit_amount: 29_900, unit_amount_decimal: null }),
    ).toBe(29_900);
  });

  it('returns null for empty input', () => {
    expect(stripeUnitAmountToCents(null)).toBeNull();
    expect(stripeUnitAmountToCents({})).toBeNull();
    expect(stripeUnitAmountToCents({ unit_amount: null, unit_amount_decimal: null })).toBeNull();
  });
});

describe('stripeUnitAmountToWholeCents', () => {
  it('rounds fractional cents to the nearest integer cent', () => {
    // 7.5 rounds up to 8 (banker's note: JS Math.round goes 0.5→1 for
    // positive numbers, which matches the existing behaviour of
    // `pickBasePriceCents`).
    expect(
      stripeUnitAmountToWholeCents({ unit_amount: 8, unit_amount_decimal: '7.5' }),
    ).toBe(8);
    expect(
      stripeUnitAmountToWholeCents({ unit_amount: 7, unit_amount_decimal: '7.4' }),
    ).toBe(7);
    expect(
      stripeUnitAmountToWholeCents({ unit_amount: 100, unit_amount_decimal: '99.6' }),
    ).toBe(100);
  });

  it('passes integer unit_amount through unchanged', () => {
    expect(
      stripeUnitAmountToWholeCents({
        unit_amount: 29_900,
        unit_amount_decimal: '29900',
      }),
    ).toBe(29_900);
    expect(
      stripeUnitAmountToWholeCents({
        unit_amount: 29_900,
        unit_amount_decimal: null,
      }),
    ).toBe(29_900);
  });

  it('returns 0 for explicit-zero unit_amount_decimal', () => {
    expect(
      stripeUnitAmountToWholeCents({ unit_amount: 99, unit_amount_decimal: '0' }),
    ).toBe(0);
  });

  it('returns null for empty input', () => {
    expect(stripeUnitAmountToWholeCents(null)).toBeNull();
    expect(stripeUnitAmountToWholeCents({})).toBeNull();
    expect(
      stripeUnitAmountToWholeCents({ unit_amount: null, unit_amount_decimal: null }),
    ).toBeNull();
  });
});
