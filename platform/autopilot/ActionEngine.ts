import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import type {
  AutopilotAction,
  AutopilotPolicy,
  AutopilotRecommendation,
  AutopilotApproval,
  AutopilotImpactReport,
} from './types';

const logger = createLogger('AUTOPILOT_ACTION_ENGINE');

function normalizeToSimpleRole(dbRole: string): string {
  if (dbRole === 'tenant_owner' || dbRole === 'owner') return 'owner';
  if (['operations_manager', 'billing_admin', 'agent_developer', 'admin'].includes(dbRole)) return 'admin';
  if (dbRole === 'manager') return 'manager';
  return 'member';
}

function mapActionRow(r: Record<string, unknown>): AutopilotAction {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    recommendationId: (r.recommendation_id as string) || null,
    actionType: r.action_type as string,
    actionPayload: (r.action_payload as Record<string, unknown>) || {},
    status: r.status as AutopilotAction['status'],
    executedAt: r.executed_at ? String(r.executed_at) : null,
    completedAt: r.completed_at ? String(r.completed_at) : null,
    result: (r.result as Record<string, unknown>) || {},
    errorMessage: (r.error_message as string) || null,
    rollbackPayload: (r.rollback_payload as Record<string, unknown>) || null,
    rolledBack: Boolean(r.rolled_back),
    rolledBackAt: r.rolled_back_at ? String(r.rolled_back_at) : null,
    rolledBackBy: (r.rolled_back_by as string) || null,
    executedBy: (r.executed_by as string) || null,
    autoExecuted: Boolean(r.auto_executed),
    metadata: (r.metadata as Record<string, unknown>) || {},
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapPolicyRow(r: Record<string, unknown>): AutopilotPolicy {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    name: r.name as string,
    description: (r.description as string) || null,
    riskTier: r.risk_tier as AutopilotPolicy['riskTier'],
    actionType: r.action_type as string,
    requiresApproval: Boolean(r.requires_approval),
    approvalRole: r.approval_role as string,
    autoExecute: Boolean(r.auto_execute),
    enabled: Boolean(r.enabled),
    metadata: (r.metadata as Record<string, unknown>) || {},
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function mapApprovalRow(r: Record<string, unknown>): AutopilotApproval {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    recommendationId: r.recommendation_id as string,
    action: r.action as AutopilotApproval['action'],
    userId: r.user_id as string,
    userRole: (r.user_role as string) || null,
    reason: (r.reason as string) || null,
    createdAt: String(r.created_at),
  };
}

function mapImpactRow(r: Record<string, unknown>): AutopilotImpactReport {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    actionId: (r.action_id as string) || null,
    recommendationId: (r.recommendation_id as string) || null,
    reportType: r.report_type as string,
    metricsBefore: (r.metrics_before as Record<string, unknown>) || {},
    metricsAfter: (r.metrics_after as Record<string, unknown>) || {},
    measuredRevenueImpactCents: r.measured_revenue_impact_cents != null ? Number(r.measured_revenue_impact_cents) : null,
    measuredCostSavingsCents: r.measured_cost_savings_cents != null ? Number(r.measured_cost_savings_cents) : null,
    improvementPercentage: r.improvement_percentage != null ? Number(r.improvement_percentage) : null,
    assessment: (r.assessment as string) || null,
    measurementPeriodStart: r.measurement_period_start ? String(r.measurement_period_start) : null,
    measurementPeriodEnd: r.measurement_period_end ? String(r.measurement_period_end) : null,
    metadata: (r.metadata as Record<string, unknown>) || {},
    createdAt: String(r.created_at),
  };
}

