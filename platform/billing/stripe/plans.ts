export type { PlanTier } from '../../../shared/billing/planCatalog';
export { PLAN_MONTHLY_PRICE_CENTS } from '../../../shared/billing/planCatalog';
import type { PlanTier } from '../../../shared/billing/planCatalog';

export type SubscriptionState = 'trialing' | 'active' | 'past_due' | 'paused' | 'cancelled';

export interface PlanLimits {
  monthlyCallLimit: number;
  monthlySmsLimit: number;
  monthlyAiMinuteLimit: number;
  overageEnabled: boolean;
  maxAgents: number;
}

export interface TrialLimits {
  durationDays: number;
  maxTotalCalls: number;
  maxCallDurationMs: number;
  maxAgents: number;
  maxToolExecutions: number;
}

export interface RateLimits {
  hourlyCallLimit: number;
  dailyCallMinuteCap: number;
}

export const TRIAL_LIMITS: TrialLimits = {
  durationDays: 7,
  maxTotalCalls: 20,
  maxCallDurationMs: 3 * 60 * 1000,
  maxAgents: 2,
  maxToolExecutions: 10,
};

export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  starter: {
    monthlyCallLimit: 500,
    monthlySmsLimit: 1_000,
    monthlyAiMinuteLimit: 250,
    overageEnabled: false,
    maxAgents: 2,
  },
  pro: {
    monthlyCallLimit: 5_000,
    monthlySmsLimit: 10_000,
    monthlyAiMinuteLimit: 2_500,
    overageEnabled: true,
    maxAgents: 10,
  },
  enterprise: {
    monthlyCallLimit: 999_999,
    monthlySmsLimit: 999_999,
    monthlyAiMinuteLimit: 999_999,
    overageEnabled: true,
    maxAgents: 999,
  },
};

export const PLAN_RATE_LIMITS: Record<PlanTier, RateLimits> = {
  starter: {
    hourlyCallLimit: 10,
    dailyCallMinuteCap: 60,
  },
  pro: {
    hourlyCallLimit: 50,
    dailyCallMinuteCap: 500,
  },
  enterprise: {
    hourlyCallLimit: 999_999,
    dailyCallMinuteCap: 999_999,
  },
};

export const TRIAL_RATE_LIMITS: RateLimits = {
  hourlyCallLimit: 5,
  dailyCallMinuteCap: 15,
};

export function getPlanPriceId(tier: PlanTier, interval: 'monthly' | 'annual' = 'monthly'): string {
  const key = `STRIPE_PRICE_${tier.toUpperCase()}_${interval.toUpperCase()}`;
  const priceId = process.env[key];
  if (!priceId) {
    throw new Error(`Missing Stripe price ID: environment variable ${key} is not set. Configure it in your environment before using billing.`);
  }
  return priceId;
}

/**
 * Resolve the env var name that holds the metered (per-minute) AI-minutes
 * Stripe price id for a given tier. Kept as a thin helper so callers stay
 * consistent with the convention used by `getPlanPriceId` for the licensed
 * monthly/annual base prices:
 *
 *   STRIPE_PRICE_<TIER>_AI_MINUTES   e.g. `STRIPE_PRICE_PRO_AI_MINUTES`
 *
 * The value is a Stripe metered Price id (`price_…`) created against the
 * tier's metered Product. When unset, the upgrade preview falls back to
 * `PLAN_CATALOG[tier].overageRatePerMinute` for the overage quote.
 */
export function getPlanAiMinutesPriceEnvKey(tier: PlanTier): string {
  return `STRIPE_PRICE_${tier.toUpperCase()}_AI_MINUTES`;
}

/**
 * Read the metered AI-minutes Stripe price id for a tier, or `null` when
 * the env var is unset. Unlike `getPlanPriceId`, this is intentionally
 * non-throwing: the metered price is an *upgrade* over the catalog default
 * for the upgrade-preview overage quote, so a missing value is a soft fall
 * back rather than a hard failure.
 */
export function getPlanAiMinutesPriceId(tier: PlanTier): string | null {
  return process.env[getPlanAiMinutesPriceEnvKey(tier)] ?? null;
}

export function validateBillingConfig(): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const tiers: PlanTier[] = ['starter', 'pro', 'enterprise'];
  const intervals = ['MONTHLY', 'ANNUAL'];

  for (const tier of tiers) {
    for (const interval of intervals) {
      const key = `STRIPE_PRICE_${tier.toUpperCase()}_${interval}`;
      if (!process.env[key]) {
        warnings.push(`${key} is not set — ${tier} ${interval.toLowerCase()} plan checkout will fail`);
      }
    }
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    warnings.push('STRIPE_SECRET_KEY is not configured — billing operations will fail');
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    warnings.push('STRIPE_WEBHOOK_SECRET is not configured — webhook verification will fail');
  }

  return { valid: warnings.length === 0, warnings };
}

const PRICE_ID_TO_PLAN: Map<string, PlanTier> = new Map();

function ensurePriceMap(): void {
  if (PRICE_ID_TO_PLAN.size > 0) return;
  const tiers: PlanTier[] = ['starter', 'pro', 'enterprise'];
  const intervals = ['MONTHLY', 'ANNUAL'];
  for (const tier of tiers) {
    for (const interval of intervals) {
      const envKey = `STRIPE_PRICE_${tier.toUpperCase()}_${interval}`;
      const priceId = process.env[envKey];
      if (priceId) {
        PRICE_ID_TO_PLAN.set(priceId, tier);
      }
    }
  }
}

export function getPlanFromPriceId(priceId: string): PlanTier {
  ensurePriceMap();
  const mapped = PRICE_ID_TO_PLAN.get(priceId);
  if (mapped) return mapped;

  for (const [envPriceId, tier] of PRICE_ID_TO_PLAN.entries()) {
    if (priceId === envPriceId) return tier;
  }

  return 'starter';
}
