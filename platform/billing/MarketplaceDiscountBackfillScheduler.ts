/**
 * Scheduled drift detector for the marketplace "Discount applied" badge.
 *
 * Background
 * ----------
 * The Stripe `invoice.finalized` webhook is the live mirror that
 * stamps `marketplace_purchases.discount_*` columns at finalize time
 * (see `platform/billing/stripe/webhook.ts`). If a webhook delivery is
 * ever dropped (signature mismatch, downstream DB blip, deploy window),
 * the in-app badge silently falls behind the receipt PDF and Finance
 * doesn't notice until reconciliation.
 *
 * `scripts/backfill-marketplace-purchase-discounts.ts` is the manual
 * one-shot to repair such drift. This scheduler runs the same script
 * in dry-run mode on a schedule and pages ops via Slack when the
 * dry-run reports a non-zero `updated` count — i.e. there are rows
 * that the live mirror missed and the backfill would stamp on demand.
 *
 * Mirrors the alerting pattern in `StripePriceVerificationScheduler`:
 * one alert on the rising edge (no drift → drift), one alert on
 * recovery (drift → no drift), no re-alerting while the same drift
 * persists across cycles.
 */

import type { PoolClient } from 'pg';
import type Stripe from 'stripe';

import { createLogger } from '../core/logger';
import { getPlatformPool } from '../db';
import { postToOpsSlackWebhook } from '../messaging/SlackWebhookNotifier';
import {
  runBackfill,
  type CliOptions,
  type RunBackfillResult,
} from '../../scripts/backfill-marketplace-purchase-discounts';

const logger = createLogger('MARKETPLACE_DISCOUNT_BACKFILL');

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
// Kept well below MIN_INTERVAL_MS so the boot-time setTimeout and the
// first setInterval tick can never coincide even if the interval is
// configured to the minimum. Mirrors the 30s warm-up used by
// StripePriceVerificationScheduler.
const INITIAL_DELAY_MS = 30 * 1000;
const MIN_INTERVAL_MS = 5 * 60 * 1000;
const MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PURCHASE_IDS_IN_ALERT = 25;

function parseIntervalEnv(): number {
  const raw = process.env.MARKETPLACE_DISCOUNT_BACKFILL_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (
    !Number.isFinite(parsed) ||
    parsed < MIN_INTERVAL_MS ||
    parsed > MAX_INTERVAL_MS
  ) {
    logger.warn(
      'Ignoring invalid MARKETPLACE_DISCOUNT_BACKFILL_INTERVAL_MS — falling back to default',
      { raw, default: DEFAULT_INTERVAL_MS },
    );
    return DEFAULT_INTERVAL_MS;
  }
  return parsed;
}

export type MarketplaceDiscountBackfillSkipReason =
  | 'no-stripe-key'
  | 'deps-init-failed'
  | 'backfill-failed';

export interface MarketplaceDiscountBackfillSnapshot {
  ranAt: string;
  source: 'scheduled' | 'manual';
  scanned: number;
  /**
   * Count of rows whose dry-run classification was `updated` —
   * i.e. they have a Stripe-side discount the in-app badge is
   * missing. The scheduler does NOT issue UPDATEs; this is the
   * "would_update" figure operators get from the script summary.
   */
  wouldUpdate: number;
  noDiscount: number;
  noStripeLink: number;
  apiFailures: number;
  /**
   * Up to MAX_PURCHASE_IDS_IN_ALERT ids of purchases that need a
   * backfill, surfaced in the Slack alert. The full list lives in the
   * script run logs an operator triggers manually via `--apply`.
   */
  driftedPurchaseIds: string[];
  truncatedPurchaseIds: boolean;
  driftDetected: boolean;
  regressed: boolean;
  slackNotified: boolean;
  skippedReason?: MarketplaceDiscountBackfillSkipReason;
  skippedError?: string;
}

let latestSnapshot: MarketplaceDiscountBackfillSnapshot | null = null;
let previousDriftDetected: boolean | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;
// Guards against scheduler-driven double-fire: if a cycle is still
// running when the next tick arrives (e.g. very long Stripe round
// trips on a large candidate set), the next tick is skipped rather
// than queued behind the in-flight cycle. Manual `runCycle` calls do
// not honour this guard so unit tests / admin "run now" buttons stay
// deterministic.
let cycleInFlight = false;

export function getLatestMarketplaceDiscountBackfillSnapshot(): MarketplaceDiscountBackfillSnapshot | null {
  return latestSnapshot;
}

export function __resetMarketplaceDiscountBackfillStateForTests(): void {
  latestSnapshot = null;
  previousDriftDetected = null;
  cycleInFlight = false;
}

interface CycleDeps {
  stripe: Pick<Stripe, 'subscriptions' | 'checkout' | 'invoices'>;
  client: Pick<PoolClient, 'query'>;
}

