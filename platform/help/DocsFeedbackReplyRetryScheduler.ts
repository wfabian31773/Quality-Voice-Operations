/**
 * Background worker that auto-retries transient SMTP failures on outbound
 * docs_feedback_replies. Wakes up every 90 seconds, finds outbound replies
 * that failed to send within the last hour and still have retries remaining,
 * and re-sends them through the same renderDocsFeedbackReplyEmail() +
 * sendEmail() path used by the manual /retry endpoint in
 * server/admin-api/routes/support.ts.
 *
 * Modelled on platform/help/SupportReplyRetryScheduler.ts so the docs feedback
 * pipeline behaves identically to the support pipeline for ops:
 *   - cap at MAX_RETRY_ATTEMPTS (= alert threshold) so a human still sees a
 *     Failed badge eventually,
 *   - gate every send on `isDocsFeedbackReplyPermanentFailure` so 5xx /
 *     mailbox-unknown / recipient-rejected hard failures are skipped exactly
 *     once and bumped straight to the cap (the same row-level helper drives
 *     `partitionFailuresByPermanence` in the digest scheduler so the two
 *     schedulers cannot disagree on what is permanent),
 *   - claim each row atomically (conditional UPDATE keyed on the observed
 *     retry_count) so concurrent workers / instances cannot double-send,
 *   - raise a critical error_log when a reply crosses the failure threshold
 *     so ops can intervene before the daily digest surfaces it.
 */

import { createLogger } from '../core/logger';
import { getPlatformPool } from '../db';
import { sendEmail } from '../email/EmailService';
import { isPermanentSmtpError, isDocsFeedbackReplyPermanentFailure } from '../email/smtpErrorClass';
import { renderDocsFeedbackReplyEmail } from './docsFeedbackReplyEmail';
import {
  DOCS_FEEDBACK_REPLY_DELIVERY_ALERT_THRESHOLD,
  raiseDocsFeedbackReplyDeliveryFailureAlert,
} from './docsFeedbackReplyDeliveryAlert';

const logger = createLogger('DOCS_FEEDBACK_REPLY_RETRY');

const CHECK_INTERVAL_MS = 90 * 1000; // every 90 seconds
const INITIAL_DELAY_MS = 30 * 1000;
const LOOKBACK_MINUTES = 60;
// Sourced from the alert threshold so the retry cap and the ops-alert boundary
// stay in lockstep — editing one updates both.
const MAX_RETRY_ATTEMPTS = DOCS_FEEDBACK_REPLY_DELIVERY_ALERT_THRESHOLD;
const BATCH_LIMIT = 25;

export interface FailedOutboundDocsReply {
  reply_id: number;
  feedback_id: number;
  article_slug: string;
  to_email: string;
  subject: string;
  body: string;
  email_error: string;
  retry_count: number;
  original_comment: string | null;
}

export async function findFailedOutboundDocsFeedbackReplies(
  maxAttempts: number = MAX_RETRY_ATTEMPTS,
  lookbackMinutes: number = LOOKBACK_MINUTES,
  limit: number = BATCH_LIMIT,
): Promise<FailedOutboundDocsReply[]> {
  const pool = getPlatformPool();
  // Critical: skip any failed reply that already has a NEWER reply in the
  // same feedback chain. The manual /retry endpoint INSERTs a new
  // docs_feedback_replies row (with retry_of pointing at the chain root)
  // instead of updating the failed row in place, so without this guard the
  // scheduler would happily re-send the original (now-stale) failed row even
  // after an admin's manual retry already succeeded — the reader would get
  // the same reply twice. The "no newer row exists for this feedback"
  // predicate covers both successful manual retries (newer row, no
  // email_error) and failed manual retries (newer row, with email_error —
  // we want to retry THAT one, not this older sibling).
  const r = await pool.query<FailedOutboundDocsReply>(
    `SELECT r.id            AS reply_id,
            r.feedback_id   AS feedback_id,
            f.article_slug  AS article_slug,
            r.to_email      AS to_email,
            r.subject       AS subject,
            r.body          AS body,
            r.email_error   AS email_error,
            r.retry_count   AS retry_count,
            f.comment       AS original_comment
     FROM docs_feedback_replies r
     JOIN docs_feedback f ON f.id = r.feedback_id
     WHERE r.email_error IS NOT NULL
       AND r.retry_count < $1
       AND r.created_at >= NOW() - ($2 || ' minutes')::interval
       AND r.to_email IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM docs_feedback_replies r2
         WHERE r2.feedback_id = r.feedback_id
           AND r2.id <> r.id
           AND r2.created_at > r.created_at
       )
     ORDER BY r.created_at ASC
     LIMIT $3`,
    [maxAttempts, String(lookbackMinutes), limit],
  );
  return r.rows;
}

