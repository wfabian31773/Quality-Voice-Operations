import type Stripe from 'stripe';
import { getStripeClient } from './client';
import { getPlanFromPriceId, getPlanAiMinutesPriceId } from './plans';
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
  /**
   * Per-message SMS rate in dollars. Sourced from the `unit_amount` on the
   * metered SMS price line on the tenant's Stripe subscription (a price
   * tagged with `metadata.metric === 'sms_sent'` or matched against
   * `STRIPE_METER_SMS_SENT`). Falls back to the env-default SMS rate
   * (`SMS_COST_PER_MESSAGE_CENTS`) when no Stripe override exists.
   *
   * Optional so existing test fixtures and downstream consumers that only
   * care about call/AI rates remain compatible — `recordSmsUsage` falls
   * back to the env default when this field is absent.
   */
  smsRatePerMessage?: number;
  /**
   * Per-minute Twilio (carrier) rate in dollars. Sourced from the
   * `unit_amount` on the metered Twilio-minutes price line on the tenant's
   * Stripe subscription (a price tagged with
   * `metadata.metric === 'twilio_minutes'` or matched against
   * `STRIPE_METER_TWILIO_MINUTES`). Falls back to the env-default Twilio
   * rate (`TWILIO_COST_PER_MINUTE_CENTS`) when no Stripe override exists.
   *
   * Optional so existing test fixtures and downstream consumers that only
   * care about base/AI/SMS rates remain compatible — `recordCallUsage`
   * falls back to the env default when this field is absent.
   */
  twilioRatePerMinute?: number;
  /** Lower-case ISO currency code for the Stripe price (e.g. `usd`). */
  currency: string;
  /**
   * Where each field came from. `stripe` means both base AND overage came
   * from live Stripe data; `mixed` means at least one came from Stripe and
   * the other from the catalog; `catalog` means we found nothing on Stripe
   * and used catalog defaults end-to-end.
   *
   * Note: `source` reflects only the base + AI-overage resolution so we
   * don't break backward-compat with the BillingEstimator UI. Use
   * `smsPriceSource` for the SMS-line provenance.
   */
  source: EffectiveRateSource;
  /**
   * Diagnostic breadcrumbs so the API consumer / debug UI can show whether
   * the override actually engaged.
   */
  basePriceSource: 'stripe' | 'catalog';
  overagePriceSource: 'stripe' | 'catalog';
  /** SMS-line provenance — `stripe` when a tagged metered SMS price was found. */
  smsPriceSource?: 'stripe' | 'catalog';
  /** Twilio-minutes provenance — `stripe` when a tagged metered Twilio-minutes price was found. */
  twilioPriceSource?: 'stripe' | 'catalog';
  /** Stripe price ids that drove the override (when applicable). */
  basePriceId: string | null;
  overagePriceId: string | null;
  /** Stripe price id for the metered SMS line (when applicable). */
  smsPriceId?: string | null;
  /** Stripe price id for the metered Twilio-minutes line (when applicable). */
  twilioPriceId?: string | null;
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

/**
 * Default per-message SMS price in cents. Read at call time so a test
 * that mutates `process.env.SMS_COST_PER_MESSAGE_CENTS` after import is
 * still honoured (mirrors the same approach `recordSmsUsage` uses).
 */
function defaultSmsRatePerMessageDollars(): number {
  const raw = parseInt(process.env.SMS_COST_PER_MESSAGE_CENTS ?? '1', 10);
  const cents = Number.isFinite(raw) && raw >= 0 ? raw : 1;
  // eslint-disable-next-line local/no-cents-divided-by-100 -- cents→dollars conversion for parity with the dollar-denominated `overageRatePerMinute` / `smsRatePerMessage` fields.
  return cents / 100;
}

/**
 * Default per-minute Twilio (carrier) price in dollars. Read at call time
 * so a test that mutates `process.env.TWILIO_COST_PER_MINUTE_CENTS` after
 * import is still honoured (mirrors the same approach `recordCallUsage`
 * uses for its env-default fallback).
 */
