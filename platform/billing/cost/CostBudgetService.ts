import { getPlatformPool, withTenantContext } from '../../db';
import { createLogger } from '../../core/logger';

const logger = createLogger('COST_BUDGET');

export interface CostBudgetSettings {
  tenantId: string;
  maxCostPerConversationCents: number;
  alertThresholdPercent: number;
  autoDowngradeModel: boolean;
  autoEndCall: boolean;
  enabled: boolean;
}

export interface BudgetCheckResult {
  withinBudget: boolean;
  currentCostCents: number;
  budgetCents: number;
  percentUsed: number;
  shouldAlert: boolean;
  shouldDowngrade: boolean;
  shouldEndCall: boolean;
}

export async function getCostBudgetSettings(tenantId: string): Promise<CostBudgetSettings | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await withTenantContext(client, tenantId, async () => {});
    const { rows } = await client.query(
      `SELECT * FROM cost_budget_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      tenantId: row.tenant_id,
      maxCostPerConversationCents: row.max_cost_per_conversation_cents,
      alertThresholdPercent: row.alert_threshold_percent,
      autoDowngradeModel: row.auto_downgrade_model,
      autoEndCall: row.auto_end_call,
      enabled: row.enabled,
    };
  } finally {
    client.release();
  }
}

export async function upsertCostBudgetSettings(
  tenantId: string,
  settings: Partial<Omit<CostBudgetSettings, 'tenantId'>>,
): Promise<CostBudgetSettings> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await withTenantContext(client, tenantId, async () => {});
    const { rows } = await client.query(
      `INSERT INTO cost_budget_settings (
        id, tenant_id, max_cost_per_conversation_cents, alert_threshold_percent,
        auto_downgrade_model, auto_end_call, enabled
      ) VALUES (
        gen_random_uuid(), $1,
        COALESCE($2, 500), COALESCE($3, 80),
        COALESCE($4, TRUE), COALESCE($5, FALSE), COALESCE($6, FALSE)
      )
      ON CONFLICT (tenant_id) DO UPDATE SET
        max_cost_per_conversation_cents = COALESCE($2, cost_budget_settings.max_cost_per_conversation_cents),
        alert_threshold_percent = COALESCE($3, cost_budget_settings.alert_threshold_percent),
        auto_downgrade_model = COALESCE($4, cost_budget_settings.auto_downgrade_model),
        auto_end_call = COALESCE($5, cost_budget_settings.auto_end_call),
        enabled = COALESCE($6, cost_budget_settings.enabled),
        updated_at = NOW()
      RETURNING *`,
      [
        tenantId,
        settings.maxCostPerConversationCents ?? null,
        settings.alertThresholdPercent ?? null,
        settings.autoDowngradeModel ?? null,
        settings.autoEndCall ?? null,
        settings.enabled ?? null,
      ],
    );
    const row = rows[0];
    logger.info('Cost budget settings updated', { tenantId });
    return {
      tenantId: row.tenant_id,
      maxCostPerConversationCents: row.max_cost_per_conversation_cents,
      alertThresholdPercent: row.alert_threshold_percent,
      autoDowngradeModel: row.auto_downgrade_model,
      autoEndCall: row.auto_end_call,
      enabled: row.enabled,
    };
  } finally {
    client.release();
  }
}

export async function checkConversationBudget(
  tenantId: string,
  currentCostCents: number,
): Promise<BudgetCheckResult> {
  const settings = await getCostBudgetSettings(tenantId);

  if (!settings || !settings.enabled) {
    return {
      withinBudget: true,
      currentCostCents,
      budgetCents: 0,
      percentUsed: 0,
      shouldAlert: false,
      shouldDowngrade: false,
      shouldEndCall: false,
    };
  }

  const budgetCents = settings.maxCostPerConversationCents;
  const percentUsed = budgetCents > 0 ? Math.round((currentCostCents / budgetCents) * 100) : 0;
  const withinBudget = currentCostCents < budgetCents;
  const shouldAlert = percentUsed >= settings.alertThresholdPercent;
  const shouldDowngrade = shouldAlert && settings.autoDowngradeModel;
  const shouldEndCall = !withinBudget && settings.autoEndCall;

  if (shouldAlert) {
    logger.warn('Conversation cost budget alert', {
      tenantId,
      currentCostCents,
      budgetCents,
      percentUsed,
    });
  }

  return {
    withinBudget,
    currentCostCents,
    budgetCents,
    percentUsed,
    shouldAlert,
    shouldDowngrade,
    shouldEndCall,
  };
}
