/**
 * Helpers for previewing the buyer's active customer-level Stripe
 * discount on the in-app marketplace UI before redirect to Stripe
 * Checkout (Task #1380).
 *
 * Server-side, `createMarketplacePurchase` already forwards the
 * customer-level discount onto the Checkout session via
 * `loadActiveCustomerDiscount` (Task #1372). These helpers mirror that
 * server-side discount math so the listing-card price, the detail-view
 * header, and the Purchase CTA panel can preview the SAME discounted
 * figure the buyer will see on the hosted Checkout page — the in-app
 * preview never disagrees with what Stripe will collect.
 *
 * The `MarketplaceCustomerDiscount` shape mirrors `PurchaseDiscountSummary`
 * (the row-level shape `marketplace_purchases` already serves) so a
 * single renderer can drive the listing preview chip AND the
 * post-purchase history chip.
 */
import { formatCents as formatCentsHelper } from './formatCurrency';

export interface MarketplaceCustomerDiscount {
  couponId: string | null;
  name: string | null;
  promotionCode: string | null;
  percentOff: number | null;
  amountOffCents: number | null;
  currency: string | null;
}

/**
 * Apply a customer-level Stripe discount to a template's listed price
 * cents. Mirrors the math `applyDiscountToBaseCents` does server-side in
 * `effectiveRate.ts` — including the floor at zero for amount-off
 * coupons that exceed the price — so the UI preview matches what
 * Stripe will charge after the redirect. Returns the input untouched
 * when no discount applies, when the discount is malformed, or for
 * free templates (we never show "$0 was Free" — that's noise).
 */
export function applyDiscountToCents(
  priceCents: number,
  discount: MarketplaceCustomerDiscount | null | undefined,
): number {
  if (!discount || priceCents <= 0) return priceCents;
  if (discount.percentOff != null && Number.isFinite(discount.percentOff)) {
    const pct = Math.max(0, Math.min(100, discount.percentOff));
    return Math.max(0, Math.round(priceCents * (1 - pct / 100)));
  }
  if (
    discount.amountOffCents != null
    && Number.isFinite(discount.amountOffCents)
  ) {
    return Math.max(0, priceCents - discount.amountOffCents);
  }
  return priceCents;
}

/**
 * Whether this discount actually moves the listed price. A coupon with
 * `percentOff: 0` or `amountOffCents: 0` is technically "active" on the
 * customer but yields no UI change — gating on this keeps the
 * strikethrough + "X% off" chip from rendering on listings that
 * wouldn't see a different number at Checkout.
 */
export function discountReducesPrice(
  discount: MarketplaceCustomerDiscount | null | undefined,
): boolean {
  if (!discount) return false;
  if (
    discount.percentOff != null
    && Number.isFinite(discount.percentOff)
    && discount.percentOff > 0
  ) {
    return true;
  }
  if (
    discount.amountOffCents != null
    && Number.isFinite(discount.amountOffCents)
    && discount.amountOffCents > 0
  ) {
    return true;
  }
  return false;
}

/**
 * Compact "X% off" / "$5.00 off" label for the discount chip rendered
 * next to (or beneath) a discounted price. Distinct from the
 * post-purchase `formatPurchaseDiscountLabel`: that chip surfaces the
 * full "X off — PROMO" attribution because the price has already been
 * paid; the listing preview chip lives next to a price string and just
 * needs to tell the buyer how much is being knocked off.
 */
export function formatDiscountChipLabel(
  discount: MarketplaceCustomerDiscount,
  fallbackCurrency: string,
): string {
  if (discount.percentOff != null && Number.isFinite(discount.percentOff)) {
    const pct = Number.isInteger(discount.percentOff)
      ? discount.percentOff
      : Math.round(discount.percentOff * 100) / 100;
    return `${pct}% off`;
  }
  if (
    discount.amountOffCents != null
    && Number.isFinite(discount.amountOffCents)
  ) {
    const ccy = (discount.currency || fallbackCurrency || 'usd').toUpperCase();
    return `${formatCentsHelper(discount.amountOffCents, { currency: ccy })} off`;
  }
  return 'Discount applied';
}

/**
 * Tooltip text for the listing-preview discount chip. The chip itself
 * is space-constrained so we keep the visible label compact; the
 * tooltip carries the full coupon attribution (name + promo code + the
 * "applied at checkout" assurance) so a buyer hovering the chip
 * understands exactly which coupon is being used and that the price
 * they see in-app is what Stripe Checkout will collect.
 */
export function buildDiscountChipTooltip(
  discount: MarketplaceCustomerDiscount,
  fallbackCurrency: string,
): string {
  const tail = discount.promotionCode || discount.name;
  const head = formatDiscountChipLabel(discount, fallbackCurrency);
  return tail
    ? `${head} — ${tail} applied at checkout`
    : `${head} applied at checkout`;
}
