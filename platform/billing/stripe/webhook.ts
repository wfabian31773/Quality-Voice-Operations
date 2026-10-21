import type Stripe from 'stripe';
import { getStripeClient, getWebhookSecret } from './client';
import { getPlanFromPriceId, PLAN_LIMITS, type SubscriptionState } from './plans';
import { getPlatformPool, withPrivilegedClient, withTenantContext } from '../../db';
import { createLogger } from '../../core/logger';
import { provisionTenant } from '../../tenant/provisioning/TenantProvisioningService';
import { normalizeDiscount, type UpgradeDiscount } from './effectiveRate';
import { invalidateStripePrice } from './priceCache';

const logger = createLogger('STRIPE_WEBHOOK');

export function constructStripeEvent(body: Buffer, signature: string): Stripe.Event {
  const stripe = getStripeClient();
  return stripe.webhooks.constructEvent(body, signature, getWebhookSecret());
}

async function withTenant<T>(tenantId: string, fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Normalize a raw Stripe `recurring.interval` value (`'month'` / `'year'`)
 * to the shape our Postgres `billing_interval` enum accepts
 * (`'monthly'` / `'annual'`). Returns `null` for anything we don't
 * recognize so callers can decide to leave the column unchanged rather
 * than blow up the INSERT/UPDATE on the enum cast.
 *
 * Used by both `handleCheckoutCompleted` (initial subscription
 * creation) and `handleSubscriptionUpdated` (Subscription Schedule
 * phase transitions for downgrades) so the two paths can never drift.
 */
function normalizeBillingInterval(raw: string | undefined | null): 'monthly' | 'annual' | null {
  if (!raw) return null;
  if (raw === 'year' || raw === 'annual') return 'annual';
  if (raw === 'month' || raw === 'monthly') return 'monthly';
  return null;
}

/**
 * Map a Stripe subscription status onto the local `subscription_status`
 * enum ('trialing' | 'active' | 'past_due' | 'paused' | 'cancelled').
 * Returns `null` for statuses with no local equivalent (`incomplete`)
 * so callers can keep their existing value instead of guessing.
 */
export function mapStripeSubscriptionStatus(raw: string | undefined | null): SubscriptionState | null {
  switch (raw) {
    case 'trialing': return 'trialing';
    case 'active': return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'paused': return 'paused';
    case 'canceled':
    case 'incomplete_expired':
      return 'cancelled';
    default: return null;
  }
}

/**
 * Stripe's `trial_end` (unix seconds) as an ISO string. `null` when the
 * subscription has no trial, `undefined` when the field is absent so
 * callers can leave the column alone.
 */
function stripeTrialEnd(sub: unknown): string | null | undefined {
  const raw = (sub as Record<string, unknown>).trial_end;
  if (raw === undefined) return undefined;
  return typeof raw === 'number' ? new Date(raw * 1000).toISOString() : null;
}

/** What a completed checkout writes to the tenant's plan row. */
export interface CheckoutSubscriptionDetails {
  status: SubscriptionState;
  trialEnd: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  billingInterval: 'monthly' | 'annual' | null;
  stripePriceId: string | null;
}

/** Plan-row details for a payment-mode checkout (no subscription). */
export const EMPTY_CHECKOUT_DETAILS: CheckoutSubscriptionDetails = {
  status: 'active', trialEnd: null, periodStart: null, periodEnd: null, billingInterval: null, stripePriceId: null,
};

/**
 * Re-read a checkout's subscription from Stripe and map it onto the plan
 * row. Shared by the `checkout.session.completed` webhook and the
 * onboarding verify-checkout route so both write the same status and
 * `trial_end`. Throws if Stripe can't be reached.
 */
export async function retrieveCheckoutSubscription(subscriptionId: string): Promise<CheckoutSubscriptionDetails> {
  const stripe = getStripeClient();
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const rawSub = sub as unknown as Record<string, unknown>;
  const rawStart = rawSub.current_period_start as number | undefined;
  const rawEnd = rawSub.current_period_end as number | undefined;
  const item = sub.items?.data?.[0];
  const priceRaw = item?.price as unknown as Record<string, unknown> | undefined;
  const recurringRaw = priceRaw?.recurring as Record<string, unknown> | undefined;
  const interval = (recurringRaw?.interval as string | undefined)
    ?? (priceRaw?.recurring_interval as string | undefined);
  return {
    status: mapStripeSubscriptionStatus(sub.status) ?? 'active',
    trialEnd: stripeTrialEnd(sub) ?? null,
    periodStart: rawStart ? new Date(rawStart * 1000).toISOString() : null,
    periodEnd: rawEnd ? new Date(rawEnd * 1000).toISOString() : null,
    // Normalize Stripe's 'month'/'year' to the local billing_interval
    // enum's 'monthly'/'annual' BEFORE storing — otherwise the
    // `::billing_interval` cast in the upsert blows up on a raw 'year'
    // value and the whole checkout write fails.
    billingInterval: normalizeBillingInterval(interval),
    stripePriceId: item?.price?.id ?? null,
  };
}

/**
 * Plan-row details from the session alone, for when the subscription
 * can't be retrieved for good. Signup and first checkouts carry a trial,
 * which Stripe completes with `no_payment_required`, so that reads as
 * `trialing`; anything paid reads as `active`.
 */
function checkoutDetailsFromSession(session: Stripe.Checkout.Session): CheckoutSubscriptionDetails {
  return {
    ...EMPTY_CHECKOUT_DETAILS,
    status: session.payment_status === 'no_payment_required' ? 'trialing' : 'active',
  };
}

const TRANSIENT_STRIPE_ERROR_TYPES = new Set(['StripeConnectionError', 'StripeAPIError', 'StripeRateLimitError']);

/**
 * True when a Stripe call failed in a way a retry can fix: connection
 * errors, Stripe-side API/5xx errors and rate limits. Other Stripe errors
 * (invalid request such as `resource_missing`, authentication, permission)
 * are permanent. Errors with no Stripe type are treated as transient.
 */
export function isTransientStripeError(err: unknown): boolean {
  const e = (err ?? {}) as { type?: unknown; statusCode?: unknown };
  if (typeof e.statusCode === 'number' && (e.statusCode >= 500 || e.statusCode === 429)) return true;
  if (typeof e.type === 'string' && e.type.startsWith('Stripe')) return TRANSIENT_STRIPE_ERROR_TYPES.has(e.type);
  return true;
}

/**
 * Upsert the tenant's plan row for a completed checkout.
 *
 * `keepWebhookStatus` (verify-checkout): when the row already tracks this
 * same `stripe_subscription_id`, a webhook has written it from Stripe, so
 * leave it alone instead of overwriting its status. Returns whether the
 * row was written.
 */
export async function upsertCheckoutSubscription(
  client: import('pg').PoolClient,
  row: {
    tenantId: string;
    plan: string;
    customerId: string | null;
    subscriptionId: string | null;
    details: CheckoutSubscriptionDetails;
  },
  options: { keepWebhookStatus?: boolean } = {},
): Promise<boolean> {
  const limits = PLAN_LIMITS[row.plan as keyof typeof PLAN_LIMITS] ?? PLAN_LIMITS.starter;
  const { details } = row;
  const result = await client.query(
    `INSERT INTO subscriptions (tenant_id, plan, status, stripe_customer_id, stripe_subscription_id,
       stripe_price_id, billing_interval,
       monthly_call_limit, monthly_sms_limit, monthly_ai_minute_limit, overage_enabled,
       current_period_start, current_period_end, trial_end)
     VALUES ($1, $2, $13::subscription_status, $3, $4, $5, COALESCE($6::billing_interval, 'monthly'),
       $7, $8, $9, $10, $11, $12, $14)
     ON CONFLICT (tenant_id) DO UPDATE SET
       plan = EXCLUDED.plan, status = EXCLUDED.status,
       trial_end = EXCLUDED.trial_end,
       stripe_customer_id = EXCLUDED.stripe_customer_id,
       stripe_subscription_id = EXCLUDED.stripe_subscription_id,
       stripe_price_id = EXCLUDED.stripe_price_id,
       billing_interval = EXCLUDED.billing_interval,
       monthly_call_limit = EXCLUDED.monthly_call_limit,
       monthly_sms_limit = EXCLUDED.monthly_sms_limit,
       monthly_ai_minute_limit = EXCLUDED.monthly_ai_minute_limit,
       overage_enabled = EXCLUDED.overage_enabled,
       current_period_start = EXCLUDED.current_period_start,
       current_period_end = EXCLUDED.current_period_end,
       updated_at = NOW()${options.keepWebhookStatus
      ? `
     WHERE subscriptions.stripe_subscription_id IS NULL
        OR subscriptions.stripe_subscription_id <> EXCLUDED.stripe_subscription_id`
      : ''}`,
    [row.tenantId, row.plan, row.customerId, row.subscriptionId,
     details.stripePriceId, details.billingInterval,
     limits.monthlyCallLimit, limits.monthlySmsLimit, limits.monthlyAiMinuteLimit, limits.overageEnabled,
     details.periodStart, details.periodEnd, details.status, details.trialEnd],
  );
  return (result.rowCount ?? 0) > 0;
}

async function isEventProcessed(eventId: string): Promise<boolean> {
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT 1 FROM billing_events WHERE stripe_event_id = $1 LIMIT 1`,
      [eventId],
    );
    return rows.length > 0;
  });
}

export async function handleStripeEvent(event: Stripe.Event): Promise<void> {
  logger.info('Processing Stripe webhook', { type: event.type, id: event.id });

  if (await isEventProcessed(event.id)) {
    logger.info('Duplicate Stripe event — skipping', { id: event.id, type: event.type });
    return;
  }

  const stripeEventId = event.id;

  switch (event.type) {
    case 'checkout.session.completed':
      await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session, stripeEventId);
      try {
        const { recordConversionEvent, getVisitorAttribution } = await import('../../analytics/WebsiteConversionService');
        const { CONVERSION_STAGE } = await import('../../../shared/analytics/conversionStages');
        const checkoutSession = event.data.object as Stripe.Checkout.Session;
        const visitorId = checkoutSession.metadata?.visitorId || checkoutSession.client_reference_id || `stripe_${checkoutSession.id}`;
        const attribution = await getVisitorAttribution(visitorId);
        const landingPage = attribution?.landingPage ?? '/signup';
        const utm = attribution ? {
          source: attribution.utmSource ?? undefined,
          medium: attribution.utmMedium ?? undefined,
          campaign: attribution.utmCampaign ?? undefined,
        } : undefined;
        await recordConversionEvent(visitorId, CONVERSION_STAGE.PAID, landingPage, utm, { stripeSessionId: checkoutSession.id, tenantId: checkoutSession.metadata?.tenantId });
      } catch (convErr) {
        logger.warn('Failed to record paid conversion event', { error: String(convErr) });
      }
      break;
    case 'invoice.finalized':
      await handleInvoiceFinalized(event.data.object as Stripe.Invoice);
      break;
    case 'invoice.payment_succeeded':
      await handleInvoiceSucceeded(event.data.object as Stripe.Invoice, stripeEventId);
      break;
    case 'invoice.payment_failed':
      await handleInvoiceFailed(event.data.object as Stripe.Invoice, stripeEventId);
      break;
    case 'customer.subscription.deleted':
      await handleSubscriptionDeleted(event.data.object as Stripe.Subscription, stripeEventId);
      break;
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(event.data.object as Stripe.Subscription, stripeEventId);
      break;
    case 'price.created':
    case 'price.updated':
    case 'price.deleted':
      handlePriceMutated(event.data.object as Stripe.Price, event.type);
      break;
    default:
      logger.info('Unhandled Stripe event type', { type: event.type });
  }
}

/**
 * Bust the in-process Stripe price cache as soon as Stripe tells us the
 * price changed. Without this, the public Pricing page (and the in-app
 * upgrade/downgrade preview surfaces) would keep quoting the cached
 * value for up to `STRIPE_PRICE_CACHE_TTL_MS` after an operator edits
 * the price in the Stripe dashboard. Handles the create/update/delete
 * lifecycle for symmetry — `price.created` is included so a stale
 * negative-cache entry (e.g. from a transient retrieve failure on a
 * brand-new price id wired into env right after publish) cannot pin a
 * misleading value.
 *
 * Intentionally lightweight: synchronous cache mutation only, no DB or
 * external IO, so we don't need to add a row to `billing_events` for
 * idempotency. Stripe re-firing the same event id just re-busts the
 * (now-empty) entry, which is a no-op.
 */
function handlePriceMutated(price: Stripe.Price, eventType: string): void {
  const priceId = price?.id;
  if (!priceId) {
    logger.warn('Stripe price webhook missing price id', { eventType });
    return;
  }
  invalidateStripePrice(priceId);
}

export async function handleCheckoutCompleted(session: Stripe.Checkout.Session, stripeEventId: string): Promise<void> {
  const tenantId = session.metadata?.tenantId;
  if (!tenantId) {
    logger.warn('checkout.session.completed missing tenantId metadata', { sessionId: session.id });
    return;
  }

  if (session.metadata?.type === 'marketplace_purchase') {
    const purchaseId = session.metadata?.purchaseId;
    if (purchaseId) {
      try {
        const { completePurchase } = await import('../../marketplace/MarketplacePurchaseService');
        const paymentId = (session.payment_intent as string) ?? session.id;
        const subscriptionId = session.subscription ? String(session.subscription) : undefined;
        const result = await completePurchase(purchaseId, paymentId, subscriptionId);
        if (result.success) {
          logger.info('Marketplace purchase completed via webhook', { purchaseId, tenantId });
        } else {
          logger.warn('Marketplace purchase completion returned error', { purchaseId, error: result.error });
        }
      } catch (err) {
        logger.error('Failed to complete marketplace purchase via webhook', { purchaseId, error: String(err) });
      }
    }
    return;
  }

  const plan = session.metadata?.plan ?? 'starter';

  // Payment-mode sessions have no subscription and stay 'active'.
  let details: CheckoutSubscriptionDetails = EMPTY_CHECKOUT_DETAILS;

  if (session.subscription) {
    try {
      details = await retrieveCheckoutSubscription(session.subscription as string);
    } catch (err) {
      // Without the subscription we can't tell a trial apart, and on a
      // first signup customer.subscription.created usually arrived before
      // this event and was dropped (no row had the customer id yet), so
      // nothing would correct a guess. For a transient failure, throw so
      // the route returns 500 and Stripe retries; no billing_events row
      // has been written yet, so the retry isn't deduped.
      if (isTransientStripeError(err)) {
        logger.error('Could not fetch checkout subscription from Stripe; failing for retry', {
          sessionId: session.id, error: String(err),
        });
        throw err;
      }
      // A permanent error (missing resource, key/mode mismatch) would fail
      // the same way for ~3 days of retries and leave the tenant
      // unprovisioned. Write the row from the session instead; the next
      // subscription/invoice webhook corrects it.
      details = checkoutDetailsFromSession(session);
      logger.error('Could not fetch checkout subscription from Stripe (permanent); writing row from the session', {
        sessionId: session.id, error: String(err), status: details.status,
      });
    }
  }
  const { billingInterval, stripePriceId, status, trialEnd } = details;

  await withTenant(tenantId, async (client) => {
    // Capture the prior plan BEFORE the UPSERT below overwrites it. We
    // need this for the 'discount_switch_completed' attribution row
    // when the tenant upgraded straight from a discounted card without
    // also clicking the recommendation banner (in which case the
    // session metadata wouldn't carry recommendationCurrentTier). Once
    // the UPSERT runs, subscriptions.plan equals the *new* plan and
    // the prior tier is lost.
    let priorPlanForDiscount: string | null = null;
    try {
      const { rows: priorRows } = await client.query(
        `SELECT plan FROM subscriptions WHERE tenant_id = $1 LIMIT 1`,
        [tenantId],
      );
      const prior = priorRows[0]?.plan;
      if (prior === 'starter' || prior === 'pro' || prior === 'enterprise') {
        priorPlanForDiscount = prior;
      }
    } catch {
      priorPlanForDiscount = null;
    }

    await upsertCheckoutSubscription(client, {
      tenantId,
      plan,
      customerId: session.customer as string | null,
      subscriptionId: session.subscription as string | null,
      details,
    });

    await appendBillingEvent(client, tenantId, 'checkout_completed', {
      sessionId: session.id,
      plan,
      customerId: session.customer,
      billingInterval,
      stripePriceId,
      status,
      trialEnd,
    }, stripeEventId);

    // Server-authoritative attribution for the BillingEstimator's
    // "Switch to <Plan>" recommendation banner. The recommendation
    // snapshot is stamped into Stripe metadata when checkout is created
    // (see createCheckoutSession), so a row here is only written when
    // Stripe itself confirms the checkout completed for a session that
    // originated from the banner.
    if (session.metadata?.recommendationSource === 'billing_estimator_recommendation') {
      const recCurrent = session.metadata?.recommendationCurrentTier;
      const recRecommended = session.metadata?.recommendationRecommendedTier;
      const recSavings = Number(session.metadata?.recommendationMonthlySavingsCents);
      const recWindow = Number(session.metadata?.recommendationTrailingWindowMonths);
      // Pre–annual-pitch sessions (and any unknown value) fall back to
      // 'tier-switch' to satisfy the CHECK constraint.
      const recRawPitch = session.metadata?.recommendationPitch;
      const recPitch =
        recRawPitch === 'tier-switch' || recRawPitch === 'annual-only'
          ? recRawPitch
          : 'tier-switch';
      if (
        (recCurrent === 'starter' || recCurrent === 'pro' || recCurrent === 'enterprise') &&
        (recRecommended === 'starter' || recRecommended === 'pro' || recRecommended === 'enterprise')
      ) {
        try {
          await client.query(
            `INSERT INTO billing_recommendation_events
               (tenant_id, event_type, current_tier, recommended_tier,
                monthly_savings_cents, trailing_window_months, metadata,
                pitch)
             VALUES ($1, 'switch_completed', $2, $3, $4, $5, $6::jsonb, $7)`,
            [
              tenantId,
              recCurrent,
              recRecommended,
              Number.isFinite(recSavings) && recSavings >= 0 ? Math.round(recSavings) : null,
              Number.isFinite(recWindow) && (recWindow === 3 || recWindow === 6 || recWindow === 12)
                ? recWindow
                : null,
              JSON.stringify({
                stripeSessionId: session.id,
                stripeEventId,
                source: 'stripe_webhook',
              }),
              recPitch,
            ],
          );
        } catch (err) {
          logger.warn('Failed to record recommendation switch_completed event', {
            tenantId,
            sessionId: session.id,
            error: String(err),
          });
        }
      }
    }

    // Server-authoritative attribution for the upgrade-card discount
    // badge. The discount snapshot (couponId / promotionCode) is stamped
    // into Stripe metadata when checkout is created (see
    // createCheckoutSession), so a 'discount_switch_completed' row here
    // means Stripe itself confirmed the conversion for a session that
    // originated from a discounted upgrade CTA. Independent of the
    // recommendation banner — both rows can be written for the same
    // session if the tenant clicked a recommended tier that also had
    // an active discount badge.
    const discountCouponId = session.metadata?.upgradeDiscountCouponId ?? null;
    const discountPromotionCode = session.metadata?.upgradeDiscountPromotionCode ?? null;
    if (discountCouponId || discountPromotionCode) {
      // current_tier prefers the recommendation snapshot (if the tenant
      // also clicked through the banner) and falls back to the prior
      // plan we captured BEFORE the UPSERT. This keeps "X → Y under
      // coupon Z" rollups in the discount report accurate even when
      // the recommendation banner wasn't involved.
      const recCurrentForDiscount = session.metadata?.recommendationCurrentTier;
      const currentTierForDiscount: string | null =
        recCurrentForDiscount === 'starter' ||
        recCurrentForDiscount === 'pro' ||
        recCurrentForDiscount === 'enterprise'
          ? recCurrentForDiscount
          : priorPlanForDiscount;
      const recommendedTierForDiscount = plan;
      if (
        (currentTierForDiscount === 'starter' ||
          currentTierForDiscount === 'pro' ||
          currentTierForDiscount === 'enterprise') &&
        (recommendedTierForDiscount === 'starter' ||
          recommendedTierForDiscount === 'pro' ||
          recommendedTierForDiscount === 'enterprise')
      ) {
        try {
          await client.query(
            `INSERT INTO billing_recommendation_events
               (tenant_id, event_type, current_tier, recommended_tier,
                monthly_savings_cents, trailing_window_months, metadata,
                coupon_id, promotion_code)
             VALUES ($1, 'discount_switch_completed', $2, $3, NULL, NULL, $4::jsonb, $5, $6)`,
            [
              tenantId,
              currentTierForDiscount,
              recommendedTierForDiscount,
              JSON.stringify({
                stripeSessionId: session.id,
                stripeEventId,
                source: 'stripe_webhook',
              }),
              discountCouponId,
              discountPromotionCode,
            ],
          );
        } catch (err) {
          logger.warn('Failed to record discount_switch_completed event', {
            tenantId,
            sessionId: session.id,
            error: String(err),
          });
        }
      }
    }
  });

  logger.info('Subscription activated from checkout', { tenantId, plan, billingInterval, status });

  try {
    const tenantStatus = await withPrivilegedClient(async (client) => {
      const { rows } = await client.query(
        `SELECT status FROM tenants WHERE id = $1`,
        [tenantId],
      );
      return rows[0]?.status as string | undefined;
    });

    if (tenantStatus === 'pending' || tenantStatus === 'provisioning') {
      const userId = session.metadata?.userId;
      if (userId) {
        await provisionTenant(tenantId, userId, plan);
        logger.info('Tenant provisioned via checkout webhook', { tenantId, userId, plan });
      } else {
        logger.warn('checkout.session.completed missing userId metadata for provisioning', { tenantId });
      }
    }
  } catch (err) {
    logger.error('Auto-provisioning after checkout failed (non-fatal)', { tenantId, error: String(err) });
  }
}

/**
 * The subscription an invoice belongs to. Older API versions put it on
 * `invoice.subscription`; newer ones on
 * `invoice.parent.subscription_details.subscription`. Either may be an id
 * or an expanded object. `null` for one-off (payment-mode) invoices.
 */
function invoiceSubscriptionId(invoice: Stripe.Invoice): string | null {
  type SubRef = string | { id?: string } | null | undefined;
  const raw = invoice as unknown as {
    subscription?: SubRef;
    parent?: { subscription_details?: { subscription?: SubRef } | null } | null;
  };
  const ref = raw.subscription ?? raw.parent?.subscription_details?.subscription ?? null;
  if (typeof ref === 'string') return ref || null;
  return ref?.id ?? null;
}

/**
 * Resolve the tenant and plan subscription an invoice event may touch.
 * Returns `null` (plan row left alone) for one-off invoices and marketplace
 * subscriptions. `subscription` is the state re-read from Stripe, or `null`
 * if Stripe couldn't be reached. Whether the subscription is the one the
 * plan row tracks is checked by the caller's UPDATE.
 */
async function resolvePlanInvoice(invoice: Stripe.Invoice): Promise<{
  tenantId: string;
  subscriptionId: string;
  subscription: Stripe.Subscription | null;
} | null> {
  const tenantId = await getTenantByCustomer(invoice.customer as string);
  if (!tenantId) return null;

  const subscriptionId = invoiceSubscriptionId(invoice);
  if (!subscriptionId) {
    logger.info('Invoice has no subscription; plan row left alone', { tenantId, invoiceId: invoice.id });
    return null;
  }

  let subscription: Stripe.Subscription | null = null;
  try {
    const latest = await getStripeClient().subscriptions.retrieve(subscriptionId);
    if (latest?.id) subscription = latest;
  } catch (err) {
    logger.warn('Could not re-fetch invoice subscription from Stripe; using invoice outcome', {
      subscriptionId, error: String(err),
    });
  }

  const forMarketplaceCheck = subscription ?? ({ id: subscriptionId, metadata: {} } as unknown as Stripe.Subscription);
  if (await isMarketplaceSubscription(forMarketplaceCheck)) {
    logger.info('Marketplace subscription invoice; plan row left alone', { tenantId, subscriptionId, invoiceId: invoice.id });
    return null;
  }

  return { tenantId, subscriptionId, subscription };
}

/**
 * Fallback when Stripe can't be reached: apply the invoice outcome to the
 * plan row, but only if it tracks this subscription (or none yet).
 */
async function applyInvoiceStatusFallback(
  tenantId: string,
  subscriptionId: string,
  statusSql: string,
  statusValues: unknown[],
  billingEvent: { type: string; data: Record<string, unknown> },
  stripeEventId: string,
): Promise<void> {
  await withTenant(tenantId, async (client) => {
    const result = await client.query(
      `UPDATE subscriptions SET status = ${statusSql}, updated_at = NOW()
        WHERE tenant_id = $1 AND (stripe_subscription_id = $2 OR stripe_subscription_id IS NULL)`,
      [tenantId, subscriptionId, ...statusValues],
    );
    if (!result.rowCount) {
      logger.info('Invoice is not for the tenant plan subscription; plan row left alone', { tenantId, subscriptionId });
      return;
    }
    await appendBillingEvent(client, tenantId, billingEvent.type, billingEvent.data, stripeEventId);
  });
}

async function handleInvoiceSucceeded(invoice: Stripe.Invoice, stripeEventId: string): Promise<void> {
  const target = await resolvePlanInvoice(invoice);
  if (!target) return;
  const { tenantId, subscriptionId, subscription } = target;
  const billingEvent = {
    type: 'payment_succeeded',
    data: {
      invoiceId: invoice.id,
      subscriptionId,
      amountPaid: invoice.amount_paid,
      currency: invoice.currency,
    },
  };

  if (subscription) {
    // Stripe's current status already covers the $0 trial-start invoice
    // (still 'trialing') and a recovered past_due (now 'active').
    await syncPlanSubscription(tenantId, subscription, stripeEventId, billingEvent);
  } else {
    // Stripe "pays" a $0 invoice when a trial starts; that must not end
    // the local trial. A real charge (or any non-trial row) still
    // flips the subscription to 'active'.
    await applyInvoiceStatusFallback(
      tenantId, subscriptionId,
      `CASE WHEN status = 'trialing' AND $3::bigint = 0 THEN status ELSE 'active' END`,
      [invoice.amount_paid ?? 0],
      billingEvent, stripeEventId,
    );
  }

  logger.info('Invoice payment succeeded', { tenantId, invoiceId: invoice.id, subscriptionId });
}

/**
 * Stamp a coupon-aware "Discount applied" badge onto the Stripe invoice
 * before the receipt PDF is generated/emailed. Mirrors the same badge
 * the tenant already sees in the Subscription card and invoice list, so
 * Finance teams archiving the PDF can verify the coupon matches what
 * was negotiated without reopening the app.
 *
 * Stripe natively renders a "Discount" subtotal line on the PDF when a
 * coupon is on the invoice, but it surfaces only the dollar/percent
 * amount — not the coupon name or promo code. We add an
 * `invoice.custom_fields` entry (a labelled badge near the header) AND
 * a footer line so the coupon's identity rides along with the receipt.
 *
 * Timing — why `invoice.finalized` (not `invoice.created`):
 *   Stripe regenerates the receipt PDF whenever the invoice is updated,
 *   and for `charge_automatically` subscriptions the receipt email is
 *   sent shortly after `invoice.payment_succeeded`. Hooking the
 *   `invoice.finalized` event puts the update *before* payment + email
 *   under normal lifecycle ordering. There is a narrow race window
 *   (Stripe generally processes finalize→pay→send within a few hundred
 *   ms) where the first email could escape with the un-badged PDF; the
 *   `invoices.update` here will still re-stamp the persisted PDF that
 *   the customer downloads later from the hosted invoice page or the
 *   billing portal. If real-world receipt timing proves unreliable in
 *   production, a follow-up could move stamping into `invoice.created`
 *   or stamp via `subscription_data.invoice_settings` at session
 *   creation time.
 *
 * Idempotency — why metadata-only (not `billing_events`):
 *   The global `isEventProcessed` check in `handleStripeEvent` only
 *   short-circuits events for which we wrote a row to `billing_events`.
 *   We deliberately don't write one for `invoice.finalized` — it isn't
 *   a billing-state-change event for our domain (subscription status
 *   doesn't move on finalize). Instead we use
 *   `invoice.metadata.discountBadgeApplied = 'true'` as a per-invoice
 *   marker, which:
 *     1. Survives Stripe retries of the same event id (Stripe re-fires
 *        finalized on certain mutations), and
 *     2. Crucially, makes the no-discount and Stripe-update-failure
 *        paths *re-runnable*. If we stored a `billing_events` row on
 *        the first attempt, a subsequent retry after a transient Stripe
 *        outage would be silently dropped.
 */
export async function handleInvoiceFinalized(invoice: Stripe.Invoice): Promise<void> {
  const invoiceId = invoice.id;
  if (!invoiceId) return;

  // Skip when no discount is on the invoice — nothing to badge.
  const totalDiscountAmounts = (invoice as unknown as {
    total_discount_amounts?: unknown[] | null;
  }).total_discount_amounts;
  const hasDiscount = Array.isArray(totalDiscountAmounts) && totalDiscountAmounts.length > 0;
  if (!hasDiscount) return;

  // Skip if we've already stamped this invoice.
  if (invoice.metadata?.discountBadgeApplied === 'true') return;

  let stripe: Stripe;
  try {
    stripe = getStripeClient();
  } catch (err) {
    logger.warn('Stripe client unavailable — skipping discount badge', {
      invoiceId,
      error: String(err),
    });
    return;
  }

  // Re-retrieve with discounts expanded so we can read coupon name +
  // percent/amount off. The webhook payload doesn't expand by default.
  let discount: UpgradeDiscount | null = null;
  try {
    const expanded = await stripe.invoices.retrieve(invoiceId, {
      expand: ['discounts', 'discounts.promotion_code'],
    });
    const rawDiscounts = (expanded as unknown as {
      discounts?: unknown[] | null;
    }).discounts ?? [];
    for (const raw of rawDiscounts) {
      if (typeof raw !== 'object' || raw === null) continue;
      const normalized = normalizeDiscount(
        raw as Parameters<typeof normalizeDiscount>[0],
      );
      if (normalized) {
        discount = normalized;
        break;
      }
    }
  } catch (err) {
    logger.warn('Failed to expand discounts on invoice.finalized', {
      invoiceId,
      error: String(err),
    });
    return;
  }

  if (!discount) return;

  const fieldName = 'Discount applied';
  // Stripe limits invoice custom_field name + value to 30 chars each.
  const fieldValue = formatDiscountBadgeLabel(discount).slice(0, 30);
  const footerLine = formatDiscountFooter(discount);

  // Preserve any custom fields the operator already set in the Stripe
  // dashboard; only replace our own slot. Cap at Stripe's 4-field max.
  const existingFields = (invoice.custom_fields ?? []).filter(
    (f) => f && f.name !== fieldName,
  );
  const customFields = [
    ...existingFields,
    { name: fieldName, value: fieldValue },
  ].slice(0, 4);

  const existingFooter = invoice.footer ?? '';
  const footer =
    existingFooter && !existingFooter.includes(footerLine)
      ? `${existingFooter}\n\n${footerLine}`
      : existingFooter || footerLine;

  try {
    await stripe.invoices.update(invoiceId, {
      custom_fields: customFields,
      footer,
      metadata: {
        ...(invoice.metadata ?? {}),
        discountBadgeApplied: 'true',
        discountBadgeCouponId: discount.couponId ?? '',
        discountBadgePromotionCode: discount.promotionCode ?? '',
      },
    });
    logger.info('Stamped discount badge on invoice', {
      invoiceId,
      couponId: discount.couponId,
      promotionCode: discount.promotionCode,
    });
  } catch (err) {
    logger.warn('Failed to stamp discount badge on invoice', {
      invoiceId,
      error: String(err),
    });
  }

  // Mirror the badge onto the originating `marketplace_purchases` row so
  // the in-app marketplace purchase history view can render the same
  // "Discount applied: <coupon>" chip the receipt PDF carries (Task
  // #1373) without a per-row Stripe round-trip. We match the invoice
  // back to a purchase via:
  //   1. One-off purchases — `invoice.metadata.purchaseId`, stamped on
  //      `invoice_creation.invoice_data.metadata` when the Checkout
  //      session was created (see `MarketplacePurchaseService`).
  //   2. Subscription purchases — `invoice.subscription`, which
  //      `completePurchase` writes back to
  //      `marketplace_purchases.stripe_subscription_id` on first
  //      checkout.completion. Subscription metadata isn't inherited by
  //      Stripe-issued invoices, so the subscription id is the only
  //      stable join key for renewal invoices.
  let purchaseIdToBadge: string | null = null;
  const metaPurchaseId = invoice.metadata?.purchaseId;
  if (typeof metaPurchaseId === 'string' && metaPurchaseId.length > 0) {
    purchaseIdToBadge = metaPurchaseId;
  } else {
    const subId = invoiceSubscriptionId(invoice);
    if (subId) {
      try {
        const pool = getPlatformPool();
        const { rows } = await pool.query(
          `SELECT id FROM marketplace_purchases
            WHERE stripe_subscription_id = $1
            ORDER BY completed_at DESC NULLS LAST
            LIMIT 1`,
          [subId],
        );
        if (rows.length > 0) {
          purchaseIdToBadge = rows[0].id as string;
        }
      } catch (err) {
        logger.warn('Failed to resolve marketplace purchase from subscription', {
          invoiceId, subscriptionId: subId, error: String(err),
        });
      }
    }
  }

  if (purchaseIdToBadge) {
    try {
      const { applyInvoiceDiscountToPurchase } = await import(
        '../../marketplace/MarketplacePurchaseService'
      );
      await applyInvoiceDiscountToPurchase(purchaseIdToBadge, discount);
    } catch (err) {
      logger.warn('Failed to mirror discount badge to marketplace purchase', {
        invoiceId, purchaseId: purchaseIdToBadge, error: String(err),
      });
    }
  }
}

/**
 * Format the short badge value shown in the invoice's `custom_fields`
 * row near the PDF header. Capped externally at Stripe's 30-char limit;
 * this helper just chooses the most informative label/amount pair.
 */
export function formatDiscountBadgeLabel(d: UpgradeDiscount): string {
  const label = d.promotionCode ?? d.name ?? d.couponId ?? 'Coupon';
  if (d.percentOff != null) {
    const pct = Number.isInteger(d.percentOff)
      ? d.percentOff
      : Number(d.percentOff.toFixed(2));
    return `${label} - ${pct}% off`;
  }
  if (d.amountOffCents != null) {
    // eslint-disable-next-line local/no-cents-divided-by-100 -- cents→dollars formatting for the human-readable badge value on the receipt PDF.
    const dollars = (d.amountOffCents / 100).toFixed(2);
    const cur = (d.currency ?? 'usd').toUpperCase();
    return `${label} - ${cur} ${dollars} off`;
  }
  return label;
}

/**
 * Format the longer footer sentence appended to the invoice PDF. Unlike
 * the badge, this isn't length-limited, so we spell out "code" vs
 * "coupon" so Finance/procurement readers don't have to guess what
 * identifier they're looking at.
 */
export function formatDiscountFooter(d: UpgradeDiscount): string {
  const codeLabel = d.promotionCode
    ? `promo code "${d.promotionCode}"`
    : d.name
      ? `coupon "${d.name}"`
      : 'coupon';
  if (d.percentOff != null) {
    const pct = Number.isInteger(d.percentOff)
      ? d.percentOff
      : Number(d.percentOff.toFixed(2));
    return `Discount applied: ${codeLabel} - ${pct}% off this invoice.`;
  }
  if (d.amountOffCents != null) {
    // eslint-disable-next-line local/no-cents-divided-by-100 -- cents→dollars formatting for the human-readable footer line on the receipt PDF.
    const dollars = (d.amountOffCents / 100).toFixed(2);
    const cur = (d.currency ?? 'usd').toUpperCase();
    return `Discount applied: ${codeLabel} - ${cur} ${dollars} off this invoice.`;
  }
  return `Discount applied: ${codeLabel}.`;
}

async function handleInvoiceFailed(invoice: Stripe.Invoice, stripeEventId: string): Promise<void> {
  const target = await resolvePlanInvoice(invoice);
  if (!target) return;
  const { tenantId, subscriptionId, subscription } = target;
  const billingEvent = {
    type: 'payment_failed',
    data: {
      invoiceId: invoice.id,
      subscriptionId,
      attemptCount: invoice.attempt_count,
    },
  };

  if (subscription) {
    // Re-read status so a late retry of an old failure can't overwrite a
    // later successful payment.
    await syncPlanSubscription(tenantId, subscription, stripeEventId, billingEvent);
  } else {
    await applyInvoiceStatusFallback(tenantId, subscriptionId, `'past_due'`, [], billingEvent, stripeEventId);
  }

  logger.warn('Invoice payment failed', { tenantId, invoiceId: invoice.id, subscriptionId });
}

/**
 * Marketplace template subscriptions share the tenant's Stripe customer
 * but are tracked in `marketplace_purchases`, never on the plan row.
 * Older ones carry no `metadata.type`, so also check the purchases table.
 */
async function isMarketplaceSubscription(sub: Stripe.Subscription): Promise<boolean> {
  if (sub.metadata?.type === 'marketplace_purchase') return true;
  const { rows } = await getPlatformPool().query(
    `SELECT 1 FROM marketplace_purchases WHERE stripe_subscription_id = $1 LIMIT 1`,
    [sub.id],
  );
  return rows.length > 0;
}

/**
 * Stripe doesn't guarantee event order and retries can land hours late,
 * so read the subscription's current state instead of trusting the
 * payload. Falls back to the payload if Stripe can't be reached.
 */
async function fetchLatestSubscription(sub: Stripe.Subscription): Promise<Stripe.Subscription> {
  try {
    const latest = await getStripeClient().subscriptions.retrieve(sub.id);
    if (latest?.id) return latest;
  } catch (err) {
    logger.warn('Could not re-fetch subscription from Stripe; using event payload', {
      subscriptionId: sub.id,
      error: String(err),
    });
  }
  return sub;
}

async function handleSubscriptionDeleted(sub: Stripe.Subscription, stripeEventId: string): Promise<void> {
  const customerId = sub.customer as string;
  const tenantId = await getTenantByCustomer(customerId);
  if (!tenantId) return;

  if (!(await isMarketplaceSubscription(sub))) {
    await withTenant(tenantId, async (client) => {
      // Only cancel the plan row for the subscription it tracks; an old
      // subscription left over from an upgrade must not cancel the new one.
      const result = await client.query(
        `UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
         WHERE tenant_id = $1 AND (stripe_subscription_id = $2 OR stripe_subscription_id IS NULL)`,
        [tenantId, sub.id],
      );
      if (!result.rowCount) {
        logger.info('Deleted subscription is not the tenant plan subscription; plan row left alone', {
          tenantId, subscriptionId: sub.id,
        });
        return;
      }
      await appendBillingEvent(client, tenantId, 'subscription_cancelled', { subscriptionId: sub.id }, stripeEventId);
    });
  }

  const pool = getPlatformPool();
  await pool.query(
    `UPDATE marketplace_purchases SET subscription_status = 'canceled'
     WHERE stripe_subscription_id = $1`,
    [sub.id],
  );

  logger.info('Subscription cancelled', { tenantId, subscriptionId: sub.id });
}

// Tier rank used by `handleSubscriptionUpdated` to detect a *strict*
// tier downgrade landing on the local subscriptions row (typically the
// scheduled second-phase swap fired by /billing/schedule-downgrade).
// Mirrors `TIER_ORDER` in `planChange.ts` — kept inline here so the
// webhook stays self-contained and a future change to the rank order
// can't silently desynchronize the two paths.
const PLAN_TIER_RANK: Record<string, number> = { starter: 0, pro: 1, enterprise: 2 };

async function handleSubscriptionUpdated(payload: Stripe.Subscription, stripeEventId: string): Promise<void> {
  const customerId = payload.customer as string;
  const tenantId = await getTenantByCustomer(customerId);
  if (!tenantId) return;

  const sub = await fetchLatestSubscription(payload);

  if (await isMarketplaceSubscription(sub)) {
    logger.info('Marketplace subscription event; plan row left alone', { tenantId, subscriptionId: sub.id });
  } else {
    await syncPlanSubscription(tenantId, sub, stripeEventId);
  }

  const marketplaceSubStatus = sub.status === 'active' ? 'active'
    : sub.status === 'past_due' ? 'past_due'
    : sub.status === 'canceled' ? 'canceled'
    : sub.status === 'unpaid' ? 'unpaid'
    : 'incomplete';
  const pool = getPlatformPool();
  await pool.query(
    `UPDATE marketplace_purchases SET subscription_status = $1
     WHERE stripe_subscription_id = $2`,
    [marketplaceSubStatus, sub.id],
  );
}

/**
 * Sync the tenant's plan row from the subscription it tracks. Records
 * `billingEvent` (default: subscription_updated) only when the row was
 * the subscription's.
 */
async function syncPlanSubscription(
  tenantId: string,
  sub: Stripe.Subscription,
  stripeEventId: string,
  billingEvent?: { type: string; data: Record<string, unknown> },
): Promise<void> {
  const item = sub.items?.data?.[0];
  const priceId = item?.price?.id;
  const plan = priceId ? getPlanFromPriceId(priceId) : undefined;
  const limits = plan ? PLAN_LIMITS[plan] : undefined;

  // Pull billing interval off the active price so a scheduled
  // monthly→annual or annual→monthly downgrade actually flips the
  // local `billing_interval` + `stripe_price_id` columns when Stripe
  // transitions schedule phases. Without this, the Billing UI would
  // show the OLD interval after a phase transition even though Stripe
  // is now charging the new cadence.
  const priceRaw = item?.price as unknown as Record<string, unknown> | undefined;
  const recurringRaw = priceRaw?.recurring as Record<string, unknown> | undefined;
  const stripeIntervalRaw =
    (recurringRaw?.interval as string | undefined)
    ?? (priceRaw?.recurring_interval as string | undefined);
  // Same Stripe-interval normalization as handleCheckoutCompleted —
  // the two paths must always store identical values into the
  // `billing_interval` enum column or the Billing UI desyncs after a
  // scheduled phase transition.
  const billingInterval = normalizeBillingInterval(stripeIntervalRaw) ?? undefined;

  await withTenant(tenantId, async (client) => {
    // Capture the prior plan BEFORE the UPDATE below overwrites it. We
    // need this to detect a strict tier downgrade applied by the webhook
    // (typically the second-phase swap on a Subscription Schedule fired
    // by /billing/schedule-downgrade). When detected we stamp
    // `downgrade_completed_at` / `downgrade_completed_to_plan` so the
    // Billing UI can render a one-time "Your downgrade to <Plan> is now
    // active" banner on the tenant's next visit (Task #1366).
    let priorPlanForDowngrade: string | null = null;
    let trackedSubscriptionId: string | null = null;
    try {
      const { rows: priorRows } = await client.query(
        `SELECT plan, stripe_subscription_id FROM subscriptions WHERE tenant_id = $1 LIMIT 1`,
        [tenantId],
      );
      const prior = priorRows[0]?.plan;
      if (typeof prior === 'string') priorPlanForDowngrade = prior;
      const tracked = priorRows[0]?.stripe_subscription_id;
      if (typeof tracked === 'string' && tracked) trackedSubscriptionId = tracked;
    } catch {
      priorPlanForDowngrade = null;
    }

    // Another subscription on the same customer (e.g. the old one left
    // running after a checkout upgrade) must not overwrite the plan row.
    if (trackedSubscriptionId && trackedSubscriptionId !== sub.id) {
      logger.info('Subscription event is not for the tenant plan subscription; plan row left alone', {
        tenantId, subscriptionId: sub.id, trackedSubscriptionId,
      });
      return;
    }

    const updateFields: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [tenantId, sub.id];

    if (plan) { values.push(plan); updateFields.push(`plan = $${values.length}`); }
    if (limits) {
      values.push(limits.monthlyCallLimit); updateFields.push(`monthly_call_limit = $${values.length}`);
      values.push(limits.monthlySmsLimit); updateFields.push(`monthly_sms_limit = $${values.length}`);
      values.push(limits.monthlyAiMinuteLimit); updateFields.push(`monthly_ai_minute_limit = $${values.length}`);
      values.push(limits.overageEnabled); updateFields.push(`overage_enabled = $${values.length}`);
    }
    if (priceId) { values.push(priceId); updateFields.push(`stripe_price_id = $${values.length}`); }
    if (billingInterval) {
      values.push(billingInterval);
      updateFields.push(`billing_interval = $${values.length}::billing_interval`);
    }

    // Strict tier-downgrade detection. We require both plans to be in
    // the rank table — an unknown prior plan (or unmapped new price)
    // could otherwise spuriously trigger the banner. Idempotent on
    // retry: once the local row reflects the new lower tier, the prior
    // plan equals the new plan and this branch is skipped.
    const isStrictTierDowngrade =
      typeof plan === 'string' &&
      priorPlanForDowngrade !== null &&
      priorPlanForDowngrade !== plan &&
      Object.prototype.hasOwnProperty.call(PLAN_TIER_RANK, priorPlanForDowngrade) &&
      Object.prototype.hasOwnProperty.call(PLAN_TIER_RANK, plan) &&
      PLAN_TIER_RANK[priorPlanForDowngrade] > PLAN_TIER_RANK[plan];
    if (isStrictTierDowngrade && plan) {
      updateFields.push('downgrade_completed_at = NOW()');
      values.push(plan);
      updateFields.push(`downgrade_completed_to_plan = $${values.length}`);
    }

    const rawSub = sub as unknown as Record<string, unknown>;
    const rawPeriodStart = rawSub.current_period_start as number | undefined;
    const rawPeriodEnd = rawSub.current_period_end as number | undefined;
    const currentPeriodStart = rawPeriodStart
      ? new Date(rawPeriodStart * 1000).toISOString()
      : null;
    const currentPeriodEnd = rawPeriodEnd
      ? new Date(rawPeriodEnd * 1000).toISOString()
      : null;
    if (currentPeriodStart) { values.push(currentPeriodStart); updateFields.push(`current_period_start = $${values.length}`); }
    if (currentPeriodEnd) { values.push(currentPeriodEnd); updateFields.push(`current_period_end = $${values.length}`); }

    // Keep status and trial_end in step with Stripe, e.g. trialing → active
    // when the trial converts, or → past_due when the first charge fails.
    const status = mapStripeSubscriptionStatus(sub.status);
    if (status) { values.push(status); updateFields.push(`status = $${values.length}::subscription_status`); }
    const trialEnd = stripeTrialEnd(sub);
    if (trialEnd !== undefined) { values.push(trialEnd); updateFields.push(`trial_end = $${values.length}`); }

    const result = await client.query(
      `UPDATE subscriptions SET ${updateFields.join(', ')}
        WHERE tenant_id = $1 AND (stripe_subscription_id = $2 OR stripe_subscription_id IS NULL)`,
      values,
    );
    if (!result.rowCount) return;
    const recorded = billingEvent
      ? { type: billingEvent.type, data: { ...billingEvent.data, plan, status, trialEnd } }
      : { type: 'subscription_updated', data: { plan, subscriptionId: sub.id, status, trialEnd } };
    await appendBillingEvent(client, tenantId, recorded.type, recorded.data, stripeEventId);
  });
}

async function getTenantByCustomer(customerId: string): Promise<string | null> {
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(
      `SELECT tenant_id FROM subscriptions WHERE stripe_customer_id = $1 LIMIT 1`,
      [customerId],
    );
    return rows[0]?.tenant_id as string ?? null;
  });
}

const EVENT_TYPE_MAP: Record<string, string> = {
  checkout_completed: 'subscription_created',
  payment_succeeded: 'invoice_paid',
  payment_failed: 'invoice_failed',
  subscription_cancelled: 'subscription_cancelled',
  subscription_updated: 'subscription_updated',
};

async function appendBillingEvent(
  client: { query: (sql: string, values?: unknown[]) => Promise<unknown> },
  tenantId: string,
  eventType: string,
  data: Record<string, unknown>,
  stripeEventId?: string,
): Promise<void> {
  const dbEventType = EVENT_TYPE_MAP[eventType] ?? 'subscription_updated';
  try {
    await client.query(
      `INSERT INTO billing_events (tenant_id, event_type, stripe_event_id, metadata)
       VALUES ($1, $2::billing_event_type, $3, $4)`,
      [tenantId, dbEventType, stripeEventId ?? null, JSON.stringify(data)],
    );
  } catch (err) {
    logger.warn('Failed to append billing event (non-fatal)', { tenantId, eventType, error: String(err) });
  }
}
