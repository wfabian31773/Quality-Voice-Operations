/**
 * Shared helper that raises a high-severity platform alert when an outbound
 * docs feedback reply has failed to deliver after several consecutive
 * attempts.
 *
 * Mirrors `raiseReplyDeliveryFailureAlert` from supportReplyDeliveryAlert.ts
 * but is keyed on a docs_feedback_replies row. Both the manual one-click
 * /retry endpoint and the background DocsFeedbackReplyRetryScheduler can fire
 * it via the same boundary-cross check (retry_count crosses
 * REPLY_DELIVERY_ALERT_THRESHOLD exactly once).
 *
 * Writes:
 *   - error_logs row at severity='critical' (always)
 *
 * Note: docs_feedback rows are anonymous public input from readers and have
 * no tenant_id, so unlike the support pipeline we do NOT also insert an
 * operations_alerts row (operations_alerts.tenant_id is NOT NULL). The
 * critical error_log is the actionable signal for ops; the daily reply
 * digest will continue to surface the failure for human follow-up too.
 */

import { logError } from '../core/observability';

/**
 * Number of consecutive failed delivery attempts (manual retries + automatic
 * retries combined) on a single docs feedback reply before we treat it as a
 * persistent failure that ops needs to look at. Aligned with
 * DocsFeedbackReplyRetryScheduler.MAX_RETRY_ATTEMPTS so the alert fires at
 * the exact moment the auto-retry loop gives up.
 */
export const DOCS_FEEDBACK_REPLY_DELIVERY_ALERT_THRESHOLD = 3;

export interface DocsFeedbackReplyDeliveryFailureInput {
  replyId: number;
  feedbackId: number;
  articleSlug: string;
  readerEmail: string | null;
  attempts: number;
  error: string;
}

export async function raiseDocsFeedbackReplyDeliveryFailureAlert(
  input: DocsFeedbackReplyDeliveryFailureInput,
): Promise<void> {
  const { replyId, feedbackId, articleSlug, readerEmail, attempts, error } = input;
  const recipientLabel = readerEmail ?? 'reader';
  const message =
    `Docs feedback reply ${replyId} on feedback ${feedbackId} (${articleSlug}): ` +
    `failed to deliver to ${recipientLabel} after ${attempts} attempt(s)`;

  await logError(null, 'critical', message, {
    service: 'docs_feedback',
    errorCode: 'docs_feedback_reply_delivery_failed',
    extra: {
      reply_id: replyId,
      feedback_id: feedbackId,
      article_slug: articleSlug,
      reader_email: readerEmail,
      attempts,
      error,
    },
  });
}
