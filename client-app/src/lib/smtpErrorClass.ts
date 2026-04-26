/**
 * Client-side mirror of `platform/email/smtpErrorClass.ts` so the admin UI can
 * distinguish "we tried 3× and gave up" from "we skipped retries because the
 * address is permanently unreachable" without an extra round-trip.
 *
 * KEEP IN SYNC with the server-side classifier — there is a parity test in
 * `tests/security/clientSmtpErrorClassParity.test.ts` that diffs both files
 * line-by-line on the keyword list and the regex rules.
 *
 * Rules of thumb:
 * - SMTP basic status code 5yz or enhanced status code 5.x.x → permanent.
 * - SMTP basic status code 4yz or enhanced status code 4.x.x → transient,
 *   even if a substring further down the message also matches a "permanent"
 *   keyword (the numeric code is authoritative).
 * - Otherwise, look for unambiguous permanent-failure keywords in the body.
 * - Fallback: anything we don't recognise is treated as transient so we don't
 *   accidentally label a salvageable error as a hard bounce.
 */

const PERMANENT_KEYWORDS: readonly string[] = [
  'no such user',
  'user unknown',
  'user not found',
  'mailbox unavailable',
  'mailbox not found',
  'mailbox does not exist',
  'mailbox is full',
  'mailbox full',
  'over quota',
  'quota exceeded',
  'recipient address rejected',
  'recipient rejected',
  'invalid recipient',
  'address rejected',
  'invalid address',
  'no mailbox here',
  'no mailbox by that name',
  'recipient does not exist',
  'account does not exist',
  'email account does not exist',
  'address does not exist',
  'user does not exist',
  'permanent failure',
  'permanently rejected',
  'permanent error',
  'relay access denied',
  'relay denied',
  'sender address rejected',
  'sender rejected',
  'eenvelope',
];

export function isPermanentSmtpError(error: string | null | undefined): boolean {
  if (!error) return false;
  const e = error.toLowerCase();

  if (/(?:^|[^0-9])4\d{2}(?:[^0-9]|$)/.test(e)) return false;
  if (/(?:^|[^0-9])4\.\d{1,3}\.\d{1,3}(?:[^0-9]|$)/.test(e)) return false;

  if (/(?:^|[^0-9])5\d{2}(?:[^0-9]|$)/.test(e)) return true;
  if (/(?:^|[^0-9])5\.\d{1,3}\.\d{1,3}(?:[^0-9]|$)/.test(e)) return true;

  return PERMANENT_KEYWORDS.some((kw) => e.includes(kw));
}

/**
 * Source-of-truth check for whether a delivery row represents a hard bounce
 * that the auto-retry scheduler has decided not to attempt again.
 *
 * Prefers the persisted `retry_skipped_reason` written by the server (set to
 * `'permanent_smtp_failure'` for 5xx / unambiguous bounce keywords) so a row
 * keeps its "Hard bounce — won't auto-retry" badge even if the SMTP error
 * text is later cleared, edited, or the client classifier diverges.
 *
 * Falls back to running `isPermanentSmtpError` against `email_error` for
 * legacy rows written before the column existed (where it will still be NULL).
 */
export function isHardBounce(row: {
  retry_skipped_reason?: string | null;
  email_error?: string | null;
}): boolean {
  if (row.retry_skipped_reason === 'permanent_smtp_failure') return true;
  if (row.retry_skipped_reason) return false;
  return isPermanentSmtpError(row.email_error);
}

// ---------------------------------------------------------------------------
// Wider retry-skipped reason vocabulary
// ---------------------------------------------------------------------------
//
// The `retry_skipped_reason` column on support_ticket_replies /
// docs_feedback_replies / support_tickets is intentionally typed as TEXT so
// the scheduler / admin paths can record other reasons the auto-retry
// pipeline gave up — not just hard bounces. These are the reasons the
// product currently knows how to render a distinct badge for.
//
// Adding a new reason: append a string constant here, give it an entry in
// `describeRetrySkippedReason` below, and start writing it from the relevant
// server path. The admin badge will pick it up automatically; rows with a
// reason this client doesn't recognise yet (e.g. a server that has been
// upgraded ahead of the client) fall through to the generic "Auto-retry
// skipped" badge so the UI never breaks.

