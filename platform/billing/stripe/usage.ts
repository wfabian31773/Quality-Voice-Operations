import { getStripeClient } from './client';
import { getPlatformPool } from '../../db';
import { createLogger } from '../../core/logger';

const logger = createLogger('STRIPE_USAGE');
const USAGE_INTERVAL_MS = 60 * 60 * 1000;

let _workerTimer: ReturnType<typeof setInterval> | null = null;

function getLastCompletedHourBucket(): { periodStart: Date; periodEnd: Date } {
  const now = new Date();
  const periodEnd = new Date(now);
  periodEnd.setUTCMinutes(0, 0, 0);
  const periodStart = new Date(periodEnd.getTime() - USAGE_INTERVAL_MS);
  return { periodStart, periodEnd };
}

export async function reportUsageForTenant(tenantId: string): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    const { periodStart, periodEnd } = getLastCompletedHourBucket();

    const { rows: subRows } = await client.query(
      `SELECT stripe_customer_id, stripe_subscription_id, plan FROM subscriptions
       WHERE tenant_id = $1 AND status = 'active' LIMIT 1`,
      [tenantId],
    );

    if (subRows.length === 0) return;

    const customerId = subRows[0].stripe_customer_id as string | null;
    if (!customerId) return;

    const { rows: usageRows } = await client.query(
      `SELECT
         COALESCE(SUM(CASE WHEN metric_type = 'ai_minutes' THEN quantity ELSE 0 END), 0) AS total_ai_minutes,
         COALESCE(SUM(CASE WHEN metric_type IN ('calls_inbound', 'calls_outbound') THEN quantity ELSE 0 END), 0) AS total_calls
       FROM usage_metrics
       WHERE tenant_id = $1
         AND period_start >= $2 AND period_end <= $3`,
      [tenantId, periodStart.toISOString(), periodEnd.toISOString()],
    );

    const totalAiMinutes = parseInt(usageRows[0]?.total_ai_minutes ?? '0', 10);
    const totalCalls = parseInt(usageRows[0]?.total_calls ?? '0', 10);
    if (totalAiMinutes <= 0 && totalCalls <= 0) return;

    const stripe = getStripeClient();
    const hourKey = periodStart.toISOString();
    const timestamp = Math.floor(periodEnd.getTime() / 1000);

    if (totalAiMinutes > 0) {
      const aiMeterEvent = process.env.STRIPE_METER_EVENT_AI_MINUTES ?? 'ai_minutes';
      await stripe.billing.meterEvents.create({
        event_name: aiMeterEvent,
        payload: {
          stripe_customer_id: customerId,
          value: String(totalAiMinutes),
        },
        timestamp,
      }, {
        idempotencyKey: `ai_${tenantId}_${hourKey}`,
      });
    }

    if (totalCalls > 0) {
      const callMeterEvent = process.env.STRIPE_METER_EVENT_CALLS ?? 'calls';
      await stripe.billing.meterEvents.create({
        event_name: callMeterEvent,
        payload: {
          stripe_customer_id: customerId,
          value: String(totalCalls),
        },
        timestamp,
      }, {
        idempotencyKey: `calls_${tenantId}_${hourKey}`,
      });
    }

    logger.info('Usage reported to Stripe', {
      tenantId,
      aiMinutes: totalAiMinutes,
      calls: totalCalls,
      hourBucket: hourKey,
    });
  } catch (err) {
    logger.error('Usage reporting failed', { tenantId, error: String(err) });
  } finally {
    client.release();
  }
}

export async function reportUsageForAllTenants(): Promise<void> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    const { rows } = await client.query(
      `SELECT DISTINCT tenant_id FROM subscriptions WHERE status = 'active'`,
    );

    for (const row of rows) {
      try {
        await reportUsageForTenant(row.tenant_id as string);
      } catch (err) {
        logger.error('Per-tenant usage report failed', { tenantId: row.tenant_id, error: String(err) });
      }
    }
  } finally {
    client.release();
  }
}

export function startUsageMeteringWorker(): void {
  if (_workerTimer) return;
  _workerTimer = setInterval(() => {
    reportUsageForAllTenants().catch((err) => {
      logger.error('Usage metering worker error', { error: String(err) });
    });
  }, USAGE_INTERVAL_MS);
  logger.info(`Usage metering worker started (${USAGE_INTERVAL_MS / 60_000}min interval)`);
}

export function stopUsageMeteringWorker(): void {
  if (_workerTimer) {
    clearInterval(_workerTimer);
    _workerTimer = null;
  }
}
