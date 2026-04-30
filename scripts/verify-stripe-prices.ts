import {
  verifyStripePrices,
  formatUsdCents,
  type PriceCheckResult,
} from '../platform/billing/stripe/verifyPrices';

function printRow(r: PriceCheckResult): void {
  const ok = r.status === 'ok';
  const icon = ok ? 'OK ' : 'FAIL';
  const mark = ok ? '\u2713' : '\u2717';
  const monthlyEq = r.monthlyEquivalentCents;
  const catalogCmp =
    monthlyEq != null
      ? `monthly_eq=${formatUsdCents(monthlyEq)} catalog=${formatUsdCents(r.catalogMonthlyCents)}`
      : '';
  console.log(
    `[${icon}] ${mark} ${r.envKey.padEnd(34)} plan=${r.plan.padEnd(10)} ` +
      `interval=${r.interval.padEnd(7)} priceId=${r.priceId ?? '(unset)'}`,
  );
  if (ok) {
    console.log(
      `       unit_amount=${formatUsdCents(r.unitAmountCents)} ${catalogCmp} actual_interval=${r.actualInterval}`,
    );
  } else {
    console.log(`       ${r.message}`);
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
  for (const r of report.results) {
    printRow(r);
  }

  console.log('');
  console.log(report.summary.message ?? '');
  process.exit(report.summary.status === 'ok' ? 0 : 1);
}

main().catch((err) => {
  console.error('[verify-stripe-prices] Unexpected error:', err);
  process.exit(1);
});