export const RETRY_SKIPPED_REASON_PERMANENT_SMTP_FAILURE = 'permanent_smtp_failure';
export const RETRY_SKIPPED_REASON_SUPPRESSION = 'suppression_list';
export const RETRY_SKIPPED_REASON_MANUAL_CANCEL = 'manual_cancel';
export const RETRY_SKIPPED_REASON_UNSUBSCRIBED = 'recipient_unsubscribed';

export type RetrySkippedTone =
  | 'hard_bounce'
  | 'suppression'
  | 'manual_cancel'
  | 'unsubscribed'
  | 'unknown';

export interface RetrySkippedReasonBadge {
  /** Compact label for inline pills (used in tables). */
  shortLabel: string;
  /** Sentence-form label for the detail view (e.g. above the reply body). */
  longLabel: string;
  /** Long-form explanation rendered in the badge tooltip. */
  description: string;
  /** Drives the badge color so different reasons are visually distinct. */
  tone: RetrySkippedTone;
}

/**
 * Map a `retry_skipped_reason` value to a human-readable badge descriptor.
 * Returns `null` when the column is unset (the row hasn't been skipped yet),
 * and falls through to a generic "Auto-retry skipped" descriptor for any
 * value the client doesn't yet recognise — that way a server that starts
 * writing a new reason before the client knows about it still renders
 * something sensible instead of crashing or silently dropping the badge.
 */
export function describeRetrySkippedReason(
  reason: string | null | undefined,
): RetrySkippedReasonBadge | null {
  if (!reason) return null;
  switch (reason) {
    case RETRY_SKIPPED_REASON_PERMANENT_SMTP_FAILURE:
      return {
        shortLabel: 'Hard bounce',
        longLabel: "Hard bounce — won\u2019t auto-retry",
        description:
          "Permanent SMTP failure (5xx, address rejected, mailbox full, \u2026) \u2014 auto-retry skipped, manual retry disabled.",
        tone: 'hard_bounce',
      };
    case RETRY_SKIPPED_REASON_SUPPRESSION:
      return {
        shortLabel: 'Suppressed by ops',
        longLabel: "Suppressed by ops \u2014 won\u2019t auto-retry",
        description:
          "Recipient address is on the platform suppression list \u2014 auto-retry skipped. Remove the address from suppression before retrying.",
        tone: 'suppression',
      };
    case RETRY_SKIPPED_REASON_MANUAL_CANCEL:
      return {
        shortLabel: 'Manually cancelled',
        longLabel: "Manually cancelled \u2014 auto-retry stopped",
        description:
          "An admin cancelled further auto-retries for this reply. Click \u201CRetry send\u201D to attempt one manual send anyway.",
        tone: 'manual_cancel',
      };
    case RETRY_SKIPPED_REASON_UNSUBSCRIBED:
      return {
        shortLabel: 'Recipient unsubscribed',
        longLabel: "Recipient unsubscribed \u2014 won\u2019t auto-retry",
        description:
          "Recipient asked to stop receiving these emails \u2014 auto-retry skipped. Reach out through another channel instead.",
        tone: 'unsubscribed',
      };
    default:
      return {
        shortLabel: 'Auto-retry skipped',
        longLabel: 'Auto-retry skipped',
        description: `Auto-retry skipped (reason: ${reason}).`,
        tone: 'unknown',
      };
  }
}

/**
 * True when a row has any `retry_skipped_reason` recorded — covers hard
 * bounces, suppression, manual cancel, unsubscribe, and any future reason
 * the server starts writing before the client knows about it.
 *
 * Distinct from `isHardBounce`: that one specifically gates on a permanent
 * SMTP failure (used to disable the manual retry button). This one is
 * useful when the UI just needs to know "the auto-retry pipeline gave up on
 * this row" so it can render the appropriate badge.
 */
export function isRetrySkipped(row: {
  retry_skipped_reason?: string | null;
  email_error?: string | null;
}): boolean {
  if (row.retry_skipped_reason) return true;
  // Legacy rows written before the column existed: fall back to the SMTP
  // classifier so the badge stays consistent across the dataset.
  return isPermanentSmtpError(row.email_error);
}
