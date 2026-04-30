import { Router } from 'express';
import { createCheckoutSession, createPortalSession } from '../../../platform/billing/stripe/checkout';
import { constructStripeEvent, handleStripeEvent } from '../../../platform/billing/stripe/webhook';
import {
  getTenantEffectiveRate,
  getTenantUpgradePreview,
  getTenantDowngradePreview,
  isPlanTier,
  loadActiveCustomerDiscount,
  nextUpgradeTier,
  normalizeDiscount,
  type UpgradeDiscount,
} from '../../../platform/billing/stripe/effectiveRate';
import {
  scheduleDowngrade,
  loadTenantSubscription,
  isStrictDowngrade,
  classifyCheckoutDirection,
} from '../../../platform/billing/stripe/planChange';
import type { PlanTier } from '../../../shared/billing/planCatalog';
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

  let subscriptionRow: Record<string, unknown> | null = null;
  let stripeCustomerId: string | null = null;
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const { rows } = await client.query(
      `SELECT plan, status, billing_interval, current_period_start, current_period_end,
              trial_end, cancelled_at, monthly_call_limit, monthly_sms_limit,
              monthly_ai_minute_limit, overage_enabled, stripe_customer_id,
              created_at, updated_at
       FROM subscriptions WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );
    await client.query('COMMIT');

    if (rows.length === 0) {
      return res.json({ subscription: null, plan: 'starter', status: 'none' });
    }
    const row = rows[0] as Record<string, unknown>;
    stripeCustomerId = (row.stripe_customer_id as string | null) ?? null;
    delete row.stripe_customer_id;
    subscriptionRow = row;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to get subscription', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to retrieve subscription' });
  } finally {
    client.release();
  }

  let discount: UpgradeDiscount | null = null;
  if (stripeCustomerId) {
    try {
      const { getStripeClient } = await import('../../../platform/billing/stripe/client');
      const stripe = getStripeClient();
      discount = await loadActiveCustomerDiscount(stripe, stripeCustomerId, {
        tenantId,
        surface: 'subscription_panel',
      });
    } catch (err) {
      logger.warn('Could not resolve customer discount for subscription panel', {
        tenantId,
        error: String(err),
      });
    }
  }

  return res.json({ subscription: { ...subscriptionRow, discount } });
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
const RECOMMENDATION_TIERS = new Set(['starter', 'pro', 'enterprise']);
const RECOMMENDATION_WINDOWS = new Set([3, 6, 12]);
const RECOMMENDATION_EVENT_TYPES = new Set(['impression', 'click']);

router.post('/billing/checkout', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId, email } = req.user!;
  const { plan = 'pro', interval = 'monthly', successUrl, cancelUrl, recommendation } = req.body as {
    plan?: string;
    interval?: string;
    successUrl?: string;
    cancelUrl?: string;
    recommendation?: {
      currentTier?: unknown;
      recommendedTier?: unknown;
      monthlySavingsCents?: unknown;
      trailingWindowMonths?: unknown;
    };
  };

  if (!VALID_PLANS.has(plan)) {
    return res.status(400).json({ error: `Invalid plan: ${plan}. Must be one of: starter, pro, enterprise` });
  }
  if (!VALID_INTERVALS.has(interval)) {
    return res.status(400).json({ error: `Invalid interval: ${interval}. Must be monthly or annual` });
  }

  // Validate the optional recommendation attribution so a malformed or
  // mismatched payload from a stale client doesn't poison Stripe metadata
  // (and, downstream, the switch_completed funnel). The recommended tier
  // must match the plan actually being purchased — otherwise the banner
  // "credit" wouldn't reflect what the tenant is buying, so we drop the
  // attribution rather than stamping misleading metadata.
  let validatedRecommendation: undefined | {
    currentTier: 'starter' | 'pro' | 'enterprise';
    recommendedTier: 'starter' | 'pro' | 'enterprise';
    monthlySavingsCents: number;
    trailingWindowMonths?: number;
  };
  if (recommendation && typeof recommendation === 'object') {
    const ct = recommendation.currentTier;
    const rt = recommendation.recommendedTier;
    if (
      typeof ct === 'string' && RECOMMENDATION_TIERS.has(ct) &&
      typeof rt === 'string' && RECOMMENDATION_TIERS.has(rt) &&
      rt === plan
    ) {
      const savings = Number(recommendation.monthlySavingsCents);
      const window = Number(recommendation.trailingWindowMonths);
      validatedRecommendation = {
        currentTier: ct as 'starter' | 'pro' | 'enterprise',
        recommendedTier: rt as 'starter' | 'pro' | 'enterprise',
        monthlySavingsCents: Number.isFinite(savings) && savings >= 0 ? Math.round(savings) : 0,
        ...(Number.isFinite(window) && RECOMMENDATION_WINDOWS.has(window)
          ? { trailingWindowMonths: window }
          : {}),
      };
    }
  }

  // Refuse strict downgrades through Checkout. Checkout always creates a
  // NEW Stripe subscription, so a downgrade routed here would leave the
  // tenant with two parallel subscriptions and flip the local
  // `subscriptions` row to the lower plan immediately on
  // checkout.session.completed — contradicting the "takes effect at next
  // renewal" promise the UI makes. Legitimate downgrades go through
  // `/billing/schedule-downgrade`.
  let currentPlan: PlanTier | null = null;
  let currentInterval: 'monthly' | 'annual' | null = null;
  if (isPlanTier(plan)) {
    try {
      const existing = await loadTenantSubscription(tenantId);
      currentPlan = existing.currentPlan;
      currentInterval = existing.currentInterval;
      if (existing.currentPlan && isStrictDowngrade(existing.currentPlan, plan)) {
        // Record the rejected downgrade attempt before returning so
        // the checkout audit trail still captures direction='downgrade'.
        await writeAuditLog({
          tenantId,
          actorUserId: req.user!.userId,
          actorRole: req.user!.role,
          action: 'billing.checkout_rejected',
          resourceType: 'billing',
          changes: {
            reason: 'downgrade_requires_schedule',
            direction: 'downgrade',
            fromPlan: existing.currentPlan,
            fromInterval: existing.currentInterval,
            toPlan: plan,
            toInterval: interval,
          },
          severity: 'warning',
          ipAddress: extractIp(req),
          userAgent: req.headers['user-agent'],
        });
        return res.status(400).json({
          error: `Cannot downgrade from ${existing.currentPlan} to ${plan} via /billing/checkout. Use POST /billing/schedule-downgrade so the change takes effect at the end of the current billing period.`,
          code: 'DOWNGRADE_REQUIRES_SCHEDULE',
        });
      }
    } catch (err) {
      // Fail CLOSED: the entire purpose of this guard is to prevent a
      // tenant from accidentally creating a parallel Stripe subscription
      // (and silently double-billing themselves) when they meant to
      // downgrade. If we can't determine the current plan we MUST NOT
      // hand them a checkout link — refuse the request and let them
      // retry. Falling open here would re-introduce the exact bug the
      // /billing/schedule-downgrade endpoint was created to fix.
      logger.error('Could not load existing subscription for checkout downgrade guard; refusing checkout', {
        tenantId,
        error: String(err),
      });
      return res.status(503).json({
        error: 'Could not verify current subscription. Please try again in a moment.',
        code: 'DOWNGRADE_GUARD_UNAVAILABLE',
      });
    }
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
      recommendation: validatedRecommendation,
    });
    const direction = classifyCheckoutDirection(
      currentPlan,
      currentInterval,
      plan as PlanTier,
      interval as 'monthly' | 'annual',
    );
    await writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'billing.checkout_created',
      resourceType: 'billing',
      changes: {
        plan,
        interval,
        direction,
        fromPlan: currentPlan,
        fromInterval: currentInterval,
        toPlan: plan,
        toInterval: interval,
      },
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

/**
 * Schedule a plan DOWNGRADE for the end of the tenant's current paid
 * billing period. Distinct from `/billing/checkout` because:
 *
 * - Checkout always creates a NEW Stripe subscription, which would leave
 *   the tenant with two parallel subscriptions (the existing higher tier
 *   AND the new lower tier) and would update the local `subscriptions`
 *   row to the new plan immediately on `checkout.session.completed`,
 *   contradicting the "takes effect at next renewal" promise the UI
 *   makes for downgrades.
 * - This endpoint instead uses Stripe Subscription Schedules to pin the
 *   current paid phase through `current_period_end` and queue a
 *   follow-up phase that swaps in the lower-tier price afterwards. The
 *   change is invisible to the customer until the existing period
 *   actually ends.
 *
 * Server-side guards:
 * - Plan + interval are validated against the same allowlist as
 *   `/billing/checkout` so a malicious caller can't smuggle through an
 *   arbitrary price ID.
 * - We require the target tier to be STRICTLY below the tenant's current
 *   tier — upgrades and same-tier "moves" still go through checkout so
 *   we don't inadvertently downgrade a customer who clicked the wrong
 *   button.
 */
router.post('/billing/schedule-downgrade', requireAuth, requireRole('manager'), async (req, res) => {
  const { tenantId } = req.user!;
  const { plan, interval = 'monthly' } = req.body as { plan?: string; interval?: string };

  if (!plan || !VALID_PLANS.has(plan)) {
    return res.status(400).json({ error: `Invalid plan: ${plan}. Must be one of: starter, pro, enterprise` });
  }
  if (!VALID_INTERVALS.has(interval)) {
    return res.status(400).json({ error: `Invalid interval: ${interval}. Must be monthly or annual` });
  }

  let currentPlan: PlanTier | null = null;
  try {
    const sub = await loadTenantSubscription(tenantId);
    if (!sub.stripeSubscriptionId || !sub.currentPlan) {
      return res.status(400).json({ error: 'No active paid subscription to downgrade from' });
    }
    currentPlan = sub.currentPlan;
  } catch (err) {
    logger.error('Failed to load tenant subscription for downgrade', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to load current subscription' });
  }

  if (!isPlanTier(plan)) {
    return res.status(400).json({ error: `Invalid plan: ${plan}` });
  }
  if (!isStrictDowngrade(currentPlan, plan)) {
    return res.status(400).json({
      error: `Target plan ${plan} is not a downgrade from ${currentPlan}. Use /billing/checkout for upgrades or interval changes.`,
    });
  }

  try {
    const result = await scheduleDowngrade({
      tenantId,
      targetPlan: plan,
      targetInterval: interval as 'monthly' | 'annual',
    });

    await writeAuditLog({
      tenantId,
      actorUserId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'billing.downgrade_scheduled',
      resourceType: 'billing',
      changes: {
        direction: 'downgrade',
        fromPlan: currentPlan,
        toPlan: plan,
        interval,
        effectiveAt: result.scheduledFor,
        scheduleId: result.scheduleId,
      },
      severity: 'warning',
      ipAddress: extractIp(req),
      userAgent: req.headers['user-agent'],
    });

    return res.json({ scheduled: result });
  } catch (err) {
    logger.error('Schedule downgrade failed', { tenantId, plan, interval, error: String(err) });
    return res.status(500).json({ error: 'Failed to schedule downgrade' });
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

  // When true, the response also carries `monthlyPriorYear` aligned 1:1
  // with `monthly`. Prior-year minutes are nullable so the client can
  // tell "no data" from "real zero".
  const compareToPriorYear =
    req.query.compareToPriorYear === '1'
    || req.query.compareToPriorYear === 'true';

  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const { rows } = await client.query(
      compareToPriorYear
        ? `WITH window_months AS (
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
               AND period_start >= date_trunc('month', NOW()) - (($2::int + 12) * INTERVAL '1 month')
               AND period_start < date_trunc('month', NOW())
             GROUP BY date_trunc('month', period_start)
           )
           SELECT
             to_char(w.month_start, 'YYYY-MM') AS month,
             COALESCE(t.minutes, 0)::bigint AS minutes,
             to_char(w.month_start - INTERVAL '12 month', 'YYYY-MM') AS prior_month,
             pt.minutes AS prior_minutes
           FROM window_months w
           LEFT JOIN monthly_totals t ON t.month_start = w.month_start
           LEFT JOIN monthly_totals pt ON pt.month_start = w.month_start - INTERVAL '12 month'
           ORDER BY w.month_start DESC`
        : `WITH window_months AS (
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

    const responseBody: {
      months: number;
      monthsWithData: number;
      monthly: Array<{ month: string; aiMinutes: number }>;
      monthlyPriorYear?: Array<{ month: string; aiMinutes: number | null }>;
      averageAiMinutes: number;
    } = {
      months,
      monthsWithData,
      monthly,
      averageAiMinutes: average,
    };

    if (compareToPriorYear) {
      responseBody.monthlyPriorYear = rows.map((r) => ({
        month: r.prior_month as string,
        aiMinutes: r.prior_minutes == null ? null : Number(r.prior_minutes),
      }));
    }

    return res.json(responseBody);
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

/**
 * Tenant-specific upgrade quote for the BillingEstimator's "Next tier up"
 * card. The optional `plan` query param picks an explicit tier; when
 * omitted, we infer the tier directly above the tenant's current plan from
 * the Stripe-reported effective rate (which is what the estimator already
 * uses to know which card to render).
 *
 * Always returns 200 — when there is no upgrade tier available (the tenant
 * is already on Enterprise) the response is `{ upgrade: null }` so the
 * client can render the "you're on the top plan" placeholder without
 * special-casing 404s.
 */
router.get('/billing/upgrade-preview', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const requested = typeof req.query.plan === 'string' ? req.query.plan : null;

  let targetPlan: PlanTier | null;
  if (requested) {
    if (!isPlanTier(requested)) {
      return res.status(400).json({
        error: `Invalid plan: ${requested}. Must be one of: starter, pro, enterprise`,
      });
    }
    targetPlan = requested;
  } else {
    // No explicit target — derive "next tier up" from the tenant's actual
    // current plan so a single call answers the estimator's question.
    try {
      const current = await getTenantEffectiveRate(tenantId);
      targetPlan = nextUpgradeTier(current.plan);
    } catch (err) {
      logger.error('Failed to resolve current plan for upgrade preview', {
        tenantId,
        error: String(err),
      });
      return res.status(500).json({ error: 'Failed to resolve upgrade preview' });
    }
  }

  if (!targetPlan) {
    return res.json({ upgrade: null });
  }

  try {
    const upgrade = await getTenantUpgradePreview(tenantId, targetPlan);
    return res.json({ upgrade });
  } catch (err) {
    logger.error('Upgrade preview lookup failed', {
      tenantId,
      targetPlan,
      error: String(err),
    });
    return res.status(500).json({ error: 'Failed to resolve upgrade preview' });
  }
});

/**
 * `GET /billing/downgrade-preview?plan=…&interval=…`
 *
 * Preview the prorated credit + next-invoice total Stripe will produce
 * when the tenant downgrades to the requested tier on the requested
 * billing interval. Surfaces the dollar value of the unused portion of
 * the current paid period (the "credit") so the Billing page downgrade
 * card and the confirmation dialog can quote it instead of just
 * promising "takes effect at next renewal".
 *
 * Always returns 200 — when the requested plan is invalid, isn't a
 * strict downgrade from the tenant's current plan, or the tenant has no
 * paid subscription, the response is `{ downgrade: null }` so the
 * client can suppress the credit copy without special-casing 404s.
 */
router.get('/billing/downgrade-preview', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const requested = typeof req.query.plan === 'string' ? req.query.plan : null;
  const requestedInterval = typeof req.query.interval === 'string' ? req.query.interval : 'monthly';

  if (!requested || !isPlanTier(requested)) {
    return res.status(400).json({
      error: `Invalid plan: ${requested ?? '(missing)'}. Must be one of: starter, pro, enterprise`,
    });
  }
  if (requestedInterval !== 'monthly' && requestedInterval !== 'annual') {
    return res.status(400).json({
      error: `Invalid interval: ${requestedInterval}. Must be one of: monthly, annual`,
    });
  }
  const targetPlan: PlanTier = requested;
  const targetInterval: 'monthly' | 'annual' = requestedInterval;

  // Refuse to quote a downgrade that isn't actually a downgrade — the
  // estimator card / confirmation copy would be nonsensical and Stripe's
  // preview would surface a positive (charge) instead of a credit.
  let currentPlan: PlanTier | null = null;
  try {
    const lookup = await loadTenantSubscription(tenantId);
    if (!lookup.stripeSubscriptionId) {
      // Free-tier tenant — there is no paid subscription to downgrade
      // FROM. Surface a `null` quote so the UI suppresses the credit
      // line; this mirrors the upgrade-preview "you're on the top
      // plan" placeholder behavior.
      return res.json({ downgrade: null });
    }
    currentPlan = lookup.currentPlan;
  } catch (err) {
    logger.error('Failed to resolve current plan for downgrade preview', {
      tenantId,
      targetPlan,
      error: String(err),
    });
    return res.status(500).json({ error: 'Failed to resolve downgrade preview' });
  }

  if (!currentPlan || !isStrictDowngrade(currentPlan, targetPlan)) {
    return res.json({ downgrade: null });
  }

  try {
    const downgrade = await getTenantDowngradePreview(tenantId, targetPlan, targetInterval);
    return res.json({ downgrade });
  } catch (err) {
    logger.error('Downgrade preview lookup failed', {
      tenantId,
      targetPlan,
      targetInterval,
      error: String(err),
    });
    return res.status(500).json({ error: 'Failed to resolve downgrade preview' });
  }
});

