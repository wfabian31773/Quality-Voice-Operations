import { Router } from 'express';
import { getPlatformPool, withTenantContext } from '../../../platform/db';
import { requireAuth, invalidateTenantStatusCache } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { createLogger } from '../../../platform/core/logger';
import { getProvisioningStatus, provisionTenant } from '../../../platform/tenant/provisioning/TenantProvisioningService';
import { getRegisteredTemplates } from '../../../platform/agent-templates/registry';
import { getStripeClient } from '../../../platform/billing/stripe/client';
import { PLAN_LIMITS } from '../../../platform/billing/stripe/plans';
import { getActivationMilestones, dismissTooltip, getDismissedTooltips } from '../../../platform/activation/ActivationService';
import { invalidateTenantCurrencyCache } from '../../../platform/billing/tenantCurrency';
import {
  SUPPORTED_BILLING_CURRENCIES,
  isSupportedBillingCurrency,
} from '../../../platform/billing/supportedCurrencies';
import { writeAuditLog, extractIp } from '../../../platform/audit/AuditService';

const router = Router();
const logger = createLogger('ADMIN_TENANTS');

function isProd(): boolean {
  const env = process.env.APP_ENV ?? process.env.NODE_ENV ?? '';
  return env.startsWith('prod') || env === 'staging';
}

router.get('/tenants/me', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const { rows } = await client.query(
      `SELECT id, name, slug, domain, status, plan, settings, feature_flags,
              COALESCE(sms_alerts_disabled, FALSE) AS sms_alerts_disabled,
              COALESCE(billing_currency, 'usd') AS billing_currency,
              COALESCE(timezone, 'America/New_York') AS timezone,
              created_at, updated_at
       FROM tenants WHERE id = $1`,
      [tenantId],
    );
    await client.query('COMMIT');

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Tenant not found' });
    }
    return res.json({ tenant: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to get tenant', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to retrieve tenant' });
  } finally {
    client.release();
  }
});