export interface RunMarketplaceDiscountBackfillCycleOptions {
  source?: 'scheduled' | 'manual';
  /**
   * Inject a custom dependency factory. The default acquires a
   * `getPlatformPool()` client and lazily imports the live Stripe
   * client (so the env-validated client never enters the import graph
   * of test files that import this module).
   */
  acquireDeps?: () => Promise<{
    deps: CycleDeps;
    release: () => Promise<void> | void;
  }>;
  /**
   * Override CLI options. `apply` is force-set to FALSE regardless of
   * what's passed — the scheduler never writes.
   */
  options?: Partial<CliOptions>;
  /**
   * Inject a stand-in for `runBackfill`. Tests use this instead of
   * mocking the script module to keep the test file self-contained.
   */
  runBackfillFn?: typeof runBackfill;
}

function defaultCliOptions(overrides?: Partial<CliOptions>): CliOptions {
  // `apply` is force-set to FALSE after spreading overrides so callers
  // can't accidentally promote a scheduled cycle to a write run.
  const merged: CliOptions = {
    apply: false,
    batchSize: 200,
    limit: null,
    tenantId: null,
    ...(overrides ?? {}),
  };
  merged.apply = false;
  return merged;
}

async function defaultAcquireDeps(): Promise<{
  deps: CycleDeps;
  release: () => Promise<void>;
}> {
  const { getStripeClient } = await import('./stripe/client');
  const stripe = getStripeClient();
  const pool = getPlatformPool();
  const client = await pool.connect();
  return {
    deps: { stripe, client },
    release: async () => client.release(),
  };
}

