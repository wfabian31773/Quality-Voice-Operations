import type Stripe from 'stripe';
import { getStripeClient, getWebhookSecret } from './client';
import { getPlanFromPriceId, PLAN_LIMITS } from './plans';
import { getPlatformPool, withTenantContext } from '../../db';
import { createLogger } from '../../core/logger';
import { provisionTenant } from '../../tenant/provisioning/TenantProvisioningService';
import { normalizeDiscount, type UpgradeDiscount } from './effectiveRate';

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

async function withPrivilegedClient<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL row_security = off`);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
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
    case 'customer.subscription.updated':
      await handleSubscriptionUpdated(event.data.object as Stripe.Subscription, stripeEventId);
      break;
    default:
      logger.info('Unhandled Stripe event type', { type: event.type });
  }
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
  const limits = PLAN_LIMITS[plan as keyof typeof PLAN_LIMITS] ?? PLAN_LIMITS.starter;

  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  let billingInterval: string | null = null;
  let stripePriceId: string | null = null;

  if (session.subscription) {
    try {
      const stripe = getStripeClient();
      const sub = await stripe.subscriptions.retrieve(session.subscription as string);
      const rawSub = sub as unknown as Record<string, unknown>;
      const rawStart = rawSub.current_period_start as number | undefined;
      const rawEnd = rawSub.current_period_end as number | undefined;
      if (rawStart) periodStart = new Date(rawStart * 1000).toISOString();
      if (rawEnd) periodEnd = new Date(rawEnd * 1000).toISOString();
      const item = sub.items?.data?.[0];
      if (item?.price?.id) stripePriceId = item.price.id;
      const priceRaw = item?.price as unknown as Record<string, unknown> | undefined;
      const recurringRaw = priceRaw?.recurring as Record<string, unknown> | undefined;
      const interval = (recurringRaw?.interval as string | undefined)
        ?? (priceRaw?.recurring_interval as string | undefined);
      // Normalize Stripe's 'month'/'year' to the local billing_interval
      // enum's 'monthly'/'annual' BEFORE storing — otherwise the
      // `$6::billing_interval` cast in the INSERT below blows up on a
      // raw 'year' value and the whole checkout webhook fails.
      billingInterval = normalizeBillingInterval(interval);
    } catch (err) {
      logger.warn('Could not fetch subscription period from Stripe', { error: String(err) });
    }
  }

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

    await client.query(
      `INSERT INTO subscriptions (tenant_id, plan, status, stripe_customer_id, stripe_subscription_id,
         stripe_price_id, billing_interval,
         monthly_call_limit, monthly_sms_limit, monthly_ai_minute_limit, overage_enabled,
         current_period_start, current_period_end)
       VALUES ($1, $2, 'active', $3, $4, $5, COALESCE($6::billing_interval, 'monthly'),
         $7, $8, $9, $10, $11, $12)
       ON CONFLICT (tenant_id) DO UPDATE SET
         plan = EXCLUDED.plan, status = 'active',
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
         updated_at = NOW()`,
      [tenantId, plan, session.customer, session.subscription,
       stripePriceId, billingInterval,
       limits.monthlyCallLimit, limits.monthlySmsLimit, limits.monthlyAiMinuteLimit, limits.overageEnabled,
       periodStart, periodEnd],
    );

    await appendBillingEvent(client, tenantId, 'checkout_completed', {
      sessionId: session.id,
      plan,
      customerId: session.customer,
      billingInterval,
      stripePriceId,
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

  logger.info('Subscription activated from checkout', { tenantId, plan, billingInterval });

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

async function handleInvoiceSucceeded(invoice: Stripe.Invoice, stripeEventId: string): Promise<void> {
  const customerId = invoice.customer as string;
  const tenantId = await getTenantByCustomer(customerId);
  if (!tenantId) return;

  await withTenant(tenantId, async (client) => {
    await client.query(
      `UPDATE subscriptions SET status = 'active', updated_at = NOW() WHERE tenant_id = $1`,
      [tenantId],
    );
    await appendBillingEvent(client, tenantId, 'payment_succeeded', {
      invoiceId: invoice.id,
      amountPaid: invoice.amount_paid,
      currency: invoice.currency,
    }, stripeEventId);
  });

  logger.info('Invoice payment succeeded', { tenantId, invoiceId: invoice.id });
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
  const customerId = invoice.customer as string;
  const tenantId = await getTenantByCustomer(customerId);
  if (!tenantId) return;

  await withTenant(tenantId, async (client) => {
    await client.query(
      `UPDATE subscriptions SET status = 'past_due', updated_at = NOW() WHERE tenant_id = $1`,
      [tenantId],
    );
    await appendBillingEvent(client, tenantId, 'payment_failed', {
      invoiceId: invoice.id,
      attemptCount: invoice.attempt_count,
    }, stripeEventId);
  });

  logger.warn('Invoice payment failed', { tenantId, invoiceId: invoice.id });
}

async function handleSubscriptionDeleted(sub: Stripe.Subscription, stripeEventId: string): Promise<void> {
  const customerId = sub.customer as string;
  const tenantId = await getTenantByCustomer(customerId);
  if (!tenantId) return;

  await withTenant(tenantId, async (client) => {
    await client.query(
      `UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
       WHERE tenant_id = $1`,
      [tenantId],
    );
    await appendBillingEvent(client, tenantId, 'subscription_cancelled', { subscriptionId: sub.id }, stripeEventId);
  });

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

async function handleSubscriptionUpdated(sub: Stripe.Subscription, stripeEventId: string): Promise<void> {
  const customerId = sub.customer as string;
  const tenantId = await getTenantByCustomer(customerId);
  if (!tenantId) return;

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
    try {
      const { rows: priorRows } = await client.query(
        `SELECT plan FROM subscriptions WHERE tenant_id = $1 LIMIT 1`,
        [tenantId],
      );
      const prior = priorRows[0]?.plan;
      if (typeof prior === 'string') priorPlanForDowngrade = prior;
    } catch {
      priorPlanForDowngrade = null;
    }

    const updateFields: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [tenantId];

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

    await client.query(
      `UPDATE subscriptions SET ${updateFields.join(', ')} WHERE tenant_id = $1`,
      values,
    );
    await appendBillingEvent(client, tenantId, 'subscription_updated', { plan, subscriptionId: sub.id }, stripeEventId);
  });

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
