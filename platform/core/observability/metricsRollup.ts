import { randomUUID } from 'crypto';
import { withPrivilegedClient, withTenantContext, getPlatformPool } from '../../db';
import { createLogger } from '../logger';

const logger = createLogger('METRICS_ROLLUP');

export async function runMetricsRollup(): Promise<void> {
  try {
    const rows = await withPrivilegedClient(async (client) => {
      const { rows } = await client.query(
        `SELECT
           cs.tenant_id,
           DATE(cs.created_at) AS day,
           COUNT(*)::int AS total_calls,
           COALESCE(AVG(cs.duration_seconds), 0) AS avg_duration
         FROM call_sessions cs
         WHERE cs.created_at >= NOW() - INTERVAL '2 days'
           AND cs.lifecycle_state = 'CALL_COMPLETED'
         GROUP BY cs.tenant_id, DATE(cs.created_at)`,
      );
      return rows;
    });

    const pool = getPlatformPool();

    for (const row of rows) {
      const tenantId = row.tenant_id as string;
      const day = String(row.day).slice(0, 10);
      const totalCalls = row.total_calls as number;
      const avgDuration = parseFloat(String(row.avg_duration));

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await withTenantContext(client, tenantId, async () => {
          await client.query(
            `DELETE FROM analytics_metrics
             WHERE tenant_id = $1
               AND metric_name = 'daily_call_volume'
               AND DATE(recorded_at) = $2::date`,
            [tenantId, day],
          );
          await client.query(
            `INSERT INTO analytics_metrics (id, tenant_id, metric_name, metric_value, dimensions, recorded_at)
             VALUES ($1, $2, 'daily_call_volume', $3, $4, $5::date)`,
            [
              randomUUID(),
              tenantId,
              totalCalls,
              JSON.stringify({ avgDuration, day }),
              day,
            ],
          );
        });
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        logger.error('Rollup upsert failed for tenant', { tenantId, day, error: String(err) });
      } finally {
        client.release();
      }
    }

    logger.info('Metrics rollup completed', { rowsProcessed: rows.length });
  } catch (err) {
    logger.error('Metrics rollup failed', { error: String(err) });
  }
}

let rollupTimer: ReturnType<typeof setInterval> | null = null;

export function startMetricsRollup(intervalMs = 3_600_000): void {
  if (rollupTimer) return;
  logger.info('Starting metrics rollup worker', { intervalMs });
  rollupTimer = setInterval(() => {
    runMetricsRollup().catch((err) => {
      logger.error('Rollup tick error', { error: String(err) });
    });
  }, intervalMs);
  runMetricsRollup().catch((err) => {
    logger.error('Initial rollup error', { error: String(err) });
  });
}

export function stopMetricsRollup(): void {
  if (rollupTimer) {
    clearInterval(rollupTimer);
    rollupTimer = null;
    logger.info('Metrics rollup worker stopped');
  }
}
