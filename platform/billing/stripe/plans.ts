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
  const priceId = process.env[key];
  if (!priceId) {
    throw new Error(`Missing Stripe price ID: environment variable ${key} is not set. Configure it in your environment before using billing.`);
  }
  return priceId;
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

  if (!process.env.STRIPE_SECRET_KEY || process.env.STRIPE_SECRET_KEY === 'sk_test_placeholder') {
    warnings.push('STRIPE_SECRET_KEY is not configured — billing operations will fail');
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET === 'whsec_placeholder') {
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
