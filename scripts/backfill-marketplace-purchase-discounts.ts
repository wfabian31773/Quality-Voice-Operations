/**
 * One-off backfill for the coupon-aware "Discount applied" badge on
 * historical `marketplace_purchases` rows.
 *
 * Background
 * ----------
 * Task #1373 added an in-app discount badge to the marketplace purchase
 * history view. The badge is sourced from columns added by
 * `migrations/107_marketplace_purchases_discount.sql`
 * (`discount_badge_applied`, `discount_coupon_id`, ...) and populated
 * forward from the `invoice.finalized` Stripe webhook in
 * `platform/billing/stripe/webhook.ts` via the shared
 * `applyInvoiceDiscountToPurchase` mirror in
 * `platform/marketplace/MarketplacePurchaseService.ts`.
 *
 * Rows whose underlying Stripe invoice was finalized BEFORE the mirror
 * code shipped never had the webhook fire against the new code path —
 * so the columns are still NULL even when the downloaded receipt PDF
 * clearly carries a coupon. Finance / tenants notice the gap when
 * reconciling old receipts against the in-app history view.
 *
 * What it does
 * ------------
 * - Walks every `marketplace_purchases` row where
 *   `discount_badge_applied = FALSE` AND we have a usable Stripe link
 *   (either a `stripe_subscription_id` for the recurring path or a
 *   `stripe_checkout_session_id` for the one-off path — the table has
 *   no `stripe_invoice_id` column so the session is the join key for
 *   one-off invoices, see "Why session-id, not invoice-id" below).
 * - For each candidate, resolves the latest Stripe invoice id, retrieves
 *   it with `expand: ['discounts', 'discounts.promotion_code']`, runs
 *   the first usable discount through the same `normalizeDiscount`
 *   helper the live webhook uses, and (when `--apply` is set) calls the
 *   shared `applyInvoiceDiscountToPurchase` mirror to stamp the
 *   discount columns. Idempotent: the SELECT predicate excludes already-
 *   stamped rows, and re-running against the same row is a no-op.
 * - Dry-run is the default. Pass `--apply` to actually issue UPDATEs.
 *
 * Why session-id, not invoice-id (deviation from task description)
 * ---------------------------------------------------------------
 * The task brief mentions a `stripe_invoice_id` column on
 * `marketplace_purchases`. That column does not currently exist (see
 * `migrations/040_marketplace_expansion.sql` and the cumulative
 * `041`/`107` add-column migrations). For one-off marketplace purchases
 * the only persisted Stripe handle is `stripe_checkout_session_id`,
 * which we expand with `{ expand: ['invoice'] }` to recover the invoice
 * id Stripe created via `invoice_creation: { enabled: true }` (see
 * `MarketplacePurchaseService.createMarketplacePurchase`). For
 * recurring marketplace purchases we use `stripe_subscription_id` and
 * resolve the latest invoice via `subscription.latest_invoice`. Both
 * paths converge on a single invoice id we then push through the live
 * `normalizeDiscount` + mirror code path.
 *
 * Idempotency / safety
 * --------------------
 * - SELECT predicate already filters out rows with
 *   `discount_badge_applied = TRUE`.
 * - All writes go through `applyInvoiceDiscountToPurchase`, which is the
 *   exact same code path the webhook uses, so the badge fields land
 *   identically whether the writer is the webhook or this script.
 * - The script never touches Stripe-side state (no invoice mutations).
 *   Only the in-app `marketplace_purchases` columns are updated; the
 *   receipt PDF was already stamped by `handleInvoiceFinalized` at
 *   finalize time.
 * - Dry-run is the DEFAULT. The operator must opt in to writes via
 *   `--apply`. This mirrors the safety stance of the rest of the
 *   `scripts/backfill-*.ts` family.
 *
 * Usage (development):
 *   APP_ENV=development DATABASE_URL=postgres://... STRIPE_SECRET_KEY=sk_test_... \
 *     npx tsx scripts/backfill-marketplace-purchase-discounts.ts
 *   APP_ENV=development DATABASE_URL=postgres://... STRIPE_SECRET_KEY=sk_test_... \
 *     npx tsx scripts/backfill-marketplace-purchase-discounts.ts --apply
 *
 * Usage (production):
 *   APP_ENV=production PLATFORM_DB_POOL_URL=postgres://... STRIPE_SECRET_KEY=sk_live_... \
 *     npx tsx scripts/backfill-marketplace-purchase-discounts.ts
 *   APP_ENV=production PLATFORM_DB_POOL_URL=postgres://... STRIPE_SECRET_KEY=sk_live_... \
 *     npx tsx scripts/backfill-marketplace-purchase-discounts.ts --apply
 *
 * Optional flags:
 *   --apply         Actually issue UPDATEs. Default is dry-run.
 *   --batch=<n>     Per-iteration page size (default 200).
 *   --limit=<n>     Stop after processing N candidate rows total (smoke tests).
 *   --tenant=<id>   Limit to a single tenant_id.
 *
 * Summary fields
 * --------------
 *   scanned          - candidate rows the loop processed
 *   updated          - rows whose UPDATE we verified flipped
 *                      `discount_badge_applied = TRUE` on disk (only
 *                      with --apply; otherwise reported as
 *                      `would_update` to avoid implying writes)
 *   no_discount      - candidate rows whose latest invoice has no
 *                      usable discount (the receipt PDF carries no
 *                      coupon either; nothing to badge)
 *   no_stripe_link   - candidate rows where Stripe returned no invoice
 *                      to chase (e.g. legacy one-offs created before
 *                      `invoice_creation: { enabled: true }` shipped)
 *   api_failures     - rows where either a Stripe call or the
 *                      verifying mirror UPDATE threw
 *   already_stamped  - rows in the same `--tenant` scope (or globally
 *                      if unscoped) that already carry the badge at
 *                      run start; reported so Finance can reconcile
 *                      "X live-stamped + Y backfill-stamped = Z total
 *                      badged" without a separate query
 *
 * Verification (after running with --apply):
 *   SELECT
 *     COUNT(*) FILTER (WHERE discount_badge_applied) AS badged,
 *     COUNT(*) FILTER (WHERE NOT discount_badge_applied) AS unbadged
 *   FROM marketplace_purchases
 *   WHERE stripe_subscription_id IS NOT NULL OR stripe_checkout_session_id IS NOT NULL;
 *   -- `badged` should equal (already_stamped + updated) from the run
 *   -- summary; `unbadged` should equal (no_discount + no_stripe_link
 *   -- + api_failures) plus any rows with no Stripe handle at all.
 */

