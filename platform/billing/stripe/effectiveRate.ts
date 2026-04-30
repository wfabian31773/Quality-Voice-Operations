import type Stripe from 'stripe';
import { getStripeClient } from './client';
import { getPlanFromPriceId } from './plans';
import { getPlatformPool, withTenantContext } from '../../db';
import { createLogger } from '../../core/logger';
import {
  PLAN_CATALOG,
  PLAN_TIERS,
  type PlanTier,
} from '../../../shared/billing/planCatalog';
import {
  stripeUnitAmountToDollars,
  stripeUnitAmountToWholeCents,
} from '../../../shared/billing/stripeUnitAmount';

const logger = createLogger('STRIPE_EFFECTIVE_RATE');

export type EffectiveRateSource = 'stripe' | 'catalog' | 'mixed';

export interface TenantEffectiveRate {
  /**
   * Plan tier we currently believe the tenant is on. Sourced from the
   * `subscriptions.plan` column when present, otherwise inferred from the
   * Stripe price id, otherwise defaulted to `starter`.
   */
  plan: PlanTier;
  /**
   * Monthly base price in cents that the tenant is actually billed for the
   * licensed (non-metered) recurring item on their Stripe subscription. Falls
   * back to the catalog `monthlyPriceCents` when no Stripe override exists.
   *
   * NOTE: this field is interval-agnostic — it always reports the monthly
   * equivalent of whatever interval the tenant's subscription is on. For an
   * apples-to-apples comparison between billing intervals (used by the
   * public pricing calculator's monthly/annual toggle) consume
   * `monthlyBasePriceCents` and `annualBasePriceCents` instead.
   */
  basePriceCents: number;
  /**
   * Per-minute overage rate in dollars (for parity with the catalog field
   * `overageRatePerMinute`). Sourced from the `unit_amount` on the metered
   * AI-minutes price line, or — failing that — the first metered price line
   * on the subscription. Falls back to the catalog rate when no Stripe
   * override exists.
   */
  overageRatePerMinute: number;
  /** Lower-case ISO currency code for the Stripe price (e.g. `usd`). */
  currency: string;
  /**
   * Where each field came from. `stripe` means both base AND overage came
   * from live Stripe data; `mixed` means at least one came from Stripe and
   * the other from the catalog; `catalog` means we found nothing on Stripe
   * and used catalog defaults end-to-end.
   */
  source: EffectiveRateSource;
  /**
   * Diagnostic breadcrumbs so the API consumer / debug UI can show whether
   * the override actually engaged.
   */
  basePriceSource: 'stripe' | 'catalog';
  overagePriceSource: 'stripe' | 'catalog';
  /** Stripe price ids that drove the override (when applicable). */
  basePriceId: string | null;
  overagePriceId: string | null;
  /**
   * Per-month price the tenant would pay billed *monthly*, in cents.
   * Resolved from the tenant's subscription when their subscription is
   * already on a monthly licensed price, otherwise from the published
   * `STRIPE_PRICE_<TIER>_MONTHLY` env var. Falls back to the catalog
   * `monthlyPriceCents` when neither yields data.
   */
  monthlyBasePriceCents: number;
  monthlyBasePriceSource: 'stripe' | 'catalog';
  monthlyBasePriceId: string | null;
  /**
   * Per-month *equivalent* of the annual billing price for the tenant's
   * tier, in cents (i.e. annual_total / 12). Resolved from the tenant's
   * subscription when their subscription is already on an annual licensed
   * price, otherwise from the published `STRIPE_PRICE_<TIER>_ANNUAL` env
   * var. Falls back to the catalog `monthlyPriceCents * (1 - 0.20)` when
   * neither yields data — which mirrors the marketing "Save 20%" badge.
   *
   * Lets the public pricing calculator render the live Stripe rate (with
   * the same badge) when the tenant flips the calculator to Annual,
   * instead of silently falling back to the catalog discount.
   */
  annualBasePriceCents: number;
  annualBasePriceSource: 'stripe' | 'catalog';
  annualBasePriceId: string | null;
}

