import type Stripe from 'stripe';
import { getStripeClient } from './client';
import { getPlanPriceId } from './plans';
import type { PlanTier } from './plans';
import { getPlatformPool, withTenantContext } from '../../db';
import { createLogger } from '../../core/logger';
import type { TenantId } from '../../core/types';
import {
  loadActiveCustomerDiscount,
  loadActiveSubscriptionDiscounts,
  type UpgradeDiscount,
} from './effectiveRate';

const logger = createLogger('STRIPE_CHECKOUT');

/**
 * Stripe limits `business_profile.headline` (the message shown at the top
 * of the hosted billing portal page) to 60 characters. We mirror that cap
 * here so the headline builder can degrade gracefully — dropping the
 * promo-code tail before it would overflow — instead of having Stripe
 * reject the configuration create call.
 */
const PORTAL_HEADLINE_MAX_CHARS = 60;

/**
 * Process-local cache of `billing_portal.configurations` ids keyed by
 * `<defaultConfigId>::<headline>`. Lets us reuse the same Stripe-side
 * configuration for repeated portal opens with the same active coupon
 * (e.g. a tenant on `PROMO25` who returns to manage their plan a second
 * time) instead of spawning a fresh configuration every session — Stripe
 * configurations are persistent objects, and creating thousands of them
 * for one coupon would clutter the dashboard.
 *
 * Including the *default configuration id* in the key invalidates the
 * cache automatically when an admin swaps the default portal
 * configuration in the Stripe dashboard (for example, to tighten which
 * customer fields can be edited). Without that prefix, a long-running
 * process would keep handing tenants a stale clone of the previous
 * default's feature toggles until the next restart.
 *
 * The cache deliberately resets on process restart; the worst case is
 * one extra create call per (process, key) pair.
 */
const portalConfigByHeadline = new Map<string, string>();

/**
 * In-flight create/lookup promises keyed the same way as
 * `portalConfigByHeadline`. If two portal-open requests with the same
 * coupon land in the same process before the first finishes its Stripe
 * configuration create, the second one awaits the first instead of
 * creating a duplicate Stripe configuration. Entries are cleared once
 * settled.
 */
const portalConfigInFlight = new Map<string, Promise<string | null>>();

function portalCacheKey(defaultConfigId: string, headline: string): string {
  return `${defaultConfigId}::${headline}`;
}

export interface CheckoutRecommendationAttribution {
  currentTier: PlanTier;
  recommendedTier: PlanTier;
  monthlySavingsCents: number;
  trailingWindowMonths?: number;
  pitch: 'tier-switch' | 'annual-only';
}

/**
 * Resolved discount snapshot from the upgrade-card discount badge. At
 * least one of `couponId` / `promotionCode` is non-null when present —
 * the route layer drops empty pairs before they reach this function.
 * Stamped into Stripe session metadata so the webhook can attribute the
 * conversion back to the specific coupon at completion time.
 */
export interface CheckoutDiscountAttribution {
  couponId: string | null;
  promotionCode: string | null;
}

