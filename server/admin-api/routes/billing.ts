import { Router } from 'express';
import { createCheckoutSession, createPortalSession } from '../../../platform/billing/stripe/checkout';
import { constructStripeEvent, handleStripeEvent } from '../../../platform/billing/stripe/webhook';
import { getTenantEffectiveRate } from '../../../platform/billing/stripe/effectiveRate';
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

/**
 * Trailing N-month AI minute usage, returned newest-first. Used by the
 * BillingEstimator's plan-recommendation card to suggest the cheapest
 * tier based on actual trailing usage rather than month-to-date only.
 *
 * The current (in-progress) calendar month is intentionally excluded so
 * the recommendation reflects *complete* historical periods. `months`
 * is clamped to [1, 12] to keep the query bounded; values outside that
 * range silently fall back to the default of 3.
 *
 * Months with no `usage_metrics` row are zero-filled via `generate_series`
 * (LEFT JOIN'd against the aggregated rows). This is critical: a tenant
 * that ran 0 AI minutes in a given month will not have a row in
 * `usage_metrics` for that month, and skipping those months would inflate
 * their trailing-3-month average and produce a misleading "downgrade"
 * recommendation. With zero-fill, a tenant with 0 / 0 / 300 across the
 * last three months averages to 100, not 300.
 */
router.get('/billing/usage/trailing', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const requested = Number.parseInt(String(req.query.months ?? '3'), 10);
  const months = Number.isFinite(requested) && requested >= 1 && requested <= 12
    ? requested
    : 3;

  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const { rows } = await client.query(
      `WITH window_months AS (
         SELECT generate_series(
           date_trunc('month', NOW()) - ($2::int * INTERVAL '1 month'),
           date_trunc('month', NOW()) - INTERVAL '1 month',
           INTERVAL '1 month'
         ) AS month_start
       ),
       monthly_totals AS (
         SELECT
           date_trunc('month', period_start) AS month_start,
           SUM(quantity)::bigint AS minutes
         FROM usage_metrics
         WHERE tenant_id = $1
           AND metric_type = 'ai_minutes'
           AND period_start >= date_trunc('month', NOW()) - ($2::int * INTERVAL '1 month')
           AND period_start < date_trunc('month', NOW())
         GROUP BY date_trunc('month', period_start)
       )
       SELECT
         to_char(w.month_start, 'YYYY-MM') AS month,
         COALESCE(t.minutes, 0)::bigint AS minutes
       FROM window_months w
       LEFT JOIN monthly_totals t ON t.month_start = w.month_start
       ORDER BY w.month_start DESC`,
      [tenantId, months],
    );
    await client.query('COMMIT');

    const monthly = rows.map((r) => ({
      month: r.month as string,
      aiMinutes: Number(r.minutes),
    }));
    // Always average over the full requested window (zero-filled), not
    // just the months that happened to have rows in usage_metrics — see
    // the doc-comment above for why.
    const total = monthly.reduce((acc, m) => acc + m.aiMinutes, 0);
    const average = monthly.length > 0 ? total / monthly.length : 0;
    const monthsWithData = monthly.filter((m) => m.aiMinutes > 0).length;

    return res.json({
      months,
      monthsWithData,
      monthly,
      averageAiMinutes: average,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to get trailing usage', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to retrieve trailing usage' });
  } finally {
    client.release();
  }
});

router.get('/billing/effective-rate', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const rate = await getTenantEffectiveRate(tenantId);
    return res.json(rate);
  } catch (err) {
    // getTenantEffectiveRate already swallows expected errors and falls
    // back to the catalog. Anything bubbling up here is a true 500 — log
    // it but still avoid leaking internals to the client.
    logger.error('Effective rate lookup failed', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to resolve effective rate' });
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

// Replay protection note (audited as part of #942):
// Stripe's `Stripe-Signature` header has the form `t=<unix>,v1=<sig>,…`. The
// `stripe.webhooks.constructEvent` helper called from `constructStripeEvent`
// re-derives the HMAC over `t.payload` and *also* enforces a default 300s
// tolerance on `t`, rejecting payloads outside the window with
// `StripeSignatureVerificationError`. That gives us the same timestamp-bound
// replay defense we hand-rolled for Cal.com (#430) and the per-request-ID
// nonce cache we added for Twilio in #942 — no additional layer is required
// here. Do not lower the tolerance; do not strip the timestamp check.
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
