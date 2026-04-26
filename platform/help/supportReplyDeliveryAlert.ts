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
