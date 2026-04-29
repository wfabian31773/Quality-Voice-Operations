/**
 * One-off audit/sweep for pre-existing NEGATIVE-quantity rollup rows in
 * `daily_org_usage` and `usage_metrics`.
 *
 * Background: Task #723 added a forward-looking guard in
 * `server/admin-api/routes/ingest.ts` so the cross-day rebalance path can
 * never *create* a new rollup row whose `quantity` / `total_calls` /
 * `total_ai_minutes` / `total_cost_cents` is negative — when the OLD-day
 * row is missing it now skips the debit and opens a
 * `billing_backfill_cross_day_skipped` ops alert instead.
 *
 * But any rows that landed in the DB *before* the guard shipped are still
 * sitting there, and downstream invoicing has to special-case them. This
 * script walks both rollup tables, finds every negative row grouped by
 * tenant/date, prints a CSV-style audit report, and (unless `--dry-run`)
 * opens one `billing_negative_usage_row_detected` operations alert per
 * affected tenant so finance has a single inbox to work through. The
 * runbook at `docs/runbooks/billing-backfill-cross-day-rebalance.md`
 * (Appendix B) describes the manual cleanup procedure each alert points
 * to.
 *
 * The script is idempotent at the alert level: if there is already an
 * unacknowledged `billing_negative_usage_row_detected` alert for a tenant
 * it leaves it alone (the metadata snapshot reflects the moment the alert
 * was first opened — re-running won't churn duplicate alerts at finance).
 * Acknowledging the existing alert and re-running will open a fresh one
 * with the current snapshot, which is the desired behavior after a manual
 * cleanup pass.
 *
 * Usage (development):
 *   APP_ENV=development DATABASE_URL=postgres://... \
 *     npx tsx scripts/sweep-negative-usage-rows.ts
 * Usage (production):
 *   APP_ENV=production PLATFORM_DB_POOL_URL=postgres://... \
 *     npx tsx scripts/sweep-negative-usage-rows.ts
 *
 * Optional flags:
 *   --dry-run        Report what would be alerted, write no alert rows.
 *   --tenant=<id>    Limit to a single tenant_id.
 */

import { Pool, type PoolClient } from 'pg';

/**
 * Path to the manual rebalance runbook. Appendix B of this doc covers the
 * one-off cleanup for pre-existing negative rows that this script flags.
 * Mirrors `BACKFILL_CROSS_DAY_RUNBOOK` in `server/admin-api/routes/ingest.ts`
 * so finance always lands at the same canonical place.
 */
const RUNBOOK_URL = 'docs/runbooks/billing-backfill-cross-day-rebalance.md';

/**
 * Alert type used by this sweeper. Distinct from
 * `billing_backfill_cross_day_skipped` (forward-looking guard at ingest
 * time) so finance can filter the audit-time alerts separately from the
 * live ones if they want to.
 */
const ALERT_TYPE = 'billing_negative_usage_row_detected';

interface DailyOrgUsageNegativeRow {
  tenant_id: string;
  date: string;
  total_calls: number;
  total_ai_minutes: number;
  total_cost_cents: number;
}

interface UsageMetricsNegativeRow {
  tenant_id: string;
  metric_type: string;
  period_start: string;
  quantity: number;
  total_cost_cents: number | null;
}

interface PerTenantSummary {
  tenant_id: string;
  daily_org_usage_rows: DailyOrgUsageNegativeRow[];
  usage_metrics_rows: UsageMetricsNegativeRow[];
}

async function findNegativeDailyOrgUsageRows(
  client: PoolClient,
  tenantFilter: string | null,
): Promise<DailyOrgUsageNegativeRow[]> {
  const params: unknown[] = [];
  let where = `total_calls < 0
            OR total_ai_minutes < 0
            OR total_cost_cents < 0`;
  if (tenantFilter) {
    params.push(tenantFilter);
    where = `tenant_id = $1 AND (${where})`;
  }
  const { rows } = await client.query<DailyOrgUsageNegativeRow>(
    `SELECT tenant_id,
            to_char(date, 'YYYY-MM-DD') AS date,
            total_calls,
            total_ai_minutes,
            total_cost_cents
       FROM daily_org_usage
      WHERE ${where}
      ORDER BY tenant_id, date`,
    params,
  );
  return rows;
}

