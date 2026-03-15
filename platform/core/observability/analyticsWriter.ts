import { randomUUID } from 'crypto';
import { getPlatformPool, withTenantContext } from '../../db';
import { createLogger } from '../logger';

const logger = createLogger('ANALYTICS_WRITER');

export async function writeCallMetric(
  tenantId: string,
  durationSeconds: number,
  dimensions: {
    outcome?: string;
    agentId?: string;
    campaignId?: string;
    callSessionId?: string;
  } = {},
): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {
      await client.query(
        `INSERT INTO analytics_metrics (id, tenant_id, metric_name, metric_value, dimensions)
         VALUES ($1, $2, 'call_completed', $3, $4)`,
        [randomUUID(), tenantId, durationSeconds, JSON.stringify(dimensions)],
      );
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to write call metric', { tenantId, error: String(err) });
  } finally {
    client.release();
  }
}

export interface MetricsSummary {
  totalCalls: number;
  avgDurationSeconds: number;
  errorCount: number;
  errorRate: number;
  dailyBreakdown: Array<{
    date: string;
    calls: number;
    avgDuration: number;
    errors: number;
  }>;
}

export async function getTenantMetrics(
  tenantId: string,
  windowDays: number,
): Promise<MetricsSummary> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: summaryRows } = await client.query(
      `SELECT
         COUNT(*)::int AS total_calls,
         COALESCE(AVG(metric_value), 0) AS avg_duration
       FROM analytics_metrics
       WHERE tenant_id = $1
         AND metric_name = 'call_completed'
         AND recorded_at >= NOW() - MAKE_INTERVAL(days => $2)`,
      [tenantId, windowDays],
    );

    const { rows: errorRows } = await client.query(
      `SELECT COUNT(*)::int AS error_count
       FROM error_logs
       WHERE tenant_id = $1
         AND occurred_at >= NOW() - MAKE_INTERVAL(days => $2)`,
      [tenantId, windowDays],
    );

    const { rows: dailyRows } = await client.query(
      `SELECT
         DATE(recorded_at) AS day,
         COUNT(*)::int AS calls,
         COALESCE(AVG(metric_value), 0) AS avg_duration
       FROM analytics_metrics
       WHERE tenant_id = $1
         AND metric_name = 'call_completed'
         AND recorded_at >= NOW() - MAKE_INTERVAL(days => $2)
       GROUP BY DATE(recorded_at)
       ORDER BY day`,
      [tenantId, windowDays],
    );

    const { rows: dailyErrorRows } = await client.query(
      `SELECT
         DATE(occurred_at) AS day,
         COUNT(*)::int AS errors
       FROM error_logs
       WHERE tenant_id = $1
         AND occurred_at >= NOW() - MAKE_INTERVAL(days => $2)
       GROUP BY DATE(occurred_at)`,
      [tenantId, windowDays],
    );

    await client.query('COMMIT');

    const totalCalls = (summaryRows[0]?.total_calls as number) ?? 0;
    const avgDurationSeconds = parseFloat(String(summaryRows[0]?.avg_duration ?? 0));
    const errorCount = (errorRows[0]?.error_count as number) ?? 0;
    const errorRate = totalCalls > 0 ? errorCount / totalCalls : 0;

    const errorsByDay = new Map<string, number>();
    for (const row of dailyErrorRows) {
      errorsByDay.set(String(row.day).slice(0, 10), row.errors as number);
    }

    const dailyBreakdown = dailyRows.map((row) => ({
      date: String(row.day).slice(0, 10),
      calls: row.calls as number,
      avgDuration: parseFloat(String(row.avg_duration)),
      errors: errorsByDay.get(String(row.day).slice(0, 10)) ?? 0,
    }));

    return { totalCalls, avgDurationSeconds, errorCount, errorRate, dailyBreakdown };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
