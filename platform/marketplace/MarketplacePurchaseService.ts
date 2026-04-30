import { randomUUID } from 'node:crypto';
import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import type { TenantId } from '../core/types';

const logger = createLogger('MARKETPLACE_PURCHASES');

export interface PurchaseInput {
  tenantId: TenantId;
  userId: string;
  templateId: string;
  successUrl: string;
  cancelUrl: string;
}

export interface PurchaseRecord {
  id: string;
  tenantId: string;
  userId: string;
  templateId: string;
  amountCents: number;
  status: string;
  createdAt: string;
  completedAt: string | null;
}

export async function createMarketplacePurchase(input: PurchaseInput): Promise<{
  success: boolean;
  error?: string;
  checkoutUrl?: string;
  purchaseId?: string;
  isFree?: boolean;
}> {
  const { tenantId, userId, templateId } = input;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: templateRows } = await client.query(
      `SELECT id, display_name, price_model, price_cents, stripe_price_id
       FROM template_registry WHERE id = $1 AND status = 'active'`,
      [templateId],
    );

    if (templateRows.length === 0) {
      await client.query('COMMIT');
      return { success: false, error: 'Template not found or not active' };
    }

    const template = templateRows[0];
    const priceModel = template.price_model as string;
    const priceCents = template.price_cents as number;

    if (priceModel === 'free' || priceCents === 0) {
      await client.query('COMMIT');
      return { success: true, isFree: true };
    }

    const { rows: existingPurchase } = await client.query(
      `SELECT id FROM marketplace_purchases
       WHERE tenant_id = $1 AND template_id = $2 AND status = 'completed'`,
      [tenantId, templateId],
    );

    if (existingPurchase.length > 0 && priceModel === 'one_time') {
      await client.query('COMMIT');
      return { success: true, isFree: true, purchaseId: existingPurchase[0].id as string };
    }

    const { rows: purchaseRows } = await client.query(
      `INSERT INTO marketplace_purchases (tenant_id, user_id, template_id, amount_cents, price_model, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING id`,
      [tenantId, userId, templateId, priceCents, priceModel],
    );

    const purchaseId = purchaseRows[0].id as string;

    let checkoutUrl = '';
    try {
      const { getStripeClient } = await import('../billing/stripe/client');
      const { loadActiveCustomerDiscount } = await import('../billing/stripe/effectiveRate');
      const stripe = getStripeClient();

      const { rows: subRows } = await client.query(
        `SELECT stripe_customer_id FROM subscriptions WHERE tenant_id = $1 LIMIT 1`,
        [tenantId],
      );
      const customerId = subRows[0]?.stripe_customer_id as string | undefined;

      // Forward the buyer's existing customer-level Stripe discount (if
      // any) so the marketplace hosted page shows the same coupon the
      // tenant already sees on their subscription invoices. Mirrors the
      // subscription Checkout path in
      // `platform/billing/stripe/checkout.ts`. Stripe rejects sessions
      // that combine `discounts` with `allow_promotion_codes`, so the
      // session-shape branch below drops `allow_promotion_codes` when a
      // discount is being forwarded.
      let sessionDiscounts: Array<{ coupon?: string; promotion_code?: string }> | undefined;
      if (customerId) {
        const customerDiscount = await loadActiveCustomerDiscount(
          stripe,
          customerId,
          { tenantId, surface: 'marketplace_checkout_session' },
        );
        if (customerDiscount?.promotionCodeId) {
          sessionDiscounts = [{ promotion_code: customerDiscount.promotionCodeId }];
        } else if (customerDiscount?.couponId) {
          sessionDiscounts = [{ coupon: customerDiscount.couponId }];
        }
      }

      const allowedOrigin = process.env.APP_URL
        ? process.env.APP_URL
        : process.env.REPLIT_DEV_DOMAIN
          ? `https://${process.env.REPLIT_DEV_DOMAIN}`
          : 'http://localhost:5000';
      const safeSuccessUrl = input.successUrl.startsWith(allowedOrigin)
        ? input.successUrl
        : `${allowedOrigin}/marketplace?purchase=success`;
      const safeCancelUrl = input.cancelUrl.startsWith(allowedOrigin)
        ? input.cancelUrl
        : `${allowedOrigin}/marketplace?purchase=cancelled`;

      const isSubscription = priceModel === 'monthly_subscription' || priceModel === 'usage_based';
      const sessionParams: Record<string, unknown> = {
        mode: isSubscription ? 'subscription' : 'payment',
        payment_method_types: ['card'],
        success_url: safeSuccessUrl,
        cancel_url: safeCancelUrl,
        metadata: { tenantId, templateId, purchaseId, type: 'marketplace_purchase' },
      };

      if (sessionDiscounts) {
        // Stripe rejects sessions that combine `discounts` with
        // `allow_promotion_codes`, so we omit the manual-entry box
        // when forwarding an existing discount.
        sessionParams.discounts = sessionDiscounts;
      } else {
        // Let buyers redeem a Stripe-managed promo code at the marketplace
        // checkout. Combined with the `invoice_creation` block below, this
        // is what makes the coupon-aware "Discount applied" badge from the
        // `invoice.finalized` webhook (see Task #1311) actually fire on
        // one-off marketplace purchases — without an invoice, Stripe never
        // emits the event the badge stamper hooks.
        sessionParams.allow_promotion_codes = true;
      }

      // For one-off marketplace purchases (mode: 'payment') Stripe does
      // NOT create an invoice by default — only a Charge + receipt email.
      // Enable `invoice_creation` so the same `invoice.finalized` webhook
      // that powers the discount badge on subscription invoices also
      // fires for marketplace add-on purchases. Mirror the session
      // metadata onto the invoice so Finance/Support can trace the
      // receipt PDF back to the originating marketplace purchase row
      // without joining through the Charge.
      if (!isSubscription) {
        sessionParams.invoice_creation = {
          enabled: true,
          invoice_data: {
            metadata: {
              tenantId,
              templateId,
              purchaseId,
              type: 'marketplace_purchase',
            },
          },
        };
      }

      if (customerId) {
        sessionParams.customer = customerId;
      }

      if (template.stripe_price_id) {
        sessionParams.line_items = [{ price: template.stripe_price_id, quantity: 1 }];
      } else if (priceModel === 'usage_based') {
        sessionParams.line_items = [{
          price_data: {
            currency: 'usd',
            product_data: { name: `${template.display_name} - Marketplace (Usage)` },
            unit_amount: priceCents,
            recurring: { interval: 'month', usage_type: 'metered' },
          },
        }];
      } else {
        sessionParams.line_items = [{
          price_data: {
            currency: 'usd',
            product_data: { name: `${template.display_name} - Marketplace` },
            unit_amount: priceCents,
            ...(priceModel === 'monthly_subscription' ? { recurring: { interval: 'month' } } : {}),
          },
          quantity: 1,
        }];
      }

      const session = await stripe.checkout.sessions.create(sessionParams as Parameters<typeof stripe.checkout.sessions.create>[0]);

      await client.query(
        `UPDATE marketplace_purchases SET stripe_checkout_session_id = $1 WHERE id = $2`,
        [session.id, purchaseId],
      );

      checkoutUrl = session.url!;
    } catch (stripeErr) {
      logger.warn('Stripe checkout creation failed, storing purchase as pending', {
        tenantId, templateId, error: String(stripeErr),
      });
      const fallbackOrigin = process.env.APP_URL
        ? process.env.APP_URL
        : process.env.REPLIT_DEV_DOMAIN
          ? `https://${process.env.REPLIT_DEV_DOMAIN}`
          : 'http://localhost:5000';
      checkoutUrl = `${fallbackOrigin}/marketplace?purchase_pending=true`;
    }

    await client.query('COMMIT');

    logger.info('Marketplace purchase initiated', { tenantId, templateId, purchaseId, priceCents });
    return { success: true, checkoutUrl, purchaseId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to create marketplace purchase', { tenantId, templateId, error: String(err) });
    return { success: false, error: 'Failed to initiate purchase' };
  } finally {
    client.release();
  }
}