async function findNegativeUsageMetricsRows(
  client: PoolClient,
  tenantFilter: string | null,
): Promise<UsageMetricsNegativeRow[]> {
  const params: unknown[] = [];
  let where = `quantity < 0 OR total_cost_cents < 0`;
  if (tenantFilter) {
    params.push(tenantFilter);
    where = `tenant_id = $1 AND (${where})`;
  }
  const { rows } = await client.query<UsageMetricsNegativeRow>(
    `SELECT tenant_id,
            metric_type::text AS metric_type,
            to_char(period_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS period_start,
            quantity,
            total_cost_cents
       FROM usage_metrics
      WHERE ${where}
      ORDER BY tenant_id, period_start, metric_type`,
    params,
  );
  return rows;
}

function groupByTenant(
  daily: DailyOrgUsageNegativeRow[],
  metrics: UsageMetricsNegativeRow[],
): PerTenantSummary[] {
  const byTenant = new Map<string, PerTenantSummary>();
  const ensure = (tenantId: string): PerTenantSummary => {
    let s = byTenant.get(tenantId);
    if (!s) {
      s = { tenant_id: tenantId, daily_org_usage_rows: [], usage_metrics_rows: [] };
      byTenant.set(tenantId, s);
    }
    return s;
  };
  for (const row of daily) ensure(row.tenant_id).daily_org_usage_rows.push(row);
  for (const row of metrics) ensure(row.tenant_id).usage_metrics_rows.push(row);
  return [...byTenant.values()].sort((a, b) => a.tenant_id.localeCompare(b.tenant_id));
}

function printReport(summaries: PerTenantSummary[]): void {
  if (summaries.length === 0) {
    console.log('[SWEEP] No negative usage rows found. Nothing to do.');
    return;
  }
  console.log(`[SWEEP] Found negative usage rows for ${summaries.length} tenant(s):`);
  for (const s of summaries) {
    console.log(`\n[SWEEP] tenant=${s.tenant_id}`);
    if (s.daily_org_usage_rows.length > 0) {
      console.log('  daily_org_usage (date | total_calls | total_ai_minutes | total_cost_cents)');
      for (const r of s.daily_org_usage_rows) {
        console.log(
          `    ${r.date} | ${r.total_calls} | ${r.total_ai_minutes} | ${r.total_cost_cents}`,
        );
      }
    }
    if (s.usage_metrics_rows.length > 0) {
      console.log('  usage_metrics (period_start | metric_type | quantity | total_cost_cents)');
      for (const r of s.usage_metrics_rows) {
        console.log(
          `    ${r.period_start} | ${r.metric_type} | ${r.quantity} | ${r.total_cost_cents ?? 'NULL'}`,
        );
      }
    }
  }
  console.log('');
}

