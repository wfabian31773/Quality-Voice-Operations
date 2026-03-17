import { randomUUID } from 'crypto';
import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import { redactToolParameters, unifiedToolRegistry } from './ToolRegistry';
import type { TenantId } from '../core/types';

const logger = createLogger('TOOL_EXECUTION_SERVICE');

export interface ToolExecutionRecord {
  id: string;
  tenantId: string;
  callSessionId: string | null;
  agentId: string | null;
  agentSlug: string | null;
  toolName: string;
  parameters: Record<string, unknown>;
  parametersRedacted: Record<string, unknown>;
  result: unknown;
  status: 'pending' | 'running' | 'success' | 'failed' | 'timeout';
  errorMessage: string | null;
  recoveryAction: string | null;
  durationMs: number | null;
  invokedAt: string;
  completedAt: string | null;
}

export interface ToolExecutionFilter {
  tenantId: string;
  callSessionId?: string;
  agentId?: string;
  toolName?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
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

export async function createToolExecution(params: {
  tenantId: TenantId;
  callSessionId?: string;
  agentId?: string;
  agentSlug?: string;
  toolName: string;
  parameters: Record<string, unknown>;
}): Promise<string> {
  const id = randomUUID();
  const redacted = redactToolParameters(params.parameters);

  try {
    await withTenant(params.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tool_invocations
           (id, tenant_id, call_session_id, agent_id, agent_slug, tool_name, input, parameters_redacted, status, invoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running', NOW())`,
        [
          id,
          params.tenantId,
          params.callSessionId ?? null,
          params.agentId ?? null,
          params.agentSlug ?? null,
          params.toolName,
          JSON.stringify(redacted),
          JSON.stringify(redacted),
        ],
      );
    });
  } catch (err) {
    logger.error('Failed to create tool execution record', {
      tenantId: params.tenantId,
      toolName: params.toolName,
      error: String(err),
    });
  }

  return id;
}

export async function completeToolExecution(params: {
  tenantId: TenantId;
  executionId: string;
  result: unknown;
  status: 'success' | 'failed' | 'timeout';
  errorMessage?: string;
  recoveryAction?: string;
  durationMs: number;
}): Promise<void> {
  try {
    await withTenant(params.tenantId, async (client) => {
      await client.query(
        `UPDATE tool_invocations SET
           output = $3,
           result = $3,
           status = $4,
           error_message = $5,
           recovery_action = $6,
           duration_ms = $7,
           completed_at = NOW()
         WHERE id = $1 AND tenant_id = $2`,
        [
          params.executionId,
          params.tenantId,
          JSON.stringify(params.result ?? null),
          params.status,
          params.errorMessage ?? null,
          params.recoveryAction ?? null,
          params.durationMs,
        ],
      );
    });
    if (params.status === 'success') {
      import('../activation/ActivationService')
        .then(({ recordActivationEvent }) =>
          recordActivationEvent(params.tenantId, 'tenant_first_workflow_execution', {
            executionId: params.executionId,
          }),
        )
        .catch(() => {});
    }
  } catch (err) {
    logger.error('Failed to complete tool execution record', {
      tenantId: params.tenantId,
      executionId: params.executionId,
      error: String(err),
    });
  }
}

export async function getToolExecution(
  tenantId: string,
  executionId: string,
): Promise<ToolExecutionRecord | null> {
  return withTenant(tenantId, async (client) => {
    const { rows } = await client.query(
      `SELECT id, tenant_id, call_session_id, agent_id, agent_slug, tool_name,
              parameters_redacted, result, status, error_message, recovery_action,
              duration_ms, invoked_at, completed_at
       FROM tool_invocations
       WHERE id = $1 AND tenant_id = $2`,
      [executionId, tenantId],
    );

    if (rows.length === 0) return null;

    return mapRow(rows[0]);
  });
}