export async function completePurchase(
  purchaseId: string,
  stripePaymentId: string,
  stripeSubscriptionId?: string,
): Promise<{ success: boolean; error?: string }> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `UPDATE marketplace_purchases
       SET status = 'completed', stripe_payment_id = $1, completed_at = NOW(),
           stripe_subscription_id = $3,
           subscription_status = CASE WHEN $3 IS NOT NULL THEN 'active' ELSE NULL END
       WHERE id = $2 AND status = 'pending'
       RETURNING tenant_id, template_id, amount_cents`,
      [stripePaymentId, purchaseId, stripeSubscriptionId ?? null],
    );

    if (rows.length === 0) {
      await client.query('COMMIT');
      return { success: false, error: 'Purchase not found or already completed' };
    }

    const purchase = rows[0];
    const templateId = purchase.template_id as string;
    const amountCents = purchase.amount_cents as number;

    const { rows: templateRows } = await client.query(
      `SELECT developer_id, developer_revenue_share_pct FROM template_registry WHERE id = $1`,
      [templateId],
    );

    const developerId = templateRows[0]?.developer_id as string | null;
    const sharePercent = parseFloat(templateRows[0]?.developer_revenue_share_pct as string ?? '70');
    const developerShare = Math.round(amountCents * (sharePercent / 100));
    const platformFee = amountCents - developerShare;

    await client.query(
      `INSERT INTO marketplace_revenue_events
         (purchase_id, template_id, developer_id, gross_amount_cents, platform_fee_cents, developer_share_cents, event_type)
       VALUES ($1, $2, $3, $4, $5, $6, 'sale')`,
      [purchaseId, templateId, developerId, amountCents, platformFee, developerShare],
    );

    await client.query('COMMIT');

    logger.info('Marketplace purchase completed', { purchaseId, templateId, amountCents });
    return { success: true };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to complete purchase', { purchaseId, error: String(err) });
    return { success: false, error: 'Failed to complete purchase' };
  } finally {
    client.release();
  }
}

