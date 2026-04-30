import { getStripeClient } from './client';
import { getPlanPriceId } from './plans';
import type { PlanTier } from './plans';
import { getPlatformPool, withTenantContext } from '../../db';
import { createLogger } from '../../core/logger';
import type { TenantId } from '../../core/types';
import { loadActiveCustomerDiscount } from './effectiveRate';

const logger = createLogger('STRIPE_CHECKOUT');

export interface CheckoutRecommendationAttribution {
  currentTier: PlanTier;
  recommendedTier: PlanTier;
  monthlySavingsCents: number;
  trailingWindowMonths?: number;
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
      `SELECT stripe_customer_id FROM subscriptions WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );
    await client.query('COMMIT');

    const customerId = rows[0]?.stripe_customer_id as string | undefined;
    if (!customerId) {
      throw new Error('No Stripe customer found for this tenant');
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });

    return { url: session.url };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