interface SubscriptionRow {
  plan: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  stripe_customer_id: string | null;
}

function normalizePlan(plan: string | null | undefined): PlanTier {
  if (plan === 'starter' || plan === 'pro' || plan === 'enterprise') return plan;
  return 'starter';
}

/**
 * Annual discount marketing has been promising on the public pricing page
 * (and in `MinutesPricingCalculator.ANNUAL_DISCOUNT`). Used as the
 * catalog-fallback floor for `annualBasePriceCents` when neither the
 * tenant's subscription nor the published `STRIPE_PRICE_<TIER>_ANNUAL`
 * env var yields a Stripe price. Kept in lock-step with the marketing
 * constant by exporting it for tests; do not change without coordinating
 * with the public pricing UI.
 */
export const CATALOG_ANNUAL_DISCOUNT = 0.2;

function catalogAnnualEquivalentCents(monthlyCents: number): number {
  return Math.round(monthlyCents * (1 - CATALOG_ANNUAL_DISCOUNT));
}

function catalogFor(plan: PlanTier): TenantEffectiveRate {
  const entry = PLAN_CATALOG[plan];
  return {
    plan,
    basePriceCents: entry.monthlyPriceCents,
    overageRatePerMinute: entry.overageRatePerMinute,
    currency: 'usd',
    source: 'catalog',
    basePriceSource: 'catalog',
    overagePriceSource: 'catalog',
    basePriceId: null,
    overagePriceId: null,
    monthlyBasePriceCents: entry.monthlyPriceCents,
    monthlyBasePriceSource: 'catalog',
    monthlyBasePriceId: null,
    annualBasePriceCents: catalogAnnualEquivalentCents(entry.monthlyPriceCents),
    annualBasePriceSource: 'catalog',
    annualBasePriceId: null,
  };
}

interface PriceLike {
  id: string;
  unit_amount: number | null;
  unit_amount_decimal: string | null;
  currency: string | null;
  recurring: {
    usage_type?: string | null;
    interval?: string | null;
    interval_count?: number | null;
    meter?: string | null;
  } | null;
  metadata: Record<string, string> | null;
}

interface ItemLike {
  price: PriceLike | null;
}

/**
 * Decide whether a Stripe price represents a metered overage line and, if so,
 * whether it is for AI minutes (the only metric the bill estimator visualises
 * today).
 *
 * We match in this order so that a tenant with a custom price metadata set
 * always wins over the env-configured meter id, but a generic metered price
 * still gets picked up as the overage source if nothing else matches:
 *   1. `price.metadata.metric === 'ai_minutes'`
 *   2. `price.recurring.meter === STRIPE_METER_AI_MINUTES`
 *   3. `price.recurring.usage_type === 'metered'`
 */
function classifyPrice(price: PriceLike | null | undefined): {
  isMetered: boolean;
  isAiMinutes: boolean;
  isLicensedRecurring: boolean;
} {
  if (!price) {
    return { isMetered: false, isAiMinutes: false, isLicensedRecurring: false };
  }
  const usageType = price.recurring?.usage_type ?? null;
  const isMetered = usageType === 'metered';
  const isLicensedRecurring = !!price.recurring && (usageType === 'licensed' || usageType == null);

  const aiMeterEnv = process.env.STRIPE_METER_AI_MINUTES ?? null;
  const meterMatches = aiMeterEnv && price.recurring?.meter === aiMeterEnv;
  const metricMetaMatches = (price.metadata?.metric ?? '').toLowerCase() === 'ai_minutes';
  const isAiMinutes = isMetered && (metricMetaMatches || !!meterMatches);

  return { isMetered, isAiMinutes, isLicensedRecurring };
}