import { Pool, type PoolClient } from 'pg';
import type Stripe from 'stripe';

import {
  normalizeDiscount,
  type UpgradeDiscount,
} from '../platform/billing/stripe/effectiveRate';

/**
 * `priceModel` values that map to a Stripe Subscription (and therefore
 * to a `stripe_subscription_id` join). Anything else is treated as a
 * one-off `payment` mode session whose invoice is reachable via
 * `checkout.sessions.retrieve(id, { expand: ['invoice'] })`.
 *
 * Mirrors the `isSubscription` branch in
 * `MarketplacePurchaseService.createMarketplacePurchase`.
 */
const SUBSCRIPTION_PRICE_MODELS: ReadonlySet<string> = new Set([
  'monthly_subscription',
  'usage_based',
]);

export interface CandidateRow {
  id: string;
  tenant_id: string;
  template_id: string;
  price_model: string;
  stripe_subscription_id: string | null;
  stripe_checkout_session_id: string | null;
}

export interface CliOptions {
  apply: boolean;
  batchSize: number;
  limit: number | null;
  tenantId: string | null;
}

export interface BackfillTotals {
  scanned: number;
  updated: number;
  noDiscount: number;
  noStripeLink: number;
  apiFailures: number;
}

/**
 * Companion count returned alongside `BackfillTotals`: how many
 * `marketplace_purchases` rows in the same `--tenant` scope were
 * already stamped (`discount_badge_applied = TRUE`) at the time the
 * run started. The SELECT predicate excludes them so they never reach
 * the per-row loop, but Finance/operators need the figure to reconcile
 * "X live-stamped + Y backfill-stamped = Z total badged".
 */