// Records 'impression' / 'click' events from the recommendation banner.
// 'switch_completed' is intentionally not accepted here — completion is
// server-attributed from the Stripe webhook (see webhook.ts) so a
// tenant cannot inflate the conversion count by hitting this endpoint.
router.post('/billing/recommendation-event', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const body = (req.body ?? {}) as {
    eventType?: unknown;
    currentTier?: unknown;
    recommendedTier?: unknown;
    monthlySavingsCents?: unknown;
    trailingWindowMonths?: unknown;
    metadata?: unknown;
  };

  const eventType = typeof body.eventType === 'string' ? body.eventType : '';
  const currentTier =
    typeof body.currentTier === 'string' ? body.currentTier : '';
  const recommendedTier =
    typeof body.recommendedTier === 'string' ? body.recommendedTier : '';

  if (!RECOMMENDATION_EVENT_TYPES.has(eventType)) {
    return res.status(400).json({
      error: `Invalid eventType. Must be one of: impression, click`,
    });
  }
  if (!RECOMMENDATION_TIERS.has(currentTier)) {
    return res.status(400).json({
      error: `Invalid currentTier. Must be one of: starter, pro, enterprise`,
    });
  }
  if (!RECOMMENDATION_TIERS.has(recommendedTier)) {
    return res.status(400).json({
      error: `Invalid recommendedTier. Must be one of: starter, pro, enterprise`,
    });
  }

  const rawSavings = Number(body.monthlySavingsCents);
  const monthlySavingsCents =
    Number.isFinite(rawSavings) && rawSavings >= 0 ? Math.round(rawSavings) : null;

  const rawWindow = Number(body.trailingWindowMonths);
  const trailingWindowMonths =
    Number.isFinite(rawWindow) && RECOMMENDATION_WINDOWS.has(rawWindow)
      ? rawWindow
      : null;

  // Cap metadata at 4KB so a misbehaving client can't flood the table.
  let metadata: Record<string, unknown> = {};
  if (body.metadata && typeof body.metadata === 'object') {
    try {
      const serialised = JSON.stringify(body.metadata);
      if (serialised.length <= 4096) {
        metadata = body.metadata as Record<string, unknown>;
      }
    } catch {
      metadata = {};
    }
  }

  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    await client.query(
      `INSERT INTO billing_recommendation_events
         (tenant_id, event_type, current_tier, recommended_tier,
          monthly_savings_cents, trailing_window_months, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [
        tenantId,
        eventType,
        currentTier,
        recommendedTier,
        monthlySavingsCents,
        trailingWindowMonths,
        JSON.stringify(metadata),
      ],
    );
    await client.query('COMMIT');
    return res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Non-fatal: don't surface analytics failures to the tenant.
    logger.warn('Failed to record recommendation event', {
      tenantId,
      eventType,
      error: String(err),
    });
    return res.status(204).end();
  } finally {
    client.release();
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
      expand: ['data.discounts', 'data.discounts.promotion_code'],
    });

    const invoices = stripeInvoices.data.map((inv) => {
      let discount: UpgradeDiscount | null = null;
      const rawDiscounts = (inv as unknown as {
        discounts?: Array<unknown> | null;
      }).discounts ?? [];
      for (const raw of rawDiscounts) {
        if (typeof raw !== 'object' || raw === null) continue;
        const normalized = normalizeDiscount(raw as Parameters<typeof normalizeDiscount>[0]);
        if (normalized) {
          discount = normalized;
          break;
        }
      }
      // Fallback for legacy invoices missing the expanded `discounts`
      // array: surface a placeholder so the badge still renders.
      if (
        !discount
        && Array.isArray((inv as unknown as { total_discount_amounts?: unknown }).total_discount_amounts)
        && ((inv as unknown as { total_discount_amounts: unknown[] }).total_discount_amounts.length > 0)
      ) {
        discount = {
          couponId: null,
          name: null,
          percentOff: null,
          amountOffCents: null,
          currency: (inv.currency ?? null)?.toLowerCase() ?? null,
          promotionCode: null,
          promotionCodeId: null,
        };
      }
      return {
        id: inv.id,
        date: inv.created ? new Date(inv.created * 1000).toISOString() : null,
        amount_cents: inv.status === 'paid' ? (inv.amount_paid ?? inv.total ?? 0) : (inv.amount_due ?? inv.total ?? 0),
        currency: inv.currency ?? 'usd',
        status: inv.status ?? 'unknown',
        invoice_pdf: inv.invoice_pdf ?? null,
        number: inv.number ?? null,
        description: inv.description ?? (inv.lines?.data?.[0]?.description || null),
        discount,
      };
    });

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
