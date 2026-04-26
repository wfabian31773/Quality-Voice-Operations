/**
 * Classify a stringified SMTP error as permanent (5xx, address rejected,
 * mailbox full, …) or transient (timeout, 4xx greylisting, connection refused,
 * …). Used by SupportReplyRetryScheduler to skip auto-retries on hard
 * failures so we don't waste sender reputation re-sending mail to invalid
 * recipients.
 *
 * Rules of thumb:
 * - SMTP basic status code 5yz or enhanced status code 5.x.x → permanent.
 * - SMTP basic status code 4yz or enhanced status code 4.x.x → transient,
 *   even if a substring further down the message also matches a "permanent"
 *   keyword (the numeric code is authoritative).
 * - Otherwise, look for unambiguous permanent-failure keywords in the body
 *   (recipient/mailbox not found, mailbox full / over quota, relay denied,
 *   nodemailer EENVELOPE addressing failures, …).
 * - Fallback: anything we don't recognise is treated as transient so we
 *   don't accidentally drop salvageable mail. Permanence has to be proven.
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
  // Constrained variants of "does not exist" — the bare phrase is too broad
  // (could match unrelated errors like "this message does not exist") so we
  // require it to be qualified by a recipient/account/email/address noun.
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

  // Numeric SMTP status takes precedence: a 4yz or 4.x.x code means the server
  // is asking us to try again later, even if the human-readable portion looks
  // alarming ("temporarily over quota", "try again later, address rejected"…).
  if (/(?:^|[^0-9])4\d{2}(?:[^0-9]|$)/.test(e)) return false;
  if (/(?:^|[^0-9])4\.\d{1,3}\.\d{1,3}(?:[^0-9]|$)/.test(e)) return false;

  // 5yz / 5.x.x permanent class.
  if (/(?:^|[^0-9])5\d{2}(?:[^0-9]|$)/.test(e)) return true;
  if (/(?:^|[^0-9])5\.\d{1,3}\.\d{1,3}(?:[^0-9]|$)/.test(e)) return true;

  return PERMANENT_KEYWORDS.some((kw) => e.includes(kw));
}

/**
 * A support_ticket_replies row (or row-like shape) used by both the scheduler
 * and the admin API. Only the two fields the permanence rule needs are
 * required so any wider row type satisfies the shape.
 */
export interface ReplyPermanenceCandidate {
  direction?: string | null;
  email_error?: string | null;
}

/**
 * Single source of truth for "is this support reply a permanent SMTP failure?"
 *
 * The rule is: outbound + has a recorded email_error + the classifier above
 * tags that error as permanent. This boolean is what the auto-retry scheduler,
 * the manual /retry endpoint, and the GET /replies endpoint all need to agree
 * on — duplicating the inline expression invites drift if we ever extend the
 * rule (for example, also treating `error_count >= N` or an explicit
 * `hard_bounce` column as permanent). Route every caller through this helper
 * so the three sites stay in lock-step.
 *
 * The direction check is skipped when the field is omitted entirely (e.g. the
 * scheduler's row type only selects outbound rows in SQL, so it doesn't carry
 * `direction`). When the field is present, it must literally be `'outbound'`.
 */
export function isReplyPermanentFailure(reply: ReplyPermanenceCandidate): boolean {
  if (reply.direction != null && reply.direction !== 'outbound') return false;
  if (!reply.email_error) return false;
  return isPermanentSmtpError(reply.email_error);
}
