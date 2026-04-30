import Stripe from 'stripe';
import {
  PLAN_TIERS,
  PLAN_CATALOG,
  type PlanTier,
} from '../../../shared/billing/planCatalog';
import { getPlanAiMinutesPriceEnvKey } from './plans';

export type PriceInterval = 'monthly' | 'annual';

export type PriceCheckKind = 'base' | 'metered-ai-minutes';

export type PriceCheckStatus =
  | 'ok'
  | 'missing-env'
  | 'stripe-error'
  | 'wrong-interval'
  | 'no-amount'
  | 'wrong-usage-type'
  | 'wrong-meter';

export interface PriceCheckResult {
  envKey: string;
  plan: PlanTier;
  kind: PriceCheckKind;
  interval: PriceInterval | null;
  status: PriceCheckStatus;
  priceId: string | null;
  expectedInterval: 'month' | 'year' | null;
  actualInterval: string | null;
  expectedUsageType: 'licensed' | 'metered';
  actualUsageType: string | null;
  expectedMeter: string | null;
  actualMeter: string | null;
  unitAmountCents: number | null;
  unitAmountDecimal: string | null;
  monthlyEquivalentCents: number | null;
  catalogMonthlyCents: number | null;
  catalogOverageRatePerMinute: number | null;
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

async function checkBase(
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
    kind: 'base',
    interval,
    status: 'ok',
    priceId,
    expectedInterval,
    actualInterval: null,
    expectedUsageType: 'licensed',
    actualUsageType: null,
    expectedMeter: null,
    actualMeter: null,
    unitAmountCents: null,
    unitAmountDecimal: null,
    monthlyEquivalentCents: null,
    catalogMonthlyCents,
    catalogOverageRatePerMinute: null,
  };

  if (!priceId) {
    return { ...base, status: 'missing-env', message: `${envKey} is not set` };
  }