export async function createCheckoutSession(params: {
  tenantId: TenantId;
  plan: PlanTier;
  interval: 'monthly' | 'annual';
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
  recommendation?: CheckoutRecommendationAttribution;
  discount?: CheckoutDiscountAttribution;
}): Promise<{ sessionId: string; url: string }> {
  const { tenantId, plan, interval, successUrl, cancelUrl, customerEmail, recommendation, discount } = params;
  const stripe = getStripeClient();

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT stripe_customer_id FROM subscriptions WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );
    const existingCustomerId = rows[0]?.stripe_customer_id as string | null;
    await client.query('COMMIT');

    const priceId = getPlanPriceId(plan, interval);

    // Stripe metadata values must be strings. Stamping the recommendation
    // snapshot here is what makes switch_completed attribution
    // server-authoritative — the webhook reads it back instead of
    // trusting client-side state.
    const recommendationMetadata: Record<string, string> = recommendation
      ? {
          recommendationSource: 'billing_estimator_recommendation',
          recommendationCurrentTier: recommendation.currentTier,
          recommendationRecommendedTier: recommendation.recommendedTier,
          recommendationMonthlySavingsCents: String(recommendation.monthlySavingsCents),
          recommendationPitch: recommendation.pitch,
          ...(recommendation.trailingWindowMonths !== undefined
            ? { recommendationTrailingWindowMonths: String(recommendation.trailingWindowMonths) }
            : {}),
        }
      : {};

    // Forward the customer's active discount so the hosted page shows
    // the coupon line. Prefer promotion_code over coupon. Stripe rejects
    // an empty `discounts: []`, so the key is omitted entirely when no
    // discount applies.
    let sessionDiscounts: Array<{ coupon?: string; promotion_code?: string }> | undefined;
    if (existingCustomerId) {
      const customerDiscount = await loadActiveCustomerDiscount(
        stripe,
        existingCustomerId,
        { tenantId, surface: 'checkout_session' },
      );
      if (customerDiscount?.promotionCodeId) {
        sessionDiscounts = [{ promotion_code: customerDiscount.promotionCodeId }];
      } else if (customerDiscount?.couponId) {
        sessionDiscounts = [{ coupon: customerDiscount.couponId }];
      }
    }

    // Discount snapshot stamped into Stripe session metadata so the
    // webhook can write a discount_switch_completed attribution row
    // back to the same coupon at completion time.
    const discountMetadata: Record<string, string> = discount
      ? {
          ...(discount.couponId
            ? { upgradeDiscountCouponId: discount.couponId }
            : {}),
          ...(discount.promotionCode
            ? { upgradeDiscountPromotionCode: discount.promotionCode }
            : {}),
        }
      : {};

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer: existingCustomerId ?? undefined,
      customer_email: existingCustomerId ? undefined : customerEmail,
      metadata: {
        tenantId,
        plan,
        interval,
        ...recommendationMetadata,
        ...discountMetadata,
      },
      subscription_data: {
        metadata: { tenantId, plan },
        trial_period_days: plan === 'starter' ? 14 : undefined,
      },
      ...(sessionDiscounts ? { discounts: sessionDiscounts } : {}),
    });

    logger.info('Checkout session created', { tenantId, plan, sessionId: session.id });
    return { sessionId: session.id, url: session.url! };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Optional knobs for `buildPortalDiscountHeadline`. Currently just the
 * "+ N more" stack indicator surfaced when a tenant has multiple
 * subscription-level discounts attached at once.
 */
export interface BuildPortalDiscountHeadlineOptions {
  /**
   * Number of *additional* usable discounts stacked on the subscription
   * beyond the headline discount itself. When > 0 the headline appends
   * a `+ N more` tail so the tenant doesn't wonder why the second/third
   * coupon they attached appears to be "missing" from the portal — the
   * in-app subscription card and the receipt PDF both already render
   * every stacked discount as its own chip, but the Stripe-hosted
   * portal allows only a single headline string.
   *
   * Negative / non-finite values are treated as 0 (defensive — the
   * caller derives this from `subDiscounts.length - 1`, which is always
   * a small non-negative integer in practice).
   */
  additionalCount?: number;
}

/**
 * Build the customer-facing headline shown at the top of the Stripe
 * hosted billing portal when the tenant is on a discounted subscription.
 * Mirrors the wording the in-app subscription card uses
 * (`Active discount: 25% off — PROMO25`) so a tenant who clicks "Manage
 * subscription" lands on a portal page that visibly confirms the same
 * coupon they see in the app and on every receipt PDF — the gap this
 * helper closes is the customer-portal surface, the only one that
 * previously had no badge at all.
 *
 * When `options.additionalCount > 0` the headline grows a `+ N more`
 * tail so a tenant who attached multiple stacked subscription-level
 * coupons can see at a glance that the portal page is showing one of
 * several active discounts (matching the multiple chips already
 * rendered by the in-app subscription card and the receipt PDF). Stripe
 * only permits one headline string, so we lead with the first usable
 * discount and append the count of the rest.
 *
 * Returns `null` when the discount carries no usable percent / amount-off
 * (defensive — `loadActiveCustomerDiscount` already drops these). The
 * result is capped at Stripe's 60-character `business_profile.headline`
 * limit; when the combined "Active discount: <amount> — <code> + N more"
 * form would overflow, the `+ N more` tail is dropped first, then the
 * promo-code/name tail, so the customer always at least sees the
 * dollar/percent figure rather than a truncated mid-word.
 */
