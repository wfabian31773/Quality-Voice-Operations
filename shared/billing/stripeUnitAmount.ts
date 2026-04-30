/**
 * Canonical helpers for parsing Stripe price `unit_amount` /
 * `unit_amount_decimal` into precise dollar / cents values.
 *
 * Stripe represents per-line prices in two parallel fields:
 *   - `unit_amount`        — integer cents (e.g. `7` ⇒ $0.07/unit)
 *   - `unit_amount_decimal` — string cents that *may* carry sub-cent
 *                             precision (e.g. `"7.5"` ⇒ $0.075/unit)
 *
 * For ordinary prices the two agree, but for metered/usage-based prices
 * Stripe permits sub-cent precision and lossily rounds `unit_amount`
 * to the nearest whole cent (so `unit_amount_decimal === "7.5"` will
 * appear as `unit_amount === 8`, biasing the quote upward by ~7%).
 *
 * These helpers centralize the conversion in one tested module so that
 * call sites do not have to remember the precedence rules or
 * hand-roll `cents / 100` math (which the `local/no-cents-divided-by-100`
 * lint rule otherwise forbids — see `eslint.config.mjs`, where this
 * file is whitelisted alongside `formatCurrency.ts`).
 *
 * Use `stripeUnitAmountToDollars` for fractional dollar values
 * (per-minute overage rates, "$/unit" quotes, etc.).
 *
 * Use `stripeUnitAmountToCents` for the precise cents value
 * (which may itself be fractional, e.g. `7.5`).
 *
 * Use `stripeUnitAmountToWholeCents` for the integer-cents value
 * the platform stores in its own tables (base subscription prices,
 * `monthlyPriceCents` in `PLAN_CATALOG`, …).
 */

export interface StripeUnitAmountInput {
  unit_amount?: number | null;
  unit_amount_decimal?: string | null;
}

/**
 * Resolve a Stripe price's unit amount to a precise cents value,
 * preferring `unit_amount_decimal` when present so sub-cent precision
 * is preserved. Returns `null` if neither field is parseable.
 *
 * The returned value MAY be fractional (e.g. `7.5` for $0.075/unit).
 */
export function stripeUnitAmountToCents(
  price: StripeUnitAmountInput | null | undefined,
): number | null {
  if (!price) return null;
  const decimal = price.unit_amount_decimal;
  if (decimal != null && decimal !== '') {
    const cents = Number(decimal);
    if (Number.isFinite(cents)) return cents;
  }
  const integer = price.unit_amount;
  if (integer != null && Number.isFinite(integer)) return integer;
  return null;
}

/**
 * Resolve a Stripe price's unit amount to a precise dollar value.
 * Returns `null` if neither `unit_amount_decimal` nor `unit_amount`
 * is parseable.
 *
 * Sub-cent precision is preserved — `{unit_amount: 8,
 * unit_amount_decimal: "7.5"}` returns `0.075`, not `0.08`.
 */
export function stripeUnitAmountToDollars(
  price: StripeUnitAmountInput | null | undefined,
): number | null {
  const cents = stripeUnitAmountToCents(price);
  if (cents === null) return null;
  // NOTE: this is the canonical Stripe-price `cents / 100` site —
  // `local/no-cents-divided-by-100` does not flag it because this
  // file is exempted in `eslint.config.mjs` (alongside
  // `formatCurrency.ts`). Sub-cent precision (e.g. $0.075/min) MUST
  // survive here, so we cannot route through `formatCurrency` (string)
  // or `centsToWholeDollars` (rounds).
  return cents / 100;
}

/**
 * Resolve a Stripe price's unit amount to an integer cents value,
 * rounded to the nearest whole cent. Use when persisting into a
 * column that stores integer cents (e.g. the platform's
 * `subscriptions` / `PLAN_CATALOG` `*Cents` fields).
 *
 * Returns `null` if neither `unit_amount_decimal` nor `unit_amount`
 * is parseable.
 */
export function stripeUnitAmountToWholeCents(
  price: StripeUnitAmountInput | null | undefined,
): number | null {
  const cents = stripeUnitAmountToCents(price);
  if (cents === null) return null;
  return Math.round(cents);
}
