/**
 * One-off backfill for the `retry_skipped_reason` column added by
 * `migrations/072_retry_skipped_reason.sql`.
 *
 * Walks `support_ticket_replies`, `support_tickets`, and `docs_feedback_replies`,
 * runs the server-side `isPermanentSmtpError` classifier against every row's
 * `email_error` text, and stamps `retry_skipped_reason = 'permanent_smtp_failure'`
 * on rows that classify as a hard bounce. Rows that already have a non-NULL
 * value are left alone so this script is safe to re-run.
 *
 * Usage (development):
 *   APP_ENV=development DATABASE_URL=postgres://... npx tsx scripts/backfill-retry-skipped-reason.ts
 * Usage (production):
 *   APP_ENV=production PLATFORM_DB_POOL_URL=postgres://... npx tsx scripts/backfill-retry-skipped-reason.ts
 *
 * Pass `--dry-run` to print what would change without writing.
 */

import { Pool, type PoolClient } from 'pg';
import { isPermanentSmtpError } from '../platform/email/smtpErrorClass';

interface BackfillTarget {
  /** Human-friendly label used in log lines. */
  label: string;
  /** SQL table name. */
  table: string;
  /** Postgres array element type for the `id = ANY($1::<type>[])` cast. */
  idArrayType: 'int' | 'text';
  /** Optional extra `WHERE` predicate (without `WHERE`). */
  extraPredicate?: string;
}

const TARGETS: readonly BackfillTarget[] = [
  // Outbound support reply emails — inbound rows never have an outbound
  // delivery error, so we explicitly skip them.
  {
    label: 'support_ticket_replies (outbound)',
    table: 'support_ticket_replies',
    idArrayType: 'int',
    extraPredicate: "direction = 'outbound'",
  },
  // The original ticket-creation email (notification to assignee/CC list)
  // also stamps `email_error` on the parent row. `support_tickets.id` is a
  // VARCHAR — see migrations/057_support_tickets_collision_fix.sql.
  {
    label: 'support_tickets',
    table: 'support_tickets',
    idArrayType: 'text',
  },
  // Outbound docs-feedback replies are the only rows in this table.
  {
    label: 'docs_feedback_replies',
    table: 'docs_feedback_replies',
    idArrayType: 'int',
  },
];

interface PerTableResult {
  label: string;
  scanned: number;
  classifiedPermanent: number;
  updated: number;
}

async function backfillTable(
  client: PoolClient,
  target: BackfillTarget,
  dryRun: boolean,
): Promise<PerTableResult> {
  const wherePieces = ['retry_skipped_reason IS NULL', 'email_error IS NOT NULL'];
  if (target.extraPredicate) wherePieces.push(target.extraPredicate);
  const whereClause = wherePieces.join(' AND ');

  const { rows } = await client.query<{ id: number | string; email_error: string }>(
    `SELECT id, email_error
       FROM ${target.table}
      WHERE ${whereClause}`,
  );

  let permanent = 0;
  const permanentIds: Array<number | string> = [];
  for (const row of rows) {
    if (isPermanentSmtpError(row.email_error)) {
      permanent += 1;
      permanentIds.push(row.id);
    }
  }

  let updated = 0;
  if (!dryRun && permanentIds.length > 0) {
    // Chunk the UPDATE so we don't blow past PG's parameter limit on huge
    // historical sets. 500 ids per batch keeps us well under the 65k limit
    // and small enough that each statement returns quickly.
    const CHUNK = 500;
    for (let i = 0; i < permanentIds.length; i += CHUNK) {
      const chunk = permanentIds.slice(i, i + CHUNK);
      const result = await client.query(
        `UPDATE ${target.table}
            SET retry_skipped_reason = 'permanent_smtp_failure'
          WHERE id = ANY($1::${target.idArrayType}[])
            AND retry_skipped_reason IS NULL`,
        [chunk],
      );
      updated += result.rowCount ?? 0;
    }
  }

  return {
    label: target.label,
    scanned: rows.length,
    classifiedPermanent: permanent,
    updated,
  };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
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

  console.log(`[BACKFILL] Environment: ${env}${dryRun ? ' (DRY RUN)' : ''}`);

  const pool = new Pool({
    connectionString: url,
    max: 2,
    ...(sslConfig ? { ssl: sslConfig } : {}),
  });

  const client = await pool.connect();
  const results: PerTableResult[] = [];

  try {
    for (const target of TARGETS) {
      console.log(`[BACKFILL] Scanning ${target.label} ...`);
      const result = await backfillTable(client, target, dryRun);
      results.push(result);
      console.log(
        `[BACKFILL]   scanned=${result.scanned} permanent=${result.classifiedPermanent} updated=${result.updated}`,
      );
    }
  } finally {
    client.release();
    await pool.end();
  }

  const totals = results.reduce(
    (acc, r) => ({
      scanned: acc.scanned + r.scanned,
      permanent: acc.permanent + r.classifiedPermanent,
      updated: acc.updated + r.updated,
    }),
    { scanned: 0, permanent: 0, updated: 0 },
  );

  console.log('[BACKFILL] Done.');
  console.log(
    `[BACKFILL] Totals — scanned=${totals.scanned} permanent=${totals.permanent} updated=${totals.updated}${dryRun ? ' (no writes performed)' : ''}`,
  );
}

main().catch((err) => {
  console.error('[BACKFILL] Failed:', err);
  process.exit(1);
});