export function buildPortalDiscountHeadline(
  discount: UpgradeDiscount | null | undefined,
  options: BuildPortalDiscountHeadlineOptions = {},
): string | null {
  if (!discount) return null;

  let offPart: string | null = null;
  if (discount.percentOff != null && Number.isFinite(discount.percentOff)) {
    const pct = Number.isInteger(discount.percentOff)
      ? discount.percentOff
      : Number(discount.percentOff.toFixed(1));
    offPart = `${pct}% off`;
  } else if (
    discount.amountOffCents != null
    && Number.isFinite(discount.amountOffCents)
  ) {
    // eslint-disable-next-line local/no-cents-divided-by-100 -- cents→dollars formatting for the human-readable headline shown on the Stripe billing portal page; mirrors the receipt PDF footer wording.
    const dollars = (discount.amountOffCents / 100).toFixed(2);
    const cur = (discount.currency ?? 'usd').toUpperCase();
    offPart = `${cur} ${dollars} off`;
  }
  if (!offPart) return null;

  const labelTail = (discount.promotionCode ?? discount.name ?? '').trim();
  const additionalCountRaw = options.additionalCount;
  const additionalCount =
    typeof additionalCountRaw === 'number'
    && Number.isFinite(additionalCountRaw)
    && additionalCountRaw > 0
      ? Math.floor(additionalCountRaw)
      : 0;
  const moreSuffix = additionalCount > 0 ? ` + ${additionalCount} more` : '';

  // Try the richest form first (off + code + "+ N more") and degrade in
  // priority order: drop the stack indicator before the promo code,
  // drop the promo code before mid-word truncation. The numeric
  // off-figure is always preserved.
  const withTailAndMore = labelTail
    ? `Active discount: ${offPart} — ${labelTail}${moreSuffix}`
    : `Active discount: ${offPart}${moreSuffix}`;
  if (withTailAndMore.length <= PORTAL_HEADLINE_MAX_CHARS) return withTailAndMore;

  const withTail = labelTail
    ? `Active discount: ${offPart} — ${labelTail}`
    : `Active discount: ${offPart}`;
  if (withTail.length <= PORTAL_HEADLINE_MAX_CHARS) return withTail;

  // Drop the promo-code/name tail next so the customer still sees the
  // numeric amount-off rather than a mid-word slice.
  const withoutTail = `Active discount: ${offPart}`;
  if (withoutTail.length <= PORTAL_HEADLINE_MAX_CHARS) return withoutTail;
  return withoutTail.slice(0, PORTAL_HEADLINE_MAX_CHARS);
}

interface PortalConfigurationFeaturesLike {
  customer_update?: Stripe.BillingPortal.Configuration.Features.CustomerUpdate | null;
  invoice_history?: Stripe.BillingPortal.Configuration.Features.InvoiceHistory | null;
  payment_method_update?: Stripe.BillingPortal.Configuration.Features.PaymentMethodUpdate | null;
  subscription_cancel?: Stripe.BillingPortal.Configuration.Features.SubscriptionCancel | null;
  subscription_update?: Stripe.BillingPortal.Configuration.Features.SubscriptionUpdate | null;
}

/**
 * Translate a Stripe-returned `Configuration.Features` object into the
 * shape `configurations.create` expects. The two are nearly identical,
 * but the response carries a handful of nullable optional slots
 * (`subscription_update.billing_cycle_anchor`, etc.) that the create
 * params type rejects, so we round-trip through JSON to strip any `null`
 * values to `undefined`. The cast back to the create-params type is safe
 * because we only ever pass back well-formed Stripe-sourced data.
 */
function clonePortalFeatures(
  features: Stripe.BillingPortal.Configuration.Features,
): Stripe.BillingPortal.ConfigurationCreateParams.Features {
  const src = features as PortalConfigurationFeaturesLike;
  const out: Record<string, unknown> = {};
  if (src.customer_update) out.customer_update = stripNulls(src.customer_update);
  if (src.invoice_history) out.invoice_history = stripNulls(src.invoice_history);
  if (src.payment_method_update) out.payment_method_update = stripNulls(src.payment_method_update);
  if (src.subscription_cancel) out.subscription_cancel = stripNulls(src.subscription_cancel);
  if (src.subscription_update) out.subscription_update = stripNulls(src.subscription_update);
  return out as Stripe.BillingPortal.ConfigurationCreateParams.Features;
}

