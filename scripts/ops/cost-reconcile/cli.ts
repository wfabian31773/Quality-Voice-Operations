// Daily cost reconciler CLI (RT-05). Read-only: fetches one America/New_York
// day of xAI usage, Twilio calls + recordings and our call rows, reconciles
// them (./reconcile) and prints the report as JSON, or writes it to --out.
// No DB writes, not scheduled anywhere.
//
//   npx tsx scripts/ops/cost-reconcile/cli.ts --date 2026-10-15 \
//     --xai-usage-file ./xai-usage-2026-10-15.json [--out ./report.json]
//
// Env (names only; values are never printed):
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN   Twilio REST (read)
//   APP_ENV + DATABASE_URL / PLATFORM_DB_POOL_URL / DATABASE_URL_PRIVILEGED
//                                           our DB, via platform/db

import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { dayWindow } from './dayWindow';
import { reconcileDay } from './reconcile';
import {
  type DbCallSource,
  type TwilioSource,
  type XaiUsageSource,
  createDbCallSource,
  createTwilioSource,
  createXaiUsageApiSource,
  createXaiUsageFileSource,
} from './sources';
import type { ReconciliationReport } from './types';

export interface CostReconcileArgs {
  date: string;
  out: string | null;
  xaiUsageFile: string | null;
}

export function parseCostReconcileArgs(args: readonly string[]): CostReconcileArgs {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const [flag, inline] = arg.split(/=(.*)/s, 2);
    if (!['--date', '--out', '--xai-usage-file'].includes(flag)) throw new Error(`Unknown argument: ${flag}`);
    const value = inline ?? args[(i += 1)];
    if (value === undefined || value === '' || value.startsWith('--')) throw new Error(`${flag} needs a value`);
    if (values.has(flag)) throw new Error(`${flag} given twice`);
    values.set(flag, value);
  }
  const date = values.get('--date');
  if (!date) throw new Error('--date YYYY-MM-DD is required');
  dayWindow(date); // validates
  return { date, out: values.get('--out') ?? null, xaiUsageFile: values.get('--xai-usage-file') ?? null };
}

export interface CostReconcileDeps {
  xai: XaiUsageSource;
  twilio: TwilioSource;
  db: DbCallSource;
}

export async function runCostReconcile(date: string, deps: CostReconcileDeps): Promise<ReconciliationReport> {
  const window = dayWindow(date);
  const [xaiUsage, twilioCalls, twilioRecordings, dbCalls] = await Promise.all([
    deps.xai.fetchUsage(window),
    deps.twilio.fetchCalls(window),
    deps.twilio.fetchRecordings(window),
    deps.db.fetchCalls(window),
  ]);
  return reconcileDay({ date, xaiUsage, twilioCalls, twilioRecordings, dbCalls });
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

export async function main(args = process.argv.slice(2), env = process.env): Promise<void> {
  const parsed = parseCostReconcileArgs(args);
  const twilio = createTwilioSource({
    accountSid: requireEnv(env, 'TWILIO_ACCOUNT_SID'),
    authToken: requireEnv(env, 'TWILIO_AUTH_TOKEN'),
  });
  const xai = parsed.xaiUsageFile ? createXaiUsageFileSource(parsed.xaiUsageFile) : createXaiUsageApiSource();
  // Loaded lazily so importing this module (tests) never opens a pool.
  const { withPrivilegedClient, getPrivilegedPool } = await import('../../../platform/db');
  let report: ReconciliationReport;
  try {
    report = await withPrivilegedClient((client) =>
      runCostReconcile(parsed.date, {
        xai,
        twilio,
        db: createDbCallSource((sql, values) => client.query(sql, values)),
      }),
    );
  } finally {
    // End the pool directly: closePlatformPool() logs to stdout, which would
    // corrupt the JSON report. Ignore failures (e.g. the pool never opened).
    await Promise.resolve()
      .then(() => getPrivilegedPool().end())
      .catch(() => undefined);
  }
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (parsed.out) {
    await writeFile(parsed.out, json, 'utf8');
    console.error(`Cost reconciliation for ${parsed.date} written to ${parsed.out}`);
  } else {
    process.stdout.write(json);
  }
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (invokedDirectly) {
  main().catch((err: unknown) => {
    // Our own error messages carry no credentials or row data; print only them.
    console.error(`Cost reconciliation failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    process.exitCode = 1;
  });
}
