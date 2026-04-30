import { getPlatformPool, withTenantContext } from '../db';
import { createLogger } from '../core/logger';
import {
  CALL_FUNNEL_STAGE,
  CALL_FUNNEL_STAGES,
  type CallFunnelStage,
} from '../../shared/analytics/conversionStages';

const logger = createLogger('CONVERSION_FUNNEL');

// Funnel ordering matches `CALL_FUNNEL_STAGES` (which preserves the
// `CALL_FUNNEL_STAGE` insertion order). Re-exported with the legacy
// `FUNNEL_STAGES` / `FunnelStage` names so existing callers continue
// to work; the single source of truth for the values lives in
// `shared/analytics/conversionStages.ts`.
export const FUNNEL_STAGES = CALL_FUNNEL_STAGES;
export type FunnelStage = CallFunnelStage;

export interface FunnelMetrics {
  stages: Array<{
    stage: string;
    count: number;
    dropOffRate: number;
    conversionRate: number;
  }>;
  overallConversionRate: number;
  totalCalls: number;
}

export interface FunnelTrend {
  date: string;
  stages: Record<string, number>;
}

export async function recordConversionStage(
  tenantId: string,
  callSessionId: string,
  stage: FunnelStage,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await withTenantContext(client, tenantId, async () => {
      await client.query(
        `INSERT INTO call_conversion_stages (tenant_id, call_session_id, stage, metadata)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [tenantId, callSessionId, stage, JSON.stringify(metadata ?? {})],
      );
    });
    logger.info('Conversion stage recorded', { tenantId, callSessionId, stage });
  } catch (err) {
    logger.error('Failed to record conversion stage', { tenantId, callSessionId, stage, error: String(err) });
  } finally {
    client.release();
  }
}

export async function getConversionFunnel(
  tenantId: string,
  from: Date,
  to: Date,
): Promise<FunnelMetrics> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { rows: totalCallsRows } = await client.query(
      `SELECT COUNT(*)::int AS total
       FROM call_sessions
       WHERE tenant_id = $1
         AND created_at >= $2
         AND created_at < $3`,
      [tenantId, from, to],
    );
    const totalCalls = (totalCallsRows[0]?.total as number) ?? 0;

    const { rows: stageRows } = await client.query(
      `SELECT
         ccs.stage,
         COUNT(DISTINCT ccs.call_session_id)::int AS count
       FROM call_conversion_stages ccs
       JOIN call_sessions cs ON cs.id = ccs.call_session_id AND cs.tenant_id = ccs.tenant_id
       WHERE ccs.tenant_id = $1
         AND cs.created_at >= $2
         AND cs.created_at < $3
       GROUP BY ccs.stage`,
      [tenantId, from, to],
    );

    await client.query('COMMIT');

    const stageCounts = new Map<string, number>();
    for (const r of stageRows) {
      stageCounts.set(r.stage as string, (r.count as number) ?? 0);
    }

    stageCounts.set(CALL_FUNNEL_STAGE.CALL_RECEIVED, totalCalls);

    const stages = FUNNEL_STAGES.map((stage, idx) => {
      const rawCount = stageCounts.get(stage) ?? 0;
      const prevCount = idx === 0 ? totalCalls : (stageCounts.get(FUNNEL_STAGES[idx - 1]) ?? 0);
      const count = Math.min(rawCount, prevCount);
      const dropOffRate = prevCount > 0 ? Math.max(0, Math.min(1, 1 - (count / prevCount))) : 0;
      const conversionRate = totalCalls > 0 ? Math.max(0, Math.min(1, count / totalCalls)) : 0;
      return { stage, count, dropOffRate, conversionRate };
    });

    const lastStageCount = stageCounts.get(CALL_FUNNEL_STAGE.CONFIRMED) ?? 0;
    const overallConversionRate = totalCalls > 0 ? lastStageCount / totalCalls : 0;

    return { stages, overallConversionRate, totalCalls };
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Failed to get conversion funnel', { tenantId, error: String(err) });
    throw err;
  } finally {
    client.release();
  }
}

export async function getConversionTrends(
  tenantId: string,
  from: Date,
  to: Date,
): Promise<FunnelTrend[]> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    const rows = await withTenantContext(client, tenantId, async () => {
      const { rows } = await client.query(
        `SELECT
           DATE(cs.created_at) AS date,
           ccs.stage,
           COUNT(DISTINCT ccs.call_session_id)::int AS count
         FROM call_conversion_stages ccs
         JOIN call_sessions cs ON cs.id = ccs.call_session_id AND cs.tenant_id = ccs.tenant_id
         WHERE ccs.tenant_id = $1
           AND cs.created_at >= $2
           AND cs.created_at < $3
         GROUP BY DATE(cs.created_at), ccs.stage
         ORDER BY date`,
        [tenantId, from, to],
      );
      return rows;
    });

    const byDate = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const date = String(r.date).slice(0, 10);
      if (!byDate.has(date)) {
        byDate.set(date, {});
      }
      byDate.get(date)![r.stage as string] = (r.count as number) ?? 0;
    }

    return Array.from(byDate.entries()).map(([date, stages]) => ({ date, stages }));
  } catch (err) {
    logger.error('Failed to get conversion trends', { tenantId, error: String(err) });
    return [];
  } finally {
    client.release();
  }
}