/**
 * Recursively replace `null` values with `undefined` (and drop the keys
 * entirely from the resulting object). Used when forwarding a Stripe
 * response object back into a create-params type — the response type
 * marks several fields as `T | null`, while the create-params type
 * marks the same fields as `T | undefined`, which TypeScript treats as
 * incompatible.
 */
function stripNulls<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripNulls(v)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null) continue;
      out[k] = stripNulls(v);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Resolve a Stripe portal configuration id to use for the customer's
 * billing-portal session whose `business_profile.headline` carries the
 * discount badge. Lazily creates a configuration that clones the
 * tenant's account-level default (so feature toggles like "allow plan
 * change" / "show invoice history" stay consistent with the dashboard
 * settings) but overrides the headline.
 *
 * Returns `null` when:
 *   - the discount yields no usable headline,
 *   - the account has no default portal configuration to clone (legacy
 *     accounts that drive the portal entirely from implicit defaults),
 *   - or any Stripe call along the way throws.
 *
 * In every null case the caller falls back to creating the session
 * without a configuration, so the portal still opens — the badge just
 * isn't surfaced. Discount visibility is a polish feature; we never let
 * it break the "Manage subscription" button.
 */
async function resolveDiscountedPortalConfigId(
  stripe: Stripe,
  discount: UpgradeDiscount | null,
  ctx: { tenantId: TenantId; additionalDiscountCount?: number },
): Promise<string | null> {
  const additionalDiscountCount = ctx.additionalDiscountCount ?? 0;
  const headline = buildPortalDiscountHeadline(discount, {
    additionalCount: additionalDiscountCount,
  });
  if (!headline) return null;

  let defaultConfig: Stripe.BillingPortal.Configuration | null = null;
  try {
    const list = await stripe.billingPortal.configurations.list({
      is_default: true,
      limit: 1,
    });
    defaultConfig = list.data[0] ?? null;
  } catch (err) {
    logger.warn('Failed to look up default portal configuration; opening portal without discount headline', {
      tenantId: ctx.tenantId,
      error: String(err),
    });
    return null;
  }
  if (!defaultConfig) {
    logger.info('No default portal configuration to clone; opening portal without discount headline', {
      tenantId: ctx.tenantId,
    });
    return null;
  }

  // Cache lookup happens *after* we know the current default config id so
  // a dashboard-level switch of the default invalidates entries that
  // were cloned from the old default.
  const cacheKey = portalCacheKey(defaultConfig.id, headline);
  const cached = portalConfigByHeadline.get(cacheKey);
  if (cached) return cached;

  // Coalesce concurrent first-opens for the same coupon: if another
  // request is already mid-create, await it instead of issuing a second
  // Stripe configuration create that would just produce a duplicate.
  const inFlight = portalConfigInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const createPromise = (async () => {
    try {
      const business = defaultConfig.business_profile;
      const created = await stripe.billingPortal.configurations.create({
        features: clonePortalFeatures(defaultConfig.features),
        business_profile: {
          headline,
          ...(business?.privacy_policy_url
            ? { privacy_policy_url: business.privacy_policy_url }
            : {}),
          ...(business?.terms_of_service_url
            ? { terms_of_service_url: business.terms_of_service_url }
            : {}),
        },
        metadata: {
          purpose: 'discount_headline',
          // Truncate to Stripe's 500-char metadata-value cap. Headline is
          // already <= 60 chars so this is just defensive.
          headline: headline.slice(0, 500),
          defaultConfigId: defaultConfig.id,
          // Stamp the coupon / promotion-code provenance so the periodic
          // cleanup sweep (PortalConfigCleanupScheduler) can match the
          // configuration back to the discount it was minted for without
          // having to reverse-parse the headline. Optional — older entries
          // missing these fields fall back to headline matching.
          ...(discount?.couponId ? { couponId: discount.couponId } : {}),
          ...(discount?.promotionCodeId
            ? { promotionCodeId: discount.promotionCodeId }
            : {}),
          // Stamp the stack size so the cleanup sweep / dashboard
          // operator can tell at a glance which configurations were
          // minted for stacked-discount tenants vs. single-coupon
          // tenants. Only present when > 0 to keep the metadata
          // bag small for the common single-discount case.
          ...(additionalDiscountCount > 0
            ? { additionalDiscountCount: String(additionalDiscountCount) }
            : {}),
        },
      });
      portalConfigByHeadline.set(cacheKey, created.id);
      return created.id;
    } catch (err) {
      logger.warn('Failed to create discounted portal configuration; opening portal without discount headline', {
        tenantId: ctx.tenantId,
        error: String(err),
      });
      return null;
    } finally {
      portalConfigInFlight.delete(cacheKey);
    }
  })();
  portalConfigInFlight.set(cacheKey, createPromise);
  return createPromise;
}