function unitAmountToDollarsPerMinute(price: PriceLike): number | null {
  // Delegate to the shared Stripe-price helper, which preserves sub-cent
  // precision (e.g. $0.075/min must NOT round to $0.08 — that would
  // silently over-quote the tenant). See
  // `shared/billing/stripeUnitAmount.ts` for the full rationale.
  return stripeUnitAmountToDollars(price);
}

function pickBasePriceCents(price: PriceLike): number | null {
  // Base prices live in integer-cents columns on our side (PLAN_CATALOG,
  // subscriptions), so round any fractional Stripe input to the nearest
  // whole cent.
  return stripeUnitAmountToWholeCents(price);
}

/**
 * Convert a Stripe-recurring base price (which may be billed annually) into
 * an equivalent monthly figure so the estimator can compare apples-to-apples
 * with `PLAN_CATALOG.monthlyPriceCents`.
 */
function normalizeBaseToMonthly(price: PriceLike, rawCents: number): number {
  const interval = price.recurring?.interval ?? 'month';
  const intervalCount = price.recurring?.interval_count ?? 1;
  if (interval === 'month') {
    return intervalCount > 1 ? Math.round(rawCents / intervalCount) : rawCents;
  }
  if (interval === 'year') {
    const months = 12 * (intervalCount || 1);
    return Math.round(rawCents / months);
  }
  if (interval === 'week') {
    const weeks = intervalCount || 1;
    return Math.round((rawCents * 52) / 12 / weeks);
  }
  if (interval === 'day') {
    const days = intervalCount || 1;
    return Math.round((rawCents * 365) / 12 / days);
  }
  return rawCents;
}

async function loadSubscriptionRow(tenantId: string): Promise<SubscriptionRow | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const { rows } = await client.query<SubscriptionRow>(
      `SELECT plan, stripe_subscription_id, stripe_price_id, stripe_customer_id
       FROM subscriptions
       WHERE tenant_id = $1
       LIMIT 1`,
      [tenantId],
    );
    await client.query('COMMIT');
    return rows[0] ?? null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.warn('Failed to load subscription row for effective rate', {
      tenantId,
      error: String(err),
    });
    return null;
  } finally {
    client.release();
  }
}

/**
 * Resolve the effective per-minute overage rate and base price for a tenant.
 *
 * The function NEVER throws — any failure (no Stripe key, network error, no
 * subscription row, missing items…) degrades gracefully to the catalog
 * defaults so the bill estimator always renders something sensible.
 */