export async function approveRecommendation(
  tenantId: string,
  recommendationId: string,
  userId: string,
  userRole: string,
): Promise<AutopilotRecommendation | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: recRows } = await client.query(
      `SELECT * FROM autopilot_recommendations WHERE id = $1 AND tenant_id = $2`,
      [recommendationId, tenantId],
    );
    if (recRows.length === 0) { await client.query('ROLLBACK'); return null; }

    const rec = recRows[0];
    if (rec.status !== 'pending') {
      await client.query('ROLLBACK');
      return null;
    }

    const policy = await findPolicyForAction(client, tenantId, rec.action_type as string, rec.risk_tier as string);
    if (policy && policy.requires_approval) {
      const requiredRole = policy.approval_role as string;
      const simpleRole = normalizeToSimpleRole(userRole);
      const roleHierarchy: Record<string, number> = { member: 1, manager: 2, admin: 3, owner: 4 };
      if ((roleHierarchy[simpleRole] ?? 0) < (roleHierarchy[requiredRole] ?? 3)) {
        await client.query('ROLLBACK');
        throw new Error(`Insufficient role: requires ${requiredRole}, user has ${simpleRole} (${userRole})`);
      }
    }

    await client.query(
      `INSERT INTO autopilot_approvals (tenant_id, recommendation_id, action, user_id, user_role)
       VALUES ($1, $2, 'approved', $3, $4)`,
      [tenantId, recommendationId, userId, userRole],
    );

    const { rows: updatedRows } = await client.query(
      `UPDATE autopilot_recommendations
       SET status = 'approved', approved_by = $3, approved_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [recommendationId, tenantId, userId],
    );

    await client.query('COMMIT');

    const { mapRecommendationRow } = await import('./AutopilotEngine');
    return mapRecommendationRow(updatedRows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function rejectRecommendation(
  tenantId: string,
  recommendationId: string,
  userId: string,
  userRole: string,
  reason?: string,
): Promise<AutopilotRecommendation | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    await client.query(
      `INSERT INTO autopilot_approvals (tenant_id, recommendation_id, action, user_id, user_role, reason)
       VALUES ($1, $2, 'rejected', $3, $4, $5)`,
      [tenantId, recommendationId, userId, userRole, reason || null],
    );

    const { rows } = await client.query(
      `UPDATE autopilot_recommendations
       SET status = 'rejected', rejected_by = $3, rejected_at = NOW(),
           rejection_reason = $4, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
       RETURNING *`,
      [recommendationId, tenantId, userId, reason || null],
    );

    await client.query('COMMIT');
    if (rows.length === 0) return null;

    const { mapRecommendationRow } = await import('./AutopilotEngine');
    return mapRecommendationRow(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function dismissRecommendation(
  tenantId: string,
  recommendationId: string,
  userId: string,
): Promise<AutopilotRecommendation | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    await client.query(
      `INSERT INTO autopilot_approvals (tenant_id, recommendation_id, action, user_id)
       VALUES ($1, $2, 'dismissed', $3)`,
      [tenantId, recommendationId, userId],
    );

    const { rows } = await client.query(
      `UPDATE autopilot_recommendations
       SET status = 'dismissed', dismissed_by = $3, dismissed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
       RETURNING *`,
      [recommendationId, tenantId, userId],
    );

    await client.query('COMMIT');
    if (rows.length === 0) return null;

    const { mapRecommendationRow } = await import('./AutopilotEngine');
    return mapRecommendationRow(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function executeAction(
  tenantId: string,
  recommendationId: string,
  userId?: string,
  autoExecuted: boolean = false,
  userRole?: string,
): Promise<AutopilotAction | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: recRows } = await client.query(
      `SELECT * FROM autopilot_recommendations WHERE id = $1 AND tenant_id = $2`,
      [recommendationId, tenantId],
    );
    if (recRows.length === 0) { await client.query('ROLLBACK'); return null; }

    const rec = recRows[0];

    if (rec.status !== 'approved' && !autoExecuted) {
      await client.query('ROLLBACK');
      throw new Error('Recommendation must be approved before execution');
    }

    if (!autoExecuted && userRole) {
      const policy = await findPolicyForAction(client, tenantId, rec.action_type as string, rec.risk_tier as string);
      if (policy && policy.requires_approval) {
        const requiredRole = policy.approval_role as string;
        const simpleRole = normalizeToSimpleRole(userRole);
        const roleHierarchy: Record<string, number> = { member: 1, manager: 2, admin: 3, owner: 4 };
        if ((roleHierarchy[simpleRole] ?? 0) < (roleHierarchy[requiredRole] ?? 3)) {
          await client.query('ROLLBACK');
          throw new Error(`Insufficient role to execute: requires ${requiredRole}, user has ${simpleRole}`);
        }
      }
    }

    const actionType = rec.action_type as string;
    const actionPayload = (rec.action_payload as Record<string, unknown>) || {};

    const { rows: actionRows } = await client.query(
      `INSERT INTO autopilot_actions (
        tenant_id, recommendation_id, action_type, action_payload,
        status, executed_at, executed_by, auto_executed
      ) VALUES ($1, $2, $3, $4, 'executing', NOW(), $5, $6)
      RETURNING *`,
      [tenantId, recommendationId, actionType, JSON.stringify(actionPayload), userId || null, autoExecuted],
    );

    const actionId = actionRows[0].id as string;

    try {
      const result = await performAction(tenantId, actionType, actionPayload);

      await client.query(
        `UPDATE autopilot_actions SET status = 'completed', completed_at = NOW(),
         result = $3, rollback_payload = $4, updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2`,
        [actionId, tenantId, JSON.stringify(result.result), JSON.stringify(result.rollbackPayload || null)],
      );

      await client.query(
        `UPDATE autopilot_recommendations SET status = 'executed', updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2`,
        [recommendationId, tenantId],
      );

      const { rows: completedRows } = await client.query(
        `SELECT * FROM autopilot_actions WHERE id = $1 AND tenant_id = $2`,
        [actionId, tenantId],
      );

      await client.query('COMMIT');

      try {
        await scheduleImpactReport(tenantId, actionId, recommendationId);
      } catch (err) {
        logger.error('Failed to schedule impact report', { tenantId, actionId, error: String(err) });
      }

      try {
        const { createInAppNotification } = await import('./NotificationService');
        await createInAppNotification(tenantId, {
          recommendationId,
          severity: 'info',
          title: `Action executed: ${actionType.replace(/_/g, ' ')}`,
          body: `The recommended action has been ${autoExecuted ? 'auto-' : ''}executed successfully.`,
        });
      } catch { /* notification is best-effort */ }

      return completedRows[0] ? mapActionRow(completedRows[0]) : null;
    } catch (err) {
      const { rows: failedRows } = await client.query(
        `UPDATE autopilot_actions SET status = 'failed', error_message = $3,
         completed_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2
         RETURNING *`,
        [actionId, tenantId, String(err)],
      );
      await client.query('COMMIT');
      logger.error('Action execution failed', { tenantId, actionId, error: String(err) });
      return failedRows[0] ? mapActionRow(failedRows[0]) : null;
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function performAction(
  tenantId: string,
  actionType: string,
  payload: Record<string, unknown>,
): Promise<{ result: Record<string, unknown>; rollbackPayload?: Record<string, unknown> }> {
  const pool = getPlatformPool();

  switch (actionType) {
    case 'activate_agent': {
      const agentId = payload.agentId as string | undefined;
      if (agentId) {
        const actionClient = await pool.connect();
        try {
          await actionClient.query('BEGIN');
          await withTenantContext(actionClient, tenantId, async () => {});
          const { rows: prev } = await actionClient.query(
            `SELECT status FROM agents WHERE id = $1 AND tenant_id = $2`, [agentId, tenantId],
          );
          const previousStatus = (prev[0]?.status as string) || 'inactive';
          await actionClient.query(
            `UPDATE agents SET status = 'active', updated_at = NOW() WHERE id = $1 AND tenant_id = $2`,
            [agentId, tenantId],
          );
          await actionClient.query('COMMIT');
          return {
            result: { action: 'activate_agent', agentId, tenantId, status: 'executed', previousStatus },
            rollbackPayload: { action: 'deactivate_agent', agentId, restoreStatus: previousStatus },
          };
        } catch (err) {
          await actionClient.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          actionClient.release();
        }
      }
      return { result: { action: 'activate_agent', tenantId, status: 'executed', note: 'No specific agent targeted' } };
    }

    case 'deactivate_agent': {
      const agentId = payload.agentId as string | undefined;
      const restoreStatus = (payload.restoreStatus as string) || 'inactive';
      if (agentId) {
        const actionClient = await pool.connect();
        try {
          await actionClient.query('BEGIN');
          await withTenantContext(actionClient, tenantId, async () => {});
          await actionClient.query(
            `UPDATE agents SET status = $3, updated_at = NOW() WHERE id = $1 AND tenant_id = $2`,
            [agentId, tenantId, restoreStatus],
          );
          await actionClient.query('COMMIT');
        } catch (err) {
          await actionClient.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          actionClient.release();
        }
      }
      return { result: { action: 'deactivate_agent', agentId, tenantId, status: 'executed' } };
    }

    case 'launch_campaign': {
      const campaignId = payload.campaignId as string | undefined;
      if (campaignId) {
        const actionClient = await pool.connect();
        try {
          await actionClient.query('BEGIN');
          await withTenantContext(actionClient, tenantId, async () => {});
          const { rows: prev } = await actionClient.query(
            `SELECT status FROM campaigns WHERE id = $1 AND tenant_id = $2`, [campaignId, tenantId],
          );
          const previousStatus = (prev[0]?.status as string) || 'draft';
          await actionClient.query(
            `UPDATE campaigns SET status = 'active', started_at = NOW(), updated_at = NOW() WHERE id = $1 AND tenant_id = $2`,
            [campaignId, tenantId],
          );
          await actionClient.query('COMMIT');
          return {
            result: { action: 'launch_campaign', campaignId, tenantId, status: 'executed', previousStatus },
            rollbackPayload: { action: 'pause_campaign', campaignId, restoreStatus: previousStatus },
          };
        } catch (err) {
          await actionClient.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          actionClient.release();
        }
      }
      return { result: { action: 'launch_campaign', tenantId, status: 'executed', note: 'Campaign config recorded' } };
    }

    case 'pause_campaign': {
      const campaignId = payload.campaignId as string | undefined;
      const restoreStatus = (payload.restoreStatus as string) || 'paused';
      if (campaignId) {
        const actionClient = await pool.connect();
        try {
          await actionClient.query('BEGIN');
          await withTenantContext(actionClient, tenantId, async () => {});
          await actionClient.query(
            `UPDATE campaigns SET status = $3, updated_at = NOW() WHERE id = $1 AND tenant_id = $2`,
            [campaignId, tenantId, restoreStatus],
          );
          await actionClient.query('COMMIT');
        } catch (err) {
          await actionClient.query('ROLLBACK').catch(() => {});
          throw err;
        } finally {
          actionClient.release();
        }
      }
      return { result: { action: 'pause_campaign', campaignId, tenantId, status: 'executed' } };
    }

    case 'update_routing': {
      const actionClient = await pool.connect();
      try {
        await actionClient.query('BEGIN');
        await withTenantContext(actionClient, tenantId, async () => {});
        const { rows: prev } = await actionClient.query(
          `SELECT settings FROM tenants WHERE id = $1`, [tenantId],
        );
        const prevSettings = (prev[0]?.settings as Record<string, unknown>) || {};
        const prevRouting = prevSettings.routing || {};
        const newSettings = { ...prevSettings, routing: { ...(prevSettings.routing as Record<string, unknown> || {}), ...(payload as Record<string, unknown>) } };
        await actionClient.query(
          `UPDATE tenants SET settings = $2, updated_at = NOW() WHERE id = $1`,
          [tenantId, JSON.stringify(newSettings)],
        );
        await actionClient.query('COMMIT');
        return {
          result: { action: 'update_routing', tenantId, status: 'executed', appliedConfig: payload },
          rollbackPayload: { action: 'revert_routing', previousRouting: prevRouting },
        };
      } catch (err) {
        await actionClient.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        actionClient.release();
      }
    }

    case 'revert_routing': {
      const actionClient = await pool.connect();
      try {
        await actionClient.query('BEGIN');
        await withTenantContext(actionClient, tenantId, async () => {});
        const { rows: prev } = await actionClient.query(
          `SELECT settings FROM tenants WHERE id = $1`, [tenantId],
        );
        const prevSettings = (prev[0]?.settings as Record<string, unknown>) || {};
        const restoredSettings = { ...prevSettings, routing: payload.previousRouting || {} };
        await actionClient.query(
          `UPDATE tenants SET settings = $2, updated_at = NOW() WHERE id = $1`,
          [tenantId, JSON.stringify(restoredSettings)],
        );
        await actionClient.query('COMMIT');
      } catch (err) {
        await actionClient.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        actionClient.release();
      }
      return { result: { action: 'revert_routing', tenantId, status: 'executed' } };
    }

    case 'create_task': {
      logger.info('Autopilot task created', { tenantId, task: payload.task, focus: payload.focus });
      const { createInAppNotification } = await import('./NotificationService');
      await createInAppNotification(tenantId, {
        severity: 'info',
        title: `Task created: ${payload.task || 'Review required'}`,
        body: `Autopilot created a follow-up task: ${JSON.stringify(payload)}`,
      });
      return { result: { action: 'create_task', task: payload, tenantId, status: 'executed' } };
    }

    case 'send_alert': {
      const { createInAppNotification } = await import('./NotificationService');
      await createInAppNotification(tenantId, {
        severity: (payload.priority as string) === 'high' ? 'critical' : 'warning',
        title: `Alert: ${payload.alertType || 'System Alert'}`,
        body: JSON.stringify(payload),
      });
      return { result: { action: 'send_alert', alert: payload, tenantId, status: 'executed' } };
    }

    case 'enable_workflow':
    case 'disable_workflow': {
      const newActive = actionType === 'enable_workflow';
      const workflowId = payload.workflowId;
      if (!workflowId) {
        throw new Error(`${actionType} requires workflowId in payload`);
      }
      const pool = getPlatformPool();
      const wfClient = await pool.connect();
      try {
        await wfClient.query('BEGIN');
        await withTenantContext(wfClient, tenantId, async () => {});
        const { rows: prevRows } = await wfClient.query(
          `SELECT is_active FROM scheduling_workflows WHERE id = $1 AND tenant_id = $2`,
          [workflowId, tenantId],
        );
        if (prevRows.length === 0) {
          await wfClient.query('ROLLBACK');
          throw new Error(`Workflow ${workflowId} not found for tenant ${tenantId}`);
        }
        const previousActive = prevRows[0].is_active;
        await wfClient.query(
          `UPDATE scheduling_workflows SET is_active = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3`,
          [newActive, workflowId, tenantId],
        );
        await wfClient.query('COMMIT');
        logger.info('Workflow action executed', { tenantId, actionType, workflowId, newActive });
        return {
          result: { action: actionType, workflowId, tenantId, status: 'executed', previousActive, newActive },
          rollbackPayload: { action: newActive ? 'disable_workflow' : 'enable_workflow', workflowId },
        };
      } catch (err) {
        await wfClient.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        wfClient.release();
      }
    }

    case 'adjust_schedule': {
      const pool = getPlatformPool();
      const schClient = await pool.connect();
      try {
        await schClient.query('BEGIN');
        await withTenantContext(schClient, tenantId, async () => {});
        const { rows: tenantRows } = await schClient.query(
          `SELECT settings FROM tenants WHERE id = $1`,
          [tenantId],
        );
        const currentSettings = tenantRows[0]?.settings || {};
        const previousSchedule = currentSettings.businessHours || currentSettings.schedule || null;
        const newSettings = {
          ...currentSettings,
          businessHours: payload.businessHours || payload.schedule,
        };
        await schClient.query(
          `UPDATE tenants SET settings = $1, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(newSettings), tenantId],
        );
        await schClient.query('COMMIT');
        logger.info('Schedule adjustment executed', { tenantId, payload });
        return {
          result: { action: 'adjust_schedule', schedule: payload, tenantId, status: 'executed' },
          rollbackPayload: { action: 'adjust_schedule', businessHours: previousSchedule },
        };
      } catch (err) {
        await schClient.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        schClient.release();
      }
    }

    default:
      logger.warn('Unknown action type', { actionType, tenantId });
      return { result: { action: actionType, status: 'executed', payload, note: 'Action type handler not implemented — recorded for review' } };
  }
}