function buildDriftSlackText(snapshot: MarketplaceDiscountBackfillSnapshot): string {
  const idsLine =
    snapshot.driftedPurchaseIds.length === 0
      ? ''
      : '\n*Affected purchase ids:*\n' +
        snapshot.driftedPurchaseIds.map((id) => `• \`${id}\``).join('\n') +
        (snapshot.truncatedPurchaseIds
          ? `\n…and ${snapshot.wouldUpdate - snapshot.driftedPurchaseIds.length} more (truncated)`
          : '');
  return [
    `:rotating_light: *Marketplace discount drift detected* — ${snapshot.wouldUpdate} purchase(s) need a backfill`,
    `Scanned ${snapshot.scanned}; api_failures=${snapshot.apiFailures}.`,
    'Promote with `tsx scripts/backfill-marketplace-purchase-discounts.ts --apply` after confirming the diff.',
    idsLine,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildRecoverySlackText(
  snapshot: MarketplaceDiscountBackfillSnapshot,
): string {
  return [
    ':white_check_mark: *Marketplace discount drift recovered* — dry-run found 0 purchases needing a backfill.',
    `Scanned ${snapshot.scanned}.`,
  ].join('\n');
}

async function postSlackSafely(text: string): Promise<boolean> {
  try {
    const result = await postToOpsSlackWebhook({ text });
    if (result.success) return true;
    if (result.skipped) {
      logger.debug(
        'Slack webhook not configured — skipping marketplace discount drift alert',
      );
    } else {
      logger.warn(
        'Failed to deliver marketplace discount drift alert to Slack',
        { error: result.error },
      );
    }
    return false;
  } catch (err) {
    logger.warn('Slack notification threw while alerting marketplace discount drift', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function makeSkippedSnapshot(
  source: 'scheduled' | 'manual',
  reason: MarketplaceDiscountBackfillSkipReason,
  error: string,
): MarketplaceDiscountBackfillSnapshot {
  return {
    ranAt: new Date().toISOString(),
    source,
    scanned: 0,
    wouldUpdate: 0,
    noDiscount: 0,
    noStripeLink: 0,
    apiFailures: 0,
    driftedPurchaseIds: [],
    truncatedPurchaseIds: false,
    driftDetected: false,
    regressed: false,
    slackNotified: false,
    skippedReason: reason,
    skippedError: error,
  };
}

export async function runMarketplaceDiscountBackfillCycle(
  options: RunMarketplaceDiscountBackfillCycleOptions = {},
): Promise<MarketplaceDiscountBackfillSnapshot> {
  const source = options.source ?? 'scheduled';
  const cliOptions = defaultCliOptions(options.options);
  const acquireDeps = options.acquireDeps ?? defaultAcquireDeps;
  const runBackfillFn = options.runBackfillFn ?? runBackfill;

  let acquired: Awaited<ReturnType<typeof acquireDeps>>;
  try {
    acquired = await acquireDeps();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Treat missing Stripe key the same way the price-drift scheduler
    // treats `no-stripe-key`: log + skip without moving the alert
    // baseline. Devs running without Stripe should never get paged.
    const isNoKey = /STRIPE_SECRET_KEY/.test(error);
    const reason: MarketplaceDiscountBackfillSkipReason = isNoKey
      ? 'no-stripe-key'
      : 'deps-init-failed';
    logger.info(
      'Marketplace discount backfill cycle skipped — could not acquire dependencies',
      { reason, error },
    );
    const snapshot = makeSkippedSnapshot(source, reason, error);
    latestSnapshot = snapshot;
    return snapshot;
  }

  let result: RunBackfillResult;
  try {
    result = await runBackfillFn(acquired.deps.client, cliOptions, {
      stripe: acquired.deps.stripe,
      // Defensive: cliOptions.apply is hard-coded to FALSE so processRow
      // never reaches this branch. If it ever does, throw loudly rather
      // than silently mutating production data from a scheduled job.
      apply: async () => {
        throw new Error(
          'Scheduled marketplace discount backfill must run in dry-run mode; refusing to write.',
        );
      },
      logger: {
        log: () => {},
        warn: (msg) => logger.warn(typeof msg === 'string' ? msg : String(msg)),
        error: (msg) =>
          logger.error(typeof msg === 'string' ? msg : String(msg)),
      },
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.error('Marketplace discount backfill cycle threw inside runBackfill', {
      error,
    });
    const snapshot = makeSkippedSnapshot(source, 'backfill-failed', error);
    latestSnapshot = snapshot;
    try {
      await acquired.release();
    } catch (releaseErr) {
      logger.warn('Failed to release backfill DB client after error', {
        error:
          releaseErr instanceof Error
            ? releaseErr.message
            : String(releaseErr),
      });
    }
    return snapshot;
  }

  try {
    await acquired.release();
  } catch (err) {
    logger.warn('Failed to release backfill DB client', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const driftIds = result.outcomes
    .filter(
      (o): o is Extract<typeof o, { kind: 'updated' }> => o.kind === 'updated',
    )
    .map((o) => o.purchaseId);
  const truncated = driftIds.length > MAX_PURCHASE_IDS_IN_ALERT;
  const driftedPurchaseIds = truncated
    ? driftIds.slice(0, MAX_PURCHASE_IDS_IN_ALERT)
    : driftIds;
  const driftDetected = result.totals.updated > 0;
  // First observed drift (previousDriftDetected null) also alerts so a
  // process restart that lands in a drifted state still pages once.
  const regressed =
    (driftDetected && previousDriftDetected !== true) ||
    (!driftDetected && previousDriftDetected === true);

  const snapshot: MarketplaceDiscountBackfillSnapshot = {
    ranAt: new Date().toISOString(),
    source,
    scanned: result.totals.scanned,
    wouldUpdate: result.totals.updated,
    noDiscount: result.totals.noDiscount,
    noStripeLink: result.totals.noStripeLink,
    apiFailures: result.totals.apiFailures,
    driftedPurchaseIds,
    truncatedPurchaseIds: truncated,
    driftDetected,
    regressed,
    slackNotified: false,
  };

  let slackNotified = false;
  if (driftDetected && previousDriftDetected !== true) {
    slackNotified = await postSlackSafely(buildDriftSlackText(snapshot));
  } else if (!driftDetected && previousDriftDetected === true) {
    slackNotified = await postSlackSafely(buildRecoverySlackText(snapshot));
  }
  snapshot.slackNotified = slackNotified;
  previousDriftDetected = driftDetected;
  latestSnapshot = snapshot;

  logger.info('Marketplace discount backfill cycle complete', {
    source,
    scanned: snapshot.scanned,
    wouldUpdate: snapshot.wouldUpdate,
    apiFailures: snapshot.apiFailures,
    driftDetected,
    regressed,
    slackNotified,
  });

  return snapshot;
}

async function runScheduledCycleWithLock(label: string): Promise<void> {
  if (cycleInFlight) {
    logger.info(
      'Skipping marketplace discount backfill tick — previous cycle still running',
      { label },
    );
    return;
  }
  cycleInFlight = true;
  try {
    await runMarketplaceDiscountBackfillCycle();
  } catch (err) {
    logger.error(`${label} marketplace discount backfill cycle failed`, {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    cycleInFlight = false;
  }
}

export function startMarketplaceDiscountBackfillScheduler(
  intervalMs: number = parseIntervalEnv(),
): void {
  if (timer) return;
  initialTimer = setTimeout(() => {
    void runScheduledCycleWithLock('Initial');
  }, INITIAL_DELAY_MS);
  timer = setInterval(() => {
    void runScheduledCycleWithLock('Periodic');
  }, intervalMs);
  logger.info('Marketplace discount backfill scheduler started', { intervalMs });
}

export function stopMarketplaceDiscountBackfillScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Marketplace discount backfill scheduler stopped');
  }
}