async function hasOpenAlertForTenant(
  client: PoolClient,
  tenantId: string,
): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM operations_alerts
        WHERE tenant_id = $1
          AND type = $2
          AND acknowledged = false
     ) AS exists`,
    [tenantId, ALERT_TYPE],
  );
  return rows[0]?.exists === true;
}

interface AlertOutcome {
  tenant_id: string;
  inserted: boolean;
  reason: 'inserted' | 'already_open' | 'skipped_dry_run';
  daily_row_count: number;
  usage_metric_row_count: number;
}

async function openAlertForTenant(
  client: PoolClient,
  summary: PerTenantSummary,
  dryRun: boolean,
): Promise<AlertOutcome> {
  const dailyCount = summary.daily_org_usage_rows.length;
  const metricsCount = summary.usage_metrics_rows.length;

  if (dryRun) {
    return {
      tenant_id: summary.tenant_id,
      inserted: false,
      reason: 'skipped_dry_run',
      daily_row_count: dailyCount,
      usage_metric_row_count: metricsCount,
    };
  }

  if (await hasOpenAlertForTenant(client, summary.tenant_id)) {
    return {
      tenant_id: summary.tenant_id,
      inserted: false,
      reason: 'already_open',
      daily_row_count: dailyCount,
      usage_metric_row_count: metricsCount,
    };
  }

  // Cap embedded row samples in metadata so a tenant with thousands of
  // negative rows doesn't blow up the JSONB column. Finance can always
  // re-run the audit query for the full list.
  const SAMPLE_CAP = 25;

  const dailySample = summary.daily_org_usage_rows.slice(0, SAMPLE_CAP);
  const metricsSample = summary.usage_metrics_rows.slice(0, SAMPLE_CAP);

  const dailyDates = summary.daily_org_usage_rows.map((r) => r.date);
  const metricsDates = summary.usage_metrics_rows.map((r) => r.period_start.slice(0, 10));
  const allDates = [...dailyDates, ...metricsDates].sort();
  const earliestDate = allDates[0] ?? null;
  const latestDate = allDates[allDates.length - 1] ?? null;

  const message =
    `Detected ${dailyCount} negative daily_org_usage row(s) and ${metricsCount} negative ` +
    `usage_metrics row(s) for this tenant — likely residue from cross-day backfill ` +
    `corrections that ran before the negative-quantity guard landed. ` +
    `Manual rebalance required: see runbook ${RUNBOOK_URL} (Appendix B).`;

  const metadata = {
    tenant_id: summary.tenant_id,
    runbook_url: RUNBOOK_URL,
    manual_rebalance_required: true,
    detection_source: 'scripts/sweep-negative-usage-rows.ts',
    daily_org_usage_negative_row_count: dailyCount,
    usage_metrics_negative_row_count: metricsCount,
    earliest_date: earliestDate,
    latest_date: latestDate,
    sample_truncated:
      dailyCount > dailySample.length || metricsCount > metricsSample.length,
    daily_org_usage_sample: dailySample,
    usage_metrics_sample: metricsSample,
  };

  await client.query(
    `INSERT INTO operations_alerts (tenant_id, type, severity, message, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [summary.tenant_id, ALERT_TYPE, 'warning', message, JSON.stringify(metadata)],
  );

  return {
    tenant_id: summary.tenant_id,
    inserted: true,
    reason: 'inserted',
    daily_row_count: dailyCount,
    usage_metric_row_count: metricsCount,
  };
}

export interface SweepResult {
  summaries: PerTenantSummary[];
  outcomes: AlertOutcome[];
}

export async function runSweep(
  client: PoolClient,
  options: { dryRun: boolean; tenantFilter: string | null },
): Promise<SweepResult> {
  const daily = await findNegativeDailyOrgUsageRows(client, options.tenantFilter);
  const metrics = await findNegativeUsageMetricsRows(client, options.tenantFilter);
  const summaries = groupByTenant(daily, metrics);

  const outcomes: AlertOutcome[] = [];
  for (const summary of summaries) {
    outcomes.push(await openAlertForTenant(client, summary, options.dryRun));
  }
  return { summaries, outcomes };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const tenantArg = process.argv.find((a) => a.startsWith('--tenant='));
  const tenantFilter = tenantArg ? tenantArg.slice('--tenant='.length) : null;

  const env = process.env.APP_ENV ?? 'development';
  let url: string;
  let sslConfig: { rejectUnauthorized: boolean } | false = false;

  if (env === 'development') {
    url = process.env.DATABASE_URL ?? '';
    if (!url) {
      throw new Error('[SWEEP] DATABASE_URL is not set for development.');
    }
  } else {
    url = process.env.PLATFORM_DB_POOL_URL ?? '';
    if (!url) {
      throw new Error('[SWEEP] PLATFORM_DB_POOL_URL is not set for production/staging.');
    }
    sslConfig = { rejectUnauthorized: false };
  }

  console.log(
    `[SWEEP] Environment: ${env}${dryRun ? ' (DRY RUN)' : ''}` +
      (tenantFilter ? ` tenant=${tenantFilter}` : ''),
  );

  const pool = new Pool({
    connectionString: url,
    max: 2,
    ...(sslConfig ? { ssl: sslConfig } : {}),
  });

  const client = await pool.connect();
  try {
    const { summaries, outcomes } = await runSweep(client, { dryRun, tenantFilter });
    printReport(summaries);

    const inserted = outcomes.filter((o) => o.reason === 'inserted').length;
    const alreadyOpen = outcomes.filter((o) => o.reason === 'already_open').length;
    const skippedDry = outcomes.filter((o) => o.reason === 'skipped_dry_run').length;

    console.log(
      `[SWEEP] Tenants flagged: ${summaries.length}. Alerts inserted: ${inserted}, ` +
        `already-open: ${alreadyOpen}, dry-run-skipped: ${skippedDry}.`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && process.argv[1].endsWith('sweep-negative-usage-rows.ts')) {
  main().catch((err) => {
    console.error('[SWEEP] Failed:', err);
    process.exit(1);
  });
}
