import { createLogger } from '../core/logger';
import { postToOpsSlackWebhook } from '../messaging/SlackWebhookNotifier';
import { sendOpsAlert } from './reconciliation';
import {
  verifyStripePrices,
  type VerifyStripePricesReport,
  type PriceCheckResult,
  type VerifyStripePricesSummary,
} from './stripe/verifyPrices';
import {
  getLatestFailureScreenshotLinks,
  type LiveBillingHealthFailureScreenshotLinks,
} from './githubLiveBillingHealthArtifact';

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
  /**
   * Links to the latest failure screenshot artifact embedded into the
   * Slack regression alert, when the GitHub integration is configured
   * and the live-billing-health workflow has at least one prior
   * failure run on record. `null` for healthy / recovery / no-key
   * cycles, when GitHub config is missing, or when the lookup itself
   * failed (best-effort — never blocks the underlying alert).
   */
  failureScreenshotLinks: LiveBillingHealthFailureScreenshotLinks | null;
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

function buildScreenshotLinkLines(
  links: LiveBillingHealthFailureScreenshotLinks | null,
): string[] {
  if (!links) return [];
  const lines: string[] = [];
  if (links.artifactPageUrl) {
    // The artifact page is the deepest link we can produce with a
    // single API call — clicking it on a logged-in GitHub session
    // downloads the zip containing
    // `screenshots/platform-admin-billing-health-live-failure.png`.
    lines.push(`Latest failure screenshot artifact: ${links.artifactPageUrl}`);
  } else if (links.artifactExpired) {
    // The 14-day retention on the upload-artifact step expired before
    // we could surface the screenshot — point on-call at the run page
    // anyway since the spec log + sister tracking issue are still
    // useful triage context.
    lines.push(
      `Latest failure run (artifact expired — only the spec log remains): ${links.workflowRunHtmlUrl}`,
    );
  } else {
    lines.push(`Latest failure run: ${links.workflowRunHtmlUrl}`);
  }
  return lines;
}

async function loadFailureScreenshotLinksSafely(): Promise<
  LiveBillingHealthFailureScreenshotLinks | null
> {
  try {
    return await getLatestFailureScreenshotLinks();
  } catch (err) {
    // Defence in depth — `getLatestFailureScreenshotLinks` already
    // catches its own errors, but if a future refactor lets one
    // escape we still want the underlying drift alert to fire rather
    // than silently failing because of an unrelated GitHub API hiccup.
    logger.warn('Failed to fetch failure-screenshot links for Slack alert', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function buildRegressionSlackText(
  report: VerifyStripePricesReport,
  failureLinks: LiveBillingHealthFailureScreenshotLinks | null,
): string {
  const failureLines = summariseFailures(report.results);
  const header = `:rotating_light: *Stripe price drift detected* — \`${report.summary.status}\` (${report.summary.failed}/${report.summary.total} failed)`;
  const trailer =
    'Live-rate badge will fall back to the catalog 20% rate until the env vars are re-pointed and the Admin API is redeployed.';
  const screenshotLines = buildScreenshotLinkLines(failureLinks);
  if (failureLines.length === 0) {
    return [header, report.summary.message ?? '', trailer, ...screenshotLines]
      .filter(Boolean)
      .join('\n');
  }
  return [header, ...failureLines, trailer, ...screenshotLines].join('\n');
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

/**
 * Wrap the same alert content into an HTML email body and send via
 * the unified ops-alert path (cost audit fix #5, commit 4/4). This is
 * the channel that always lands — `postSlackSafely` above is a no-op
 * when `OPS_SLACK_WEBHOOK_URL` is unset (which it is in QVO, since
 * there's no Slack workspace), and before this commit the regression
 * + recovery alerts had been silently dropping.
 */
async function sendOpsEmailSafely(
  subjectShort: string,
  bodyText: string,
  severity: 'warning' | 'urgent',
): Promise<boolean> {
  try {
    const result = await sendOpsAlert({
      severity,
      subject: subjectShort,
      // Render the Slack-style plain text as preformatted HTML so
      // newlines + indentation survive the email-client text→HTML
      // squash. Strip Slack's `:emoji:` syntax → empty so it doesn't
      // appear literally in the inbox.
      bodyHtml: `<pre style="font-family:system-ui,Segoe UI,sans-serif;white-space:pre-wrap;">${bodyText
        .replace(/</g, '&lt;')
        .replace(/:[\w_+\-]+:/g, '')
        .replace(/\*([^*]+)\*/g, '<strong>$1</strong>')}</pre>`,
      bodyText,
      source: 'stripe_price_drift',
    });
    return result.success === true;
  } catch (err) {
    logger.warn('Ops email failed while alerting Stripe price drift', {
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
      failureScreenshotLinks: null,
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
  let failureScreenshotLinks: LiveBillingHealthFailureScreenshotLinks | null = null;
  if (failed && previousStatus !== status) {
    // Fetch the GitHub-hosted failure screenshot artifact link (if
    // configured) so on-call can confirm the visual regression
    // directly from the alert thread without bouncing through the
    // Admin console. Best-effort — `loadFailureScreenshotLinksSafely`
    // returns null for unconfigured / empty / errored lookups so the
    // underlying Slack alert always fires regardless.
    failureScreenshotLinks = await loadFailureScreenshotLinksSafely();
    const regressionText = buildRegressionSlackText(report, failureScreenshotLinks);
    slackNotified = await postSlackSafely(regressionText);
    // Fan-out to email regardless of Slack outcome so the alert lands
    // somewhere even when Slack is unconfigured (which is the QVO
    // default state — see audit doc commit 4/4 for context).
    await sendOpsEmailSafely(
      `Stripe price drift — ${report.summary.failed}/${report.summary.total} failed`,
      regressionText,
      'urgent',
    );
  } else if (!failed && previousStatus !== null && isFailure(previousStatus)) {
    const recoveryText = buildRecoverySlackText(report);
    slackNotified = await postSlackSafely(recoveryText);
    await sendOpsEmailSafely(
      'Stripe price drift recovered',
      recoveryText,
      'warning',
    );
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
    failureScreenshotLinks,
  };
  latestSnapshot = snapshot;

  logger.info('Stripe price verification cycle complete', {
    source,
    status,
    failed: report.summary.failed,
    total: report.summary.total,
    regressed,
    slackNotified,
    failureScreenshotLinked: failureScreenshotLinks !== null,
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
