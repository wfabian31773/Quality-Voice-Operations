import { getPlatformPool } from '../db';
import { createLogger } from '../core/logger';

const logger = createLogger('ACTIVATION');

export type ActivationEventType =
  | 'tenant_agent_created'
  | 'tenant_agent_deployed'
  | 'tenant_phone_connected'
  | 'tenant_tools_connected'
  | 'tenant_first_call'
  | 'tenant_first_workflow_execution';

export interface ActivationEvent {
  id: string;
  tenant_id: string;
  event_type: ActivationEventType;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ActivationMilestones {
  agent_created: boolean;
  agent_deployed: boolean;
  phone_connected: boolean;
  tools_connected: boolean;
  first_call_completed: boolean;
  first_workflow_executed: boolean;
  agent_created_at: string | null;
  agent_deployed_at: string | null;
  phone_connected_at: string | null;
  tools_connected_at: string | null;
  first_call_at: string | null;
  first_workflow_at: string | null;
}

export async function recordActivationEvent(
  tenantId: string,
  eventType: ActivationEventType,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const pool = getPlatformPool();
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO activation_events (tenant_id, event_type, metadata)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, event_type) DO NOTHING`,
      [tenantId, eventType, JSON.stringify(metadata)],
    );
    if (rowCount && rowCount > 0) {
      logger.info('Activation event recorded', { tenantId, eventType });
    } else {
      logger.debug('Activation event already recorded', { tenantId, eventType });
    }
  } catch (err) {
    logger.error('Failed to record activation event', { tenantId, eventType, error: String(err) });
  }
}

export async function getActivationMilestones(tenantId: string): Promise<ActivationMilestones> {
  const pool = getPlatformPool();
  try {
    const { rows } = await pool.query(
      `SELECT event_type, created_at FROM activation_events WHERE tenant_id = $1`,
      [tenantId],
    );

    const events = new Map<string, string>();
    for (const row of rows) {
      events.set(row.event_type as string, row.created_at as string);
    }

    return {
      agent_created: events.has('tenant_agent_created'),
      agent_deployed: events.has('tenant_agent_deployed'),
      phone_connected: events.has('tenant_phone_connected'),
      tools_connected: events.has('tenant_tools_connected'),
      first_call_completed: events.has('tenant_first_call'),
      first_workflow_executed: events.has('tenant_first_workflow_execution'),
      agent_created_at: events.get('tenant_agent_created') ?? null,
      agent_deployed_at: events.get('tenant_agent_deployed') ?? null,
      phone_connected_at: events.get('tenant_phone_connected') ?? null,
      tools_connected_at: events.get('tenant_tools_connected') ?? null,
      first_call_at: events.get('tenant_first_call') ?? null,
      first_workflow_at: events.get('tenant_first_workflow_execution') ?? null,
    };
  } catch (err) {
    logger.error('Failed to get activation milestones', { tenantId, error: String(err) });
    return {
      agent_created: false,
      agent_deployed: false,
      phone_connected: false,
      tools_connected: false,
      first_call_completed: false,
      first_workflow_executed: false,
      agent_created_at: null,
      agent_deployed_at: null,
      phone_connected_at: null,
      tools_connected_at: null,
      first_call_at: null,
      first_workflow_at: null,
    };
  }
}

export async function getAllTenantsActivationMetrics(): Promise<Array<{
  tenant_id: string;
  tenant_name: string;
  tenant_plan: string;
  tenant_status: string;
  tenant_created_at: string;
  agent_created_at: string | null;
  agent_deployed_at: string | null;
  phone_connected_at: string | null;
  tools_connected_at: string | null;
  first_call_at: string | null;
  first_workflow_at: string | null;
  time_to_agent_hours: number | null;
  time_to_call_hours: number | null;
  time_to_workflow_hours: number | null;
  milestones_completed: number;
}>> {
  const pool = getPlatformPool();
  const { rows } = await pool.query(`
    SELECT
      t.id AS tenant_id,
      t.name AS tenant_name,
      t.plan AS tenant_plan,
      t.status AS tenant_status,
      t.created_at AS tenant_created_at,
      MAX(CASE WHEN ae.event_type = 'tenant_agent_created' THEN ae.created_at END) AS agent_created_at,
      MAX(CASE WHEN ae.event_type = 'tenant_agent_deployed' THEN ae.created_at END) AS agent_deployed_at,
      MAX(CASE WHEN ae.event_type = 'tenant_phone_connected' THEN ae.created_at END) AS phone_connected_at,
      MAX(CASE WHEN ae.event_type = 'tenant_tools_connected' THEN ae.created_at END) AS tools_connected_at,
      MAX(CASE WHEN ae.event_type = 'tenant_first_call' THEN ae.created_at END) AS first_call_at,
      MAX(CASE WHEN ae.event_type = 'tenant_first_workflow_execution' THEN ae.created_at END) AS first_workflow_at,
      COUNT(DISTINCT ae.event_type) AS milestones_completed
    FROM tenants t
    LEFT JOIN activation_events ae ON ae.tenant_id = t.id
    GROUP BY t.id, t.name, t.plan, t.status, t.created_at
    ORDER BY t.created_at DESC
  `);

  return rows.map((row) => {
    const tenantCreated = new Date(row.tenant_created_at as string).getTime();
    const agentAt = row.agent_created_at ? new Date(row.agent_created_at as string).getTime() : null;
    const callAt = row.first_call_at ? new Date(row.first_call_at as string).getTime() : null;
    const workflowAt = row.first_workflow_at ? new Date(row.first_workflow_at as string).getTime() : null;

    return {
      tenant_id: row.tenant_id as string,
      tenant_name: row.tenant_name as string,
      tenant_plan: row.tenant_plan as string,
      tenant_status: row.tenant_status as string,
      tenant_created_at: row.tenant_created_at as string,
      agent_created_at: (row.agent_created_at as string) ?? null,
      agent_deployed_at: (row.agent_deployed_at as string) ?? null,
      phone_connected_at: (row.phone_connected_at as string) ?? null,
      tools_connected_at: (row.tools_connected_at as string) ?? null,
      first_call_at: (row.first_call_at as string) ?? null,
      first_workflow_at: (row.first_workflow_at as string) ?? null,
      time_to_agent_hours: agentAt ? Math.round((agentAt - tenantCreated) / 3600000 * 10) / 10 : null,
      time_to_call_hours: callAt ? Math.round((callAt - tenantCreated) / 3600000 * 10) / 10 : null,
      time_to_workflow_hours: workflowAt ? Math.round((workflowAt - tenantCreated) / 3600000 * 10) / 10 : null,
      milestones_completed: parseInt(String(row.milestones_completed), 10) || 0,
    };
  });
}

export async function dismissTooltip(userId: string, tooltipKey: string): Promise<void> {
  const pool = getPlatformPool();
  await pool.query(
    `INSERT INTO tooltip_dismissals (user_id, tooltip_key) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, tooltipKey],
  );
}

export async function getDismissedTooltips(userId: string): Promise<string[]> {
  const pool = getPlatformPool();
  const { rows } = await pool.query(
    `SELECT tooltip_key FROM tooltip_dismissals WHERE user_id = $1`,
    [userId],
  );
  return rows.map((r) => r.tooltip_key as string);
}
