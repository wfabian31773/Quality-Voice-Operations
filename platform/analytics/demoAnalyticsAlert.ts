/**
 * Raises a high-severity platform alert when a write to the `demo_analytics`
 * table fails.
 *
 * The public Demo page POSTs to `/demo/track-cta` whenever a prospect clicks
 * "Start Free Trial" or "Book a Demo" after completing a demo call. That
 * handler calls `recordDemoAnalyticsEvent`, which catches DB errors so the
 * user-facing flow is never broken — but if the underlying insert silently
 * fails (table missing, DB down, connection pool exhausted, schema drift,
 * etc.), the highest-intent leads on the marketing site are dropped on the
 * floor with nothing more than a `logger.warn`. Nobody is paged.
 *
 * This helper closes that gap. On a write failure it writes a `critical`
 * row to `error_logs` (the same channel `raiseDeliveryFailureAlert` and
 * `raiseReplyDeliveryFailureAlert` use for high-priority infra issues), so
 * the existing ops surfaces (`/admin/reliability`, error-log digests,
 * downstream PagerDuty/Slack fan-out) all light up.
 *
 * Dedup
 * -----
 * A failure on the demo_analytics insert is almost always a symptom of a
 * shared infra problem (DB down, pool exhausted, schema drift) that will
 * affect *every* CTA click for as long as it lasts. Without dedup, a
 * downed DB would page ops once per click — exactly the spam pattern this
 * task calls out. We keep an in-memory cooldown keyed on the alert
 * (there is only one event type today) so:
 *
 *   - The first failure inside a quiet window fires immediately.
 *   - Subsequent failures inside DEMO_ANALYTICS_ALERT_DEDUP_MS just bump a
 *     suppressed-since-last counter.
 *   - The next failure after the cooldown expires fires again, and the
 *     suppressed count rides along in the alert metadata so ops can see
 *     how many CTA clicks were lost while we were silent.
 *
 * The dedup state is intentionally process-local. Anything more durable
 * would require writing through the same DB whose health we're trying to
 * report on. A multi-process deployment will at worst page once per
 * process per cooldown — still bounded, still well under the per-click
 * spam this is meant to prevent.
 */

import { logError } from '../core/observability';
import { createLogger } from '../core/logger';

const logger = createLogger('DEMO_ANALYTICS_ALERT');

/**
 * How long to suppress repeat alerts for the same failure mode. Tunable
 * via `DEMO_ANALYTICS_ALERT_DEDUP_MS` so support can tighten or relax the
 * cooldown during incident response without redeploying.
 */
export const DEFAULT_DEMO_ANALYTICS_ALERT_DEDUP_MS = 5 * 60_000;

function getDedupWindowMs(): number {
  const raw = process.env.DEMO_ANALYTICS_ALERT_DEDUP_MS;
  if (!raw) return DEFAULT_DEMO_ANALYTICS_ALERT_DEDUP_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_DEMO_ANALYTICS_ALERT_DEDUP_MS;
  }
  return parsed;
}

interface DedupState {
  lastAlertedAt: number;
  suppressedSinceLastAlert: number;
}

let dedupState: DedupState | null = null;

/**
 * Test-only hook: clears the in-memory cooldown so each test starts from
 * a known state. Not exported through any production index.
 */
export function __resetDemoAnalyticsAlertDedupForTests(): void {
  dedupState = null;
}

export interface DemoAnalyticsWriteFailureInput {
  /** The `event_type` that was being inserted (e.g. `cta_clicked`). */
  eventType: string;
  /** The `cta_type`, when this was a CTA click. */
  ctaType?: string | null;
  /** The `agent_type` the prospect was demoing, when known. */
  agentType?: string | null;
  /** The DB error captured by the caller. Stringified for the alert. */
  error: unknown;
}

/**
 * Reports a failed `demo_analytics` insert to the platform alert pipeline.
 *
 * Always safe to call from a `catch` block — it never throws. If the alert
 * write itself fails (e.g. error_logs is also unreachable) the failure is
 * logged and swallowed so the caller's user-facing path is unaffected.
 */
export async function raiseDemoAnalyticsWriteFailureAlert(
  input: DemoAnalyticsWriteFailureInput,
): Promise<void> {
  const { eventType, ctaType, agentType, error } = input;
  const now = Date.now();
  const windowMs = getDedupWindowMs();

  if (dedupState && now - dedupState.lastAlertedAt < windowMs) {
    dedupState.suppressedSinceLastAlert += 1;
    return;
  }

  const suppressedSinceLastAlert = dedupState?.suppressedSinceLastAlert ?? 0;
  dedupState = { lastAlertedAt: now, suppressedSinceLastAlert: 0 };

  const errorString = error instanceof Error ? error.message : String(error);
  const suppressedNote =
    suppressedSinceLastAlert > 0
      ? ` (${suppressedSinceLastAlert} additional failure(s) suppressed since last alert)`
      : '';
  const message =
    `Failed to record demo_analytics event "${eventType}"${suppressedNote}. ` +
    `Demo CTA click intent is being dropped — investigate the platform DB / ` +
    `demo_analytics table immediately.`;

  try {
    await logError(null, 'critical', message, {
      service: 'demo_analytics',
      errorCode: 'demo_analytics_write_failed',
      extra: {
        event_type: eventType,
        cta_type: ctaType ?? null,
        agent_type: agentType ?? null,
        error: errorString,
        suppressed_since_last_alert: suppressedSinceLastAlert,
        dedup_window_ms: windowMs,
      },
    });
  } catch (err) {
    // logError already swallows DB write failures internally, but guard
    // against a programmer error in the alert path bubbling up into the
    // caller's catch block and breaking the user-facing flow.
    logger.warn('Failed to dispatch demo_analytics write-failure alert', {
      error: String(err),
    });
  }
}
