import type Stripe from 'stripe';
import { getStripeClient, getWebhookSecret } from './client';
import { getPlanFromPriceId, PLAN_LIMITS } from './plans';
import { getPlatformPool, withTenantContext } from '../../db';
import { createLogger } from '../../core/logger';
import { provisionTenant } from '../../tenant/provisioning/TenantProvisioningService';

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

async function handleCheckoutCompleted(session: Stripe.Checkout.Session, stripeEventId: string): Promise<void> {
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
      if (interval) billingInterval = interval;
    } catch (err) {
      logger.warn('Could not fetch subscription period from Stripe', { error: String(err) });
    }
  }

  await withTenant(tenantId, async (client) => {
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

async function handleSubscriptionUpdated(sub: Stripe.Subscription, stripeEventId: string): Promise<void> {
  const customerId = sub.customer as string;
  const tenantId = await getTenantByCustomer(customerId);
  if (!tenantId) return;

  const item = sub.items?.data?.[0];
  const priceId = item?.price?.id;
  const plan = priceId ? getPlanFromPriceId(priceId) : undefined;
  const limits = plan ? PLAN_LIMITS[plan] : undefined;

  await withTenant(tenantId, async (client) => {
    const updateFields: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [tenantId];

    if (plan) { values.push(plan); updateFields.push(`plan = $${values.length}`); }
    if (limits) {
      values.push(limits.monthlyCallLimit); updateFields.push(`monthly_call_limit = $${values.length}`);
      values.push(limits.monthlySmsLimit); updateFields.push(`monthly_sms_limit = $${values.length}`);
      values.push(limits.monthlyAiMinuteLimit); updateFields.push(`monthly_ai_minute_limit = $${values.length}`);
      values.push(limits.overageEnabled); updateFields.push(`overage_enabled = $${values.length}`);
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