export async function rollbackAction(
  tenantId: string,
  actionId: string,
  userId: string,
): Promise<AutopilotAction | null> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows } = await client.query(
      `SELECT * FROM autopilot_actions WHERE id = $1 AND tenant_id = $2`,
      [actionId, tenantId],
    );
    if (rows.length === 0 || rows[0].rolled_back) {
      await client.query('ROLLBACK');
      return null;
    }

    const action = rows[0];
    const rollbackPayload = action.rollback_payload as Record<string, unknown> | null;

    if (rollbackPayload) {
      await performAction(tenantId, rollbackPayload.action as string, rollbackPayload);
    }

    const { rows: updated } = await client.query(
      `UPDATE autopilot_actions SET rolled_back = true, rolled_back_at = NOW(),
       rolled_back_by = $3, status = 'rolled_back', updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [actionId, tenantId, userId],
    );

    await client.query('COMMIT');
    return updated[0] ? mapActionRow(updated[0]) : null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getActionHistory(
  tenantId: string,
  options: { limit?: number; offset?: number; status?: string } = {},
): Promise<{ actions: AutopilotAction[]; total: number }> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  const limit = Math.min(options.limit ?? 50, 100);
  const offset = options.offset ?? 0;

  try {
    await client.query('BEGIN');
    return await withTenantContext(client, tenantId, async () => {
      const conditions = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      let idx = 2;

      if (options.status) { conditions.push(`status = $${idx++}`); params.push(options.status); }

      const where = conditions.join(' AND ');
      const { rows: countRows } = await client.query(
        `SELECT COUNT(*)::int AS total FROM autopilot_actions WHERE ${where}`, params,
      );
      const { rows } = await client.query(
        `SELECT * FROM autopilot_actions WHERE ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset],
      );
      await client.query('COMMIT');
      return { actions: rows.map(mapActionRow), total: countRows[0]?.total ?? 0 };
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getPolicies(tenantId: string): Promise<AutopilotPolicy[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT * FROM autopilot_policies WHERE tenant_id = $1 ORDER BY risk_tier, action_type`,
        [tenantId],
      );
      await client.query('COMMIT');
      return rows.map(mapPolicyRow);
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return [];
  } finally {
    client.release();
  }
}

export async function upsertPolicy(
  tenantId: string,
  policy: { name: string; riskTier: string; actionType: string; requiresApproval: boolean; approvalRole: string; autoExecute: boolean; description?: string },
): Promise<AutopilotPolicy> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: existing } = await client.query(
      `SELECT id FROM autopilot_policies WHERE tenant_id = $1 AND action_type = $2 AND risk_tier = $3`,
      [tenantId, policy.actionType, policy.riskTier],
    );

    let rows;
    if (existing.length > 0) {
      const result = await client.query(
        `UPDATE autopilot_policies SET name = $3, description = $4, requires_approval = $5,
         approval_role = $6, auto_execute = $7, updated_at = NOW()
         WHERE id = $1 AND tenant_id = $2 RETURNING *`,
        [existing[0].id, tenantId, policy.name, policy.description || null,
         policy.requiresApproval, policy.approvalRole, policy.autoExecute],
      );
      rows = result.rows;
    } else {
      const result = await client.query(
        `INSERT INTO autopilot_policies (tenant_id, name, description, risk_tier, action_type,
         requires_approval, approval_role, auto_execute)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [tenantId, policy.name, policy.description || null, policy.riskTier,
         policy.actionType, policy.requiresApproval, policy.approvalRole, policy.autoExecute],
      );
      rows = result.rows;
    }

    await client.query('COMMIT');
    return mapPolicyRow(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function getImpactReports(
  tenantId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<{ reports: AutopilotImpactReport[]; total: number }> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  const limit = Math.min(options.limit ?? 50, 100);
  const offset = options.offset ?? 0;

  try {
    await client.query('BEGIN');
    return await withTenantContext(client, tenantId, async () => {
      const { rows: countRows } = await client.query(
        `SELECT COUNT(*)::int AS total FROM autopilot_impact_reports WHERE tenant_id = $1`, [tenantId],
      );
      const { rows } = await client.query(
        `SELECT * FROM autopilot_impact_reports WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [tenantId, limit, offset],
      );
      await client.query('COMMIT');
      return { reports: rows.map(mapImpactRow), total: countRows[0]?.total ?? 0 };
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function findPolicyForAction(
  client: { query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
  tenantId: string,
  actionType: string,
  riskTier: string,
): Promise<Record<string, unknown> | null> {
  const { rows } = await client.query(
    `SELECT * FROM autopilot_policies
     WHERE tenant_id = $1 AND action_type = $2 AND risk_tier = $3 AND enabled = true
     LIMIT 1`,
    [tenantId, actionType, riskTier],
  );
  return rows[0] || null;
}

async function scheduleImpactReport(
  tenantId: string,
  actionId: string,
  recommendationId: string,
): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const { rows: callsBefore } = await client.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE lifecycle_state = 'CALL_COMPLETED')::int AS completed,
         COUNT(*) FILTER (WHERE lifecycle_state = 'MISSED' OR (direction = 'inbound' AND duration_seconds < 5 AND lifecycle_state != 'CALL_COMPLETED'))::int AS missed,
         COUNT(*) FILTER (WHERE lifecycle_state IN ('CALL_FAILED','WORKFLOW_FAILED'))::int AS failed
       FROM call_sessions
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
      [tenantId, sevenDaysAgo, now],
    );

    const { rows: recRows } = await client.query(
      `SELECT estimated_revenue_impact_cents, estimated_cost_savings_cents
       FROM autopilot_recommendations WHERE id = $1 AND tenant_id = $2`,
      [recommendationId, tenantId],
    );

    const metricsBefore = callsBefore[0] || {};
    const rec = recRows[0] || {};

    await client.query(
      `INSERT INTO autopilot_impact_reports (
        tenant_id, action_id, recommendation_id, report_type,
        metrics_before, metrics_after,
        measured_revenue_impact_cents, measured_cost_savings_cents,
        assessment, measurement_period_start, measurement_period_end
      ) VALUES ($1, $2, $3, 'baseline', $4, $5, $6, $7, $8, $9, $10)`,
      [
        tenantId, actionId, recommendationId,
        JSON.stringify(metricsBefore), JSON.stringify({}),
        rec.estimated_revenue_impact_cents ?? null,
        rec.estimated_cost_savings_cents ?? null,
        'Baseline metrics captured at action execution. Post-action metrics will be measured after the observation period.',
        sevenDaysAgo, now,
      ],
    );

    await client.query('COMMIT');
    logger.info('Impact report baseline created', { tenantId, actionId });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to create impact report baseline', { tenantId, actionId, error: String(err) });
  } finally {
    client.release();
  }
}

export async function generatePostActionImpactReport(
  tenantId: string,
  actionId: string,
): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: baselineRows } = await client.query(
      `SELECT * FROM autopilot_impact_reports
       WHERE tenant_id = $1 AND action_id = $2 AND report_type = 'baseline'
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, actionId],
    );
    if (baselineRows.length === 0) { await client.query('COMMIT'); return; }

    const baseline = baselineRows[0];
    const metricsBefore = (baseline.metrics_before as Record<string, unknown>) || {};

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const { rows: callsAfter } = await client.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE lifecycle_state = 'CALL_COMPLETED')::int AS completed,
         COUNT(*) FILTER (WHERE lifecycle_state = 'MISSED' OR (direction = 'inbound' AND duration_seconds < 5 AND lifecycle_state != 'CALL_COMPLETED'))::int AS missed,
         COUNT(*) FILTER (WHERE lifecycle_state IN ('CALL_FAILED','WORKFLOW_FAILED'))::int AS failed
       FROM call_sessions
       WHERE tenant_id = $1 AND created_at >= $2 AND created_at < $3`,
      [tenantId, sevenDaysAgo, now],
    );

    const metricsAfter = callsAfter[0] || {};
    const beforeMissed = Number(metricsBefore.missed || 0);
    const afterMissed = Number(metricsAfter.missed || 0);
    const improvement = beforeMissed > 0 ? Math.round(((beforeMissed - afterMissed) / beforeMissed) * 100) : 0;

    await client.query(
      `INSERT INTO autopilot_impact_reports (
        tenant_id, action_id, recommendation_id, report_type,
        metrics_before, metrics_after,
        improvement_percentage, assessment,
        measurement_period_start, measurement_period_end
      ) VALUES ($1, $2, $3, 'post_action', $4, $5, $6, $7, $8, $9)`,
      [
        tenantId, actionId, baseline.recommendation_id,
        JSON.stringify(metricsBefore), JSON.stringify(metricsAfter),
        improvement,
        `Post-action measurement: missed calls ${improvement > 0 ? 'decreased' : 'unchanged'} by ${Math.abs(improvement)}%.`,
        baseline.measurement_period_end, now,
      ],
    );

    await client.query('COMMIT');
    logger.info('Post-action impact report generated', { tenantId, actionId, improvement });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to generate post-action impact report', { tenantId, actionId, error: String(err) });
  } finally {
    client.release();
  }
}

export { mapActionRow, mapPolicyRow, mapApprovalRow, mapImpactRow };
