import { getPlatformPool, withTenantContext } from '../../db';
import { PLAN_LIMITS } from '../stripe/plans';
import type { PlanTier } from '../stripe/plans';
import type { TenantId } from '../../core/types';
import { createLogger } from '../../core/logger';
import { checkTrialLimits } from '../guardrails/TrialGuard';

const logger = createLogger('BUDGET_CHECK');

export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
  plan: string;
  status: string;
  isTrial: boolean;
  usage: {
    callsUsed: number;
    callLimit: number;
    aiMinutesUsed: number;
    aiMinuteLimit: number;
    toolExecutions?: number;
    toolExecutionLimit?: number;
  };
}

export async function checkBudget(tenantId: TenantId, options?: { failOpen?: boolean }): Promise<BudgetCheckResult> {
  const failOpen = options?.failOpen ?? false;
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: subRows } = await client.query(
      `SELECT plan, status, monthly_call_limit, monthly_ai_minute_limit, overage_enabled
       FROM subscriptions WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );

    const sub = subRows[0];
    const plan = (sub?.plan as string) ?? 'starter';
    const subStatus = (sub?.status as string) ?? 'none';
    const isTrial = subRows.length === 0 || subStatus === 'trialing';

    if (isTrial) {
      await client.query('COMMIT');
      const trialResult = await checkTrialLimits(tenantId);
      return {
        allowed: trialResult.allowed,
        reason: trialResult.reason,
        plan: 'trial',
        status: 'trialing',
        isTrial: true,
        usage: {
          callsUsed: trialResult.usage.totalCalls,
          callLimit: trialResult.usage.maxCalls,
          aiMinutesUsed: 0,
          aiMinuteLimit: 0,
          toolExecutions: trialResult.usage.toolExecutions,
          toolExecutionLimit: trialResult.usage.maxToolExecutions,
        },
      };
    }

    if (subRows.length === 0) {
      await client.query('COMMIT');
      const defaultLimits = PLAN_LIMITS.starter;
      return {
        allowed: true,
        plan: 'starter',
        status: 'none',
        isTrial: false,
        usage: {
          callsUsed: 0,
          callLimit: defaultLimits.monthlyCallLimit,
          aiMinutesUsed: 0,
          aiMinuteLimit: defaultLimits.monthlyAiMinuteLimit,
        },
      };
    }

    const callLimit = (sub.monthly_call_limit as number) ?? PLAN_LIMITS[plan as PlanTier]?.monthlyCallLimit ?? 500;
    const aiMinuteLimit = (sub.monthly_ai_minute_limit as number) ?? PLAN_LIMITS[plan as PlanTier]?.monthlyAiMinuteLimit ?? 250;
    const overageEnabled = (sub.overage_enabled as boolean) ?? false;

    if (subStatus === 'cancelled' || subStatus === 'past_due') {
      await client.query('COMMIT');
      return {
        allowed: false,
        reason: `Subscription is ${subStatus}. Please update your billing to continue.`,
        plan,
        status: subStatus,
        isTrial: false,
        usage: { callsUsed: 0, callLimit, aiMinutesUsed: 0, aiMinuteLimit },
      };
    }

    const { rows: usageRows } = await client.query(
      `SELECT metric_type, SUM(quantity) AS total
       FROM usage_metrics
       WHERE tenant_id = $1
         AND period_start >= date_trunc('month', NOW())
       GROUP BY metric_type`,
      [tenantId],
    );
    await client.query('COMMIT');

    let callsUsed = 0;
    let aiMinutesUsed = 0;
    for (const row of usageRows) {
      const metricType = row.metric_type as string;
      const total = parseInt(row.total as string, 10);
      if (metricType === 'calls_inbound' || metricType === 'calls_outbound') callsUsed += total;
      if (metricType === 'ai_minutes') aiMinutesUsed += total;
    }

    const usage = { callsUsed, callLimit, aiMinutesUsed, aiMinuteLimit };

    if (!overageEnabled && callsUsed >= callLimit) {
      logger.warn('Monthly call limit reached', { tenantId, plan, callsUsed, callLimit });
      return {
        allowed: false,
        reason: `Monthly call limit reached (${callsUsed}/${callLimit}). Upgrade your plan or wait until next billing cycle.`,
        plan,
        status: subStatus,
        isTrial: false,
        usage,
      };
    }

    if (!overageEnabled && aiMinutesUsed >= aiMinuteLimit) {
      logger.warn('Monthly AI minute limit reached', { tenantId, plan, aiMinutesUsed, aiMinuteLimit });
      return {
        allowed: false,
        reason: `Monthly AI minute limit reached (${aiMinutesUsed}/${aiMinuteLimit}). Upgrade your plan or wait until next billing cycle.`,
        plan,
        status: subStatus,
        isTrial: false,
        usage,
      };
    }

    return { allowed: true, plan, status: subStatus, isTrial: false, usage };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Budget check failed', { tenantId, error: String(err), failOpen });
    return {
      allowed: failOpen,
      reason: failOpen
        ? 'Budget check failed — allowing call (fail-open mode)'
        : 'Budget check failed — blocking call for safety (fail-closed mode)',
      plan: 'unknown',
      status: 'error',
      isTrial: false,
      usage: { callsUsed: 0, callLimit: 0, aiMinutesUsed: 0, aiMinuteLimit: 0 },
    };
  } finally {
    client.release();
  }
}
