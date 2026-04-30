/**
 * One-off backfill for the `direction` label on historical
 * `billing.checkout_created` audit-log rows.
 *
 * Background: the Platform Admin "Plan-change direction" panel
 * (`/platform/checkout-directions`) groups checkout activity by
 * `changes->>'direction'`. The writer in
 * `server/admin-api/routes/billing.ts` started stamping that field after
 * Task #1300 shipped — anything older has `fromPlan`/`toPlan`/
 * `fromInterval`/`toInterval` populated but no `direction`, so the chart
 * silently buckets all of that history under "unknown".
 *
 * This script walks every `audit_logs` row where:
 *   - `action = 'billing.checkout_created'`, AND
 *   - `changes->>'direction' IS NULL` (i.e. not yet backfilled),
 * derives the direction with the *same* `classifyCheckoutDirection`
 * helper the live writer uses, and stamps it into `changes` via
 * `jsonb_set(... , '{direction}', to_jsonb(<value>))`.
 *
 * Why this script needs special privileges
 * ----------------------------------------
 * `audit_logs` is intentionally append-only in production. Migration
 * `046_enterprise_security.sql` installs:
 *   1. An `audit_logs_no_update` BEFORE-UPDATE trigger that raises
 *      `audit_logs is immutable: UPDATE operations are not permitted`
 *      on every row mutation.
 *   2. RLS policies that gate access to the platform-admin role.
 *
 * Both protections exist to keep tenant-facing audit history tamper-
 * evident, so this script — the only sanctioned mutation path for
 * historical audit rows — must:
 *   - Run inside a single transaction with `SET LOCAL row_security = off`
 *     so the platform admin role can SELECT/UPDATE every row regardless
 *     of tenant scoping.
 *   - Temporarily disable the immutability trigger via
 *     `ALTER TABLE audit_logs DISABLE TRIGGER audit_logs_no_update`,
 *     re-enable it BEFORE COMMIT, and unconditionally re-enable it on
 *     error too. Any rollback automatically restores the trigger
 *     because the DISABLE is itself transactional DDL — but we still
 *     emit an explicit ENABLE so a successful commit lands with the
 *     guard back on.
 *
 * Idempotency / safety
 * --------------------
 * - The SELECT predicate already filters out rows that have a direction.
 * - Each UPDATE re-asserts `changes->>'direction' IS NULL` AND
 *   `action = 'billing.checkout_created'` in its WHERE clause, so a
 *   concurrent live writer between SELECT and UPDATE cannot be
 *   clobbered (the live path never UPDATEs audit_logs anyway, but we
 *   defend in depth).
 * - `--dry-run` exits before issuing any DISABLE/UPDATE/ENABLE — useful
 *   for capturing the projected per-direction tallies without taking
 *   any lock on `audit_logs`.
 * - `--batch=<n>` overrides the per-UPDATE chunk size (default 200).
 *
 * `billing.checkout_rejected` rows are intentionally NOT touched —
 * the rejection writer (strict-downgrade guard) has always stamped
 * `direction: 'downgrade'` since that audit was introduced.
 *
 * Usage (development):
 *   APP_ENV=development DATABASE_URL=postgres://... \
 *     npx tsx scripts/backfill-checkout-direction.ts --dry-run
 *   APP_ENV=development DATABASE_URL=postgres://... \
 *     npx tsx scripts/backfill-checkout-direction.ts
 *
 * Usage (production):
 *   APP_ENV=production PLATFORM_DB_POOL_URL=postgres://... \
 *     npx tsx scripts/backfill-checkout-direction.ts --dry-run
 *   APP_ENV=production PLATFORM_DB_POOL_URL=postgres://... \
 *     npx tsx scripts/backfill-checkout-direction.ts
 *
 * Verification (after running):
 *   SELECT COALESCE(NULLIF(changes->>'direction', ''), 'unknown') AS direction,
 *          COUNT(*)
 *     FROM audit_logs
 *    WHERE action = 'billing.checkout_created'
 *    GROUP BY 1
 *    ORDER BY 2 DESC;
 *   -- "unknown" should now only contain rows with no usable target
 *   -- plan/interval (the script reports those as `skippedNoTarget`).
 */