function defaultTwilioRatePerMinuteDollars(): number {
  const raw = parseInt(process.env.TWILIO_COST_PER_MINUTE_CENTS ?? '2', 10);
  const cents = Number.isFinite(raw) && raw >= 0 ? raw : 2;
  // eslint-disable-next-line local/no-cents-divided-by-100 -- cents→dollars conversion for parity with the dollar-denominated `overageRatePerMinute` / `twilioRatePerMinute` fields.
  return cents / 100;
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
    smsRatePerMessage: defaultSmsRatePerMessageDollars(),
    twilioRatePerMinute: defaultTwilioRatePerMinuteDollars(),
    currency: 'usd',
    source: 'catalog',
    basePriceSource: 'catalog',
    overagePriceSource: 'catalog',
    smsPriceSource: 'catalog',
    twilioPriceSource: 'catalog',
    basePriceId: null,
    overagePriceId: null,
    smsPriceId: null,
    twilioPriceId: null,
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
 * which metric it covers (AI minutes, SMS, or Twilio carrier minutes).
 *
 * We match in this order so that a tenant with a custom price metadata set
 * always wins over the env-configured meter id, but a generic metered price
 * still gets picked up as the AI-overage source if nothing else matches:
 *   1. `price.metadata.metric === 'ai_minutes'` / `'sms_sent'` / `'twilio_minutes'`
 *   2. `price.recurring.meter === STRIPE_METER_AI_MINUTES` /
 *      `STRIPE_METER_SMS_SENT` / `STRIPE_METER_TWILIO_MINUTES`
 *   3. `price.recurring.usage_type === 'metered'` (AI fallback only — we do
 *      NOT default a generic metered line to SMS or Twilio to avoid
 *      double-counting it across multiple metrics).
 */
function classifyPrice(price: PriceLike | null | undefined): {
  isMetered: boolean;
  isAiMinutes: boolean;
  isSms: boolean;
  isTwilioMinutes: boolean;
  isLicensedRecurring: boolean;
} {
  if (!price) {
    return {
      isMetered: false,
      isAiMinutes: false,
      isSms: false,
      isTwilioMinutes: false,
      isLicensedRecurring: false,
    };
  }
  const usageType = price.recurring?.usage_type ?? null;
  const isMetered = usageType === 'metered';
  const isLicensedRecurring = !!price.recurring && (usageType === 'licensed' || usageType == null);

  const metricMeta = (price.metadata?.metric ?? '').toLowerCase();

  const aiMeterEnv = process.env.STRIPE_METER_AI_MINUTES ?? null;
  const aiMeterMatches = aiMeterEnv && price.recurring?.meter === aiMeterEnv;
  const aiMetaMatches = metricMeta === 'ai_minutes';
  const isAiMinutes = isMetered && (aiMetaMatches || !!aiMeterMatches);

  const smsMeterEnv = process.env.STRIPE_METER_SMS_SENT ?? null;
  const smsMeterMatches = smsMeterEnv && price.recurring?.meter === smsMeterEnv;
  const smsMetaMatches = metricMeta === 'sms_sent' || metricMeta === 'sms';
  const isSms = isMetered && (smsMetaMatches || !!smsMeterMatches);

  const twilioMeterEnv = process.env.STRIPE_METER_TWILIO_MINUTES ?? null;
  const twilioMeterMatches = twilioMeterEnv && price.recurring?.meter === twilioMeterEnv;
  const twilioMetaMatches =
    metricMeta === 'twilio_minutes'
    || metricMeta === 'twilio'
    || metricMeta === 'carrier_minutes';
  const isTwilioMinutes = isMetered && (twilioMetaMatches || !!twilioMeterMatches);

  return { isMetered, isAiMinutes, isSms, isTwilioMinutes, isLicensedRecurring };
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
  let smsPrice: PriceLike | null = null;
  let twilioMinutesPrice: PriceLike | null = null;
  // Generic metered fallback for the AI-overage rate. We deliberately
  // SKIP SMS- and Twilio-tagged metered lines here so a tenant with an
  // SMS or Twilio price configured but no AI price configured doesn't
  // get those rates misquoted as their AI overage.
  let firstMeteredAiCandidate: PriceLike | null = null;

  for (const item of items) {
    const price = item.price;
    if (!price) continue;
    const {
      isMetered,
      isAiMinutes,
      isSms,
      isTwilioMinutes,
      isLicensedRecurring,
    } = classifyPrice(price);
    if (isAiMinutes && !aiMinutesPrice) aiMinutesPrice = price;
    if (isSms && !smsPrice) smsPrice = price;
    if (isTwilioMinutes && !twilioMinutesPrice) twilioMinutesPrice = price;
    if (
      isMetered
      && !isSms
      && !isTwilioMinutes
      && !firstMeteredAiCandidate
    ) {
      firstMeteredAiCandidate = price;
    }
    if (isLicensedRecurring && !basePrice) basePrice = price;
  }

  // Prefer the explicitly-tagged AI minutes meter, fall back to whatever
  // metered line is on the subscription so a custom-priced grandfathered
  // tenant still wins over the catalog defaults.
  const overagePrice = aiMinutesPrice ?? firstMeteredAiCandidate;

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

  let smsRatePerMessage = fallback.smsRatePerMessage ?? defaultSmsRatePerMessageDollars();
  let smsPriceSource: 'stripe' | 'catalog' = 'catalog';
  let smsPriceId: string | null = null;
  if (smsPrice) {
    const dollarsPerMessage = stripeUnitAmountToDollars(smsPrice);
    if (dollarsPerMessage != null) {
      smsRatePerMessage = dollarsPerMessage;
      smsPriceSource = 'stripe';
      smsPriceId = smsPrice.id;
    }
  }

  let twilioRatePerMinute =
    fallback.twilioRatePerMinute ?? defaultTwilioRatePerMinuteDollars();
  let twilioPriceSource: 'stripe' | 'catalog' = 'catalog';
  let twilioPriceId: string | null = null;
  if (twilioMinutesPrice) {
    const dollarsPerMin = unitAmountToDollarsPerMinute(twilioMinutesPrice);
    if (dollarsPerMin != null) {
      twilioRatePerMinute = dollarsPerMin;
      twilioPriceSource = 'stripe';
      twilioPriceId = twilioMinutesPrice.id;
    }
  }

  const currency = (
    basePrice?.currency
    ?? overagePrice?.currency
    ?? smsPrice?.currency
    ?? twilioMinutesPrice?.currency
    ?? fallback.currency
  ).toLowerCase();

  // `source` intentionally only reflects the base + AI-overage axes so the
  // BillingEstimator UI keeps its existing meaning. SMS provenance is
  // surfaced via `smsPriceSource` instead.
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
    smsRatePerMessage,
    twilioRatePerMinute,
    currency,
    source,
    basePriceSource,
    overagePriceSource,
    smsPriceSource,
    twilioPriceSource,
    basePriceId,
    overagePriceId,
    smsPriceId,
    twilioPriceId,
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
  /** Human-readable promotion code (e.g. "PROMO25") for display. */
  promotionCode: string | null;
  /** Stripe `promo_*` id, suitable for forwarding to Checkout's `discounts`. */
  promotionCodeId: string | null;
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
   * tier. Resolved in this order:
   *   1. The metered Stripe price id wired in via
   *      `STRIPE_PRICE_<TIER>_AI_MINUTES` — when present and retrievable,
   *      we use its `unit_amount_decimal` (sub-cent precision preserved)
   *      so the upgrade overage matches what Stripe will actually invoice.
   *   2. Otherwise the catalog `overageRatePerMinute` for the target tier.
   * After base resolution we apply any `percent_off` from the customer's
   * discount (Stripe applies percentage coupons to the entire invoice,
   * including metered usage). `amount_off` coupons are flat invoice
   * credits and do NOT change the per-minute rate, so we leave the
   * overage untouched in that case.
   */
  overageRatePerMinute: number;
  currency: string;
  source: EffectiveRateSource;
  basePriceSource: 'stripe' | 'catalog';
  overagePriceSource: 'stripe' | 'catalog';
  /** Stripe price id we used for the base (when applicable). */
  basePriceId: string | null;
  /** Stripe metered price id we used for the overage (when applicable). */
  overagePriceId: string | null;
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
    overagePriceId: null,
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
 *
 * Exported so it can be reused by other Stripe surfaces (the
 * `/billing/subscription` and `/billing/invoices` endpoints, and the
 * Checkout session builder) that want to render the same coupon badge
 * without re-implementing the validity / expiry checks.
 */
export function normalizeDiscount(
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
  let promotionCodeId: string | null = null;
  const promo = discount.promotion_code;
  if (typeof promo === 'string') {
    // Unexpanded — Stripe returns just the `promo_*` id. Use it as the
    // forwardable id; we don't have the human label.
    promotionCodeId = promo;
  } else if (promo && typeof promo === 'object') {
    promotionCode = promo.code ?? null;
    promotionCodeId = promo.id ?? null;
  }

  return {
    couponId: coupon.id ?? null,
    name: coupon.name ?? null,
    percentOff,
    amountOffCents,
    currency: (coupon.currency ?? null)?.toLowerCase() ?? null,
    promotionCode,
    promotionCodeId,
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

/**
 * Fetch the tenant's Stripe customer record and translate any active
 * discount on it into our compact `UpgradeDiscount` shape. Returns
 * `null` when there is no customer, when the customer has no discount,
 * when the discount has expired, or when the Stripe call throws — every
 * failure path degrades silently so a discount lookup never breaks the
 * surface that called it.
 *
 * Used by the upgrade-preview path (via `getTenantUpgradePreview`), the
 * `/billing/subscription` panel, and the Checkout session builder so all
 * three render the same coupon badge from the same source of truth.
 */
export async function loadActiveCustomerDiscount(
  stripe: Stripe,
  customerId: string,
  ctx: { tenantId: string; surface: string },
): Promise<UpgradeDiscount | null> {
  try {
    const customer = (await stripe.customers.retrieve(customerId, {
      expand: ['discount.promotion_code'],
    })) as unknown as CustomerLike;
    if (!customer || customer.deleted === true) return null;
    return normalizeDiscount(customer.discount);
  } catch (err) {
    logger.warn('Failed to retrieve customer discount', {
      tenantId: ctx.tenantId,
      surface: ctx.surface,
      customerId,
      error: String(err),
    });
    return null;
  }
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
 * Resolution order for the per-minute overage rate:
 *   1. Look up `STRIPE_PRICE_<TIER>_AI_MINUTES` (the metered Stripe price id
 *      for AI minutes on the target tier), retrieve it from Stripe, and use
 *      its `unit_amount_decimal` so we keep sub-cent precision (the live
 *      Stripe rate is the most accurate quote we can give).
 *   2. Fall back to the catalog `overageRatePerMinute` for the target tier.
 *
 * After we have the published base AND the metered overage, we look at the
 * tenant's Stripe customer record for an active `discount` (a coupon or
 * promotion-code redemption) and apply it. This is what lets Sales attach
 * a custom percent-off coupon to a tenant's customer in Stripe and have
 * the bill estimator show the *actual* upgrade quote instead of the
 * catalog list price.
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

  // 2. Try to resolve the metered AI-minutes Stripe price id for the
  //    target tier and use its `unit_amount_decimal` for the overage. This
  //    is the analogue of how `getTenantEffectiveRate` reads the metered
  //    line off the *active* subscription — the only difference here is
  //    that we don't have a subscription on the target tier yet, so the
  //    metered price has to be looked up by env-keyed id instead.
  const meteredPriceId = getPlanAiMinutesPriceId(targetPlan);
  let overageRatePerMinute = fallback.overageRatePerMinute;
  let overagePriceSource: 'stripe' | 'catalog' = 'catalog';
  let overagePriceId: string | null = null;
  // Track whether the env var was configured but the lookup failed, so we
  // can surface that as a `mixed` source (we tried for live data and only
  // got partial coverage).
  let meteredFetchAttemptedAndFailed = false;

  if (meteredPriceId) {
    try {
      const meteredPrice = (await stripe.prices.retrieve(meteredPriceId)) as unknown as PriceLike;
      // Defense-in-depth: the env value is operator-controlled, so confirm
      // the retrieved price is actually a metered line before we trust its
      // unit_amount as a per-minute rate. A licensed/recurring monthly
      // price wired here by mistake would otherwise be quoted as an
      // *overage* (e.g. "$399/min"), which is catastrophic for the
      // estimator. We intentionally accept a generic metered line that
      // isn't tagged with `metric=ai_minutes` / the AI minutes meter,
      // matching `getTenantEffectiveRate`'s behaviour for grandfathered
      // tenants — operators are expected to wire the right price id, and
      // this check is just a guardrail against the obvious wrong-shape
      // misconfiguration.
      const { isMetered } = classifyPrice(meteredPrice);
      const dollarsPerMin = isMetered
        ? unitAmountToDollarsPerMinute(meteredPrice)
        : null;
      if (dollarsPerMin != null) {
        overageRatePerMinute = dollarsPerMin;
        overagePriceSource = 'stripe';
        overagePriceId = meteredPrice.id ?? meteredPriceId;
        if (meteredPrice.currency && currency === fallback.currency) {
          currency = meteredPrice.currency.toLowerCase();
        }
      } else {
        meteredFetchAttemptedAndFailed = true;
        if (!isMetered) {
          // Surface this loud-and-clear so ops sees the misconfiguration
          // in logs even though the user-facing endpoint degrades silently.
          logger.warn('Configured AI-minutes Stripe price is not metered — ignoring', {
            tenantId,
            targetPlan,
            priceId: meteredPriceId,
            usageType: meteredPrice.recurring?.usage_type ?? null,
          });
        }
      }
    } catch (err) {
      meteredFetchAttemptedAndFailed = true;
      logger.warn('Failed to retrieve upgrade target metered price from Stripe', {
        tenantId,
        targetPlan,
        priceId: meteredPriceId,
        error: String(err),
      });
    }
  }

  // 3. Fetch the tenant's Stripe customer to read any active discount.
  //    `customer.discount.promotion_code` can be a string id or an inline
  //    object — we expand it so we can surface the human-readable code.
  //    The `loadActiveCustomerDiscount` helper centralises the same call
  //    so the `/billing/subscription` panel and the Checkout session
  //    builder render the identical badge from the same source of truth.
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
    overageRatePerMinute,
    discount,
  );

  // Source semantics:
  //   - `stripe`  → both the base AND the overage came from live Stripe
  //                 data (or the overage is catalog-by-default because no
  //                 metered env var was configured — i.e. there is no
  //                 *better* answer available).
  //   - `mixed`   → at least one field came from Stripe and the other had
  //                 to fall back. A discount applied to a catalog base is
  //                 also `mixed` (the discount itself is live Stripe data).
  //   - `catalog` → nothing came from Stripe.
  let source: EffectiveRateSource;
  const baseFromStripe = basePriceSource === 'stripe';
  const overageFromStripe = overagePriceSource === 'stripe';
  if (baseFromStripe && overageFromStripe) {
    source = 'stripe';
  } else if (baseFromStripe && !meteredFetchAttemptedAndFailed) {
    // Legacy path: no metered env wired (yet) — base is the freshest data
    // we could surface, so call it `stripe` rather than `mixed`.
    source = 'stripe';
  } else if (baseFromStripe || overageFromStripe || discount) {
    source = 'mixed';
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
    overagePriceId,
    discount,
  };
}

/**
 * Tenant-specific downgrade quote for a single target tier. Returned by
 * `getTenantDowngradePreview` and consumed by `GET /billing/downgrade-preview`.
 *
 * Mirrors what `scheduleDowngrade` (in `planChange.ts`) actually does
 * to a tenant's Stripe subscription: a deferred phase swap that
 * happens at `current_period_end` with `proration_behavior: 'none'`.
 * Because the swap is at the period boundary there is no time-overlap
 * to credit, so `prorationCreditCents` is always 0 today. The preview
 * is still useful: it surfaces the actual `nextInvoiceTotalCents`
 * Stripe will produce on the new tier (which differs from the public
 * catalog when the tenant has a customer-level coupon attached).
 */
export interface TenantDowngradePreview {
  plan: PlanTier;
  interval: 'monthly' | 'annual';
  /**
   * Absolute value (in cents, >= 0) of the prorated credit Stripe will
   * issue for the unused portion of the current paid period. Sum of
   * the `proration === true` negative lines on the Stripe preview
   * invoice. With the deferred-swap scheduler this is 0 in practice;
   * if the scheduler is ever switched to immediate proration the
   * preview will start surfacing a real value automatically.
   */
  prorationCreditCents: number;
  /**
   * Total (in cents) of the next invoice Stripe will produce after the
   * downgrade takes effect. Falls back to the catalog price for the
   * target tier (in the requested interval) when the Stripe preview
   * isn't available.
   */
  nextInvoiceTotalCents: number;
  /**
   * ISO timestamp (UTC) of when the next invoice is expected — Stripe's
   * `next_payment_attempt` when present, otherwise `period_end`.
   */
  nextInvoiceAt: string | null;
  /**
   * Effective monthly base price (in cents) on the new tier, after any
   * customer-level discount is applied.
   */
  basePriceCents: number;
  currency: string;
  source: EffectiveRateSource;
  basePriceSource: 'stripe' | 'catalog';
  basePriceId: string | null;
  discount: UpgradeDiscount | null;
}

function catalogDowngradeFor(
  plan: PlanTier,
  interval: 'monthly' | 'annual',
): TenantDowngradePreview {
  const entry = PLAN_CATALOG[plan];
  // For annual cadence the "next invoice" is the published annual list
  // price; we apply the marketing-side ANNUAL_DISCOUNT to the per-month
  // figure and multiply by 12 so the catalog fallback matches what the
  // public pricing page advertises.
  const monthlyCents = entry.monthlyPriceCents;
  const nextInvoiceCents = interval === 'annual'
    ? catalogAnnualEquivalentCents(monthlyCents) * 12
    : monthlyCents;
  return {
    plan,
    interval,
    prorationCreditCents: 0,
    nextInvoiceTotalCents: nextInvoiceCents,
    nextInvoiceAt: null,
    basePriceCents: monthlyCents,
    currency: 'usd',
    source: 'catalog',
    basePriceSource: 'catalog',
    basePriceId: null,
    discount: null,
  };
}

interface PreviewLineItemLike {
  amount?: number | null;
  proration?: boolean | null;
}

interface PreviewInvoiceLike {
  total?: number | null;
  amount_due?: number | null;
  currency?: string | null;
  next_payment_attempt?: number | null;
  period_end?: number | null;
  lines?: { data?: PreviewLineItemLike[] } | null;
}

interface SubscriptionItemPriceLike {
  price?: { id?: string | null; recurring?: { usage_type?: string | null } | null } | null;
  id?: string | null;
}

/**
 * Quote what a tenant would pay on their next invoice if they
 * downgraded to `targetPlan` on the requested billing `interval`.
 *
 * Calls `stripe.invoices.createPreview` with `proration_behavior: 'none'`
 * so the preview reflects what `scheduleDowngrade` actually does
 * (swap to the lower price at `current_period_end`, no mid-period
 * proration). Any active customer-level coupon is automatically
 * applied by Stripe to the previewed next invoice. Never throws —
 * every Stripe error degrades to a catalog fallback so the downgrade
 * card always renders.
 */
export async function getTenantDowngradePreview(
  tenantId: string,
  targetPlan: PlanTier,
  targetInterval: 'monthly' | 'annual' = 'monthly',
): Promise<TenantDowngradePreview> {
  const fallback = catalogDowngradeFor(targetPlan, targetInterval);

  const subRow = await loadSubscriptionRow(tenantId);
  const customerId = subRow?.stripe_customer_id ?? null;
  const subscriptionId = subRow?.stripe_subscription_id ?? null;

  let stripe: Stripe;
  try {
    stripe = getStripeClient();
  } catch (err) {
    logger.info('Stripe client unavailable — using catalog defaults for downgrade preview', {
      tenantId,
      targetPlan,
      targetInterval,
      error: String(err),
    });
    return fallback;
  }

  // Resolve the published price id for the target (tier + interval).
  const priceEnvKey = `STRIPE_PRICE_${targetPlan.toUpperCase()}_${targetInterval.toUpperCase()}`;
  const publishedPriceId = process.env[priceEnvKey] ?? null;

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
      logger.warn('Failed to retrieve downgrade target price from Stripe', {
        tenantId,
        targetPlan,
        targetInterval,
        priceId: publishedPriceId,
        error: String(err),
      });
    }
  }

  // Resolve the customer-level discount so we can both surface it on
  // the response AND let Stripe honor it on the preview (the preview
  // inherits discounts attached to the subscription/customer when we
  // don't pass an explicit `discounts` list).
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
      logger.warn('Failed to retrieve customer for downgrade preview discount', {
        tenantId,
        targetPlan,
        targetInterval,
        customerId,
        error: String(err),
      });
    }
  }

  // We need both a published target price id AND an active subscription
  // to ask Stripe for a real preview. If either is missing, return the
  // catalog-based numbers with the discount applied locally.
  const discountedBase = applyDiscountToBaseCents(basePriceCents, discount);
  if (!publishedPriceId || !subscriptionId) {
    return {
      ...fallback,
      basePriceCents: discountedBase,
      basePriceSource,
      basePriceId,
      currency,
      discount,
      source: discount ? 'mixed' : basePriceSource === 'stripe' ? 'stripe' : 'catalog',
    };
  }

  // Retrieve the current subscription so we know which licensed item
  // id to swap in the preview.
  let subscription: { items?: { data?: SubscriptionItemPriceLike[] } } | null = null;
  try {
    subscription = (await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price'],
    })) as unknown as { items?: { data?: SubscriptionItemPriceLike[] } };
  } catch (err) {
    logger.warn('Failed to retrieve subscription for downgrade preview', {
      tenantId,
      subscriptionId,
      error: String(err),
    });
  }

  const items = subscription?.items?.data ?? [];
  // Replace the licensed recurring item; metered overage items stay
  // put so we don't disturb the AI-minutes meter when previewing a
  // base-plan swap.
  const licensedItem = items.find((it) => {
    const ut = it.price?.recurring?.usage_type ?? null;
    return ut === 'licensed' || ut == null;
  }) ?? items[0] ?? null;

  if (!licensedItem?.id) {
    return {
      ...fallback,
      basePriceCents: discountedBase,
      basePriceSource,
      basePriceId,
      currency,
      discount,
      source: basePriceSource === 'stripe' || discount ? 'mixed' : 'catalog',
    };
  }

  // Ask Stripe for the preview invoice with the new price swapped in.
  // `proration_behavior: 'none'` matches scheduleDowngrade — the swap
  // happens at period_end with no mid-period proration, so the next
  // invoice is just the new tier's recurring charge (with any
  // customer-level coupon applied).
  let preview: PreviewInvoiceLike | null = null;
  try {
    preview = (await stripe.invoices.createPreview({
      subscription: subscriptionId,
      subscription_details: {
        items: [{ id: licensedItem.id, price: publishedPriceId }],
        proration_behavior: 'none',
      },
      expand: ['lines.data'],
    })) as unknown as PreviewInvoiceLike;
  } catch (err) {
    logger.warn('Failed to create Stripe invoice preview for downgrade', {
      tenantId,
      subscriptionId,
      targetPlan,
      targetInterval,
      error: String(err),
    });
  }

  if (!preview) {
    return {
      ...fallback,
      basePriceCents: discountedBase,
      basePriceSource,
      basePriceId,
      currency,
      discount,
      source: basePriceSource === 'stripe' || discount ? 'mixed' : 'catalog',
    };
  }

  // Sum prorated credit lines only — `proration === true` AND amount<0.
  // We deliberately ignore unrelated negative invoice items (manual
  // credit notes, refunds for other line items) so the value we
  // surface is strictly the downgrade-driven credit, not whatever
  // negative balance the customer happens to have queued.
  const lines = preview.lines?.data ?? [];
  let prorationCreditCents = 0;
  for (const line of lines) {
    if (line.proration !== true) continue;
    const amt = typeof line.amount === 'number' ? line.amount : 0;
    if (amt < 0) prorationCreditCents += -amt;
  }

  const nextInvoiceTotalCents = typeof preview.total === 'number'
    ? preview.total
    : typeof preview.amount_due === 'number'
      ? preview.amount_due
      : fallback.nextInvoiceTotalCents;

  const nextInvoiceAtUnix = preview.next_payment_attempt ?? preview.period_end ?? null;
  const nextInvoiceAt = nextInvoiceAtUnix
    ? new Date(nextInvoiceAtUnix * 1000).toISOString()
    : null;

  if (preview.currency) currency = preview.currency.toLowerCase();

  const source: EffectiveRateSource = basePriceSource === 'stripe' ? 'stripe' : 'mixed';

  return {
    plan: targetPlan,
    interval: targetInterval,
    prorationCreditCents,
    nextInvoiceTotalCents,
    nextInvoiceAt,
    basePriceCents: discountedBase,
    currency,
    source,
    basePriceSource,
    basePriceId,
    discount,
  };
}
