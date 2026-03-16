import { PLAN_RATE_LIMITS, TRIAL_RATE_LIMITS } from '../stripe/plans';
import type { PlanTier } from '../stripe/plans';
import { createLogger } from '../../core/logger';

const logger = createLogger('HOURLY_RATE_LIMITER');

interface HourlyBucket {
  count: number;
  resetAt: number;
}

const tenantBuckets = new Map<string, HourlyBucket>();

function getBucket(tenantId: string): HourlyBucket {
  const now = Date.now();
  const existing = tenantBuckets.get(tenantId);

  if (existing && existing.resetAt > now) {
    return existing;
  }

  const bucket: HourlyBucket = {
    count: 0,
    resetAt: now + 60 * 60 * 1000,
  };
  tenantBuckets.set(tenantId, bucket);
  return bucket;
}

export function checkHourlyCallLimit(
  tenantId: string,
  plan: PlanTier | 'trial',
): { allowed: boolean; reason?: string; remaining: number } {
  const limits = plan === 'trial' ? TRIAL_RATE_LIMITS : PLAN_RATE_LIMITS[plan];
  const bucket = getBucket(tenantId);
  const remaining = Math.max(0, limits.hourlyCallLimit - bucket.count);

  if (bucket.count >= limits.hourlyCallLimit) {
    const resetInMin = Math.ceil((bucket.resetAt - Date.now()) / 60_000);
    logger.warn('Hourly call rate limit exceeded', { tenantId, plan, count: bucket.count, limit: limits.hourlyCallLimit });
    return {
      allowed: false,
      reason: `Hourly call limit reached (${bucket.count}/${limits.hourlyCallLimit}). Try again in ~${resetInMin} minutes or upgrade your plan.`,
      remaining: 0,
    };
  }

  return { allowed: true, remaining };
}

export function incrementHourlyCallCount(tenantId: string): void {
  const bucket = getBucket(tenantId);
  bucket.count++;
}

export function getHourlyCallCount(tenantId: string): number {
  const bucket = getBucket(tenantId);
  return bucket.count;
}

setInterval(() => {
  const now = Date.now();
  for (const [tenantId, bucket] of tenantBuckets) {
    if (bucket.resetAt <= now) {
      tenantBuckets.delete(tenantId);
    }
  }
}, 5 * 60 * 1000);