import { Pool, type PoolClient } from 'pg';
import {
  classifyCheckoutDirection,
  type CheckoutDirection,
} from '../platform/billing/stripe/planChange';
import type { PlanTier } from '../platform/billing/stripe/plans';

const PLAN_TIERS: ReadonlySet<PlanTier> = new Set(['starter', 'pro', 'enterprise']);
const INTERVALS: ReadonlySet<'monthly' | 'annual'> = new Set(['monthly', 'annual']);

/**
 * Name of the BEFORE-UPDATE trigger from
 * `migrations/046_enterprise_security.sql`. We reference it by name so
 * `ALTER TABLE ... DISABLE TRIGGER` does NOT fall back to disabling
 * `USER` (every user trigger on the table) — there are now multiple
 * audit-log triggers in production and we only want to bypass the
 * immutability check.
 */
export const IMMUTABILITY_TRIGGER_NAME = 'audit_logs_no_update';

function asPlanTier(value: unknown): PlanTier | null {
  return typeof value === 'string' && PLAN_TIERS.has(value as PlanTier)
    ? (value as PlanTier)
    : null;
}

function asInterval(value: unknown): 'monthly' | 'annual' | null {
  return typeof value === 'string' && INTERVALS.has(value as 'monthly' | 'annual')
    ? (value as 'monthly' | 'annual')
    : null;
}

interface CheckoutAuditRow {
  id: string;
  changes: Record<string, unknown> | null;
}

export interface BackfillRunOptions {
  dryRun: boolean;
  batchSize: number;
}

export interface BackfillRunResult {
  scanned: number;
  classified: Record<CheckoutDirection, number>;
  skippedNoTarget: number;
  updated: number;
}

function makeEmptyClassified(): Record<CheckoutDirection, number> {
  return { upgrade: 0, downgrade: 0, interval_change: 0, same: 0, new: 0 };
}

interface ClassifiedRow {
  id: string;
  direction: CheckoutDirection;
}

interface ClassificationResult {
  scanned: number;
  classified: Record<CheckoutDirection, number>;
  skippedNoTarget: number;
  toUpdate: ClassifiedRow[];
}

/**
 * Read-only pass: SELECT every candidate row and classify it via
 * `classifyCheckoutDirection`. Held lock is the SELECT's row-level
 * lock only (no ACCESS EXCLUSIVE lock on the table), so we can do all
 * of the heavy I/O *before* we touch the immutability trigger.
 */
async function classifyCandidates(
  client: Pick<PoolClient, 'query'>,
): Promise<ClassificationResult> {
  const { rows } = await client.query<CheckoutAuditRow>(
    `SELECT id, changes
       FROM audit_logs
      WHERE action = 'billing.checkout_created'
        AND (changes->>'direction' IS NULL OR changes->>'direction' = '')`,
  );

  const classified: Record<CheckoutDirection, number> = makeEmptyClassified();
  const toUpdate: ClassifiedRow[] = [];
  let skippedNoTarget = 0;

  for (const row of rows) {
    const changes = row.changes ?? {};
    // The writer records both shapes — the original `plan`/`interval`
    // pair AND the disambiguated `toPlan`/`toInterval` pair. Older rows
    // sometimes only have the former, so prefer `toPlan` and fall back
    // to `plan`. Same for the interval.
    const targetPlan =
      asPlanTier(changes.toPlan) ?? asPlanTier(changes.plan);
    const targetInterval =
      asInterval(changes.toInterval) ?? asInterval(changes.interval);
    if (!targetPlan || !targetInterval) {
      // Without a usable target we cannot derive a direction; leave the
      // row alone and report it so the operator can spot-check.
      skippedNoTarget += 1;
      continue;
    }
    const fromPlan = asPlanTier(changes.fromPlan);
    const fromInterval = asInterval(changes.fromInterval);
    const direction = classifyCheckoutDirection(
      fromPlan,
      fromInterval,
      targetPlan,
      targetInterval,
    );
    classified[direction] += 1;
    toUpdate.push({ id: row.id, direction });
  }

  return { scanned: rows.length, classified, skippedNoTarget, toUpdate };
}