  try {
    const price = await stripe.prices.retrieve(priceId);
    const actualInterval = price.recurring?.interval ?? null;
    const intervalCount = price.recurring?.interval_count ?? 1;
    const rawCents = price.unit_amount ?? null;
    const actualUsageType = price.recurring?.usage_type ?? null;
    const actualMeter = price.recurring?.meter ?? null;

    const result: PriceCheckResult = {
      ...base,
      actualInterval,
      actualUsageType,
      actualMeter,
      unitAmountCents: rawCents,
      unitAmountDecimal: price.unit_amount_decimal ?? null,
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

async function checkMeteredAiMinutes(
  stripe: Stripe,
  plan: PlanTier,
  expectedMeter: string | null,
): Promise<PriceCheckResult> {
  const envKey = getPlanAiMinutesPriceEnvKey(plan);
  const priceId = process.env[envKey] ?? null;
  const catalogOverageRatePerMinute = PLAN_CATALOG[plan].overageRatePerMinute;

  const base: PriceCheckResult = {
    envKey,
    plan,
    kind: 'metered-ai-minutes',
    interval: null,
    status: 'ok',
    priceId,
    expectedInterval: null,
    actualInterval: null,
    expectedUsageType: 'metered',
    actualUsageType: null,
    expectedMeter,
    actualMeter: null,
    unitAmountCents: null,
    unitAmountDecimal: null,
    monthlyEquivalentCents: null,
    catalogMonthlyCents: null,
    catalogOverageRatePerMinute,
  };

  if (!expectedMeter) {
    return {
      ...base,
      status: 'missing-env',
      message: `STRIPE_METER_AI_MINUTES is not set — required when STRIPE_METER_EVENT_AI_MINUTES is set so the verifier can match each metered price's recurring.meter (Stripe stores the meter id, not the event name)`,
    };
  }

  if (!priceId) {
    return {
      ...base,
      status: 'missing-env',
      message: `${envKey} is not set — set it once the metered AI-minutes price exists in Stripe, or unset STRIPE_METER_EVENT_AI_MINUTES if this deployment has not opted in yet`,
    };
  }

  try {
    const price = await stripe.prices.retrieve(priceId);
    const actualInterval = price.recurring?.interval ?? null;
    const actualUsageType = price.recurring?.usage_type ?? null;
    const actualMeter = price.recurring?.meter ?? null;
    const rawCents = price.unit_amount ?? null;

    const result: PriceCheckResult = {
      ...base,
      actualInterval,
      actualUsageType,
      actualMeter,
      unitAmountCents: rawCents,
      unitAmountDecimal: price.unit_amount_decimal ?? null,
    };

    if (actualUsageType !== 'metered') {
      return {
        ...result,
        status: 'wrong-usage-type',
        message: `Price ${priceId} has recurring.usage_type=${actualUsageType ?? '(unset)'}, expected metered`,
      };
    }

    if (actualMeter !== expectedMeter) {
      return {
        ...result,
        status: 'wrong-meter',
        message: `Price ${priceId} has recurring.meter=${actualMeter ?? '(unset)'}, expected ${expectedMeter} (STRIPE_METER_AI_MINUTES)`,
      };
    }

    if (rawCents == null && (price.unit_amount_decimal ?? null) == null) {
      return {
        ...result,
        status: 'no-amount',
        message: `Price ${priceId} has no unit_amount or unit_amount_decimal (tiered or missing)`,
      };
    }

    return result;
  } catch (err) {
    return {
      ...base,
      status: 'stripe-error',
      message: `Stripe error retrieving ${priceId}: ${(err as Error).message}`,
    };
  }
}

/**
 * Verify each `STRIPE_PRICE_<TIER>_<INTERVAL>` resolves to a Stripe price
 * with the expected `recurring.interval`. When `STRIPE_METER_EVENT_AI_MINUTES`
 * is set, also verify each `STRIPE_PRICE_<TIER>_AI_MINUTES` is a metered
 * price whose `recurring.meter` matches `STRIPE_METER_AI_MINUTES` (the meter
 * id, distinct from the event name). Returns a `no-stripe-key` summary
 * (instead of throwing) when `STRIPE_SECRET_KEY` is unset.
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

  const meterEvent = process.env.STRIPE_METER_EVENT_AI_MINUTES ?? null;
  const meterId = process.env.STRIPE_METER_AI_MINUTES ?? null;

  const tasks: Array<Promise<PriceCheckResult>> = [];
  for (const plan of PLAN_TIERS) {
    tasks.push(checkBase(stripe, plan, 'monthly'));
    tasks.push(checkBase(stripe, plan, 'annual'));
  }
  if (meterEvent) {
    for (const plan of PLAN_TIERS) {
      tasks.push(checkMeteredAiMinutes(stripe, plan, meterId));
    }
  }
  const results = await Promise.all(tasks);

  const failed = results.filter((r) => r.status !== 'ok').length;
  const ok = results.length - failed;

  const baseChecked = results.filter((r) => r.kind === 'base').length;
  const meteredChecked = results.filter((r) => r.kind === 'metered-ai-minutes').length;
  const okSummary =
    meteredChecked > 0
      ? `All ${results.length} Stripe prices verified (${baseChecked} base + ${meteredChecked} metered AI-minutes).`
      : `All ${results.length} STRIPE_PRICE_<TIER>_<INTERVAL> env vars verified.`;

  return {
    summary: {
      total: results.length,
      ok,
      failed,
      status: failed === 0 ? 'ok' : 'failed',
      message: failed === 0 ? okSummary : `${failed} of ${results.length} checks failed.`,
    },
    results,
    generatedAt,
  };
}

export function formatUsdCents(cents: number | null): string {
  if (cents == null) return '—';
  // eslint-disable-next-line local/no-cents-divided-by-100 -- spot-check display
  return `$${(cents / 100).toFixed(2)}`;
}

export function formatPerMinuteRate(
  unitAmountCents: number | null,
  unitAmountDecimal: string | null,
): string {
  if (unitAmountDecimal != null) {
    const decimalCents = Number.parseFloat(unitAmountDecimal);
    if (Number.isFinite(decimalCents)) {
      // eslint-disable-next-line local/no-cents-divided-by-100 -- sub-cent display
      const dollars = decimalCents / 100;
      return `$${dollars.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}/min`;
    }
  }
  if (unitAmountCents != null) {
    return `${formatUsdCents(unitAmountCents)}/min`;
  }
  return '—';
}