export async function listToolExecutions(
  filter: ToolExecutionFilter,
): Promise<{ executions: ToolExecutionRecord[]; total: number }> {
  return withTenant(filter.tenantId, async (client) => {
    const conditions = ['tenant_id = $1'];
    const values: unknown[] = [filter.tenantId];
    let idx = 2;

    if (filter.callSessionId) {
      conditions.push(`call_session_id = $${idx++}`);
      values.push(filter.callSessionId);
    }
    if (filter.agentId) {
      conditions.push(`(agent_id = $${idx} OR agent_slug = $${idx})`);
      values.push(filter.agentId);
      idx++;
    }
    if (filter.toolName) {
      conditions.push(`tool_name = $${idx++}`);
      values.push(filter.toolName);
    }
    if (filter.status) {
      conditions.push(`status = $${idx++}`);
      values.push(filter.status);
    }
    if (filter.startDate) {
      conditions.push(`invoked_at >= $${idx++}`);
      values.push(filter.startDate);
    }
    if (filter.endDate) {
      conditions.push(`invoked_at <= $${idx++}`);
      values.push(filter.endDate);
    }

    const where = conditions.join(' AND ');
    const limit = Math.min(filter.limit ?? 50, 200);
    const offset = filter.offset ?? 0;

    const countQuery = `SELECT COUNT(*) AS total FROM tool_invocations WHERE ${where}`;
    const { rows: countRows } = await client.query(countQuery, values);
    const total = parseInt(countRows[0].total as string, 10);

    const dataQuery = `SELECT id, tenant_id, call_session_id, agent_id, agent_slug, tool_name,
                              parameters_redacted, result, status, error_message, recovery_action,
                              duration_ms, invoked_at, completed_at
                       FROM tool_invocations
                       WHERE ${where}
                       ORDER BY invoked_at DESC
                       LIMIT $${idx} OFFSET $${idx + 1}`;
    values.push(limit, offset);

    const { rows } = await client.query(dataQuery, values);

    return {
      executions: rows.map(mapRow),
      total,
    };
  });
}

export async function getToolExecutionStats(
  tenantId: string,
  windowDays: number = 7,
): Promise<{
  totalExecutions: number;
  successCount: number;
  failureCount: number;
  avgDurationMs: number;
  topTools: Array<{ toolName: string; count: number; avgDuration: number }>;
  dailyBreakdown: Array<{ date: string; total: number; success: number; failed: number }>;
}> {
  return withTenant(tenantId, async (client) => {
    const { rows: summaryRows } = await client.query(
      `SELECT
         COUNT(*) AS total,
         COUNT(*) FILTER (WHERE status = 'success') AS success_count,
         COUNT(*) FILTER (WHERE status = 'failed') AS failure_count,
         COALESCE(AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 0) AS avg_duration
       FROM tool_invocations
       WHERE tenant_id = $1 AND invoked_at >= NOW() - ($2 || ' days')::interval`,
      [tenantId, windowDays],
    );

    const summary = summaryRows[0];

    const { rows: topToolRows } = await client.query(
      `SELECT tool_name,
              COUNT(*) AS cnt,
              COALESCE(AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 0) AS avg_dur
       FROM tool_invocations
       WHERE tenant_id = $1 AND invoked_at >= NOW() - ($2 || ' days')::interval
       GROUP BY tool_name
       ORDER BY cnt DESC
       LIMIT 10`,
      [tenantId, windowDays],
    );

    const { rows: dailyRows } = await client.query(
      `SELECT DATE(invoked_at)::text AS day,
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE status = 'success') AS success,
              COUNT(*) FILTER (WHERE status = 'failed') AS failed
       FROM tool_invocations
       WHERE tenant_id = $1 AND invoked_at >= NOW() - ($2 || ' days')::interval
       GROUP BY DATE(invoked_at)
       ORDER BY day`,
      [tenantId, windowDays],
    );

    return {
      totalExecutions: parseInt(summary.total as string, 10),
      successCount: parseInt(summary.success_count as string, 10),
      failureCount: parseInt(summary.failure_count as string, 10),
      avgDurationMs: Math.round(parseFloat(summary.avg_duration as string) || 0),
      topTools: topToolRows.map((r) => ({
        toolName: r.tool_name as string,
        count: parseInt(r.cnt as string, 10),
        avgDuration: Math.round(parseFloat(r.avg_dur as string) || 0),
      })),
      dailyBreakdown: dailyRows.map((r) => ({
        date: String(r.day),
        total: parseInt(r.total as string, 10),
        success: parseInt(r.success as string, 10),
        failed: parseInt(r.failed as string, 10),
      })),
    };
  });
}

function mapRow(row: Record<string, unknown>): ToolExecutionRecord {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    callSessionId: row.call_session_id as string | null,
    agentId: row.agent_id as string | null,
    agentSlug: row.agent_slug as string | null,
    toolName: row.tool_name as string,
    parameters: {},
    parametersRedacted: (row.parameters_redacted as Record<string, unknown>) ?? {},
    result: row.result,
    status: row.status as ToolExecutionRecord['status'],
    errorMessage: row.error_message as string | null,
    recoveryAction: row.recovery_action as string | null,
    durationMs: row.duration_ms as number | null,
    invokedAt: row.invoked_at instanceof Date ? row.invoked_at.toISOString() : String(row.invoked_at ?? ''),
    completedAt: row.completed_at ? (row.completed_at instanceof Date ? row.completed_at.toISOString() : String(row.completed_at)) : null,
  };
}
