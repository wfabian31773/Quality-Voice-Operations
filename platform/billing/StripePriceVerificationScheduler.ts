import { createLogger } from '../core/logger';
import { postToOpsSlackWebhook } from '../messaging/SlackWebhookNotifier';
import {
  verifyStripePrices,
  type VerifyStripePricesReport,
  type PriceCheckResult,
  type VerifyStripePricesSummary,
} from './stripe/verifyPrices';

const logger = createLogger('STRIPE_PRICE_DRIFT');

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const INITIAL_DELAY_MS = 30 * 1000;
const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;

function parseIntervalEnv(): number {
  const raw = process.env.STRIPE_PRICE_DRIFT_INTERVAL_MS;
  if (!raw) return DEFAULT_INTERVAL_MS;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_INTERVAL_MS || parsed > MAX_INTERVAL_MS) {
    logger.warn('Ignoring invalid STRIPE_PRICE_DRIFT_INTERVAL_MS — falling back to default', {
      raw,
      default: DEFAULT_INTERVAL_MS,
    });
    return DEFAULT_INTERVAL_MS;
  }
  return parsed;
}

function isFailure(status: VerifyStripePricesSummary['status']): boolean {
  return status === 'failed';
}

export interface StripePriceVerificationSnapshot {
  ranAt: string;
  source: 'scheduled' | 'manual';
  summary: VerifyStripePricesSummary;
  lastOkAt: string | null;
  lastFailureAt: string | null;
  regressed: boolean;
  slackNotified: boolean;
}

let latestSnapshot: StripePriceVerificationSnapshot | null = null;
let previousStatus: VerifyStripePricesSummary['status'] | null = null;
let lastOkAt: string | null = null;
let lastFailureAt: string | null = null;

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

export function getLatestStripePriceVerificationSnapshot(): StripePriceVerificationSnapshot | null {
  return latestSnapshot;
}

export function __resetStripePriceVerificationStateForTests(): void {
  latestSnapshot = null;
  previousStatus = null;
  lastOkAt = null;
  lastFailureAt = null;
}

function summariseFailures(results: PriceCheckResult[]): string[] {
  return results
    .filter((r) => r.status !== 'ok')
    .map((r) => {
      const detail = r.message ? ` — ${r.message}` : '';
      return `• \`${r.envKey}\` (${r.plan} ${r.interval}): *${r.status}*${detail}`;
    });
}

function buildRegressionSlackText(report: VerifyStripePricesReport): string {
  const failureLines = summariseFailures(report.results);
  const header = `:rotating_light: *Stripe price drift detected* — \`${report.summary.status}\` (${report.summary.failed}/${report.summary.total} failed)`;
  const trailer =
    'Live-rate badge will fall back to the catalog 20% rate until the env vars are re-pointed and the Admin API is redeployed.';
  if (failureLines.length === 0) {
    return [header, report.summary.message ?? '', trailer].filter(Boolean).join('\n');
  }
  return [header, ...failureLines, trailer].join('\n');
}

function buildRecoverySlackText(report: VerifyStripePricesReport): string {
  return [
    `:white_check_mark: *Stripe price drift recovered* — all ${report.summary.total} price env vars verified.`,
    report.summary.message ?? '',
  ]
    .filter(Boolean)
    .join('\n');
}

async function postSlackSafely(text: string): Promise<boolean> {
  try {
    const result = await postToOpsSlackWebhook({ text });
    if (result.success) return true;
    if (result.skipped) {
      logger.debug('Slack webhook not configured — skipping Stripe price drift alert');
    } else {
      logger.warn('Failed to deliver Stripe price drift alert to Slack', {
        error: result.error,
      });
    }
    return false;
  } catch (err) {
    logger.warn('Slack notification threw while alerting Stripe price drift', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export interface RunStripePriceVerificationOptions {
  source?: 'scheduled' | 'manual';
}

export async function runStripePriceVerificationCycle(
  options: RunStripePriceVerificationOptions = {},
): Promise<StripePriceVerificationSnapshot> {
  const source = options.source ?? 'scheduled';
  const report = await verifyStripePrices();
  const status = report.summary.status;

  // `no-stripe-key` means dev environments without keys; don't alert and
  // don't move the regression baseline forward.
  if (status === 'no-stripe-key') {
    const snapshot: StripePriceVerificationSnapshot = {
      ranAt: report.generatedAt,
      source,
      summary: report.summary,
      lastOkAt,
      lastFailureAt,
      regressed: false,
      slackNotified: false,
    };
    latestSnapshot = snapshot;
    return snapshot;
  }

  const failed = isFailure(status);
  // First observed failure (previousStatus null) also alerts so a process
  // restart that lands in a broken state still pages once.
  const regressed =
    (failed && previousStatus !== status) ||
    (!failed && previousStatus !== null && isFailure(previousStatus));

  let slackNotified = false;
  if (failed && previousStatus !== status) {
    slackNotified = await postSlackSafely(buildRegressionSlackText(report));
  } else if (!failed && previousStatus !== null && isFailure(previousStatus)) {
    slackNotified = await postSlackSafely(buildRecoverySlackText(report));
  }

  if (failed) {
    lastFailureAt = report.generatedAt;
  } else {
    lastOkAt = report.generatedAt;
    lastFailureAt = null;
  }
  previousStatus = status;

  const snapshot: StripePriceVerificationSnapshot = {
    ranAt: report.generatedAt,
    source,
    summary: report.summary,
    lastOkAt,
    lastFailureAt,
    regressed,
    slackNotified,
  };
  latestSnapshot = snapshot;

  logger.info('Stripe price verification cycle complete', {
    source,
    status,
    failed: report.summary.failed,
    total: report.summary.total,
    regressed,
    slackNotified,
  });

  return snapshot;
}

export function startStripePriceVerificationScheduler(
  intervalMs: number = parseIntervalEnv(),
): void {
  if (timer) return;

  initialTimer = setTimeout(() => {
    runStripePriceVerificationCycle().catch((err) => {
      logger.error('Initial Stripe price verification cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    runStripePriceVerificationCycle().catch((err) => {
      logger.error('Stripe price verification cycle failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, intervalMs);

  logger.info('Stripe price verification scheduler started', { intervalMs });
}

export function stopStripePriceVerificationScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Stripe price verification scheduler stopped');
  }
}
