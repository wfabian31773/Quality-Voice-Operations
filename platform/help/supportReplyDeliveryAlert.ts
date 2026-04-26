/**
 * Shared helper that raises a high-severity platform alert when an outbound
 * support reply has failed to deliver after several consecutive attempts.
 *
 * Mirrors the `raiseDeliveryFailureAlert` used for ticket-creation failures
 * (server/admin-api/routes/support.ts) but is keyed on a specific reply so
 * the manual /retry endpoint AND the background SupportReplyRetryScheduler
 * can both fire it.
 *
 * Writes:
 *   - error_logs row at severity='critical' (always)
 *   - operations_alerts row of type='support_reply_delivery_failed',
 *     severity='high' (only when the ticket is linked to a tenant —
 *     operations_alerts.tenant_id is NOT NULL).
 *
 * Dedup: callers fire this exactly once per reply by gating on
 * `attempts === REPLY_DELIVERY_ALERT_THRESHOLD` (the boundary-cross). Both
 * paths increment `support_ticket_replies.retry_count` monotonically, so the
 * threshold can only be reached once per reply.
 */

import { createLogger } from '../core/logger';
import { getPlatformPool } from '../db';
import { logError } from '../core/observability';

const logger = createLogger('SUPPORT_REPLY_ALERT');

/**
 * Number of consecutive failed delivery attempts (manual retries + automatic
 * retries combined) on a single reply before we treat it as a persistent
 * failure that ops needs to look at. Aligned with
 * SupportReplyRetryScheduler.MAX_RETRY_ATTEMPTS so the alert fires at the
 * exact moment the auto-retry loop gives up.
 */
export const REPLY_DELIVERY_ALERT_THRESHOLD = 3;

export interface ReplyDeliveryFailureInput {
  replyId: number;
  ticketId: string;
  tenantId: string | null;
  customerEmail: string | null;
  attempts: number;
  error: string;
}

