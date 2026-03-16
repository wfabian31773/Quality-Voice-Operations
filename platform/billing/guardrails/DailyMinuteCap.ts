import { getPlatformPool, withTenantContext } from '../../db';
import { PLAN_RATE_LIMITS, TRIAL_RATE_LIMITS } from '../stripe/plans';
import type { PlanTier } from '../stripe/plans';
import { createLogger } from '../../core/logger';

const logger = createLogger('DAILY_MINUTE_CAP');

function getTodayBoundaries(): { start: Date; end: Date } {
  const now = new Date();
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { start, end };
}

export async function getDailyCallMinutes(tenantId: string): Promise<number> {
  const pool = getPlatformPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await withTenantContext(client, tenantId, async () => {});

    const { start } = getTodayBoundaries();

    const { rows } = await client.query(
      `SELECT COALESCE(SUM(quantity), 0) AS total
       FROM usage_metrics
       WHERE tenant_id = $1
         AND metric_type = 'ai_minutes'
         AND period_start >= $2`,
      [tenantId, start.toISOString()],
    );

    await client.query('COMMIT');
    return parseInt(rows[0]?.total as string, 10) || 0;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error('Failed to get daily call minutes', { tenantId, error: String(err) });
    return 0;
  } finally {
    client.release();
  }
}

export async function checkDailyMinuteCap(
  tenantId: string,
  plan: PlanTier | 'trial',
): Promise<{ allowed: boolean; reason?: string; minutesUsed: number; cap: number }> {
  const limits = plan === 'trial' ? TRIAL_RATE_LIMITS : PLAN_RATE_LIMITS[plan];
  const minutesUsed = await getDailyCallMinutes(tenantId);

  if (minutesUsed >= limits.dailyCallMinuteCap) {
    logger.warn('Daily call minute cap exceeded', { tenantId, plan, minutesUsed, cap: limits.dailyCallMinuteCap });
    return {
      allowed: false,
      reason: `Daily call minute cap reached (${minutesUsed}/${limits.dailyCallMinuteCap} minutes). Service resumes tomorrow or upgrade your plan for higher limits.`,
      minutesUsed,
      cap: limits.dailyCallMinuteCap,
    };
  }

  return { allowed: true, minutesUsed, cap: limits.dailyCallMinuteCap };
}
