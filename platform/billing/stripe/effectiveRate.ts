import type Stripe from 'stripe';
import { getStripeClient } from './client';
import { getPlanFromPriceId } from './plans';
import { getPlatformPool, withTenantContext } from '../../db';
import { createLogger } from '../../core/logger';
import {
  PLAN_CATALOG,
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
}

interface SubscriptionRow {
  plan: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
}

function normalizePlan(plan: string | null | undefined): PlanTier {
  if (plan === 'starter' || plan === 'pro' || plan === 'enterprise') return plan;
  return 'starter';
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
      `SELECT plan, stripe_subscription_id, stripe_price_id
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
  if (basePrice) {
    const raw = pickBasePriceCents(basePrice);
    if (raw != null) {
      basePriceCents = normalizeBaseToMonthly(basePrice, raw);
      basePriceSource = 'stripe';
      basePriceId = basePrice.id;
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
  };
}
