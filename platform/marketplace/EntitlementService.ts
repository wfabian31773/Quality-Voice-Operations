import { getPlatformPool, withTenantContext } from '../db';
import { PLAN_LIMITS, type PlanTier } from '../billing/stripe/plans';
import { listConnectorConfigs } from '../integrations/connectors/db';
import { createLogger } from '../core/logger';
import type { TenantId } from '../core/types';

const logger = createLogger('ENTITLEMENT_SERVICE');

const PLAN_HIERARCHY: Record<string, number> = {
  starter: 0,
  pro: 1,
  enterprise: 2,
};

export interface EntitlementCheckResult {
  allowed: boolean;
  errors: string[];
  warnings: string[];
  plan: string;
  agentCount: number;
  maxAgents: number;
}

export interface TemplateRequirements {
  minPlan: string;
  requiredIntegrations: string[];
}

export async function checkEntitlement(
  tenantId: TenantId,
  requirements: TemplateRequirements,
): Promise<EntitlementCheckResult> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: subRows } = await client.query(
      `SELECT plan, status FROM subscriptions WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );

    const plan = subRows.length > 0 ? (subRows[0].plan as string) : 'starter';
    const subStatus = subRows.length > 0 ? (subRows[0].status as string) : 'active';

    const errors: string[] = [];
    const warnings: string[] = [];

    if (subStatus === 'cancelled' || subStatus === 'past_due') {
      errors.push(`Subscription is ${subStatus}. Please update your billing to install templates.`);
    }

    const tenantLevel = PLAN_HIERARCHY[plan] ?? 0;
    const requiredLevel = PLAN_HIERARCHY[requirements.minPlan] ?? 0;
    if (tenantLevel < requiredLevel) {
      errors.push(
        `This template requires the ${requirements.minPlan} plan or higher. Your current plan is ${plan}.`,
      );
    }

    const { rows: agentRows } = await client.query(
      `SELECT COUNT(*) AS count FROM agents WHERE tenant_id = $1`,
      [tenantId],
    );
    const agentCount = parseInt(agentRows[0].count as string, 10);
    const limits = PLAN_LIMITS[plan as PlanTier] ?? PLAN_LIMITS.starter;
    const maxAgents = limits.maxAgents;

    if (agentCount >= maxAgents) {
      errors.push(
        `Agent limit reached (${agentCount}/${maxAgents}). Upgrade your plan to install more agents.`,
      );
    }

    await client.query('COMMIT');

    if (requirements.requiredIntegrations.length > 0) {
      const connectors = await listConnectorConfigs(tenantId);
      const enabledTypes = new Set(connectors.filter((c) => c.isEnabled).map((c) => c.connectorType));

      for (const required of requirements.requiredIntegrations) {
        if (!enabledTypes.has(required as any)) {
          errors.push(
            `Required integration "${required}" is not configured. Please set it up before installing this template.`,
          );
        }
      }
    }

    return {
      allowed: errors.length === 0,
      errors,
      warnings,
      plan,
      agentCount,
      maxAgents,
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Entitlement check failed', { tenantId, error: String(err) });
    return {
      allowed: false,
      errors: ['Entitlement check failed due to an internal error.'],
      warnings: [],
      plan: 'unknown',
      agentCount: 0,
      maxAgents: 0,
    };
  } finally {
    client.release();
  }
}