export async function getTenantEffectiveRate(
  tenantId: string,
): Promise<TenantEffectiveRate> {
  const subRow = await loadSubscriptionRow(tenantId);

  // Infer the plan tier ASAP so even a Stripe-less fallback returns a
  // tenant-correct catalog row.
  const inferredPlan: PlanTier = (() => {
    if (subRow?.plan) {
      const normalized = normalizePlan(subRow.plan);
      if (normalized) return normalized;
    }
    if (subRow?.stripe_price_id) {
      try {
        return getPlanFromPriceId(subRow.stripe_price_id);
      } catch {
        /* fall through */
      }
    }
    return 'starter';
  })();

  const fallback = catalogFor(inferredPlan);

  if (!subRow?.stripe_subscription_id) {
    return fallback;
  }

  let stripe: Stripe;
  try {
    stripe = getStripeClient();
  } catch (err) {
    // Stripe key not configured (dev mode without secrets, or temporary
    // outage). Catalog fallback is the right answer here.
    logger.info('Stripe client unavailable — using catalog defaults', {
      tenantId,
      error: String(err),
    });
    return fallback;
  }

  let subscription: { items?: { data?: ItemLike[] } } | null = null;
  try {
    subscription = (await stripe.subscriptions.retrieve(
      subRow.stripe_subscription_id,
      { expand: ['items.data.price'] },
    )) as unknown as { items?: { data?: ItemLike[] } };
  } catch (err) {
    logger.warn('Failed to retrieve subscription from Stripe', {
      tenantId,
      subscriptionId: subRow.stripe_subscription_id,
      error: String(err),
    });
    return fallback;
  }

  const items = subscription?.items?.data ?? [];
  if (items.length === 0) {
    return fallback;
  }

  let basePrice: PriceLike | null = null;
  let aiMinutesPrice: PriceLike | null = null;
  let firstMeteredPrice: PriceLike | null = null;

  for (const item of items) {
    const price = item.price;
    if (!price) continue;
    const { isMetered, isAiMinutes, isLicensedRecurring } = classifyPrice(price);
    if (isAiMinutes && !aiMinutesPrice) aiMinutesPrice = price;
    if (isMetered && !firstMeteredPrice) firstMeteredPrice = price;
    if (isLicensedRecurring && !basePrice) basePrice = price;
  }

  // Prefer the explicitly-tagged AI minutes meter, fall back to whatever
  // metered line is on the subscription so a custom-priced grandfathered
  // tenant still wins over the catalog defaults.
  const overagePrice = aiMinutesPrice ?? firstMeteredPrice;

  let basePriceCents = fallback.basePriceCents;
  let basePriceSource: 'stripe' | 'catalog' = 'catalog';
  let basePriceId: string | null = null;
  let baseInterval: string | null = null;
  if (basePrice) {
    const raw = pickBasePriceCents(basePrice);
    if (raw != null) {
      basePriceCents = normalizeBaseToMonthly(basePrice, raw);
      basePriceSource = 'stripe';
      basePriceId = basePrice.id;
      baseInterval = basePrice.recurring?.interval ?? null;
    }
  }

  let overageRatePerMinute = fallback.overageRatePerMinute;
  let overagePriceSource: 'stripe' | 'catalog' = 'catalog';
  let overagePriceId: string | null = null;
  if (overagePrice) {
    const dollarsPerMin = unitAmountToDollarsPerMinute(overagePrice);
    if (dollarsPerMin != null) {
      overageRatePerMinute = dollarsPerMin;
      overagePriceSource = 'stripe';
      overagePriceId = overagePrice.id;
    }
  }

  const currency = (
    basePrice?.currency
    ?? overagePrice?.currency
    ?? fallback.currency
  ).toLowerCase();

  let source: EffectiveRateSource;
  if (basePriceSource === 'stripe' && overagePriceSource === 'stripe') {
    source = 'stripe';
  } else if (basePriceSource === 'stripe' || overagePriceSource === 'stripe') {
    source = 'mixed';
  } else {
    source = 'catalog';
  }

  // Resolve the per-interval base prices that power the public pricing
  // calculator's monthly/annual toggle. The interval that matches the
  // tenant's actual subscription reuses the sub-derived value we already
  // resolved above (so a custom-priced grandfathered tenant keeps their
  // negotiated rate). The other interval is fetched from the published
  // `STRIPE_PRICE_<TIER>_<INTERVAL>` env var so the calculator can show
  // the live Stripe rate (with the same badge) on either side of the
  // toggle instead of falling back to the catalog.
  const subIsMonthly = baseInterval === 'month' && basePriceSource === 'stripe';
  const subIsAnnual = baseInterval === 'year' && basePriceSource === 'stripe';

  let monthlyBasePriceCents = fallback.monthlyBasePriceCents;
  let monthlyBasePriceSource: 'stripe' | 'catalog' = 'catalog';
  let monthlyBasePriceId: string | null = null;
  if (subIsMonthly) {
    monthlyBasePriceCents = basePriceCents;
    monthlyBasePriceSource = 'stripe';
    monthlyBasePriceId = basePriceId;
  } else {
    const monthlyResolved = await resolvePublishedIntervalPrice(
      stripe,
      inferredPlan,
      'monthly',
      tenantId,
    );
    if (monthlyResolved) {
      monthlyBasePriceCents = monthlyResolved.cents;
      monthlyBasePriceSource = 'stripe';
      monthlyBasePriceId = monthlyResolved.id;
    }
  }

  let annualBasePriceCents = fallback.annualBasePriceCents;
  let annualBasePriceSource: 'stripe' | 'catalog' = 'catalog';
  let annualBasePriceId: string | null = null;
  if (subIsAnnual) {
    annualBasePriceCents = basePriceCents;
    annualBasePriceSource = 'stripe';
    annualBasePriceId = basePriceId;
  } else {
    const annualResolved = await resolvePublishedIntervalPrice(
      stripe,
      inferredPlan,
      'annual',
      tenantId,
    );
    if (annualResolved) {
      annualBasePriceCents = annualResolved.cents;
      annualBasePriceSource = 'stripe';
      annualBasePriceId = annualResolved.id;
    }
  }

  return {
    plan: inferredPlan,
    basePriceCents,
    overageRatePerMinute,
    currency,
    source,
    basePriceSource,
    overagePriceSource,
    basePriceId,
    overagePriceId,
    monthlyBasePriceCents,
    monthlyBasePriceSource,
    monthlyBasePriceId,
    annualBasePriceCents,
    annualBasePriceSource,
    annualBasePriceId,
  };
}

