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