export async function checkPurchaseAccess(
  tenantId: TenantId,
  templateId: string,
): Promise<{ hasAccess: boolean; purchase?: PurchaseRecord }> {
  const pool = getPlatformPool();

  const { rows: templateRows } = await pool.query(
    `SELECT price_model, price_cents FROM template_registry WHERE id = $1`,
    [templateId],
  );

  if (templateRows.length === 0) return { hasAccess: false };

  const priceModel = templateRows[0].price_model as string;
  const priceCents = templateRows[0].price_cents as number;

  if (priceModel === 'free' || priceCents === 0) {
    return { hasAccess: true };
  }

  const { rows } = await pool.query(
    `SELECT id, tenant_id, user_id, template_id, amount_cents, status, created_at, completed_at,
            stripe_subscription_id, subscription_status, price_model
     FROM marketplace_purchases
     WHERE tenant_id = $1 AND template_id = $2 AND status = 'completed'
     ORDER BY completed_at DESC
     LIMIT 1`,
    [tenantId, templateId],
  );

  if (rows.length === 0) return { hasAccess: false };

  const purchase = rows[0];
  const purchaseRecord: PurchaseRecord = {
    id: purchase.id as string,
    tenantId: purchase.tenant_id as string,
    userId: purchase.user_id as string,
    templateId: purchase.template_id as string,
    amountCents: purchase.amount_cents as number,
    status: purchase.status as string,
    createdAt: purchase.created_at as string,
    completedAt: purchase.completed_at as string | null,
  };

  if (priceModel === 'monthly_subscription' || priceModel === 'usage_based') {
    const subStatus = purchase.subscription_status as string | null;
    if (!subStatus || subStatus === 'canceled' || subStatus === 'unpaid') {
      return { hasAccess: false, purchase: purchaseRecord };
    }
  }

  return { hasAccess: true, purchase: purchaseRecord };
}

/**
 * Report marketplace add-on usage to Stripe via the Billing Meter Events API
 * (https://docs.stripe.com/billing/subscriptions/usage-based/recording-usage).
 *
 * The legacy `subscriptionItems.createUsageRecord` endpoint has been removed
 * from the Stripe TypeScript types and is on Stripe's deprecation track, so we
 * publish a meter event instead. The `event_name` is resolved from the
 * template's `stripe_meter_event_name` column (set by the marketplace developer
 * when the template is published) with a `STRIPE_MARKETPLACE_METER_EVENT` env
 * fallback for templates provisioned before the column existed. The customer
 * is identified by `stripe_customer_id` from the tenant's primary subscription.
 *
 * Idempotency: callers that need exactly-once semantics for a given business
 * event should pass `idempotencyKey` derived from that event's stable id (e.g.
 * the tool-execution id, the call-session id, etc.). Stripe deduplicates meter
 * events by `idempotencyKey` for at least 24h. When no key is supplied we
 * generate a per-call UUID — this still protects against the Stripe SDK's own
 * automatic transport retries, but two distinct `reportUsage()` calls from the
 * route layer WILL produce two billable events (the route is just a thin
 * passthrough today; metering is the caller's responsibility).
 */
