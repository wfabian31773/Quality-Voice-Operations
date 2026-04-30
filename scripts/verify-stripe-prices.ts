import {
  verifyStripePrices,
  formatUsdCents,
  formatPerMinuteRate,
  type PriceCheckResult,
} from '../platform/billing/stripe/verifyPrices';

function printBaseRow(r: PriceCheckResult): void {
  const ok = r.status === 'ok';
  const icon = ok ? 'OK ' : 'FAIL';
  const mark = ok ? '\u2713' : '\u2717';
  const monthlyEq = r.monthlyEquivalentCents;
  const catalog = r.catalogMonthlyCents;
  const catalogCmp =
    monthlyEq != null && catalog != null
      ? `monthly_eq=${formatUsdCents(monthlyEq)} catalog=${formatUsdCents(catalog)}`
      : '';
  console.log(
    `[${icon}] ${mark} ${r.envKey.padEnd(34)} plan=${r.plan.padEnd(10)} ` +
      `interval=${(r.interval ?? '-').padEnd(7)} priceId=${r.priceId ?? '(unset)'}`,
  );
  if (ok) {
    console.log(
      `       unit_amount=${formatUsdCents(r.unitAmountCents)} ${catalogCmp} actual_interval=${r.actualInterval}`,
    );
  } else {
    console.log(`       ${r.message}`);
  }
}

function printMeteredRow(r: PriceCheckResult): void {
  const ok = r.status === 'ok';
  const icon = ok ? 'OK ' : 'FAIL';
  const mark = ok ? '\u2713' : '\u2717';
  console.log(
    `[${icon}] ${mark} ${r.envKey.padEnd(34)} plan=${r.plan.padEnd(10)} ` +
      `kind=metered priceId=${r.priceId ?? '(unset)'}`,
  );
  if (ok) {
    const catalogStr =
      r.catalogOverageRatePerMinute != null
        ? `catalog=$${r.catalogOverageRatePerMinute.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}/min`
        : '';
    console.log(
      `       rate=${formatPerMinuteRate(r.unitAmountCents, r.unitAmountDecimal)} ${catalogStr} ` +
        `usage_type=${r.actualUsageType ?? '(unset)'} meter=${r.actualMeter ?? '(unset)'}`,
    );
  } else {
    console.log(`       ${r.message}`);
  }
}

function printRow(r: PriceCheckResult): void {
  if (r.kind === 'metered-ai-minutes') {
    printMeteredRow(r);
  } else {
    printBaseRow(r);
  }
}

async function main(): Promise<void> {
  const report = await verifyStripePrices();

  if (report.summary.status === 'no-stripe-key') {
    console.error(`[verify-stripe-prices] ${report.summary.message}`);
    process.exit(1);
  }

  console.log('');
  console.log('STRIPE PRICE BACKFILL VERIFICATION');
  console.log('===================================');

  const baseRows = report.results.filter((r) => r.kind === 'base');
  const meteredRows = report.results.filter((r) => r.kind === 'metered-ai-minutes');

  if (baseRows.length > 0) {
    console.log('');
    console.log('-- Base prices (STRIPE_PRICE_<TIER>_<INTERVAL>) --');
    for (const r of baseRows) printRow(r);
  }

  if (meteredRows.length > 0) {
    console.log('');
    console.log(
      '-- Metered AI-minute prices (STRIPE_PRICE_<TIER>_AI_MINUTES, gated on STRIPE_METER_EVENT_AI_MINUTES; recurring.meter compared to STRIPE_METER_AI_MINUTES) --',
    );
    for (const r of meteredRows) printRow(r);
  } else {
    console.log('');
    console.log(
      '-- Metered AI-minute prices skipped: STRIPE_METER_EVENT_AI_MINUTES is not set (deployment has not opted in to per-tier metered AI billing yet). --',
    );
  }

  console.log('');
  console.log(report.summary.message ?? '');
  process.exit(report.summary.status === 'ok' ? 0 : 1);
}

main().catch((err) => {
  console.error('[verify-stripe-prices] Unexpected error:', err);
  process.exit(1);
});