/**
 * UPDATE phase. Group ids by derived direction so each UPDATE only
 * carries one literal value, keeping the parameterized statement
 * simple and the chunk size purely an id-count cap (Postgres parameter
 * limit is 65k; 200 ids per batch is well clear of that).
 */
async function applyDirectionUpdates(
  client: Pick<PoolClient, 'query'>,
  toUpdate: readonly ClassifiedRow[],
  batchSize: number,
): Promise<number> {
  if (toUpdate.length === 0) return 0;
  const byDirection = new Map<CheckoutDirection, string[]>();
  for (const row of toUpdate) {
    const list = byDirection.get(row.direction) ?? [];
    list.push(row.id);
    byDirection.set(row.direction, list);
  }
  let updated = 0;
  for (const [direction, ids] of byDirection) {
    for (let i = 0; i < ids.length; i += batchSize) {
      const chunk = ids.slice(i, i + batchSize);
      const result = await client.query(
        `UPDATE audit_logs
            SET changes = jsonb_set(
              COALESCE(changes, '{}'::jsonb),
              '{direction}',
              to_jsonb($2::text),
              true
            )
          WHERE id = ANY($1::varchar[])
            AND action = 'billing.checkout_created'
            AND (changes->>'direction' IS NULL OR changes->>'direction' = '')`,
        [chunk, direction],
      );
      updated += result.rowCount ?? 0;
    }
  }
  return updated;
}

/**
 * Pure SELECT/UPDATE backfill. Caller is responsible for:
 *   - opening a privileged transaction (`SET LOCAL row_security = off`),
 *   - disabling the audit_logs immutability trigger BEFORE invoking
 *     this function and re-enabling it after.
 *
 * Exported separately so the unit test can drive it with a fake client
 * and assert on the SQL we issue + the directions we derive, without
 * having to simulate the trigger lifecycle.
 *
 * Note: the higher-level `runBackfillWithImmutabilityTrigger` wrapper
 * splits this into a separate classification pass (no lock) and an
 * UPDATE phase (lock held only for the UPDATEs) to minimise the time
 * the immutability trigger is disabled in production.
 */
export async function runBackfill(
  client: Pick<PoolClient, 'query'>,
  opts: BackfillRunOptions,
): Promise<BackfillRunResult> {
  const c = await classifyCandidates(client);
  const updated = opts.dryRun
    ? 0
    : await applyDirectionUpdates(client, c.toUpdate, opts.batchSize);
  return {
    scanned: c.scanned,
    classified: c.classified,
    skippedNoTarget: c.skippedNoTarget,
    updated,
  };
}

/**
 * Wraps `runBackfill` with the "safe-to-mutate-audit_logs" trigger
 * dance described in the file header. Caller still owns transaction
 * management — pass an open privileged client (`row_security = off`).
 *
 * Lock discipline: classification (the SELECT pass) runs WITHOUT
 * touching the trigger, so the `ALTER TABLE ... DISABLE TRIGGER`
 * (which takes ACCESS EXCLUSIVE on `audit_logs`) is held only for the
 * duration of the UPDATEs themselves. If classification finds nothing
 * to update we skip the trigger dance entirely.
 *
 * In dry-run mode the trigger is NEVER disabled because no UPDATE
 * will be issued and we don't want to touch the production lock graph.
 */