export async function reportUsage(
  tenantId: TenantId,
  templateId: string,
  quantity: number,
  options: { idempotencyKey?: string } = {},
): Promise<{ success: boolean; error?: string }> {
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(quantity)) {
    return { success: false, error: 'quantity must be a positive integer' };
  }

  const pool = getPlatformPool();

  const { rows } = await pool.query(
    `SELECT mp.id AS purchase_id,
            mp.stripe_subscription_id,
            mp.subscription_status,
            tr.stripe_meter_event_name
     FROM marketplace_purchases mp
     LEFT JOIN template_registry tr ON tr.id = mp.template_id
     WHERE mp.tenant_id = $1 AND mp.template_id = $2 AND mp.status = 'completed'
       AND mp.stripe_subscription_id IS NOT NULL
     ORDER BY mp.completed_at DESC LIMIT 1`,
    [tenantId, templateId],
  );

  if (rows.length === 0 || !rows[0].stripe_subscription_id) {
    return { success: false, error: 'No active usage-based subscription found' };
  }

  const subStatus = rows[0].subscription_status as string | null;
  if (subStatus !== 'active' && subStatus !== 'past_due') {
    return { success: false, error: 'Subscription is not active' };
  }

  const purchaseId = rows[0].purchase_id as string;
  const eventName =
    (rows[0].stripe_meter_event_name as string | null) ??
    process.env.STRIPE_MARKETPLACE_METER_EVENT ??
    null;

  if (!eventName) {
    logger.error('Marketplace template missing stripe_meter_event_name and no env fallback', {
      tenantId, templateId,
    });
    return {
      success: false,
      error: 'Marketplace template is not configured for usage reporting (missing meter event name)',
    };
  }

  const { rows: customerRows } = await pool.query(
    `SELECT stripe_customer_id FROM subscriptions
     WHERE tenant_id = $1 AND stripe_customer_id IS NOT NULL
     LIMIT 1`,
    [tenantId],
  );
  const customerId = customerRows[0]?.stripe_customer_id as string | undefined;
  if (!customerId) {
    return { success: false, error: 'Tenant has no Stripe customer for usage reporting' };
  }

  try {
    const stripe = (await import('../billing/stripe/client')).getStripeClient();
    const timestamp = Math.floor(Date.now() / 1000);
    const idempotencyKey = options.idempotencyKey
      ? `mkt_${purchaseId}_${options.idempotencyKey}`
      : `mkt_${purchaseId}_${randomUUID()}`;

    await stripe.billing.meterEvents.create(
      {
        event_name: eventName,
        payload: {
          stripe_customer_id: customerId,
          value: String(quantity),
        },
        timestamp,
      },
      { idempotencyKey },
    );

    logger.info('Usage reported for marketplace subscription', {
      tenantId, templateId, quantity, eventName, purchaseId,
    });
    return { success: true };
  } catch (err) {
    logger.error('Failed to report usage', { tenantId, templateId, error: String(err) });
    return { success: false, error: 'Failed to report usage to billing provider' };
  }
}

export async function getRevenueStats(options: {
  developerId?: string;
  templateId?: string;
  days?: number;
} = {}): Promise<{
  totalRevenue: number;
  platformFees: number;
  developerPayouts: number;
  purchaseCount: number;
  recentEvents: { templateId: string; grossAmount: number; eventType: string; createdAt: string }[];
  byTemplate: { templateId: string; templateName: string; revenueCents: number; purchaseCount: number }[];
}> {
  const pool = getPlatformPool();
  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (options.developerId) {
    conditions.push(`developer_id = $${idx++}`);
    params.push(options.developerId);
  }
  if (options.templateId) {
    conditions.push(`template_id = $${idx++}`);
    params.push(options.templateId);
  }
  if (options.days) {
    conditions.push(`created_at >= NOW() - INTERVAL '${options.days} days'`);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const [statsResult, eventsResult, byTemplateResult] = await Promise.all([
    pool.query(
      `SELECT
         COALESCE(SUM(gross_amount_cents), 0)::int AS total_revenue,
         COALESCE(SUM(platform_fee_cents), 0)::int AS platform_fees,
         COALESCE(SUM(developer_share_cents), 0)::int AS developer_payouts,
         COUNT(*)::int AS purchase_count
       FROM marketplace_revenue_events ${where}`,
      params,
    ),
    pool.query(
      `SELECT template_id, gross_amount_cents, event_type, created_at
       FROM marketplace_revenue_events ${where}
       ORDER BY created_at DESC
       LIMIT 50`,
      params,
    ),
    pool.query(
      `SELECT
         e.template_id,
         COALESCE(tr.display_name, 'Unknown') AS template_name,
         COALESCE(SUM(e.gross_amount_cents), 0)::int AS revenue_cents,
         COUNT(*)::int AS purchase_count
       FROM marketplace_revenue_events e
       LEFT JOIN template_registry tr ON tr.id = e.template_id
       ${where}
       GROUP BY e.template_id, tr.display_name
       ORDER BY revenue_cents DESC
       LIMIT 50`,
      params,
    ),
  ]);

  const s = statsResult.rows[0];

  return {
    totalRevenue: s.total_revenue,
    platformFees: s.platform_fees,
    developerPayouts: s.developer_payouts,
    purchaseCount: s.purchase_count,
    recentEvents: eventsResult.rows.map((e) => ({
      templateId: e.template_id as string,
      grossAmount: e.gross_amount_cents as number,
      eventType: e.event_type as string,
      createdAt: e.created_at as string,
    })),
    byTemplate: byTemplateResult.rows.map((r) => ({
      templateId: r.template_id as string,
      templateName: r.template_name as string,
      revenueCents: r.revenue_cents as number,
      purchaseCount: r.purchase_count as number,
    })),
  };
}