/**
 * Test-only escape hatch so the in-process configuration cache doesn't
 * leak between vitest cases that all share the same module instance.
 * Not part of the public API; the export name is deliberately verbose
 * to discourage runtime callers.
 */
export function __resetPortalConfigCacheForTests(): void {
  portalConfigByHeadline.clear();
  portalConfigInFlight.clear();
}

/**
 * Evict every cached entry that points to `configurationId`. Called by
 * the periodic cleanup sweep right after it deactivates a configuration
 * on Stripe so the in-process cache doesn't keep handing the now-dead id
 * to subsequent portal-open requests in the same process. The next open
 * for that coupon will recreate a fresh active configuration.
 *
 * Returns the number of cache entries removed (0 when nothing was
 * cached locally — common when the cleanup runs in a different process
 * from the one that originally cached it).
 */
export function evictPortalConfigCacheById(configurationId: string): number {
  let removed = 0;
  for (const [key, id] of portalConfigByHeadline.entries()) {
    if (id === configurationId) {
      portalConfigByHeadline.delete(key);
      removed += 1;
    }
  }
  return removed;
}

export async function createPortalSession(params: {
  tenantId: TenantId;
  returnUrl: string;
}): Promise<{ url: string }> {
  const { tenantId, returnUrl } = params;
  const stripe = getStripeClient();

  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const { rows } = await client.query(
      `SELECT stripe_customer_id, stripe_subscription_id
         FROM subscriptions WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );
    await client.query('COMMIT');

    const customerId = rows[0]?.stripe_customer_id as string | undefined;
    const subscriptionId = rows[0]?.stripe_subscription_id as string | undefined;
    if (!customerId) {
      throw new Error('No Stripe customer found for this tenant');
    }

    // Resolve the active discount and, if present, the portal
    // configuration that surfaces it as a headline. Both calls degrade
    // silently (the loaders already swallow their own errors and
    // return null/[]) — a tenant must always be able to open their
    // billing portal even when the discount lookup or configuration
    // creation fails.
    //
    // Modern tenants typically receive their coupon at the
    // *subscription* level (`subscription.discounts[]`) rather than on
    // the customer record itself. We check the customer first (so a
    // legacy customer-scoped coupon still wins, matching the old
    // behaviour) and then fall back to the first usable
    // subscription-level discount so the much larger pool of tenants
    // whose coupons live on the subscription also see the headline.
    let discount = await loadActiveCustomerDiscount(stripe, customerId, {
      tenantId,
      surface: 'portal_session',
    });
    // Number of *additional* usable subscription-level discounts beyond
    // the one chosen as the headline. Stays at 0 for the legacy
    // customer-level path (Stripe only allows one customer.discount), so
    // the "+ N more" tail only shows up for the modern stacked-
    // subscription-discount shape, which is the only one that can
    // actually exceed a single coupon.
    let additionalDiscountCount = 0;
    if (!discount && subscriptionId) {
      const subDiscounts = await loadActiveSubscriptionDiscounts(
        stripe,
        subscriptionId,
        { tenantId, surface: 'portal_session' },
      );
      discount = subDiscounts[0] ?? null;
      if (subDiscounts.length > 1) {
        additionalDiscountCount = subDiscounts.length - 1;
      }
    }
    const configurationId = await resolveDiscountedPortalConfigId(stripe, discount, {
      tenantId,
      additionalDiscountCount,
    });

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
      ...(configurationId ? { configuration: configurationId } : {}),
    });

    return { url: session.url };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
