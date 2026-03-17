import { Router } from 'express';
import { createCheckoutSession, createPortalSession } from '../../../platform/billing/stripe/checkout';
import { constructStripeEvent, handleStripeEvent } from '../../../platform/billing/stripe/webhook';
import { checkBudget } from '../../../platform/billing/budget/checkBudget';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { requireAuth } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import { writeAuditLog, extractIp } from '../../../platform/audit/AuditService';

const router = Router();
const logger = createLogger('ADMIN_BILLING');

router.get('/billing/subscription', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const { rows } = await client.query(
      `SELECT plan, status, billing_interval, current_period_start, current_period_end,
              trial_end, cancelled_at, monthly_call_limit, monthly_sms_limit,
              monthly_ai_minute_limit, overage_enabled, created_at, updated_at
       FROM subscriptions WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );
    await client.query('COMMIT');

    if (rows.length === 0) {
      return res.json({ subscription: null, plan: 'starter', status: 'none' });
    }
    return res.json({ subscription: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to get subscription', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to retrieve subscription' });
  } finally {
    client.release();
  }
});

router.get('/billing/usage', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT metric_type, SUM(quantity) AS total
       FROM usage_metrics
       WHERE tenant_id = $1
         AND period_start >= date_trunc('month', NOW())
       GROUP BY metric_type`,
      [tenantId],
    );
    await client.query('COMMIT');

    const usage: Record<string, number> = {};
    for (const row of rows) {
      usage[row.metric_type as string] = parseInt(row.total as string, 10);
    }
    return res.json({ usage });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to get usage', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to retrieve usage' });
  } finally {
    client.release();
  }
});

const VALID_PLANS = new Set(['starter', 'pro', 'enterprise']);
const VALID_INTERVALS = new Set(['monthly', 'annual']);

router.post('/billing/checkout', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId, email } = req.user!;
  const { plan = 'pro', interval = 'monthly', successUrl, cancelUrl } = req.body as {
    plan?: string;
    interval?: string;
    successUrl?: string;
    cancelUrl?: string;
  };

  if (!VALID_PLANS.has(plan)) {
    return res.status(400).json({ error: `Invalid plan: ${plan}. Must be one of: starter, pro, enterprise` });
  }
  if (!VALID_INTERVALS.has(interval)) {
    return res.status(400).json({ error: `Invalid interval: ${interval}. Must be monthly or annual` });
  }

  const baseUrl = `${req.protocol}://${req.hostname}`;

  try {
    const result = await createCheckoutSession({
      tenantId,
      plan: plan as 'starter' | 'pro' | 'enterprise',
      interval: interval as 'monthly' | 'annual',
      successUrl: successUrl ?? `${baseUrl}/dashboard?checkout=success`,
      cancelUrl: cancelUrl ?? `${baseUrl}/dashboard?checkout=cancelled`,
      customerEmail: email,
    });
    await writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'billing.checkout_created',
      resourceType: 'billing',
      changes: { plan, interval },
      severity: 'warning',
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });
    return res.json(result);
  } catch (err) {
    logger.error('Checkout session creation failed', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

router.post('/billing/portal', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { returnUrl } = req.body as { returnUrl?: string };
  const baseUrl = `${req.protocol}://${req.hostname}`;

  try {
    const result = await createPortalSession({
      tenantId,
      returnUrl: returnUrl ?? `${baseUrl}/dashboard`,
    });
    await writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'billing.portal_accessed',
      resourceType: 'billing',
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });
    return res.json(result);
  } catch (err) {
    logger.error('Portal session creation failed', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to create billing portal session' });
  }
});

router.get('/billing/budget', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const result = await checkBudget(tenantId, { failOpen: true });
    return res.json(result);
  } catch (err) {
    logger.error('Budget check failed', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to check budget' });
  }
});

router.get('/billing/invoices', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
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
      return res.json({ invoices: [] });
    }

    const { getStripeClient } = await import('../../../platform/billing/stripe/client');
    const stripe = getStripeClient();
    const stripeInvoices = await stripe.invoices.list({
      customer: customerId,
      limit: 10,
    });

    const invoices = stripeInvoices.data.map((inv) => ({
      id: inv.id,
      date: inv.created ? new Date(inv.created * 1000).toISOString() : null,
      amount_cents: inv.status === 'paid' ? (inv.amount_paid ?? inv.total ?? 0) : (inv.amount_due ?? inv.total ?? 0),
      currency: inv.currency ?? 'usd',
      status: inv.status ?? 'unknown',
      invoice_pdf: inv.invoice_pdf ?? null,
      number: inv.number ?? null,
      description: inv.description ?? (inv.lines?.data?.[0]?.description || null),
    }));

    return res.json({ invoices });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to fetch invoices', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to fetch invoices' });
  } finally {
    client.release();
  }
});

router.post('/billing/stripe-webhook', async (req, res) => {
  const signature = req.headers['stripe-signature'];
  if (!signature || typeof signature !== 'string') {
    return res.status(400).json({ error: 'Missing stripe-signature header' });
  }

  let event;
  try {
    event = constructStripeEvent(req.body as Buffer, signature);
  } catch (err) {
    logger.warn('Stripe webhook signature verification failed', { error: String(err) });
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  try {
    await handleStripeEvent(event);
    return res.json({ received: true });
  } catch (err) {
    logger.error('Stripe webhook handler failed', { type: event.type, error: String(err) });
    return res.status(500).json({ error: 'Webhook handler failed' });
  }
});

export default router;