/**
 * Look up the published Stripe price for `<tier>/<interval>` via the
 * `STRIPE_PRICE_<TIER>_<INTERVAL>` env var, fetch it from Stripe, and
 * normalise its `unit_amount` to a per-month figure. Returns `null` when
 * the env var is not set, when Stripe returns no usable amount, or when
 * the API call throws — every failure path degrades silently so the
 * caller can keep its catalog fallback intact (the calculator must
 * always render *something*).
 */
async function resolvePublishedIntervalPrice(
  stripe: Stripe,
  plan: PlanTier,
  interval: 'monthly' | 'annual',
  tenantId: string,
): Promise<{ cents: number; id: string } | null> {
  const envKey = `STRIPE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`;
  const priceId = process.env[envKey] ?? null;
  if (!priceId) return null;

  try {
    const stripePrice = (await stripe.prices.retrieve(priceId)) as unknown as PriceLike;
    // Defence in depth: the env var convention assumes `_MONTHLY` points
    // at a `recurring.interval === 'month'` price and `_ANNUAL` at
    // `'year'`. A misconfigured env var that crosses the wires would,
    // post-`normalizeBaseToMonthly`, surface as a wrong dollar value
    // (e.g. an annual $3,600 price wired to `_MONTHLY` would normalise
    // to $300/mo and be shown as the "live monthly Stripe quote"). Fail
    // closed and let the catalog fallback take over instead.
    const expectedInterval = interval === 'monthly' ? 'month' : 'year';
    const actualInterval = stripePrice.recurring?.interval ?? null;
    if (actualInterval !== expectedInterval) {
      logger.warn('Published interval price has unexpected recurring.interval', {
        tenantId,
        plan,
        envKey,
        priceId,
        expectedInterval,
        actualInterval,
      });
      return null;
    }
    const raw = pickBasePriceCents(stripePrice);
    if (raw == null) return null;
    return {
      cents: normalizeBaseToMonthly(stripePrice, raw),
      id: stripePrice.id ?? priceId,
    };
  } catch (err) {
    logger.warn('Failed to retrieve published interval price for effective rate', {
      tenantId,
      plan,
      interval,
      priceId,
      error: String(err),
    });
    return null;
  }
}

/**
 * Discount we resolved off the tenant's Stripe customer record (or, in the
 * case of a single-shot promotion code redemption, off the Stripe `Coupon`
 * itself). All amounts here are *as Stripe stored them* — `percentOff` is a
 * 0–100 number, `amountOffCents` is in the smallest currency unit. The UI
 * is responsible for rendering it.
 */
