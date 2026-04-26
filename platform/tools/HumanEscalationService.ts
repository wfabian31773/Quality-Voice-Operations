import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import type { TenantId } from '../core/types';
import {
  fanoutInAppNotification,
  filterEmailRecipientsByPreference,
} from '../notifications/NotificationPreferences';
import { sendEmail, escalationAlertEmail } from '../email';

const logger = createLogger('HUMAN_ESCALATION');

const ESCALATION_NOTIFICATION_TYPE = 'escalation';

function appBaseUrl(): string {
  return (
    process.env.APP_URL ??
    `https://${process.env.REPLIT_DEV_DOMAIN ?? 'localhost:5173'}`
  );
}

export interface EscalationTask {
  id: string;
  tenantId: string;
  callSessionId: string;
  agentSlug: string | null;
  callerPhone: string | null;
  reason: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  status: 'pending' | 'assigned' | 'in_progress' | 'completed' | 'dismissed';
  assignedTo: string | null;
  notes: string | null;
  toolName: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateEscalationTaskParams {
  tenantId: TenantId;
  callSessionId: string;
  agentSlug?: string;
  callerPhone?: string;
  reason: string;
  priority: EscalationTask['priority'];
  toolName?: string;
  metadata?: Record<string, unknown>;
}

interface DbClient {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

async function withTenant<T>(tenantId: string, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});
    const result = await fn(client as unknown as DbClient);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function mapRow(row: Record<string, unknown>): EscalationTask {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    callSessionId: row.call_session_id as string,
    agentSlug: row.agent_slug as string | null,
    callerPhone: row.caller_phone as string | null,
    reason: row.reason as string,
    priority: row.priority as EscalationTask['priority'],
    status: row.status as EscalationTask['status'],
    assignedTo: row.assigned_to as string | null,
    notes: row.notes as string | null,
    toolName: row.tool_name as string | null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at ?? ''),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at ?? ''),
  };
}

