import { getPlatformPool, withTenantContext } from '../../db';
import { TRIAL_LIMITS } from '../stripe/plans';
import type { TenantId } from '../../core/types';
import { createLogger } from '../../core/logger';

const logger = createLogger('TRIAL_GUARD');

export interface TrialCheckResult {
  isTrial: boolean;
  allowed: boolean;
  reason?: string;
  usage: {
    totalCalls: number;
    maxCalls: number;
    toolExecutions: number;
    maxToolExecutions: number;
    agentCount: number;
    maxAgents: number;
  };
  trialExpiresAt?: string;
}

export async function checkTrialLimits(tenantId: TenantId): Promise<TrialCheckResult> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: subRows } = await client.query(
      `SELECT status, trial_end FROM subscriptions WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );

    const isTrial = subRows.length === 0 || subRows[0]?.status === 'trialing';

    if (!isTrial) {
      await client.query('COMMIT');
      return {
        isTrial: false,
        allowed: true,
        usage: {
          totalCalls: 0,
          maxCalls: TRIAL_LIMITS.maxTotalCalls,
          toolExecutions: 0,
          maxToolExecutions: TRIAL_LIMITS.maxToolExecutions,
          agentCount: 0,
          maxAgents: TRIAL_LIMITS.maxAgents,
        },
      };
    }

    const { rows: tenantRows } = await client.query(
      `SELECT trial_expires_at FROM tenants WHERE id = $1`,
      [tenantId],
    );

    const trialExpiresAt = tenantRows[0]?.trial_expires_at as string | null;
    if (trialExpiresAt && new Date(trialExpiresAt) < new Date()) {
      await client.query('COMMIT');
      return {
        isTrial: true,
        allowed: false,
        reason: 'Your free trial has expired. Please upgrade to a paid plan to continue using the platform.',
        usage: { totalCalls: 0, maxCalls: TRIAL_LIMITS.maxTotalCalls, toolExecutions: 0, maxToolExecutions: TRIAL_LIMITS.maxToolExecutions, agentCount: 0, maxAgents: TRIAL_LIMITS.maxAgents },
        trialExpiresAt: trialExpiresAt ?? undefined,
      };
    }

    const { rows: usageRows } = await client.query(
      `SELECT metric_type, SUM(quantity) AS total
       FROM usage_metrics
       WHERE tenant_id = $1
       GROUP BY metric_type`,
      [tenantId],
    );

    let totalCalls = 0;
    let toolExecutions = 0;
    for (const row of usageRows) {
      const metricType = row.metric_type as string;
      const total = parseInt(row.total as string, 10);
      if (metricType === 'calls_inbound' || metricType === 'calls_outbound') totalCalls += total;
      if (metricType === 'tool_executions') toolExecutions += total;
    }

    const { rows: agentRows } = await client.query(
      `SELECT COUNT(*) AS count FROM agents WHERE tenant_id = $1`,
      [tenantId],
    );
    const agentCount = parseInt(agentRows[0]?.count as string, 10) || 0;

    await client.query('COMMIT');

    const usage = {
      totalCalls,
      maxCalls: TRIAL_LIMITS.maxTotalCalls,
      toolExecutions,
      maxToolExecutions: TRIAL_LIMITS.maxToolExecutions,
      agentCount,
      maxAgents: TRIAL_LIMITS.maxAgents,
    };

    if (totalCalls >= TRIAL_LIMITS.maxTotalCalls) {
      logger.warn('Trial call limit reached', { tenantId, totalCalls });
      return {
        isTrial: true,
        allowed: false,
        reason: `Trial call limit reached (${totalCalls}/${TRIAL_LIMITS.maxTotalCalls}). Upgrade your plan to make more calls.`,
        usage,
        trialExpiresAt: trialExpiresAt ?? undefined,
      };
    }

    if (toolExecutions >= TRIAL_LIMITS.maxToolExecutions) {
      logger.warn('Trial tool execution limit reached', { tenantId, toolExecutions });
      return {
        isTrial: true,
        allowed: false,
        reason: `Trial tool execution limit reached (${toolExecutions}/${TRIAL_LIMITS.maxToolExecutions}). Upgrade your plan to continue using tools.`,
        usage,
        trialExpiresAt: trialExpiresAt ?? undefined,
      };
    }

    return {
      isTrial: true,
      allowed: true,
      usage,
      trialExpiresAt: trialExpiresAt ?? undefined,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Trial check failed', { tenantId, error: String(err) });
    return {
      isTrial: false,
      allowed: true,
      usage: { totalCalls: 0, maxCalls: TRIAL_LIMITS.maxTotalCalls, toolExecutions: 0, maxToolExecutions: TRIAL_LIMITS.maxToolExecutions, agentCount: 0, maxAgents: TRIAL_LIMITS.maxAgents },
    };
  } finally {
    client.release();
  }
}

export async function checkTrialAgentLimit(tenantId: TenantId): Promise<{ allowed: boolean; reason?: string }> {
  const result = await checkTrialLimits(tenantId);
  if (!result.isTrial) return { allowed: true };

  if (result.usage.agentCount >= TRIAL_LIMITS.maxAgents) {
    return {
      allowed: false,
      reason: `Trial agent limit reached (${result.usage.agentCount}/${TRIAL_LIMITS.maxAgents}). Upgrade your plan to create more agents.`,
    };
  }

  return { allowed: true };
}