export interface UpgradeDiscount {
  couponId: string | null;
  name: string | null;
  percentOff: number | null;
  amountOffCents: number | null;
  currency: string | null;
  promotionCode: string | null;
}

/**
 * Tenant-specific upgrade quote for a single target tier. Returned by
 * `getTenantUpgradePreview` and consumed by `GET /billing/upgrade-preview`.
 *
 * Mirrors the field set on `TenantEffectiveRate` so the BillingEstimator
 * can render the comparison-tier card with the same accent ("Live Stripe
 * rate") and provenance breadcrumbs as the current-tier card. The extra
 * `discount` field surfaces *why* the preview differs from the published
 * catalog, which Sales/Support need when a tenant questions the quote.
 */
export interface TenantUpgradePreview {
  /** The tier this preview is for (the value the caller asked about). */
  plan: PlanTier;
  /**
   * Effective monthly base price (in cents) the tenant would pay AFTER any
   * customer-level discount/coupon/promotion code is applied. Falls back to
   * the catalog `monthlyPriceCents` when no Stripe price/customer data is
   * available.
   */
  basePriceCents: number;
  /**
   * Per-minute overage rate (in dollars) the tenant would pay on the target
   * tier. We don't have a per-tier metered price configured yet, so this
   * starts from the catalog rate for the target tier and applies any
   * `percent_off` from the customer's discount (Stripe applies percentage
   * coupons to the entire invoice, including metered usage). `amount_off`
   * coupons only apply once to the invoice total and do NOT change the
   * per-minute rate, so we leave the overage untouched in that case.
   */
  overageRatePerMinute: number;
  currency: string;
  source: EffectiveRateSource;
  basePriceSource: 'stripe' | 'catalog';
  overagePriceSource: 'stripe' | 'catalog';
  /** Stripe price id we used for the base (when applicable). */
  basePriceId: string | null;
  /** Discount we resolved off the customer record (when applicable). */
  discount: UpgradeDiscount | null;
}

function catalogUpgradeFor(plan: PlanTier): TenantUpgradePreview {
  const entry = PLAN_CATALOG[plan];
  return {
    plan,
    basePriceCents: entry.monthlyPriceCents,
    overageRatePerMinute: entry.overageRatePerMinute,
    currency: 'usd',
    source: 'catalog',
    basePriceSource: 'catalog',
    overagePriceSource: 'catalog',
    basePriceId: null,
    discount: null,
  };
}

interface CouponLike {
  id?: string | null;
  name?: string | null;
  percent_off?: number | null;
  amount_off?: number | null;
  currency?: string | null;
  valid?: boolean | null;
}

interface PromotionCodeLike {
  id?: string | null;
  code?: string | null;
  active?: boolean | null;
}

interface DiscountLike {
  coupon?: CouponLike | null;
  promotion_code?: string | PromotionCodeLike | null;
  end?: number | null;
}

interface CustomerLike {
  id?: string | null;
  deleted?: boolean | null;
  discount?: DiscountLike | null;
  currency?: string | null;
}

/**
 * Translate a Stripe `Discount` (off `customer.discount`) into our compact
 * `UpgradeDiscount` shape. Returns `null` when the discount has expired or
 * the underlying coupon is no longer valid so the preview never quotes a
 * stale promo.
 */
