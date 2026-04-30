import Stripe from 'stripe';
import { PLAN_TIERS, PLAN_CATALOG, type PlanTier } from '../../../shared/billing/planCatalog';

export type PriceInterval = 'monthly' | 'annual';

export type PriceCheckStatus =
  | 'ok'
  | 'missing-env'
  | 'stripe-error'
  | 'wrong-interval'
  | 'no-amount';

export interface PriceCheckResult {
  envKey: string;
  plan: PlanTier;
  interval: PriceInterval;
  status: PriceCheckStatus;
  priceId: string | null;
  expectedInterval: 'month' | 'year';
  actualInterval: string | null;
  unitAmountCents: number | null;
  monthlyEquivalentCents: number | null;
  catalogMonthlyCents: number;
  message?: string;
}

export interface VerifyStripePricesSummary {
  total: number;
  ok: number;
  failed: number;
  status: 'ok' | 'failed' | 'no-stripe-key';
  message?: string;
}

export interface VerifyStripePricesReport {
  summary: VerifyStripePricesSummary;
  results: PriceCheckResult[];
  generatedAt: string;
}

function envKeyFor(plan: PlanTier, interval: PriceInterval): string {
  return `STRIPE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`;
}

function expectedIntervalFor(interval: PriceInterval): 'month' | 'year' {
  return interval === 'monthly' ? 'month' : 'year';
}

async function checkOne(
  stripe: Stripe,
  plan: PlanTier,
  interval: PriceInterval,
): Promise<PriceCheckResult> {
  const envKey = envKeyFor(plan, interval);
  const priceId = process.env[envKey] ?? null;
  const expectedInterval = expectedIntervalFor(interval);
  const catalogMonthlyCents = PLAN_CATALOG[plan].monthlyPriceCents;

  const base: PriceCheckResult = {
    envKey,
    plan,
    interval,
    status: 'ok',
    priceId,
    expectedInterval,
    actualInterval: null,
    unitAmountCents: null,
    monthlyEquivalentCents: null,
    catalogMonthlyCents,
  };

  if (!priceId) {
    return { ...base, status: 'missing-env', message: `${envKey} is not set` };
  }

  try {
    const price = await stripe.prices.retrieve(priceId);
    const actualInterval = price.recurring?.interval ?? null;
    const intervalCount = price.recurring?.interval_count ?? 1;
    const rawCents = price.unit_amount ?? null;

    const result: PriceCheckResult = {
      ...base,
      actualInterval,
      unitAmountCents: rawCents,
    };

    if (actualInterval !== expectedInterval) {
      return {
        ...result,
        status: 'wrong-interval',
        message: `Price ${priceId} has recurring.interval=${actualInterval}, expected ${expectedInterval}`,
      };
    }

    if (rawCents == null) {
      return {
        ...result,
        status: 'no-amount',
        message: `Price ${priceId} has no unit_amount (tiered or missing)`,
      };
    }

    const monthlyEquivalentCents =
      expectedInterval === 'month'
        ? Math.round(rawCents / Math.max(1, intervalCount))
        : Math.round(rawCents / (12 * Math.max(1, intervalCount)));

    return { ...result, monthlyEquivalentCents };
  } catch (err) {
    return {
      ...base,
      status: 'stripe-error',
      message: `Stripe error retrieving ${priceId}: ${(err as Error).message}`,
    };
  }
}

/**
 * Verify every `STRIPE_PRICE_<TIER>_<INTERVAL>` env var resolves to a Stripe
 * price with the expected `recurring.interval`. Used both by the CLI
 * (`scripts/verify-stripe-prices.ts`, which the deploy build runs as a gate)
 * and by the in-app "Billing config health" admin tile so ops can re-run the
 * same check without redeploying. When `STRIPE_SECRET_KEY` is not set the
 * verifier short-circuits with a `no-stripe-key` summary instead of throwing
 * — that lets the admin tile render a clear "not configured" state in dev.
 */
export async function verifyStripePrices(options?: {
  apiKey?: string;
}): Promise<VerifyStripePricesReport> {
  const apiKey = options?.apiKey ?? process.env.STRIPE_SECRET_KEY;
  const generatedAt = new Date().toISOString();

  if (!apiKey) {
    return {
      summary: {
        total: 0,
        ok: 0,
        failed: 0,
        status: 'no-stripe-key',
        message: 'STRIPE_SECRET_KEY is not set — cannot verify prices.',
      },
      results: [],
      generatedAt,
    };
  }

  const stripe = new Stripe(apiKey, { apiVersion: '2026-02-25.clover' as const });

  const tasks: Array<Promise<PriceCheckResult>> = [];
  for (const plan of PLAN_TIERS) {
    tasks.push(checkOne(stripe, plan, 'monthly'));
    tasks.push(checkOne(stripe, plan, 'annual'));
  }
  const results = await Promise.all(tasks);

  const failed = results.filter((r) => r.status !== 'ok').length;
  const ok = results.length - failed;

  return {
    summary: {
      total: results.length,
      ok,
      failed,
      status: failed === 0 ? 'ok' : 'failed',
      message:
        failed === 0
          ? `All ${results.length} STRIPE_PRICE_<TIER>_<INTERVAL> env vars verified.`
          : `${failed} of ${results.length} checks failed.`,
    },
    results,
    generatedAt,
  };
}

export function formatUsdCents(cents: number | null): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}