export interface AlreadyStampedCount {
  alreadyStamped: number;
}

/**
 * Per-row outcome bucket. Exposed publicly so the unit test can assert
 * the classification without re-implementing the totals math.
 */
export type RowOutcome =
  | { kind: 'updated'; purchaseId: string; invoiceId: string }
  | { kind: 'no_discount'; purchaseId: string; invoiceId: string }
  | { kind: 'no_stripe_link'; purchaseId: string }
  | { kind: 'api_failure'; purchaseId: string; error: string };

export function parseArgs(argv: readonly string[]): CliOptions {
  let apply = false;
  let batchSize = 200;
  let limit: number | null = null;
  let tenantId: string | null = null;

  for (const arg of argv) {
    if (arg === '--apply') {
      apply = true;
    } else if (arg.startsWith('--batch=')) {
      const n = Number.parseInt(arg.slice('--batch='.length), 10);
      if (Number.isFinite(n) && n > 0) batchSize = n;
    } else if (arg.startsWith('--limit=')) {
      const n = Number.parseInt(arg.slice('--limit='.length), 10);
      if (Number.isFinite(n) && n > 0) limit = n;
    } else if (arg.startsWith('--tenant=')) {
      const v = arg.slice('--tenant='.length).trim();
      if (v) tenantId = v;
    }
  }

  return { apply, batchSize, limit, tenantId };
}

/**
 * Page through `marketplace_purchases` ordered by `id` so the cursor is
 * stable across iterations even when concurrent writes shift
 * `created_at`. Returns at most `batchSize` rows whose id is strictly
 * greater than `afterId` (`null` for the first page).
 *
 * Filters:
 *   - `discount_badge_applied = FALSE` — idempotency guard.
 *   - At least one of `stripe_subscription_id` / `stripe_checkout_session_id`
 *     is set — rows with neither cannot be linked to a Stripe invoice.
 *   - Optional `tenant_id` scope when `--tenant=` is passed.
 */
/**
 * Snapshot the count of rows in the same tenant scope that already
 * carry `discount_badge_applied = TRUE`. Reported in the run summary
 * so an operator can read off "alreadyStamped + updated = total
 * badged" without joining live with the script output.
 *
 * Scoped by `--tenant` so a single-tenant run reports a single-tenant
 * total; an unscoped run reports the global total. The "stripe link
 * available" predicate matches `selectCandidatePage` so the two
 * counters align with the same population (rows that COULD be
 * backfilled), not with rows that have no Stripe handle to chase.
 */