function normalizeDiscount(
  discount: DiscountLike | null | undefined,
): UpgradeDiscount | null {
  if (!discount) return null;
  const coupon = discount.coupon;
  if (!coupon) return null;
  // Skip coupons Stripe has already invalidated (expired, max redemptions,
  // manually deleted). `valid` is `true` when the coupon is currently
  // redeemable; `undefined` means we couldn't read it (rare) — treat as
  // usable to avoid false negatives.
  if (coupon.valid === false) return null;
  // Discount-end is a unix timestamp in seconds (or null/0 for forever).
  if (discount.end && discount.end > 0 && discount.end * 1000 < Date.now()) {
    return null;
  }
  const percentOff =
    coupon.percent_off != null && Number.isFinite(coupon.percent_off)
      ? coupon.percent_off
      : null;
  const amountOffCents =
    coupon.amount_off != null && Number.isFinite(coupon.amount_off)
      ? coupon.amount_off
      : null;
  // Both null = pure-metadata coupon = no actual savings to surface.
  if (percentOff == null && amountOffCents == null) return null;

  let promotionCode: string | null = null;
  const promo = discount.promotion_code;
  if (typeof promo === 'string') {
    promotionCode = promo;
  } else if (promo && typeof promo === 'object') {
    promotionCode = promo.code ?? promo.id ?? null;
  }

  return {
    couponId: coupon.id ?? null,
    name: coupon.name ?? null,
    percentOff,
    amountOffCents,
    currency: (coupon.currency ?? null)?.toLowerCase() ?? null,
    promotionCode,
  };
}

/**
 * Apply the discount to a base price expressed in cents. `percent_off` wins
 * over `amount_off` when both are present (Stripe treats these as mutually
 * exclusive on a single coupon, but defensive code is cheap). Returns the
 * post-discount base price, clamped to >= 0.
 */
function applyDiscountToBaseCents(
  baseCents: number,
  discount: UpgradeDiscount | null,
): number {
  if (!discount) return baseCents;
  if (discount.percentOff != null) {
    const factor = Math.max(0, Math.min(100, discount.percentOff)) / 100;
    return Math.max(0, Math.round(baseCents * (1 - factor)));
  }
  if (discount.amountOffCents != null) {
    return Math.max(0, baseCents - discount.amountOffCents);
  }
  return baseCents;
}

function applyDiscountToPerMinute(
  ratePerMinute: number,
  discount: UpgradeDiscount | null,
): number {
  if (!discount) return ratePerMinute;
  if (discount.percentOff != null) {
    const factor = Math.max(0, Math.min(100, discount.percentOff)) / 100;
    return Math.max(0, ratePerMinute * (1 - factor));
  }
  // `amount_off` is a flat invoice credit, not a per-minute discount, so we
  // intentionally leave the metered rate alone here. The estimator already
  // shows the discounted base, which is where the credit gets reflected.
  return ratePerMinute;
}

export function isPlanTier(value: unknown): value is PlanTier {
  return typeof value === 'string' && (PLAN_TIERS as string[]).includes(value);
}

/**
 * Resolve the next tier ABOVE the tenant's current plan. Returns `null`
 * when the tenant is already on the top published tier (Enterprise) so the
 * caller can short-circuit without quoting a non-existent upgrade.
 */
export function nextUpgradeTier(currentPlan: PlanTier): PlanTier | null {
  const idx = PLAN_TIERS.indexOf(currentPlan);
  if (idx < 0 || idx >= PLAN_TIERS.length - 1) return null;
  return PLAN_TIERS[idx + 1];
}

/**
 * Quote what a tenant would pay if they upgraded to `targetPlan`.
 *
 * Resolution order for the base price:
 *   1. Look up the published `STRIPE_PRICE_<TIER>_MONTHLY` price id, retrieve
 *      it from Stripe, and use its `unit_amount` (normalized to monthly).
 *   2. Fall back to the catalog `monthlyPriceCents`.
 *
 * After we have the published base, we look at the tenant's Stripe customer
 * record for an active `discount` (a coupon or promotion-code redemption)
 * and apply it to the base. This is what lets Sales attach a custom
 * percent-off coupon to a tenant's customer in Stripe and have the bill
 * estimator show the *actual* upgrade quote instead of the catalog list
 * price.
 *
 * Like `getTenantEffectiveRate`, this function NEVER throws — every Stripe
 * error degrades to the catalog defaults so the comparison-tier card
 * always renders.
 */