export interface DocsRetryAttemptResult {
  reply_id: number;
  feedback_id: number;
  attempt: number;
  delivered: boolean;
  error: string | null;
}

/**
 * Atomically claim a candidate row for this worker before sending. The claim
 * is a conditional UPDATE that only succeeds when the row is still in the
 * exact state we observed during the SELECT — same retry_count, still failed.
 * If a concurrent cycle (or another instance) got there first, `retry_count`
 * will have been bumped and the WHERE clause matches zero rows, so we skip
 * without sending. The bump also reserves an attempt slot, so even if our
 * send crashes mid-flight we won't infinite-loop on the same row.
 */
async function claimReplyForRetry(reply: FailedOutboundDocsReply): Promise<boolean> {
  const pool = getPlatformPool();
  const r = await pool.query<{ id: number }>(
    `UPDATE docs_feedback_replies
     SET retry_count = retry_count + 1,
         last_retry_at = NOW()
     WHERE id = $1
       AND email_error IS NOT NULL
       AND retry_count = $2
     RETURNING id`,
    [reply.reply_id, reply.retry_count ?? 0],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Atomically jump retry_count straight to MAX_RETRY_ATTEMPTS for a reply we've
 * decided is permanently undeliverable. Same conditional-UPDATE shape as the
 * regular claim so we don't race a concurrent worker. Returns true when this
 * worker actually made the transition (so we know whether to fire the alert).
 */
async function markReplyPermanentlyFailed(reply: FailedOutboundDocsReply): Promise<boolean> {
  const pool = getPlatformPool();
  const r = await pool.query<{ id: number }>(
    `UPDATE docs_feedback_replies
     SET retry_count = $3,
         last_retry_at = NOW()
     WHERE id = $1
       AND email_error IS NOT NULL
       AND retry_count = $2
     RETURNING id`,
    [reply.reply_id, reply.retry_count ?? 0, MAX_RETRY_ATTEMPTS],
  );
  return (r.rowCount ?? 0) > 0;
}

async function retrySingleReply(
  reply: FailedOutboundDocsReply,
): Promise<DocsRetryAttemptResult | null> {
  const claimed = await claimReplyForRetry(reply);
  if (!claimed) {
    logger.debug('Docs feedback reply auto-retry skipped — claim lost to concurrent worker', {
      reply_id: reply.reply_id,
      feedback_id: reply.feedback_id,
    });
    return null;
  }

  const { html, text } = renderDocsFeedbackReplyEmail({
    articleSlug: reply.article_slug,
    originalComment: reply.original_comment,
    body: reply.body,
  });

  const result = await sendEmail({
    to: reply.to_email,
    subject: reply.subject,
    html,
    text,
  });

  const attempt = (reply.retry_count ?? 0) + 1;
  const newError = result.success ? null : (result.error ?? 'unknown');
  // Permanent if either the EmailService surfaced a structured permanent
  // flag (preferred — driven by the actual SMTP response code) or the error
  // string itself matches a known terminal pattern.
  const permanent = !result.success && (result.permanent === true || isPermanentSmtpError(newError));
  // Effective attempt count after this cycle: jump straight to MAX on a
  // permanent failure so the row leaves the auto-retry pool.
  const effectiveRetryCount = permanent ? MAX_RETRY_ATTEMPTS : attempt;

  const pool = getPlatformPool();
  try {
    if (permanent) {
      // Hard failure: record the outcome AND bump retry_count to MAX so the
      // next cycle leaves the row alone for a human to look at. Folded into
      // a single UPDATE so the row is consistent if either statement fails.
      await pool.query(
        `UPDATE docs_feedback_replies
         SET email_message_id = $2,
             email_error = $3,
             retry_count = $4
         WHERE id = $1`,
        [reply.reply_id, result.messageId ?? null, newError, MAX_RETRY_ATTEMPTS],
      );
    } else {
      // The claim already incremented retry_count and stamped last_retry_at;
      // here we just record the outcome (message id / error) of this attempt.
      await pool.query(
        `UPDATE docs_feedback_replies
         SET email_message_id = $2,
             email_error = $3
         WHERE id = $1`,
        [reply.reply_id, result.messageId ?? null, newError],
      );
    }
    if (result.success) {
      // Mirror the manual reply path: bump reply_count on docs_feedback when
      // the reply is finally delivered. Failed attempts never bumped it, so
      // the counter only tracks successful deliveries.
      try {
        await pool.query(
          `UPDATE docs_feedback SET reply_count = reply_count + 1 WHERE id = $1`,
          [reply.feedback_id],
        );
      } catch (err) {
        logger.warn('Failed to bump reply_count after auto-retry', {
          reply_id: reply.reply_id,
          feedback_id: reply.feedback_id,
          error: String(err),
        });
      }
    }
  } catch (err) {
    logger.error('Failed to persist docs feedback auto-retry result', {
      reply_id: reply.reply_id,
      feedback_id: reply.feedback_id,
      error: String(err),
    });
  }

  if (result.success) {
    logger.info('Docs feedback reply auto-retry succeeded', {
      reply_id: reply.reply_id,
      feedback_id: reply.feedback_id,
      attempt,
    });
  } else {
    const exhausted = effectiveRetryCount >= MAX_RETRY_ATTEMPTS;
    logger.warn('Docs feedback reply auto-retry failed', {
      reply_id: reply.reply_id,
      feedback_id: reply.feedback_id,
      attempt,
      effective_retry_count: effectiveRetryCount,
      max_attempts: MAX_RETRY_ATTEMPTS,
      error: newError ?? 'unknown',
      permanent,
      exhausted,
    });

    // Boundary-cross alert: when this failed attempt is the one that pushes
    // the reply's total attempt count to the configured threshold, raise a
    // critical error_log so ops can intervene. The strict-crossing check
    // naturally dedupes — retry_count only increases, so the threshold is
    // crossed exactly once per reply (regardless of whether the failed
    // attempts came from this scheduler or the manual /retry endpoint, which
    // both bump the same counter). Permanent failures jump retry_count to
    // MAX in one go, so we use the effective count here to make sure the
    // alert still fires on the very first hard bounce.
    const previousRetryCount = reply.retry_count ?? 0;
    if (
      previousRetryCount < DOCS_FEEDBACK_REPLY_DELIVERY_ALERT_THRESHOLD &&
      effectiveRetryCount >= DOCS_FEEDBACK_REPLY_DELIVERY_ALERT_THRESHOLD
    ) {
      raiseDocsFeedbackReplyDeliveryFailureAlert({
        replyId: reply.reply_id,
        feedbackId: reply.feedback_id,
        articleSlug: reply.article_slug,
        readerEmail: reply.to_email ?? null,
        attempts: effectiveRetryCount,
        error: newError ?? 'unknown',
      }).catch((alertErr) => {
        logger.warn('Failed to raise docs feedback reply delivery alert', {
          reply_id: reply.reply_id,
          feedback_id: reply.feedback_id,
          error: String(alertErr),
        });
      });
    }
  }

  return {
    reply_id: reply.reply_id,
    feedback_id: reply.feedback_id,
    attempt,
    delivered: result.success,
    error: newError,
  };
}

export interface DocsRetryCycleResult {
  considered: number;
  delivered: number;
  failed: number;
  attempts: DocsRetryAttemptResult[];
}

export async function runDocsFeedbackReplyRetryCycle(): Promise<DocsRetryCycleResult> {
  let candidates: FailedOutboundDocsReply[];
  try {
    candidates = await findFailedOutboundDocsFeedbackReplies();
  } catch (err) {
    logger.error('Failed to query failed outbound docs feedback replies', { error: String(err) });
    return { considered: 0, delivered: 0, failed: 0, attempts: [] };
  }

  if (candidates.length === 0) {
    logger.debug('No failed outbound docs feedback replies eligible for auto-retry');
    return { considered: 0, delivered: 0, failed: 0, attempts: [] };
  }

  const attempts: DocsRetryAttemptResult[] = [];
  let delivered = 0;
  let failed = 0;
  let skipped = 0;
  let permanentSkipped = 0;
  for (const reply of candidates) {
    try {
      // Pre-check: if the prior failure was a hard SMTP error (5xx, address
      // rejected, mailbox full, …) sending again will only burn sender
      // reputation and likely get throttled by the receiving server. Mark
      // the row as exhausted and move on so a human picks it up. We still
      // raise the ops alert because this is the threshold-cross event for
      // this reply. The row-shaped helper keeps this scheduler and the
      // digest scheduler's `partitionFailuresByPermanence` in lock-step on
      // what counts as a permanent docs-feedback reply failure.
      if (isDocsFeedbackReplyPermanentFailure(reply)) {
        const marked = await markReplyPermanentlyFailed(reply);
        if (!marked) {
          // Concurrent worker already advanced this row — nothing to do.
          logger.debug('Docs feedback reply skip-on-permanent lost claim', {
            reply_id: reply.reply_id,
            feedback_id: reply.feedback_id,
          });
          skipped += 1;
          continue;
        }
        const previousRetryCount = reply.retry_count ?? 0;
        logger.info('Skipped auto-retry for permanent SMTP failure', {
          reply_id: reply.reply_id,
          feedback_id: reply.feedback_id,
          previous_retry_count: previousRetryCount,
          new_retry_count: MAX_RETRY_ATTEMPTS,
          email_error: reply.email_error,
        });
        if (
          previousRetryCount < DOCS_FEEDBACK_REPLY_DELIVERY_ALERT_THRESHOLD &&
          MAX_RETRY_ATTEMPTS >= DOCS_FEEDBACK_REPLY_DELIVERY_ALERT_THRESHOLD
        ) {
          raiseDocsFeedbackReplyDeliveryFailureAlert({
            replyId: reply.reply_id,
            feedbackId: reply.feedback_id,
            articleSlug: reply.article_slug,
            readerEmail: reply.to_email ?? null,
            attempts: MAX_RETRY_ATTEMPTS,
            error: reply.email_error,
          }).catch((alertErr) => {
            logger.warn('Failed to raise docs feedback reply delivery alert', {
              reply_id: reply.reply_id,
              feedback_id: reply.feedback_id,
              error: String(alertErr),
            });
          });
        }
        permanentSkipped += 1;
        continue;
      }

      const r = await retrySingleReply(reply);
      if (r === null) {
        skipped += 1;
        continue;
      }
      attempts.push(r);
      if (r.delivered) delivered += 1;
      else failed += 1;
    } catch (err) {
      logger.error('Docs feedback auto-retry threw unexpectedly', {
        reply_id: reply.reply_id,
        feedback_id: reply.feedback_id,
        error: String(err),
      });
      failed += 1;
    }
  }

  logger.info('Docs feedback reply auto-retry cycle complete', {
    considered: candidates.length,
    delivered,
    failed,
    skipped,
    permanent_skipped: permanentSkipped,
  });

  return { considered: candidates.length, delivered, failed, attempts };
}

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

export function startDocsFeedbackReplyRetryScheduler(
  intervalMs: number = CHECK_INTERVAL_MS,
): void {
  if (timer) return;

  initialTimer = setTimeout(() => {
    runDocsFeedbackReplyRetryCycle().catch((err) => {
      logger.error('Initial docs feedback reply auto-retry cycle failed', { error: String(err) });
    });
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    runDocsFeedbackReplyRetryCycle().catch((err) => {
      logger.error('Docs feedback reply auto-retry cycle failed', { error: String(err) });
    });
  }, intervalMs);

  logger.info('Docs feedback reply auto-retry scheduler started', {
    intervalMs,
    maxAttempts: MAX_RETRY_ATTEMPTS,
    lookbackMinutes: LOOKBACK_MINUTES,
  });
}

export function stopDocsFeedbackReplyRetryScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Docs feedback reply auto-retry scheduler stopped');
  }
}
