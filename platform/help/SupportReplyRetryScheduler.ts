/**
 * Background worker that auto-retries transient SMTP failures on outbound
 * support_ticket_replies. Wakes up every minute or two, finds outbound replies
 * that failed to send within the last hour and still have retries remaining,
 * and re-sends them through the same renderOutboundTicketReplyEmail() +
 * sendEmail() path used by the manual /retry endpoint.
 *
 * After MAX_RETRY_ATTEMPTS the row is left alone so the human still sees a
 * Failed badge for genuinely undeliverable mail.
 */

import { createLogger } from '../core/logger';
import { getPlatformPool } from '../db';
import { sendEmail } from '../email/EmailService';
import { isPermanentSmtpError } from '../email/smtpErrorClass';
import {
  buildReplyToAddress,
  generateInboundToken,
  renderOutboundTicketReplyEmail,
} from './supportReplyEmail';
import {
  REPLY_DELIVERY_ALERT_THRESHOLD,
  raiseReplyDeliveryFailureAlert,
} from './supportReplyDeliveryAlert';

const logger = createLogger('SUPPORT_REPLY_RETRY');

const CHECK_INTERVAL_MS = 90 * 1000; // every 90 seconds
const INITIAL_DELAY_MS = 30 * 1000;
const LOOKBACK_MINUTES = 60;
// Sourced from REPLY_DELIVERY_ALERT_THRESHOLD so the retry cap and the ops-alert
// boundary stay in lockstep — editing one updates both.
const MAX_RETRY_ATTEMPTS = REPLY_DELIVERY_ALERT_THRESHOLD;
const BATCH_LIMIT = 25;

export interface FailedOutboundReply {
  reply_id: number;
  ticket_id: string;
  body: string;
  email_error: string;
  retry_count: number;
  user_email: string;
  topic: string;
  inbound_token: string | null;
  tenant_id: string | null;
}

export async function findFailedOutboundReplies(
  maxAttempts: number = MAX_RETRY_ATTEMPTS,
  lookbackMinutes: number = LOOKBACK_MINUTES,
  limit: number = BATCH_LIMIT,
): Promise<FailedOutboundReply[]> {
  const pool = getPlatformPool();
  const r = await pool.query<FailedOutboundReply>(
    `SELECT r.id           AS reply_id,
            r.ticket_id    AS ticket_id,
            r.body         AS body,
            r.email_error  AS email_error,
            r.retry_count  AS retry_count,
            t.user_email   AS user_email,
            t.topic        AS topic,
            t.inbound_token AS inbound_token,
            t.tenant_id    AS tenant_id
     FROM support_ticket_replies r
     JOIN support_tickets t ON t.id = r.ticket_id
     WHERE r.direction = 'outbound'
       AND r.email_error IS NOT NULL
       AND r.retry_count < $1
       AND r.created_at >= NOW() - ($2 || ' minutes')::interval
       AND t.user_email IS NOT NULL
     ORDER BY r.created_at ASC
     LIMIT $3`,
    [maxAttempts, String(lookbackMinutes), limit],
  );
  return r.rows;
}

async function ensureInboundToken(
  ticketId: string,
  existing: string | null,
): Promise<string> {
  if (existing) return existing;
  const token = generateInboundToken();
  try {
    const pool = getPlatformPool();
    await pool.query(
      `UPDATE support_tickets SET inbound_token = $2 WHERE id = $1`,
      [ticketId, token],
    );
  } catch (err) {
    // Non-fatal — even without a stored token the outbound email still goes
    // out; replies just won't thread back to this ticket. Log so we notice.
    logger.warn('Failed to persist inbound token during auto-retry', {
      ticket_id: ticketId,
      error: String(err),
    });
  }
  return token;
}

export interface RetryAttemptResult {
  reply_id: number;
  ticket_id: string;
  attempt: number;
  delivered: boolean;
  error: string | null;
}

/**
 * Atomically claim a candidate row for this worker before sending. The claim
 * is a conditional UPDATE that only succeeds when the row is still in the
 * exact state we observed during the SELECT — same retry_count, still failed,
 * still outbound. If a concurrent cycle (or another instance) got there first,
 * `retry_count` will have been bumped and the WHERE clause matches zero rows,
 * so we skip without sending. The bump also reserves an attempt slot, so even
 * if our send crashes mid-flight we won't infinite-loop on the same row.
 */
