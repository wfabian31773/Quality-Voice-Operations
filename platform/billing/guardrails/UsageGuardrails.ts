import { getPlatformPool, withPrivilegedClient } from '../../db';
import { PLAN_LIMITS, PLAN_RATE_LIMITS } from '../stripe/plans';
import type { PlanTier } from '../stripe/plans';
import { createLogger } from '../../core/logger';

const logger = createLogger('USAGE_GUARDRAILS');

interface TenantUsageSummary {
  tenantId: string;
  plan: PlanTier;
  status: string;
  callsUsed: number;
  callLimit: number;
  aiMinutesUsed: number;
  aiMinuteLimit: number;
  dailyMinutesUsed: number;
  dailyMinuteCap: number;
}

async function getTenantUsageSummaries(): Promise<TenantUsageSummary[]> {
  return withPrivilegedClient(async (client) => {
    const { rows } = await client.query(`
      SELECT
        s.tenant_id,
        s.plan,
        s.status,
        COALESCE((
          SELECT SUM(um.quantity)
          FROM usage_metrics um
          WHERE um.tenant_id = s.tenant_id
            AND um.metric_type IN ('calls_inbound', 'calls_outbound')
            AND um.period_start >= date_trunc('month', NOW())
        ), 0) AS calls_used,
        COALESCE((
          SELECT SUM(um.quantity)
          FROM usage_metrics um
          WHERE um.tenant_id = s.tenant_id
            AND um.metric_type = 'ai_minutes'
            AND um.period_start >= date_trunc('month', NOW())
        ), 0) AS ai_minutes_used,
        COALESCE((
          SELECT SUM(um.quantity)
          FROM usage_metrics um
          WHERE um.tenant_id = s.tenant_id
            AND um.metric_type = 'ai_minutes'
            AND um.period_start >= date_trunc('day', NOW())
        ), 0) AS daily_minutes_used
      FROM subscriptions s
      WHERE s.status IN ('active', 'trialing')
    `);

    return rows.map((row) => {
      const plan = (row.plan as PlanTier) || 'starter';
      const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.starter;
      const rateLimits = PLAN_RATE_LIMITS[plan] ?? PLAN_RATE_LIMITS.starter;

      return {
        tenantId: row.tenant_id as string,
        plan,
        status: row.status as string,
        callsUsed: parseInt(String(row.calls_used), 10),
        callLimit: limits.monthlyCallLimit,
        aiMinutesUsed: parseInt(String(row.ai_minutes_used), 10),
        aiMinuteLimit: limits.monthlyAiMinuteLimit,
        dailyMinutesUsed: parseInt(String(row.daily_minutes_used), 10),
        dailyMinuteCap: rateLimits.dailyCallMinuteCap,
      };
    });
  });
}