export async function runBackfillWithImmutabilityTrigger(
  client: Pick<PoolClient, 'query'>,
  opts: BackfillRunOptions,
): Promise<BackfillRunResult> {
  const c = await classifyCandidates(client);
  const baseResult: BackfillRunResult = {
    scanned: c.scanned,
    classified: c.classified,
    skippedNoTarget: c.skippedNoTarget,
    updated: 0,
  };
  if (opts.dryRun || c.toUpdate.length === 0) {
    return baseResult;
  }

  await client.query(
    `ALTER TABLE audit_logs DISABLE TRIGGER ${IMMUTABILITY_TRIGGER_NAME}`,
  );
  try {
    const updated = await applyDirectionUpdates(client, c.toUpdate, opts.batchSize);
    return { ...baseResult, updated };
  } finally {
    // Re-enable INSIDE the transaction so a successful COMMIT lands
    // with the immutability guard restored. On a thrown error the
    // outer caller will ROLLBACK, which Postgres uses to restore the
    // pre-DISABLE state automatically — the explicit re-enable here is
    // belt-and-braces and also lets the same client be reused for
    // post-backfill verification queries safely.
    await client
      .query(`ALTER TABLE audit_logs ENABLE TRIGGER ${IMMUTABILITY_TRIGGER_NAME}`)
      .catch((err) => {
        // Surface but don't mask the original error if there was one;
        // log to stderr so the operator can investigate manually. The
        // outer transaction will roll back on any unhandled error and
        // restore trigger state regardless.
        console.error(
          `[BACKFILL] WARNING: failed to ENABLE TRIGGER ${IMMUTABILITY_TRIGGER_NAME}; transaction rollback will restore it. error=${String(err)}`,
        );
      });
  }
}

function parseFlag(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const rawBatch = parseFlag('batch');
  const parsedBatch = rawBatch ? parseInt(rawBatch, 10) : NaN;
  const batchSize = Number.isFinite(parsedBatch) && parsedBatch > 0 ? parsedBatch : 200;

  const env = process.env.APP_ENV ?? 'development';
  let url: string;
  let sslConfig: { rejectUnauthorized: boolean } | false = false;

  if (env === 'development') {
    url = process.env.DATABASE_URL ?? '';
    if (!url) {
      throw new Error('[BACKFILL] DATABASE_URL is not set for development.');
    }
  } else {
    url = process.env.PLATFORM_DB_POOL_URL ?? '';
    if (!url) {
      throw new Error('[BACKFILL] PLATFORM_DB_POOL_URL is not set for production/staging.');
    }
    sslConfig = { rejectUnauthorized: false };
  }

  console.log(
    `[BACKFILL] checkout-direction env=${env} batch=${batchSize}${dryRun ? ' (DRY RUN)' : ''}`,
  );

  const pool = new Pool({
    connectionString: url,
    max: 2,
    ...(sslConfig ? { ssl: sslConfig } : {}),
  });
  const client = await pool.connect();
  let result: BackfillRunResult | null = null;
  try {
    await client.query('BEGIN');
    // RLS bypass — same pattern as `withPrivilegedClient` in
    // `platform/db/index.ts`. Required because audit_logs has tenant
    // RLS policies that would otherwise scope the SELECT to whatever
    // tenant context this raw connection happens to land in.
    await client.query('SET LOCAL row_security = off');
    result = await runBackfillWithImmutabilityTrigger(client, { dryRun, batchSize });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }

  console.log(`[BACKFILL] scanned=${result.scanned} skippedNoTarget=${result.skippedNoTarget}`);
  console.log(
    `[BACKFILL] derived: upgrade=${result.classified.upgrade} downgrade=${result.classified.downgrade} interval_change=${result.classified.interval_change} same=${result.classified.same} new=${result.classified.new}`,
  );
  console.log(
    `[BACKFILL] updated=${result.updated}${dryRun ? ' (no writes performed)' : ''}`,
  );
}

// Only auto-run when invoked as a script (`tsx scripts/...`), not when the
// test imports `runBackfill` for its fake-client harness.
const invokedAsScript =
  typeof process.argv[1] === 'string' && /backfill-checkout-direction\.ts$/.test(process.argv[1]);
if (invokedAsScript) {
  main().catch((err) => {
    console.error('[BACKFILL] Failed:', err);
    process.exit(1);
  });
}
