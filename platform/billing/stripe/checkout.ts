import { getStripeClient } from './client';
import { getPlanPriceId } from './plans';
import type { PlanTier } from './plans';
import { getPlatformPool, withTenantContext } from '../../db';
import { createLogger } from '../../core/logger';
import type { TenantId } from '../../core/types';

const logger = createLogger('STRIPE_CHECKOUT');

export async function createCheckoutSession(params: {
  tenantId: TenantId;
  plan: PlanTier;
  interval: 'monthly' | 'annual';
  successUrl: string;
  cancelUrl: string;
  customerEmail?: string;
}): Promise<{ sessionId: string; url: string }> {
  const { tenantId, plan, interval, successUrl, cancelUrl, customerEmail } = params;
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

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer: existingCustomerId ?? undefined,
      customer_email: existingCustomerId ? undefined : customerEmail,
      metadata: { tenantId, plan, interval },
      subscription_data: {
        metadata: { tenantId, plan },
        trial_period_days: plan === 'starter' ? 14 : undefined,
      },
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
