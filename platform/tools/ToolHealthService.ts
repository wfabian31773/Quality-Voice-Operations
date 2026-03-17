import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import { onToolFailure, type ToolFailureEvent } from './RetryOrchestrator';
import type { TenantId } from '../core/types';

const logger = createLogger('TOOL_HEALTH_SERVICE');

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

export async function recordToolFailureEvent(event: ToolFailureEvent): Promise<void> {
  try {
    await withTenant(event.tenantId, async (client) => {
      await client.query(
        `INSERT INTO tool_failure_events (
          tenant_id, tool_name, call_session_id, agent_slug, error,
          retry_count, max_retries, final_failure, fallback_attempted, fallback_success
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          event.tenantId, event.toolName, event.callSessionId, event.agentSlug ?? null,
          event.error.substring(0, 1000), event.retryCount, event.maxRetries,
          event.finalFailure, event.fallbackAttempted, event.fallbackSuccess,
        ],
      );
    });
  } catch (err) {
    logger.error('Failed to record tool failure event', { error: String(err) });
  }
}

export interface ToolHealthMetrics {
  toolName: string;
  totalExecutions: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  retryCount: number;
  avgDurationMs: number;
  recentFailures: Array<{
    id: string;
    error: string;
    callSessionId: string;
    retryCount: number;
    fallbackAttempted: boolean;
    fallbackSuccess: boolean;
    createdAt: string;
  }>;
}

export async function getToolHealthMetrics(
  tenantId: string,
  windowDays: number = 7,
): Promise<{
  tools: ToolHealthMetrics[];
  overallSuccessRate: number;
  totalExecutions: number;
  totalFailures: number;
  callCompletionRate: number;
}> {
  return withTenant(tenantId, async (client) => {
    const { rows: toolRows } = await client.query(
      `SELECT
        tool_name,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'success')::int AS success_count,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failure_count,
        COALESCE(AVG(duration_ms) FILTER (WHERE duration_ms IS NOT NULL), 0) AS avg_duration
       FROM tool_invocations
       WHERE tenant_id = $1 AND invoked_at >= NOW() - ($2 || ' days')::interval
       GROUP BY tool_name
       ORDER BY total DESC`,
      [tenantId, windowDays],
    );

    const { rows: retryRows } = await client.query(
      `SELECT tool_name, COUNT(*)::int AS total_retries
       FROM tool_failure_events
       WHERE tenant_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval
         AND final_failure = false
       GROUP BY tool_name`,
      [tenantId, windowDays],
    );
    const retryMap = new Map<string, number>();
    for (const r of retryRows) {
      retryMap.set(r.tool_name as string, r.total_retries as number);
    }

    const { rows: failureRows } = await client.query(
      `SELECT id, tool_name, error, call_session_id, retry_count,
              fallback_attempted, fallback_success, created_at
       FROM tool_failure_events
       WHERE tenant_id = $1 AND final_failure = true AND created_at >= NOW() - ($2 || ' days')::interval
       ORDER BY created_at DESC
       LIMIT 50`,
      [tenantId, windowDays],
    );

    const failuresByTool = new Map<string, typeof failureRows>();
    for (const f of failureRows) {
      const name = f.tool_name as string;
      if (!failuresByTool.has(name)) failuresByTool.set(name, []);
      failuresByTool.get(name)!.push(f);
    }

    let totalExec = 0;
    let totalFail = 0;

    const tools: ToolHealthMetrics[] = toolRows.map((row) => {
      const name = row.tool_name as string;
      const total = row.total as number;
      const successCount = row.success_count as number;
      const failureCount = row.failure_count as number;
      totalExec += total;
      totalFail += failureCount;

      const recentFailures = (failuresByTool.get(name) ?? []).slice(0, 5).map((f) => ({
        id: f.id as string,
        error: (f.error as string) ?? '',
        callSessionId: f.call_session_id as string,
        retryCount: f.retry_count as number,
        fallbackAttempted: Boolean(f.fallback_attempted),
        fallbackSuccess: Boolean(f.fallback_success),
        createdAt: f.created_at instanceof Date ? f.created_at.toISOString() : String(f.created_at),
      }));

      return {
        toolName: name,
        totalExecutions: total,
        successCount,
        failureCount,
        successRate: total > 0 ? Math.round((successCount / total) * 10000) / 100 : 100,
        retryCount: retryMap.get(name) ?? 0,
        avgDurationMs: Math.round(parseFloat(String(row.avg_duration)) || 0),
        recentFailures,
      };
    });

    const { rows: callRows } = await client.query(
      `SELECT
        COUNT(*)::int AS total_calls,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_calls
       FROM call_logs
       WHERE tenant_id = $1 AND created_at >= NOW() - ($2 || ' days')::interval`,
      [tenantId, windowDays],
    );

    const totalCalls = (callRows[0]?.total_calls as number) ?? 0;
    const completedCalls = (callRows[0]?.completed_calls as number) ?? 0;
    const callCompletionRate = totalCalls > 0 ? Math.round((completedCalls / totalCalls) * 10000) / 100 : 100;

    return {
      tools,
      overallSuccessRate: totalExec > 0 ? Math.round(((totalExec - totalFail) / totalExec) * 10000) / 100 : 100,
      totalExecutions: totalExec,
      totalFailures: totalFail,
      callCompletionRate,
    };
  });
}

let trackingInitialized = false;

export function initToolHealthTracking(): void {
  if (trackingInitialized) return;
  onToolFailure((event) => {
    recordToolFailureEvent(event).catch(() => {});
  });
  trackingInitialized = true;
  logger.info('Tool health tracking initialized');
}
