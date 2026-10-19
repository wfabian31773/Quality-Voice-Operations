import { getPlatformPool, withTenantContext } from '../db';
import { TRIAL_LIMITS } from '../billing/stripe/plans';
import { isTrialSubscription } from '../billing/guardrails/TrialGuard';
import { listConnectorConfigs } from '../integrations/connectors/db';
import { createLogger } from '../core/logger';
import type { TenantId } from '../core/types';

const logger = createLogger('ENTITLEMENT_SERVICE');

// Every plan includes every template, vertical and tool; plans differ only in
// minutes and usage caps (docs/shop/tools-spec.md, "Plans and entitlements").
// Nothing here may gate on plan tier. The only agent-count limit is the trial's.

export interface EntitlementCheckResult {
  allowed: boolean;
  errors: string[];
  warnings: string[];
  plan: string;
  agentCount: number;
  /** TRIAL_LIMITS.maxAgents while on trial; null (no cap) on any paid plan. */
  maxAgents: number | null;
}

export interface TemplateRequirements {
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
    const isTrial = isTrialSubscription(subRows[0]);

    const errors: string[] = [];
    const warnings: string[] = [];

    if (subStatus === 'cancelled' || subStatus === 'past_due') {
      errors.push(`Subscription is ${subStatus}. Please update your billing to install templates.`);
    }

    const { rows: agentRows } = await client.query(
      `SELECT COUNT(*) AS count FROM agents WHERE tenant_id = $1`,
      [tenantId],
    );
    const agentCount = parseInt(agentRows[0].count as string, 10);
    const maxAgents = isTrial ? TRIAL_LIMITS.maxAgents : null;

    if (maxAgents !== null && agentCount >= maxAgents) {
      errors.push(
        `Trial agent limit reached (${agentCount}/${maxAgents}). Choose a paid plan to install more agents.`,
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
      maxAgents: null,
    };
  } finally {
    client.release();
  }
}
