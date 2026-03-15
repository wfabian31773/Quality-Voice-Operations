export type PlanTier = 'starter' | 'pro' | 'enterprise';

export interface PlanLimits {
  monthlyCallLimit: number;
  monthlySmsLimit: number;
  monthlyAiMinuteLimit: number;
  overageEnabled: boolean;
  maxAgents: number;
}

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

export function getPlanPriceId(tier: PlanTier, interval: 'monthly' | 'annual' = 'monthly'): string {
  const key = `STRIPE_PRICE_${tier.toUpperCase()}_${interval.toUpperCase()}`;
  return process.env[key] ?? `price_${tier}_${interval}_placeholder`;
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