export async function createEscalationTask(params: CreateEscalationTaskParams): Promise<EscalationTask> {
  const task = await withTenant(params.tenantId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO escalation_tasks (
        tenant_id, call_session_id, agent_slug, caller_phone, reason, priority, status, tool_name, metadata, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, NOW(), NOW())
      RETURNING *`,
      [
        params.tenantId,
        params.callSessionId,
        params.agentSlug ?? null,
        params.callerPhone ?? null,
        params.reason,
        params.priority,
        params.toolName ?? null,
        JSON.stringify(params.metadata ?? {}),
      ],
    );
    logger.info('Escalation task created', {
      tenantId: params.tenantId,
      callId: params.callSessionId,
      priority: params.priority,
      taskId: rows[0].id,
    });
    return mapRow(rows[0]);
  });

  // Best-effort notification fan-out. Never fail task creation because a
  // notification couldn't be delivered — the escalation row is the source of
  // truth and surfaces in the queue regardless of preferences.
  notifyHumanEscalation(task).catch((err) => {
    logger.warn('Failed to dispatch escalation notifications', {
      tenantId: task.tenantId,
      taskId: task.id,
      error: String(err),
    });
  });

  return task;
}

/**
 * Fan out an in-app row per opted-in user and send an email to admin/owner
 * recipients who have not opted out of the 'escalation' category. Routed
 * through the standard preference helpers so on-call rotation members can
 * silence escalation pings without losing other alerts.
 *
 * Exported for tests; production callers should rely on createEscalationTask
 * triggering this automatically.
 */
export async function notifyHumanEscalation(task: EscalationTask): Promise<void> {
  const escalationsPath = '/ops/reliability?tab=escalations';
  const escalationsUrl = `${appBaseUrl().replace(/\/$/, '')}${escalationsPath}`;

  const reasonSnippet = task.reason.slice(0, 200);
  const title = `Human escalation: ${task.priority.toUpperCase()}`;
  const message =
    `A live call needs human attention: ${reasonSnippet}` +
    (task.callerPhone ? ` (caller ${task.callerPhone})` : '');

  const inAppMetadata = {
    link: escalationsPath,
    escalationTaskId: task.id,
    callSessionId: task.callSessionId,
    agentSlug: task.agentSlug,
    callerPhone: task.callerPhone,
    priority: task.priority,
    toolName: task.toolName,
  };

  try {
    await fanoutInAppNotification({
      tenantId: task.tenantId,
      type: ESCALATION_NOTIFICATION_TYPE,
      title,
      message,
      metadata: inAppMetadata,
      category: 'escalation',
    });
  } catch (err) {
    logger.error('Failed to fan out escalation in-app notification', {
      tenantId: task.tenantId,
      taskId: task.id,
      error: String(err),
    });
  }

  const pool = getPlatformPool();
  let tenantName: string | undefined;
  let recipients: string[] = [];
  try {
    const { rows: tenantRows } = await pool.query(
      `SELECT name FROM tenants WHERE id = $1`,
      [task.tenantId],
    );
    if (tenantRows.length > 0) {
      tenantName = (tenantRows[0].name as string | null) ?? undefined;
    }

    const { rows: userRows } = await pool.query(
      `SELECT email FROM users
       WHERE tenant_id = $1
         AND role IN ('admin', 'owner')
         AND email IS NOT NULL
         AND COALESCE(is_active, TRUE) = TRUE
       LIMIT 10`,
      [task.tenantId],
    );
    recipients = userRows
      .map((r) => (r.email as string | null) ?? '')
      .filter((e): e is string => Boolean(e));
  } catch (err) {
    logger.warn('Failed to look up tenant admins for escalation email', {
      tenantId: task.tenantId,
      taskId: task.id,
      error: String(err),
    });
    return;
  }

  if (recipients.length === 0) {
    logger.info('No tenant admins found to email about human escalation', {
      tenantId: task.tenantId,
      taskId: task.id,
    });
    return;
  }

  const beforeFilter = recipients.length;
  recipients = await filterEmailRecipientsByPreference(
    task.tenantId,
    recipients,
    'escalation',
  );
  if (recipients.length === 0) {
    logger.info('All admin recipients opted out of escalation email notifications', {
      tenantId: task.tenantId,
      taskId: task.id,
      removed: beforeFilter,
    });
    return;
  }

  const { subject, html, text } = escalationAlertEmail({
    tenantName,
    reason: task.reason,
    priority: task.priority,
    agentSlug: task.agentSlug,
    callerPhone: task.callerPhone,
    toolName: task.toolName,
    callSessionId: task.callSessionId,
    escalationsUrl,
    raisedAt: new Date(task.createdAt || Date.now()).toUTCString(),
  });

  for (const to of recipients) {
    try {
      const result = await sendEmail({ to, subject, html, text });
      if (!result.success) {
        logger.warn('Escalation alert email send failed', {
          tenantId: task.tenantId,
          taskId: task.id,
          to,
          error: result.error,
        });
      }
    } catch (err) {
      logger.warn('Escalation alert email threw', {
        tenantId: task.tenantId,
        taskId: task.id,
        to,
        error: String(err),
      });
    }
  }

  logger.info('Human escalation notifications dispatched', {
    tenantId: task.tenantId,
    taskId: task.id,
    priority: task.priority,
    emailRecipients: recipients.length,
  });
}

export async function listEscalationTasks(
  tenantId: string,
  options: { status?: string; priority?: string; limit?: number; offset?: number } = {},
): Promise<{ tasks: EscalationTask[]; total: number }> {
  return withTenant(tenantId, async (client) => {
    const conditions = ['tenant_id = $1'];
    const values: unknown[] = [tenantId];
    let idx = 2;

    if (options.status) {
      conditions.push(`status = $${idx++}`);
      values.push(options.status);
    }
    if (options.priority) {
      conditions.push(`priority = $${idx++}`);
      values.push(options.priority);
    }

    const where = conditions.join(' AND ');
    const limit = Math.min(options.limit ?? 50, 200);
    const offset = options.offset ?? 0;

    const { rows: countRows } = await client.query(
      `SELECT COUNT(*)::int AS total FROM escalation_tasks WHERE ${where}`, values,
    );
    const { rows } = await client.query(
      `SELECT * FROM escalation_tasks WHERE ${where} ORDER BY
        CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...values, limit, offset],
    );

    return {
      tasks: rows.map(mapRow),
      total: countRows[0]?.total ?? 0,
    };
  });
}

export async function updateEscalationTask(
  tenantId: string,
  taskId: string,
  updates: { status?: EscalationTask['status']; assignedTo?: string; notes?: string },
): Promise<EscalationTask | null> {
  return withTenant(tenantId, async (client) => {
    const setClauses: string[] = ['updated_at = NOW()'];
    const values: unknown[] = [taskId, tenantId];
    let idx = 3;

    if (updates.status) {
      setClauses.push(`status = $${idx++}`);
      values.push(updates.status);
    }
    if (updates.assignedTo !== undefined) {
      setClauses.push(`assigned_to = $${idx++}`);
      values.push(updates.assignedTo);
    }
    if (updates.notes !== undefined) {
      setClauses.push(`notes = $${idx++}`);
      values.push(updates.notes);
    }

    const { rows } = await client.query(
      `UPDATE escalation_tasks SET ${setClauses.join(', ')} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      values,
    );

    if (rows.length === 0) return null;
    return mapRow(rows[0]);
  });
}

export async function getEscalationTaskStats(tenantId: string): Promise<{
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  byPriority: Record<string, number>;
}> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status IN ('assigned', 'in_progress'))::int AS in_progress,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed
       FROM escalation_tasks WHERE tenant_id = $1`,
      [tenantId],
    );
    const { rows: priorityRows } = await client.query(
      `SELECT priority, COUNT(*)::int AS cnt FROM escalation_tasks WHERE tenant_id = $1 GROUP BY priority`,
      [tenantId],
    );

    const byPriority: Record<string, number> = {};
    for (const r of priorityRows) {
      byPriority[r.priority as string] = r.cnt as number;
    }

    return {
      total: rows[0]?.total ?? 0,
      pending: rows[0]?.pending ?? 0,
      inProgress: rows[0]?.in_progress ?? 0,
      completed: rows[0]?.completed ?? 0,
      byPriority,
    };
  });
}