export async function raiseReplyDeliveryFailureAlert(
  input: ReplyDeliveryFailureInput,
): Promise<void> {
  const { replyId, ticketId, tenantId, customerEmail, attempts, error } = input;
  const recipientLabel = customerEmail ?? 'customer';
  const message =
    `Support reply ${replyId} on ticket ${ticketId}: failed to deliver to ` +
    `${recipientLabel} after ${attempts} attempt(s)`;

  await logError(tenantId, 'critical', message, {
    service: 'support',
    errorCode: 'support_reply_delivery_failed',
    extra: {
      reply_id: replyId,
      ticket_id: ticketId,
      customer_email: customerEmail,
      attempts,
      error,
    },
  });

  if (!tenantId) {
    // operations_alerts.tenant_id is NOT NULL; without a tenant we can only
    // record the critical error_log above. Tickets without a tenant are
    // anonymous support intake from the marketing site.
    return;
  }

  try {
    const pool = getPlatformPool();
    await pool.query(
      `INSERT INTO operations_alerts (tenant_id, type, severity, message, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        tenantId,
        'support_reply_delivery_failed',
        'high',
        message,
        JSON.stringify({
          reply_id: replyId,
          ticket_id: ticketId,
          customer_email: customerEmail,
          attempts,
          error,
        }),
      ],
    );
  } catch (err) {
    logger.warn('Failed to insert operations_alert for support reply failure', {
      reply_id: replyId,
      ticket_id: ticketId,
      error: String(err),
    });
  }
}

// ----- Per-recipient first-hard-bounce alert ----------------------------------
//
// `raiseReplyDeliveryFailureAlert` (above) is keyed on a single reply and
// fires every time *that* reply crosses the per-reply attempt threshold. It
// does NOT, by itself, surface the higher-signal "this email address has
// started bouncing for the first time" event — the same address can produce
// hard bounces across several tickets, but ops only needs to be paged the
// first time the list rots.
//
// `raiseRecipientFirstBounceAlert` covers that case. Dedup is enforced by a
// dedicated table (`support_recipient_bounce_alerts`) with the lowercased
// address as the primary key, claimed atomically via INSERT ... ON CONFLICT
// DO NOTHING. Subsequent hard bounces for the same recipient — whether they
// come from a different reply, ticket, or retry path — see the conflict and
// short-circuit without writing a second alert.

export interface RecipientFirstBounceInput {
  /** Recipient address whose first permanent failure triggered the alert. */
  recipientEmail: string;
  /** Reply id that produced the failure (for forensics). */
  replyId: number;
  /** Ticket id that produced the failure. */
  ticketId: string;
  /** Tenant id of the ticket; null for anonymous marketing-site tickets. */
  tenantId: string | null;
  /** SMTP error string captured at failure time. */
  error: string;
}

export interface RecipientFirstBounceResult {
  /**
   * True when this call was the one that wrote the alert. False when the
   * recipient was already on the dedup table (someone else got there first).
   * Callers can use this to log/observe alert firings without re-implementing
   * the dedup check.
   */
  alerted: boolean;
}

/**
 * Fires the one-shot ops alert the first time a recipient address transitions
 * from "no permanent failures" to "has a permanent failure".
 *
 * Atomic + idempotent: the dedup row is claimed via INSERT ... ON CONFLICT
 * DO NOTHING, so concurrent callers (manual /retry + the background scheduler
 * racing on the same address) cannot both fire the alert.
 *
 * Writes (only on a successful claim):
 *   - support_recipient_bounce_alerts row keyed on the lowercased address
 *   - error_logs row at severity='critical'
 *   - operations_alerts row of type='support_recipient_first_bounce',
 *     severity='high' (only when the originating ticket has a tenant_id —
 *     operations_alerts.tenant_id is NOT NULL).
 */
export async function raiseRecipientFirstBounceAlert(
  input: RecipientFirstBounceInput,
): Promise<RecipientFirstBounceResult> {
  const { recipientEmail, replyId, ticketId, tenantId, error } = input;
  const emailLower = recipientEmail.trim().toLowerCase();
  if (!emailLower) {
    return { alerted: false };
  }

  const pool = getPlatformPool();

  // Atomic claim. Only the first writer for this address gets a returned
  // row; everyone else short-circuits without ever doing the alert work.
  let claimed = false;
  try {
    const r = await pool.query<{ email_lower: string }>(
      `INSERT INTO support_recipient_bounce_alerts
         (email_lower, reply_id, ticket_id, tenant_id, last_error)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email_lower) DO NOTHING
       RETURNING email_lower`,
      [emailLower, replyId, ticketId, tenantId, error],
    );
    claimed = (r.rowCount ?? 0) > 0;
  } catch (err) {
    // A failed INSERT must not crash the calling retry path. Worst case the
    // next bounce on the same address re-attempts the claim and pages ops
    // then instead of now.
    logger.warn('Failed to claim recipient first-bounce alert', {
      email_lower: emailLower,
      reply_id: replyId,
      ticket_id: ticketId,
      error: String(err),
    });
    return { alerted: false };
  }

  if (!claimed) {
    // Already alerted for this address — dedup hit, nothing more to do.
    return { alerted: false };
  }

  const message =
    `Recipient ${emailLower} has produced its first permanent SMTP failure ` +
    `(reply ${replyId} on ticket ${ticketId})`;

  await logError(tenantId, 'critical', message, {
    service: 'support',
    errorCode: 'support_recipient_first_bounce',
    extra: {
      recipient_email: emailLower,
      reply_id: replyId,
      ticket_id: ticketId,
      error,
    },
  });

  if (!tenantId) {
    // operations_alerts.tenant_id is NOT NULL — anonymous tickets only get
    // the critical error_log + dedup row. Same trade-off as the per-reply
    // alert above.
    return { alerted: true };
  }

  try {
    await pool.query(
      `INSERT INTO operations_alerts (tenant_id, type, severity, message, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        tenantId,
        'support_recipient_first_bounce',
        'high',
        message,
        JSON.stringify({
          recipient_email: emailLower,
          reply_id: replyId,
          ticket_id: ticketId,
          error,
        }),
      ],
    );
  } catch (err) {
    logger.warn('Failed to insert operations_alert for recipient first bounce', {
      email_lower: emailLower,
      reply_id: replyId,
      ticket_id: ticketId,
      error: String(err),
    });
  }

  return { alerted: true };
}