async function sendNotification(
  tenantId: string,
  type: string,
  title: string,
  message: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const pool = getPlatformPool();
  try {
    const { rows: recent } = await pool.query(
      `SELECT id FROM tenant_notifications
       WHERE tenant_id = $1 AND type = $2 AND created_at > NOW() - INTERVAL '24 hours'
       LIMIT 1`,
      [tenantId, type],
    );
    if (recent.length > 0) return;

    await pool.query(
      `INSERT INTO tenant_notifications (tenant_id, type, title, message, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, type, title, message, JSON.stringify(metadata)],
    );
  } catch (err) {
    logger.error('Failed to send notification', { tenantId, type, error: String(err) });
  }
}

async function logBillingEvent(
  tenantId: string,
  eventType: 'usage_warning' | 'account_suspended',
  description: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const pool = getPlatformPool();
  try {
    await pool.query(
      `INSERT INTO billing_events (tenant_id, event_type, description, metadata)
       VALUES ($1, $2::billing_event_type, $3, $4)`,
      [tenantId, eventType, description, JSON.stringify(metadata)],
    );
  } catch (err) {
    logger.error('Failed to log billing event', { tenantId, eventType, error: String(err) });
  }
}

async function suspendTenant(tenantId: string, reason: string): Promise<void> {
  try {
    await withPrivilegedClient(async (client) => {
      await client.query(
        `UPDATE tenants SET status = 'suspended', suspended_at = NOW(), suspension_reason = $2, updated_at = NOW() WHERE id = $1`,
        [tenantId, reason],
      );
    });
    logger.warn('Tenant auto-suspended', { tenantId, reason });
  } catch (err) {
    logger.error('Failed to suspend tenant', { tenantId, error: String(err) });
  }
}

export async function runUsageGuardrailsCheck(): Promise<void> {
  try {
    const summaries = await getTenantUsageSummaries();

    for (const summary of summaries) {
      if (summary.plan === 'enterprise') continue;

      const callPercent = summary.callLimit > 0 ? summary.callsUsed / summary.callLimit : 0;
      const minutePercent = summary.aiMinuteLimit > 0 ? summary.aiMinutesUsed / summary.aiMinuteLimit : 0;
      const dailyMinutePercent = summary.dailyMinuteCap > 0 ? summary.dailyMinutesUsed / summary.dailyMinuteCap : 0;

      if (callPercent >= 0.8 && callPercent < 1.0) {
        const msg = `You have used ${summary.callsUsed} of your ${summary.callLimit} monthly calls (${Math.round(callPercent * 100)}%). Consider upgrading your plan.`;
        await sendNotification(summary.tenantId, 'usage_warning_calls', 'Approaching Call Limit', msg,
          { metric: 'calls', used: summary.callsUsed, limit: summary.callLimit, percent: callPercent });
        await logBillingEvent(summary.tenantId, 'usage_warning', msg,
          { metric: 'calls', used: summary.callsUsed, limit: summary.callLimit, percent: callPercent });
      }

      if (minutePercent >= 0.8 && minutePercent < 1.0) {
        const msg = `You have used ${summary.aiMinutesUsed} of your ${summary.aiMinuteLimit} monthly AI minutes (${Math.round(minutePercent * 100)}%). Consider upgrading your plan.`;
        await sendNotification(summary.tenantId, 'usage_warning_minutes', 'Approaching AI Minute Limit', msg,
          { metric: 'ai_minutes', used: summary.aiMinutesUsed, limit: summary.aiMinuteLimit, percent: minutePercent });
        await logBillingEvent(summary.tenantId, 'usage_warning', msg,
          { metric: 'ai_minutes', used: summary.aiMinutesUsed, limit: summary.aiMinuteLimit, percent: minutePercent });
      }

      if (dailyMinutePercent >= 0.8 && dailyMinutePercent < 1.0) {
        const msg = `You have used ${summary.dailyMinutesUsed} of your ${summary.dailyMinuteCap} daily call minutes (${Math.round(dailyMinutePercent * 100)}%).`;
        await sendNotification(summary.tenantId, 'usage_warning_daily_minutes', 'Approaching Daily Minute Cap', msg,
          { metric: 'daily_minutes', used: summary.dailyMinutesUsed, limit: summary.dailyMinuteCap, percent: dailyMinutePercent });
        await logBillingEvent(summary.tenantId, 'usage_warning', msg,
          { metric: 'daily_minutes', used: summary.dailyMinutesUsed, limit: summary.dailyMinuteCap, percent: dailyMinutePercent });
      }

      if (callPercent >= 2.0) {
        const reason = `Auto-suspended: Monthly call usage (${summary.callsUsed}) exceeded 2x limit (${summary.callLimit * 2})`;
        await suspendTenant(summary.tenantId, reason);
        await sendNotification(summary.tenantId, 'account_suspended', 'Account Suspended - Usage Exceeded',
          `Your account has been suspended because your call usage (${summary.callsUsed}) exceeded twice your plan limit (${summary.callLimit}). Please contact support to resolve.`,
          { metric: 'calls', used: summary.callsUsed, limit: summary.callLimit });
        await logBillingEvent(summary.tenantId, 'account_suspended', reason,
          { metric: 'calls', used: summary.callsUsed, limit: summary.callLimit });
      }

      if (minutePercent >= 2.0) {
        const reason = `Auto-suspended: Monthly AI minute usage (${summary.aiMinutesUsed}) exceeded 2x limit (${summary.aiMinuteLimit * 2})`;
        await suspendTenant(summary.tenantId, reason);
        await sendNotification(summary.tenantId, 'account_suspended', 'Account Suspended - Usage Exceeded',
          `Your account has been suspended because your AI minute usage (${summary.aiMinutesUsed}) exceeded twice your plan limit (${summary.aiMinuteLimit}). Please contact support to resolve.`,
          { metric: 'ai_minutes', used: summary.aiMinutesUsed, limit: summary.aiMinuteLimit });
        await logBillingEvent(summary.tenantId, 'account_suspended', reason,
          { metric: 'ai_minutes', used: summary.aiMinutesUsed, limit: summary.aiMinuteLimit });
      }

      if (dailyMinutePercent >= 2.0) {
        const reason = `Auto-suspended: Daily call minute usage (${summary.dailyMinutesUsed}) exceeded 2x cap (${summary.dailyMinuteCap * 2})`;
        await suspendTenant(summary.tenantId, reason);
        await sendNotification(summary.tenantId, 'account_suspended', 'Account Suspended - Daily Limit Exceeded',
          `Your account has been suspended because your daily call minutes (${summary.dailyMinutesUsed}) exceeded twice your daily cap (${summary.dailyMinuteCap}). Please contact support to resolve.`,
          { metric: 'daily_minutes', used: summary.dailyMinutesUsed, limit: summary.dailyMinuteCap });
        await logBillingEvent(summary.tenantId, 'account_suspended', reason,
          { metric: 'daily_minutes', used: summary.dailyMinutesUsed, limit: summary.dailyMinuteCap });
      }
    }

    logger.info('Usage guardrails check completed', { tenantsChecked: summaries.length });
  } catch (err) {
    logger.error('Usage guardrails check failed', { error: String(err) });
  }
}

let guardrailInterval: ReturnType<typeof setInterval> | null = null;

export function startUsageGuardrailsScheduler(intervalMs: number = 5 * 60 * 1000): void {
  if (guardrailInterval) return;
  guardrailInterval = setInterval(runUsageGuardrailsCheck, intervalMs);
  logger.info('Usage guardrails scheduler started', { intervalMs });
}

export function stopUsageGuardrailsScheduler(): void {
  if (guardrailInterval) {
    clearInterval(guardrailInterval);
    guardrailInterval = null;
  }
}
