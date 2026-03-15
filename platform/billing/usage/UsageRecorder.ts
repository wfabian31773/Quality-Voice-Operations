import { getPlatformPool, withTenantContext } from '../../db';
import { createLogger } from '../../core/logger';

const logger = createLogger('USAGE_RECORDER');

function getHourBucket(now: Date = new Date()): { periodStart: Date; periodEnd: Date } {
  const periodStart = new Date(now);
  periodStart.setUTCMinutes(0, 0, 0);
  const periodEnd = new Date(periodStart.getTime() + 60 * 60 * 1000);
  return { periodStart, periodEnd };
}

export interface CallCostEstimate {
  totalCostCents: number;
  twilioCostCents: number;
  aiCostCents: number;
}

const TWILIO_PER_MINUTE_CENTS = parseInt(process.env.TWILIO_COST_PER_MINUTE_CENTS ?? '2', 10);
const AI_PER_MINUTE_CENTS = parseInt(process.env.AI_COST_PER_MINUTE_CENTS ?? '6', 10);

export function estimateCallCost(durationSeconds: number): CallCostEstimate {
  const minutes = Math.ceil(durationSeconds / 60);
  const twilioCostCents = minutes * TWILIO_PER_MINUTE_CENTS;
  const aiCostCents = minutes * AI_PER_MINUTE_CENTS;
  return {
    totalCostCents: twilioCostCents + aiCostCents,
    twilioCostCents,
    aiCostCents,
  };
}

export async function recordCallUsage(
  tenantId: string,
  direction: 'inbound' | 'outbound',
  durationSeconds: number,
  aiMinutes?: number,
): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { periodStart, periodEnd } = getHourBucket();
    const metricType = direction === 'inbound' ? 'calls_inbound' : 'calls_outbound';
    const callMinutes = Math.ceil(durationSeconds / 60);
    const estimatedAiMinutes = aiMinutes ?? callMinutes;
    const costEstimate = estimateCallCost(durationSeconds);

    const callCostCents = costEstimate.twilioCostCents;

    await client.query(
      `INSERT INTO usage_metrics (id, tenant_id, metric_type, period_start, period_end, quantity, unit_cost_cents, total_cost_cents)
       VALUES (gen_random_uuid(), $1, $2::usage_metric_type, $3, $4, 1, $5, $5)
       ON CONFLICT (tenant_id, metric_type, period_start)
       DO UPDATE SET
         quantity = usage_metrics.quantity + 1,
         total_cost_cents = COALESCE(usage_metrics.total_cost_cents, 0) + EXCLUDED.total_cost_cents,
         updated_at = NOW()`,
      [tenantId, metricType, periodStart.toISOString(), periodEnd.toISOString(), callCostCents],
    );

    if (estimatedAiMinutes > 0) {
      await client.query(
        `INSERT INTO usage_metrics (id, tenant_id, metric_type, period_start, period_end, quantity, unit_cost_cents, total_cost_cents)
         VALUES (gen_random_uuid(), $1, 'ai_minutes'::usage_metric_type, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, metric_type, period_start)
         DO UPDATE SET
           quantity = usage_metrics.quantity + EXCLUDED.quantity,
           total_cost_cents = COALESCE(usage_metrics.total_cost_cents, 0) + EXCLUDED.total_cost_cents,
           updated_at = NOW()`,
        [tenantId, periodStart.toISOString(), periodEnd.toISOString(),
         estimatedAiMinutes, AI_PER_MINUTE_CENTS, estimatedAiMinutes * AI_PER_MINUTE_CENTS],
      );
    }

    await client.query('COMMIT');

    logger.info('Call usage recorded', {
      tenantId,
      direction,
      durationSeconds,
      aiMinutes: estimatedAiMinutes,
      metricType,
      hourBucket: periodStart.toISOString(),
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to record call usage', { tenantId, direction, error: String(err) });
  } finally {
    client.release();
  }
}

export async function recordSmsUsage(
  tenantId: string,
  count: number = 1,
): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { periodStart, periodEnd } = getHourBucket();
    const perSmsCents = parseInt(process.env.SMS_COST_PER_MESSAGE_CENTS ?? '1', 10);

    await client.query(
      `INSERT INTO usage_metrics (id, tenant_id, metric_type, period_start, period_end, quantity, unit_cost_cents, total_cost_cents)
       VALUES (gen_random_uuid(), $1, 'sms_sent'::usage_metric_type, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, metric_type, period_start)
       DO UPDATE SET
         quantity = usage_metrics.quantity + EXCLUDED.quantity,
         total_cost_cents = COALESCE(usage_metrics.total_cost_cents, 0) + EXCLUDED.total_cost_cents,
         updated_at = NOW()`,
      [tenantId, periodStart.toISOString(), periodEnd.toISOString(),
       count, perSmsCents, count * perSmsCents],
    );

    await client.query('COMMIT');

    logger.info('SMS usage recorded', { tenantId, count, hourBucket: periodStart.toISOString() });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to record SMS usage', { tenantId, error: String(err) });
  } finally {
    client.release();
  }
}