async function claimReplyForRetry(reply: FailedOutboundReply): Promise<boolean> {
  const pool = getPlatformPool();
  const r = await pool.query<{ id: number }>(
    `UPDATE support_ticket_replies
     SET retry_count = retry_count + 1,
         last_retry_at = NOW()
     WHERE id = $1
       AND direction = 'outbound'
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
async function markReplyPermanentlyFailed(reply: FailedOutboundReply): Promise<boolean> {
  const pool = getPlatformPool();
  // Record `retry_skipped_reason = 'permanent_smtp_failure'` alongside the
  // retry-count bump so the admin UI can render the "Hard bounce — won't
  // auto-retry" badge straight from authoritative server state without
  // re-running the SMTP classifier on the client.
  const r = await pool.query<{ id: number }>(
    `UPDATE support_ticket_replies
     SET retry_count = $3,
         last_retry_at = NOW(),
         retry_skipped_reason = 'permanent_smtp_failure'
     WHERE id = $1
       AND direction = 'outbound'
       AND email_error IS NOT NULL
       AND retry_count = $2
     RETURNING id`,
    [reply.reply_id, reply.retry_count ?? 0, MAX_RETRY_ATTEMPTS],
  );
  return (r.rowCount ?? 0) > 0;
}

async function retrySingleReply(reply: FailedOutboundReply): Promise<RetryAttemptResult | null> {
  const claimed = await claimReplyForRetry(reply);
  if (!claimed) {
    logger.debug('Support reply auto-retry skipped — claim lost to concurrent worker', {
      reply_id: reply.reply_id,
      ticket_id: reply.ticket_id,
    });
    return null;
  }

  const token = await ensureInboundToken(reply.ticket_id, reply.inbound_token);
  const { subject, html, text } = renderOutboundTicketReplyEmail({
    ticketId: reply.ticket_id,
    topic: reply.topic,
    body: reply.body,
  });

  const result = await sendEmail({
    to: reply.user_email,
    subject,
    html,
    text,
    replyTo: buildReplyToAddress(token),
    headers: { 'X-QVO-Ticket-Id': reply.ticket_id },
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
      // We also stamp `retry_skipped_reason = 'permanent_smtp_failure'` here
      // so the admin UI's hard-bounce badge is driven by authoritative
      // server state instead of re-running the SMTP classifier client-side.
      await pool.query(
        `UPDATE support_ticket_replies
         SET email_message_id = $2,
             email_error = $3,
             retry_count = $4,
             retry_skipped_reason = 'permanent_smtp_failure'
         WHERE id = $1`,
        [reply.reply_id, result.messageId ?? null, newError, MAX_RETRY_ATTEMPTS],
      );
    } else {
      // The claim already incremented retry_count and stamped last_retry_at;
      // here we just record the outcome (message id / error) of this attempt.
      await pool.query(
        `UPDATE support_ticket_replies
         SET email_message_id = $2,
             email_error = $3
         WHERE id = $1`,
        [reply.reply_id, result.messageId ?? null, newError],
      );
    }
    // Bump ticket updated_at so the inbox surfaces the activity.
    await pool.query(
      `UPDATE support_tickets SET updated_at = NOW() WHERE id = $1`,
      [reply.ticket_id],
    );
  } catch (err) {
    logger.error('Failed to persist auto-retry result', {
      reply_id: reply.reply_id,
      ticket_id: reply.ticket_id,
      error: String(err),
    });
  }

  if (result.success) {
    logger.info('Support reply auto-retry succeeded', {
      reply_id: reply.reply_id,
      ticket_id: reply.ticket_id,
      attempt,
    });
  } else {
    const exhausted = effectiveRetryCount >= MAX_RETRY_ATTEMPTS;
    logger.warn('Support reply auto-retry failed', {
      reply_id: reply.reply_id,
      ticket_id: reply.ticket_id,
      attempt,
      effective_retry_count: effectiveRetryCount,
      max_attempts: MAX_RETRY_ATTEMPTS,
      error: newError ?? 'unknown',
      permanent,
      exhausted,
    });

    // Boundary-cross alert: when this failed attempt is the one that pushes
    // the reply's total attempt count to the configured threshold, raise an
    // operations_alerts row + critical error_log so ops can intervene. The
    // strict-crossing check naturally dedupes — retry_count only increases,
    // so the threshold is crossed exactly once per reply (regardless of
    // whether the failed attempts came from this scheduler or the manual
    // /retry endpoint, which both bump the same counter). Permanent failures
    // jump retry_count to MAX in one go, so we use the effective count here
    // to make sure the alert still fires on the very first hard bounce.
    const previousRetryCount = reply.retry_count ?? 0;
    if (
      previousRetryCount < REPLY_DELIVERY_ALERT_THRESHOLD &&
      effectiveRetryCount >= REPLY_DELIVERY_ALERT_THRESHOLD
    ) {
      raiseReplyDeliveryFailureAlert({
        replyId: reply.reply_id,
        ticketId: reply.ticket_id,
        tenantId: reply.tenant_id ?? null,
        customerEmail: reply.user_email ?? null,
        attempts: effectiveRetryCount,
        error: newError ?? 'unknown',
      }).catch((alertErr) => {
        logger.warn('Failed to raise support reply delivery alert', {
          reply_id: reply.reply_id,
          ticket_id: reply.ticket_id,
          error: String(alertErr),
        });
      });
    }
  }

  return {
    reply_id: reply.reply_id,
    ticket_id: reply.ticket_id,
    attempt,
    delivered: result.success,
    error: newError,
  };
}

export interface RetryCycleResult {
  considered: number;
  delivered: number;
  failed: number;
  attempts: RetryAttemptResult[];
}

export async function runSupportReplyRetryCycle(): Promise<RetryCycleResult> {
  let candidates: FailedOutboundReply[];
  try {
    candidates = await findFailedOutboundReplies();
  } catch (err) {
    logger.error('Failed to query failed outbound replies', { error: String(err) });
    return { considered: 0, delivered: 0, failed: 0, attempts: [] };
  }

  if (candidates.length === 0) {
    logger.debug('No failed outbound replies eligible for auto-retry');
    return { considered: 0, delivered: 0, failed: 0, attempts: [] };
  }

  const attempts: RetryAttemptResult[] = [];
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
      // this reply.
      if (isPermanentSmtpError(reply.email_error)) {
        const marked = await markReplyPermanentlyFailed(reply);
        if (!marked) {
          // Concurrent worker already advanced this row — nothing to do.
          logger.debug('Support reply skip-on-permanent lost claim', {
            reply_id: reply.reply_id,
            ticket_id: reply.ticket_id,
          });
          skipped += 1;
          continue;
        }
        const previousRetryCount = reply.retry_count ?? 0;
        logger.info('Skipped auto-retry for permanent SMTP failure', {
          reply_id: reply.reply_id,
          ticket_id: reply.ticket_id,
          previous_retry_count: previousRetryCount,
          new_retry_count: MAX_RETRY_ATTEMPTS,
          email_error: reply.email_error,
        });
        if (
          previousRetryCount < REPLY_DELIVERY_ALERT_THRESHOLD &&
          MAX_RETRY_ATTEMPTS >= REPLY_DELIVERY_ALERT_THRESHOLD
        ) {
          raiseReplyDeliveryFailureAlert({
            replyId: reply.reply_id,
            ticketId: reply.ticket_id,
            tenantId: reply.tenant_id ?? null,
            customerEmail: reply.user_email ?? null,
            attempts: MAX_RETRY_ATTEMPTS,
            error: reply.email_error,
          }).catch((alertErr) => {
            logger.warn('Failed to raise support reply delivery alert', {
              reply_id: reply.reply_id,
              ticket_id: reply.ticket_id,
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
      logger.error('Auto-retry threw unexpectedly', {
        reply_id: reply.reply_id,
        ticket_id: reply.ticket_id,
        error: String(err),
      });
      failed += 1;
    }
  }

  logger.info('Support reply auto-retry cycle complete', {
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

export function startSupportReplyRetryScheduler(
  intervalMs: number = CHECK_INTERVAL_MS,
): void {
  if (timer) return;

  initialTimer = setTimeout(() => {
    runSupportReplyRetryCycle().catch((err) => {
      logger.error('Initial support reply auto-retry cycle failed', { error: String(err) });
    });
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    runSupportReplyRetryCycle().catch((err) => {
      logger.error('Support reply auto-retry cycle failed', { error: String(err) });
    });
  }, intervalMs);

  logger.info('Support reply auto-retry scheduler started', {
    intervalMs,
    maxAttempts: MAX_RETRY_ATTEMPTS,
    lookbackMinutes: LOOKBACK_MINUTES,
  });
}

export function stopSupportReplyRetryScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Support reply auto-retry scheduler stopped');
  }
}
