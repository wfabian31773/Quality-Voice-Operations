import Stripe from 'stripe';
import { PLAN_TIERS, PLAN_CATALOG, type PlanTier } from '../shared/billing/planCatalog';

type Interval = 'monthly' | 'annual';

interface CheckResult {
  envKey: string;
  plan: PlanTier;
  interval: Interval;
  status: 'ok' | 'missing-env' | 'stripe-error' | 'wrong-interval' | 'no-amount';
  priceId: string | null;
  expectedInterval: 'month' | 'year';
  actualInterval: string | null;
  unitAmountCents: number | null;
  monthlyEquivalentCents: number | null;
  catalogMonthlyCents: number;
  message?: string;
}

function envKeyFor(plan: PlanTier, interval: Interval): string {
  return `STRIPE_PRICE_${plan.toUpperCase()}_${interval.toUpperCase()}`;
}

function expectedIntervalFor(interval: Interval): 'month' | 'year' {
  return interval === 'monthly' ? 'month' : 'year';
}

async function checkOne(
  stripe: Stripe,
  plan: PlanTier,
  interval: Interval,
): Promise<CheckResult> {
  const envKey = envKeyFor(plan, interval);
  const priceId = process.env[envKey] ?? null;
  const expectedInterval = expectedIntervalFor(interval);
  const catalogMonthlyCents = PLAN_CATALOG[plan].monthlyPriceCents;

  const base: CheckResult = {
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

    const result: CheckResult = {
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

function fmtUsd(cents: number | null): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toFixed(2)}`;
}

async function main() {
  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey) {
    console.error('[verify-stripe-prices] STRIPE_SECRET_KEY is not set — cannot verify prices.');
    process.exit(1);
  }
  const stripe = new Stripe(apiKey, { apiVersion: '2026-02-25.clover' as const });

  const tasks: Array<Promise<CheckResult>> = [];
  for (const plan of PLAN_TIERS) {
    tasks.push(checkOne(stripe, plan, 'monthly'));
    tasks.push(checkOne(stripe, plan, 'annual'));
  }
  const results = await Promise.all(tasks);

  const failures = results.filter((r) => r.status !== 'ok');

  console.log('');
  console.log('STRIPE PRICE BACKFILL VERIFICATION');
  console.log('===================================');
  for (const r of results) {
    const ok = r.status === 'ok';
    const icon = ok ? 'OK ' : 'FAIL';
    const mark = ok ? '\u2713' : '\u2717';
    const monthlyEq = r.monthlyEquivalentCents;
    const catalogCmp =
      monthlyEq != null
        ? `monthly_eq=${fmtUsd(monthlyEq)} catalog=${fmtUsd(r.catalogMonthlyCents)}`
        : '';
    console.log(
      `[${icon}] ${mark} ${r.envKey.padEnd(34)} plan=${r.plan.padEnd(10)} ` +
        `interval=${r.interval.padEnd(7)} priceId=${r.priceId ?? '(unset)'}`,
    );
    if (ok) {
      console.log(
        `       unit_amount=${fmtUsd(r.unitAmountCents)} ${catalogCmp} actual_interval=${r.actualInterval}`,
      );
    } else {
      console.log(`       ${r.message}`);
    }
  }

  console.log('');
  if (failures.length === 0) {
    console.log(`All ${results.length} STRIPE_PRICE_<TIER>_<INTERVAL> env vars verified.`);
    process.exit(0);
  } else {
    console.log(`${failures.length} of ${results.length} checks failed.`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[verify-stripe-prices] Unexpected error:', err);
  process.exit(1);
});