export async function getTenantUpgradePreview(
  tenantId: string,
  targetPlan: PlanTier,
): Promise<TenantUpgradePreview> {
  const fallback = catalogUpgradeFor(targetPlan);

  const subRow = await loadSubscriptionRow(tenantId);
  const customerId = subRow?.stripe_customer_id ?? null;

  let stripe: Stripe;
  try {
    stripe = getStripeClient();
  } catch (err) {
    logger.info('Stripe client unavailable — using catalog defaults for upgrade preview', {
      tenantId,
      targetPlan,
      error: String(err),
    });
    return fallback;
  }

  // 1. Try to resolve the published Stripe price id for the target tier.
  //    `getPlanPriceId` throws when the env var is missing; we treat that as
  //    a soft failure (fall back to catalog) so the endpoint stays useful in
  //    dev environments that haven't wired every tier up.
  let priceEnvKey: string | null = null;
  let publishedPriceId: string | null = null;
  try {
    // Inline read so we don't import `getPlanPriceId` (which throws) and
    // can keep the soft-fail behavior local.
    priceEnvKey = `STRIPE_PRICE_${targetPlan.toUpperCase()}_MONTHLY`;
    publishedPriceId = process.env[priceEnvKey] ?? null;
  } catch {
    publishedPriceId = null;
  }

  let basePriceCents = fallback.basePriceCents;
  let basePriceSource: 'stripe' | 'catalog' = 'catalog';
  let basePriceId: string | null = null;
  let currency: string = fallback.currency;

  if (publishedPriceId) {
    try {
      const stripePrice = (await stripe.prices.retrieve(publishedPriceId)) as unknown as PriceLike;
      const raw = pickBasePriceCents(stripePrice);
      if (raw != null) {
        basePriceCents = normalizeBaseToMonthly(stripePrice, raw);
        basePriceSource = 'stripe';
        basePriceId = stripePrice.id ?? publishedPriceId;
        if (stripePrice.currency) currency = stripePrice.currency.toLowerCase();
      }
    } catch (err) {
      logger.warn('Failed to retrieve upgrade target price from Stripe', {
        tenantId,
        targetPlan,
        priceId: publishedPriceId,
        error: String(err),
      });
    }
  }

  // 2. Fetch the tenant's Stripe customer to read any active discount.
  //    `customer.discount.promotion_code` can be a string id or an inline
  //    object — we expand it so we can surface the human-readable code.
  let discount: UpgradeDiscount | null = null;
  if (customerId) {
    try {
      const customer = (await stripe.customers.retrieve(customerId, {
        expand: ['discount.promotion_code'],
      })) as unknown as CustomerLike;
      if (customer && customer.deleted !== true) {
        discount = normalizeDiscount(customer.discount);
        if (customer.currency && currency === fallback.currency) {
          currency = customer.currency.toLowerCase();
        }
      }
    } catch (err) {
      logger.warn('Failed to retrieve customer for upgrade preview discount', {
        tenantId,
        targetPlan,
        customerId,
        error: String(err),
      });
    }
  }

  const discountedBase = applyDiscountToBaseCents(basePriceCents, discount);
  const discountedOverage = applyDiscountToPerMinute(
    fallback.overageRatePerMinute,
    discount,
  );

  // The published catalog rate is the only thing we have for the metered
  // line, so its source stays `catalog` even when we discount it — the
  // discount provenance is surfaced separately via the `discount` field.
  const overagePriceSource: 'stripe' | 'catalog' = 'catalog';

  let source: EffectiveRateSource;
  if (basePriceSource === 'stripe' && discount) {
    source = 'stripe';
  } else if (basePriceSource === 'stripe' || discount) {
    source = basePriceSource === 'stripe' ? 'stripe' : 'mixed';
  } else {
    source = 'catalog';
  }

  return {
    plan: targetPlan,
    basePriceCents: discountedBase,
    overageRatePerMinute: discountedOverage,
    currency,
    source,
    basePriceSource,
    overagePriceSource,
    basePriceId,
    discount,
  };
}