export async function countAlreadyStamped(
  client: Pick<PoolClient, 'query'>,
  opts: CliOptions,
): Promise<number> {
  const conditions: string[] = [
    'discount_badge_applied = TRUE',
    '(stripe_subscription_id IS NOT NULL OR stripe_checkout_session_id IS NOT NULL)',
  ];
  const params: unknown[] = [];
  if (opts.tenantId) {
    params.push(opts.tenantId);
    conditions.push(`tenant_id = $${params.length}`);
  }
  const { rows } = await client.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM marketplace_purchases
      WHERE ${conditions.join(' AND ')}`,
    params,
  );
  const raw = rows[0]?.count ?? '0';
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function selectCandidatePage(
  client: Pick<PoolClient, 'query'>,
  opts: CliOptions,
  afterId: string | null,
): Promise<CandidateRow[]> {
  const conditions: string[] = [
    'discount_badge_applied = FALSE',
    '(stripe_subscription_id IS NOT NULL OR stripe_checkout_session_id IS NOT NULL)',
  ];
  const params: unknown[] = [];

  if (afterId !== null) {
    params.push(afterId);
    conditions.push(`id > $${params.length}`);
  }
  if (opts.tenantId) {
    params.push(opts.tenantId);
    conditions.push(`tenant_id = $${params.length}`);
  }

  params.push(opts.batchSize);
  const limitParamIdx = params.length;

  const sql = `SELECT id,
                      tenant_id,
                      template_id,
                      price_model,
                      stripe_subscription_id,
                      stripe_checkout_session_id
                 FROM marketplace_purchases
                WHERE ${conditions.join(' AND ')}
                ORDER BY id ASC
                LIMIT $${limitParamIdx}`;

  const { rows } = await client.query<CandidateRow>(sql, params);
  return rows;
}

/**
 * Resolve the latest Stripe invoice id for a candidate row. Returns
 * `null` when the row has no usable Stripe link (so the caller bumps
 * the `noStripeLink` counter and moves on without burning a Stripe API
 * call) — distinct from `apiFailure`, which is a thrown error.
 *
 * Two paths:
 *   1. Subscription (`monthly_subscription` / `usage_based`): retrieve
 *      the subscription with `expand: ['latest_invoice']` and read the
 *      invoice id off it. We ask Stripe for the latest invoice rather
 *      than walking the full history because (a) the task brief asks
 *      for it, and (b) coupon-aware badges only need a single hit per
 *      purchase row.
 *   2. One-off (`one_time` / anything else): retrieve the Checkout
 *      session with `expand: ['invoice']`. Sessions created with
 *      `invoice_creation: { enabled: true }` (the live code path since
 *      Task #1311) have an invoice attached. Older one-offs without
 *      invoice creation will return `null`, which the caller treats as
 *      `no_discount` (there is no invoice to badge — the receipt was a
 *      bare Charge).
 */
export async function resolveInvoiceId(
  stripe: Pick<Stripe, 'subscriptions' | 'checkout'>,
  row: CandidateRow,
): Promise<string | null> {
  const isSubscription = SUBSCRIPTION_PRICE_MODELS.has(row.price_model);

  if (isSubscription) {
    if (!row.stripe_subscription_id) return null;
    const sub = await stripe.subscriptions.retrieve(row.stripe_subscription_id, {
      expand: ['latest_invoice'],
    });
    const latest = (sub as unknown as {
      latest_invoice?: string | { id?: string } | null;
    }).latest_invoice;
    if (typeof latest === 'string') return latest;
    if (latest && typeof latest === 'object' && typeof latest.id === 'string') {
      return latest.id;
    }
    return null;
  }

  // One-off path: session → invoice.
  if (!row.stripe_checkout_session_id) return null;
  const session = await stripe.checkout.sessions.retrieve(
    row.stripe_checkout_session_id,
    { expand: ['invoice'] },
  );
  const invoice = (session as unknown as {
    invoice?: string | { id?: string } | null;
  }).invoice;
  if (typeof invoice === 'string') return invoice;
  if (invoice && typeof invoice === 'object' && typeof invoice.id === 'string') {
    return invoice.id;
  }
  return null;
}

/**
 * Retrieve the invoice with discounts expanded (the webhook payload
 * doesn't expand by default — see `handleInvoiceFinalized` in
 * `webhook.ts`) and return the first usable normalised discount, or
 * `null` when the invoice has none.
 */
export async function fetchInvoiceDiscount(
  stripe: Pick<Stripe, 'invoices'>,
  invoiceId: string,
): Promise<UpgradeDiscount | null> {
  const expanded = await stripe.invoices.retrieve(invoiceId, {
    expand: ['discounts', 'discounts.promotion_code'],
  });
  const rawDiscounts = (expanded as unknown as {
    discounts?: unknown[] | null;
  }).discounts ?? [];
  for (const raw of rawDiscounts) {
    if (typeof raw !== 'object' || raw === null) continue;
    const normalized = normalizeDiscount(
      raw as Parameters<typeof normalizeDiscount>[0],
    );
    if (normalized) return normalized;
  }
  return null;
}

export interface RunBackfillDeps {
  stripe: Pick<Stripe, 'subscriptions' | 'checkout' | 'invoices'>;
  /**
   * Mirror writer. Production wires this to
   * `applyInvoiceDiscountToPurchase` from `MarketplacePurchaseService`
   * — but wrapped by `wrapApplyWithVerification` (see `main`) so a
   * silent UPDATE-failure inside the live writer (which logs and
   * swallows) is surfaced as a per-row `api_failure` instead of being
   * counted as `updated`. Tests inject simpler stubs directly.
   */
  apply: (purchaseId: string, discount: UpgradeDiscount) => Promise<void>;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export interface RunBackfillResult {
  totals: BackfillTotals;
  outcomes: RowOutcome[];
}

/**
 * Wraps the live `applyInvoiceDiscountToPurchase` mirror with a
 * post-write verification: re-reads `discount_badge_applied` for the
 * row and throws if it didn't flip to TRUE. The live writer logs and
 * swallows DB errors (so a transient failure doesn't poison the
 * webhook delivery), which is the right call for the live path but
 * means the backfill could otherwise count a silently-failed UPDATE
 * as `updated`. Throwing here demotes those to `api_failure` so the
 * summary's `updated` count means "verified-stamped on disk".
 *
 * Exported for the unit test (so we can assert on the verifying
 * UPDATE-then-SELECT semantics without spinning up a real DB).
 */
export function wrapApplyWithVerification(
  liveApply: (purchaseId: string, discount: UpgradeDiscount) => Promise<void>,
  client: Pick<PoolClient, 'query'>,
): (purchaseId: string, discount: UpgradeDiscount) => Promise<void> {
  return async (purchaseId, discount) => {
    await liveApply(purchaseId, discount);
    const { rows } = await client.query<{ discount_badge_applied: boolean }>(
      `SELECT discount_badge_applied
         FROM marketplace_purchases
        WHERE id = $1`,
      [purchaseId],
    );
    const flipped = rows[0]?.discount_badge_applied === true;
    if (!flipped) {
      throw new Error(
        `applyInvoiceDiscountToPurchase silently failed for purchase=${purchaseId} ` +
          `(discount_badge_applied is still FALSE / row missing)`,
      );
    }
  };
}

/**
 * Process a single candidate row end-to-end: resolve invoice id →
 * fetch + normalise discount → (when not dry-run) call the mirror
 * writer. Returns the per-row outcome so the caller can update both the
 * tally and the per-row log line.
 */
export async function processRow(
  row: CandidateRow,
  opts: CliOptions,
  deps: RunBackfillDeps,
): Promise<RowOutcome> {
  let invoiceId: string | null;
  try {
    invoiceId = await resolveInvoiceId(deps.stripe, row);
  } catch (err) {
    return { kind: 'api_failure', purchaseId: row.id, error: String(err) };
  }
  if (!invoiceId) {
    return { kind: 'no_stripe_link', purchaseId: row.id };
  }

  let discount: UpgradeDiscount | null;
  try {
    discount = await fetchInvoiceDiscount(deps.stripe, invoiceId);
  } catch (err) {
    return { kind: 'api_failure', purchaseId: row.id, error: String(err) };
  }
  if (!discount) {
    return { kind: 'no_discount', purchaseId: row.id, invoiceId };
  }

  if (opts.apply) {
    try {
      await deps.apply(row.id, discount);
    } catch (err) {
      return { kind: 'api_failure', purchaseId: row.id, error: String(err) };
    }
  }
  return { kind: 'updated', purchaseId: row.id, invoiceId };
}

/**
 * Pure-loop driver. Pages through candidates with `selectCandidatePage`,
 * processes each row via `processRow`, and accumulates a structured
 * tally. Caller owns the Pool / transaction lifecycle (the live writer
 * does its own one-row UPDATE per call, so a long-running outer
 * transaction would just hold locks for nothing).
 */
export async function runBackfill(
  client: Pick<PoolClient, 'query'>,
  opts: CliOptions,
  deps: RunBackfillDeps,
): Promise<RunBackfillResult> {
  const logger = deps.logger ?? console;
  const totals: BackfillTotals = {
    scanned: 0,
    updated: 0,
    noDiscount: 0,
    noStripeLink: 0,
    apiFailures: 0,
  };
  const outcomes: RowOutcome[] = [];
  let cursor: string | null = null;

  while (true) {
    if (opts.limit != null && totals.scanned >= opts.limit) break;

    // Cap the page size at the remaining limit so we don't over-fetch
    // the last page when --limit is set.
    const remainingLimit =
      opts.limit != null ? opts.limit - totals.scanned : null;
    const pageOpts: CliOptions =
      remainingLimit != null && remainingLimit < opts.batchSize
        ? { ...opts, batchSize: remainingLimit }
        : opts;

    const page = await selectCandidatePage(client, pageOpts, cursor);
    if (page.length === 0) break;

    for (const row of page) {
      totals.scanned += 1;
      const outcome = await processRow(row, opts, deps);
      outcomes.push(outcome);
      switch (outcome.kind) {
        case 'updated':
          totals.updated += 1;
          logger.log(
            `[BACKFILL] updated purchase=${outcome.purchaseId} invoice=${outcome.invoiceId}`,
          );
          break;
        case 'no_discount':
          totals.noDiscount += 1;
          break;
        case 'no_stripe_link':
          totals.noStripeLink += 1;
          break;
        case 'api_failure':
          totals.apiFailures += 1;
          logger.warn(
            `[BACKFILL] api_failure purchase=${outcome.purchaseId} error=${outcome.error}`,
          );
          break;
      }
      cursor = row.id;
      if (opts.limit != null && totals.scanned >= opts.limit) break;
    }
  }

  return { totals, outcomes };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
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
      throw new Error(
        '[BACKFILL] PLATFORM_DB_POOL_URL is not set for production/staging.',
      );
    }
    sslConfig = { rejectUnauthorized: false };
  }

  console.log(
    `[BACKFILL] marketplace-purchase-discounts env=${env} batch=${opts.batchSize}` +
      `${opts.limit != null ? ` limit=${opts.limit}` : ''}` +
      `${opts.tenantId ? ` tenant=${opts.tenantId}` : ''}` +
      `${opts.apply ? '' : ' (DRY RUN — pass --apply to write)'}`,
  );

  // Lazy imports keep test runs from pulling the live Stripe client +
  // service module (which themselves depend on env-validated config) at
  // import time. The unit test imports `runBackfill` / `processRow` /
  // helpers directly and never reaches `main()`.
  const { getStripeClient } = await import('../platform/billing/stripe/client');
  const { applyInvoiceDiscountToPurchase } = await import(
    '../platform/marketplace/MarketplacePurchaseService'
  );
  const stripe = getStripeClient();

  const pool = new Pool({
    connectionString: url,
    max: 2,
    ...(sslConfig ? { ssl: sslConfig } : {}),
  });
  const client = await pool.connect();
  let result: RunBackfillResult;
  let alreadyStamped: number;
  try {
    alreadyStamped = await countAlreadyStamped(client, opts);
    result = await runBackfill(client, opts, {
      stripe,
      apply: wrapApplyWithVerification(applyInvoiceDiscountToPurchase, client),
    });
  } finally {
    client.release();
    await pool.end();
  }

  // In dry-run mode the per-row "updated" classification means
  // "would update if --apply were set" — no UPDATE is issued. Surface
  // that in the summary label so an operator never confuses a dry-run
  // tally with a write tally.
  const updateLabel = opts.apply ? 'updated' : 'would_update';
  console.log(
    `[BACKFILL] scanned=${result.totals.scanned} ` +
      `${updateLabel}=${result.totals.updated} ` +
      `no_discount=${result.totals.noDiscount} ` +
      `no_stripe_link=${result.totals.noStripeLink} ` +
      `api_failures=${result.totals.apiFailures} ` +
      `already_stamped=${alreadyStamped}` +
      `${opts.apply ? '' : ' (DRY RUN — no writes performed)'}`,
  );
  if (opts.limit != null && result.totals.scanned >= opts.limit) {
    console.log(`[BACKFILL] Stopped after --limit=${opts.limit} rows.`);
  }
}

// Only auto-run when invoked as a script (`tsx scripts/...`), not when
// the test imports the helpers above for its fake-client harness.
const invokedAsScript =
  typeof process.argv[1] === 'string' &&
  /backfill-marketplace-purchase-discounts\.ts$/.test(process.argv[1]);
if (invokedAsScript) {
  main().catch((err) => {
    console.error('[BACKFILL] Failed:', err);
    process.exit(1);
  });
}