router.get('/tenants/me/provisioning-status', requireAuth, async (req, res) => {
  const { tenantId, userId } = req.user!;

  try {
    const status = await getProvisioningStatus(tenantId);

    if (status.status === 'pending' && !isProd()) {
      try {
        await provisionTenant(tenantId, userId, 'starter');
        logger.info('Dev-mode auto-provision triggered for pending tenant', { tenantId });
        const updated = await getProvisioningStatus(tenantId);
        return res.json(updated);
      } catch (provErr) {
        logger.warn('Dev-mode auto-provision failed', { tenantId, error: String(provErr) });
      }
    }

    return res.json(status);
  } catch (err) {
    logger.error('Failed to get provisioning status', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to retrieve provisioning status' });
  }
});

router.post('/tenants/me/verify-checkout', requireAuth, async (req, res) => {
  const { tenantId, userId } = req.user!;
  const { sessionId } = req.body as { sessionId?: string };

  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Missing sessionId' });
  }

  try {
    const pool = getPlatformPool();
    const client = await pool.connect();
    let tenantStatus: string;
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL row_security = off`);
      const { rows } = await client.query(`SELECT status FROM tenants WHERE id = $1`, [tenantId]);
      await client.query('COMMIT');
      tenantStatus = (rows[0]?.status as string) ?? 'unknown';
    } finally {
      client.release();
    }

    if (tenantStatus === 'active') {
      invalidateTenantStatusCache(tenantId);
      return res.json({ status: 'ready' });
    }

    const stripe = getStripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    if (session.metadata?.tenantId !== tenantId) {
      return res.status(403).json({ error: 'Session does not belong to this tenant' });
    }

    if (session.payment_status !== 'paid' && session.status !== 'complete') {
      return res.json({ status: 'pending', paymentStatus: session.payment_status });
    }

    const plan = (session.metadata?.plan ?? 'starter') as keyof typeof PLAN_LIMITS;
    const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.starter;

    const subClient = await pool.connect();
    try {
      await subClient.query('BEGIN');
      await subClient.query(`SET LOCAL row_security = off`);
      await subClient.query(
        `INSERT INTO subscriptions (tenant_id, plan, status, stripe_customer_id, stripe_subscription_id,
           monthly_call_limit, monthly_sms_limit, monthly_ai_minute_limit, overage_enabled)
         VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id) DO UPDATE SET
           plan = EXCLUDED.plan, status = 'active',
           stripe_customer_id = EXCLUDED.stripe_customer_id,
           stripe_subscription_id = EXCLUDED.stripe_subscription_id,
           monthly_call_limit = EXCLUDED.monthly_call_limit,
           monthly_sms_limit = EXCLUDED.monthly_sms_limit,
           monthly_ai_minute_limit = EXCLUDED.monthly_ai_minute_limit,
           overage_enabled = EXCLUDED.overage_enabled,
           updated_at = NOW()`,
        [tenantId, plan, session.customer, session.subscription,
         limits.monthlyCallLimit, limits.monthlySmsLimit, limits.monthlyAiMinuteLimit, limits.overageEnabled],
      );
      await subClient.query('COMMIT');
    } catch (subErr) {
      await subClient.query('ROLLBACK').catch(() => {});
      logger.warn('Subscription upsert during verify-checkout failed (non-fatal)', { tenantId, error: String(subErr) });
    } finally {
      subClient.release();
    }

    await provisionTenant(tenantId, userId, plan);
    invalidateTenantStatusCache(tenantId);
    logger.info('Tenant provisioned via checkout verification', { tenantId, userId, plan });

    return res.json({ status: 'ready' });
  } catch (err) {
    logger.error('Checkout verification failed', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Checkout verification failed' });
  }
});

router.get('/agent-types', requireAuth, (_req, res) => {
  return res.json({ agentTypes: getRegisteredTemplates() });
});

const VALID_IANA_TIMEZONES = (() => {
  try {
    return new Set(Intl.supportedValuesOf('timeZone'));
  } catch {
    return null;
  }
})();

function isValidTimezone(tz: string): boolean {
  if (VALID_IANA_TIMEZONES) return VALID_IANA_TIMEZONES.has(tz);
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const SUPPORTED_PRIMARY_LANGUAGES = new Set([
  'en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'zh', 'ja', 'ko', 'ar', 'hi',
]);

router.get('/tenants/me/supported-currencies', requireAuth, (_req, res) => {
  return res.json({ currencies: SUPPORTED_BILLING_CURRENCIES });
});

router.patch('/tenants/me', requireAuth, requireRole('owner'), async (req, res) => {
  const { tenantId, userId, role } = req.user!;
  const { name, domain, settings, smsAlertsDisabled, timezone, billingCurrency } = req.body as {
    name?: string;
    domain?: string;
    settings?: Record<string, unknown>;
    smsAlertsDisabled?: boolean;
    timezone?: string;
    billingCurrency?: string;
  };

  // Top-level `timezone` writes the dedicated `tenants.timezone` column added
  // in migration 097 — that column is what the scheduling code
  // (`getTenantTimezone` in `routes/scheduling.ts`) reads when expanding
  // recurring series and checking override windows. Keeping it as a top-level
  // field (rather than nested in `settings`) avoids the historical drift
  // where `settings.timezone` was a JSON-blob-only value the scheduler never
  // saw.
  if (timezone !== undefined) {
    if (typeof timezone !== 'string' || !isValidTimezone(timezone)) {
      return res.status(400).json({ error: `Invalid timezone: "${timezone}". Must be a valid IANA timezone identifier.` });
    }
  }

  if (settings && settings.timezone !== undefined) {
    if (typeof settings.timezone !== 'string' || !isValidTimezone(settings.timezone)) {
      return res.status(400).json({ error: `Invalid timezone: "${settings.timezone}". Must be a valid IANA timezone identifier.` });
    }
  }

  if (settings && settings.primaryLanguage !== undefined) {
    if (
      typeof settings.primaryLanguage !== 'string' ||
      !SUPPORTED_PRIMARY_LANGUAGES.has(settings.primaryLanguage)
    ) {
      return res.status(400).json({
        error: `Invalid primaryLanguage: "${settings.primaryLanguage}". Must be one of: ${[...SUPPORTED_PRIMARY_LANGUAGES].join(', ')}.`,
      });
    }
  }

  if (smsAlertsDisabled !== undefined && typeof smsAlertsDisabled !== 'boolean') {
    return res.status(400).json({ error: 'smsAlertsDisabled must be a boolean' });
  }

  // Cheap shape check before we touch the DB. The supported-list check
  // is deferred until after we've read the tenant's *current* currency
  // so a tenant whose stored code predates our curated allowlist (e.g.
  // a legacy `cny` row) can still save unrelated Settings fields — the
  // UI re-sends `billingCurrency` on every save, and we only want to
  // enforce the allowlist when the value is actually changing.
  let normalizedCurrency: string | undefined;
  if (billingCurrency !== undefined) {
    if (typeof billingCurrency !== 'string') {
      return res.status(400).json({ error: 'billingCurrency must be a string' });
    }
    const trimmed = billingCurrency.trim().toLowerCase();
    if (trimmed.length !== 3 || !/^[a-z]{3}$/.test(trimmed)) {
      return res.status(400).json({
        error: `Invalid billingCurrency: "${billingCurrency}". Must be a 3-letter ISO 4217 code.`,
      });
    }
    normalizedCurrency = trimmed;
  }

  const pool = getPlatformPool();
  const client = await pool.connect();

  let previousCurrency: string | null = null;
  let currencyIsNoOp = false;

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    if (normalizedCurrency !== undefined) {
      const { rows: currentRows } = await client.query(
        `SELECT COALESCE(billing_currency, 'usd') AS billing_currency FROM tenants WHERE id = $1`,
        [tenantId],
      );
      previousCurrency = (currentRows[0]?.billing_currency as string) ?? null;

      if (previousCurrency === normalizedCurrency) {
        // Unchanged — skip the column update, the audit log, and the
        // supported-list enforcement (so legacy codes aren't blocked
        // from saving unrelated fields).
        currencyIsNoOp = true;
      } else if (!isSupportedBillingCurrency(normalizedCurrency)) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: `Invalid billingCurrency: "${billingCurrency}". Must be a supported ISO 4217 code.`,
          supported: SUPPORTED_BILLING_CURRENCIES.map((c) => c.code),
        });
      }
    }

    const updates: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [tenantId];

    if (name) { values.push(name); updates.push(`name = $${values.length}`); }
    if (domain !== undefined) { values.push(domain); updates.push(`domain = $${values.length}`); }
    if (settings) { values.push(JSON.stringify(settings)); updates.push(`settings = $${values.length}`); }
    if (smsAlertsDisabled !== undefined) {
      values.push(smsAlertsDisabled);
      updates.push(`sms_alerts_disabled = $${values.length}`);
    }
    if (timezone !== undefined) {
      values.push(timezone);
      updates.push(`timezone = $${values.length}`);
    }
    if (normalizedCurrency !== undefined && !currencyIsNoOp) {
      values.push(normalizedCurrency);
      updates.push(`billing_currency = $${values.length}`);
    }

    const { rows } = await client.query(
      `UPDATE tenants SET ${updates.join(', ')} WHERE id = $1
       RETURNING id, name, slug, domain, status, plan, settings,
                 COALESCE(sms_alerts_disabled, FALSE) AS sms_alerts_disabled,
                 COALESCE(timezone, 'America/New_York') AS timezone,
                 COALESCE(billing_currency, 'usd') AS billing_currency, updated_at`,
      values,
    );
    await client.query('COMMIT');

    if (normalizedCurrency !== undefined && previousCurrency !== normalizedCurrency) {
      // Drop the per-tenant cache so the very next cost-screen request
      // sees the new currency without waiting for the 60s TTL to roll.
      invalidateTenantCurrencyCache(tenantId);

      // Audit-trail the change so platform admins can answer "who flipped
      // us to EUR last Tuesday" without trawling postgres history.
      try {
        await writeAuditLog({
          tenantId,
          actorUserId: userId,
          actorRole: role,
          action: 'tenant.billing_currency_changed',
          resourceType: 'tenant',
          resourceId: tenantId,
          changes: { from: previousCurrency ?? 'usd', to: normalizedCurrency },
          beforeState: { billingCurrency: previousCurrency ?? 'usd' },
          afterState: { billingCurrency: normalizedCurrency },
          severity: 'info',
          ipAddress: extractIp(req),
          userAgent: req.headers['user-agent'],
        });
      } catch (auditErr) {
        logger.warn('Failed to record billing-currency audit log (non-fatal)', {
          tenantId,
          error: String(auditErr),
        });
      }
    }

    return res.json({ tenant: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to update tenant', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to update tenant' });
  } finally {
    client.release();
  }
});

router.get('/tenants/me/activation', requireAuth, async (req, res) => {
  const { tenantId } = req.user!;
  try {
    const milestones = await getActivationMilestones(tenantId);
    return res.json({ milestones });
  } catch (err) {
    logger.error('Failed to get activation milestones', { tenantId, error: String(err) });
    return res.status(500).json({ error: 'Failed to retrieve activation milestones' });
  }
});

router.get('/tenants/me/tooltips', requireAuth, async (req, res) => {
  const { userId } = req.user!;
  try {
    const dismissed = await getDismissedTooltips(userId);
    return res.json({ dismissed });
  } catch (err) {
    logger.error('Failed to get tooltip dismissals', { userId, error: String(err) });
    return res.status(500).json({ error: 'Failed to retrieve tooltip state' });
  }
});

router.post('/tenants/me/tooltips/dismiss', requireAuth, async (req, res) => {
  const { userId } = req.user!;
  const { tooltipKey } = req.body as { tooltipKey?: string };
  if (!tooltipKey || typeof tooltipKey !== 'string') {
    return res.status(400).json({ error: 'tooltipKey is required' });
  }
  try {
    await dismissTooltip(userId, tooltipKey);
    return res.json({ success: true });
  } catch (err) {
    logger.error('Failed to dismiss tooltip', { userId, tooltipKey, error: String(err) });
    return res.status(500).json({ error: 'Failed to dismiss tooltip' });
  }
});

export default router;
