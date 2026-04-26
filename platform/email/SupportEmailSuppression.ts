/**
 * Suppression and unsubscribe checks for support emails.
 *
 * Two independent address-scoped lists:
 *   - `support_email_suppressions`: addresses we've decided not to send to,
 *     usually because a previous send hard-bounced. Auto-populated by the
 *     scheduler / manual retry path the moment they classify a row as a
 *     permanent SMTP failure.
 *   - `support_email_unsubscribes`: addresses that have explicitly asked us
 *     to stop. Populated by the unsubscribe sink — the RFC 8058 one-click
 *     POST + landing-page GET on `/support/unsubscribe` and the
 *     `unsubscribe@<domain>` mailto: branch on `/support/inbound`.
 *
 * Both lists key on the lowercased address so a mixed-case retry can never
 * silently bypass an entry. Callers should treat the lists as read-mostly:
 * lookups are tiny PK reads and cheap enough to do on every send.
 *
 * The reason strings returned here line up with the
 * `RETRY_SKIPPED_REASON_*` constants in
 * `client-app/src/lib/smtpErrorClass.ts` so the admin UI's
 * `describeRetrySkippedReason` renders the right badge without translation.
 */

import { createLogger } from '../core/logger';
import { getPlatformPool } from '../db';

const logger = createLogger('SUPPORT_EMAIL_SUPPRESSION');

export type SupportEmailSkipReason =
  | 'suppression_list'
  | 'recipient_unsubscribed';

export interface SupportEmailSkipDecision {
  /** True when the address is on either list. */
  skip: boolean;
  /**
   * Which `retry_skipped_reason` value to stamp on the reply row when this
   * decision is acted on. Unsubscribes win over suppressions because they
   * are user-driven and durable; an admin who clears a suppression entry
   * shouldn't accidentally re-enable mail to an address that asked to stop.
   */
  reason: SupportEmailSkipReason | null;
  /** Lowercased address that was checked, returned for logging. */
  emailLower: string | null;
}

const NO_SKIP: SupportEmailSkipDecision = {
  skip: false,
  reason: null,
  emailLower: null,
};

/**
 * Normalises and looks up an address against both lists. Returns a
 * `{skip:false}` decision for blank input so callers can use this as a
 * straight-line gate without separate "missing address" handling.
 */
export async function checkSupportEmailSkip(
  email: string | null | undefined,
): Promise<SupportEmailSkipDecision> {
  if (!email) return NO_SKIP;
  const emailLower = email.trim().toLowerCase();
  if (!emailLower) return NO_SKIP;

  const pool = getPlatformPool();
  try {
    // Unsubscribe takes precedence (see header comment).
    const unsub = await pool.query<{ email_lower: string }>(
      `SELECT email_lower FROM support_email_unsubscribes WHERE email_lower = $1 LIMIT 1`,
      [emailLower],
    );
    if ((unsub.rowCount ?? 0) > 0) {
      return { skip: true, reason: 'recipient_unsubscribed', emailLower };
    }

    const supp = await pool.query<{ email_lower: string }>(
      `SELECT email_lower FROM support_email_suppressions WHERE email_lower = $1 LIMIT 1`,
      [emailLower],
    );
    if ((supp.rowCount ?? 0) > 0) {
      return { skip: true, reason: 'suppression_list', emailLower };
    }

    return { skip: false, reason: null, emailLower };
  } catch (err) {
    // Defensive: a transient DB error must NOT block a legitimate send. Log
    // loudly and let the caller proceed — the worst case is one extra send
    // attempt to an address we'd otherwise have suppressed, and the next
    // bounce will re-add it.
    logger.warn('Support email suppression lookup failed — proceeding without skip', {
      email_lower: emailLower,
      error: String(err),
    });
    return NO_SKIP;
  }
}

/**
 * Adds (or refreshes) an entry in the suppression list. Idempotent via
 * ON CONFLICT. Use when a send hard-bounces so future sends to the same
 * address are skipped before the network call.
 */
export async function addSupportEmailSuppression(
  email: string | null | undefined,
  args: { reason: string; source: string; lastError?: string | null },
): Promise<void> {
  if (!email) return;
  const emailLower = email.trim().toLowerCase();
  if (!emailLower) return;

  const pool = getPlatformPool();
  try {
    await pool.query(
      `INSERT INTO support_email_suppressions
         (email_lower, reason, source, last_error)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (email_lower) DO UPDATE
         SET reason = EXCLUDED.reason,
             source = EXCLUDED.source,
             last_error = EXCLUDED.last_error,
             added_at = NOW()`,
      [emailLower, args.reason, args.source, args.lastError ?? null],
    );
    logger.info('Added support email to suppression list', {
      email_lower: emailLower,
      reason: args.reason,
      source: args.source,
    });
  } catch (err) {
    // Non-fatal: a missed suppression entry just means the next send to this
    // address will go through the network and (likely) bounce again, which
    // will re-trigger this insert. Don't fail the caller's flow over it.
    logger.warn('Failed to record support email suppression', {
      email_lower: emailLower,
      reason: args.reason,
      source: args.source,
      error: String(err),
    });
  }
}

/**
 * Adds (or refreshes) an entry in the unsubscribe list. Reserved for the
 * future unsubscribe sink (List-Unsubscribe header / landing page) — the
 * read path uses the row immediately so the helper exists today even
 * though no production caller writes to it yet.
 */
export async function addSupportEmailUnsubscribe(
  email: string | null | undefined,
  source: string,
): Promise<void> {
  if (!email) return;
  const emailLower = email.trim().toLowerCase();
  if (!emailLower) return;

  const pool = getPlatformPool();
  try {
    await pool.query(
      `INSERT INTO support_email_unsubscribes (email_lower, source)
       VALUES ($1, $2)
       ON CONFLICT (email_lower) DO UPDATE
         SET source = EXCLUDED.source,
             unsubscribed_at = NOW()`,
      [emailLower, source],
    );
    logger.info('Recorded support email unsubscribe', {
      email_lower: emailLower,
      source,
    });
  } catch (err) {
    logger.warn('Failed to record support email unsubscribe', {
      email_lower: emailLower,
      source,
      error: String(err),
    });
  }
}

/**
 * Removes an entry from the unsubscribe list. Used by the landing page's
 * "Resubscribe" affordance so a recipient who changed their mind can opt
 * back in without round-tripping through ops. Returns `true` when a row
 * was actually deleted (i.e. the address was previously opted out) and
 * `false` when the address wasn't on the list — the latter case is still
 * a successful no-op for the caller, since the desired end state (mail
 * is allowed) holds either way.
 *
 * On a real removal we also write a row to
 * `support_email_unsubscribe_audit` snapshotting the deleted unsubscribe
 * (`previous_unsubscribed_at`, `previous_source`) so the PlatformAdmin
 * "Suppression list" view can show recently-resubscribed addresses for
 * support reps to sanity-check against "I thought I asked to stop"
 * complaints. We use `DELETE ... RETURNING` so the snapshot is captured
 * in the same statement that erases the row — no race window where the
 * row vanishes before we can read it.
 *
 * The audit insert is best-effort: if it fails after the delete already
 * succeeded the resubscribe still stands (which is the user-facing
 * promise we're keeping), and we log loudly so ops can see the missing
 * trail. We do NOT swallow the DELETE error itself — callers need to
 * surface a retryable failure rather than falsely confirming the
 * resubscribe.
 */
export async function removeSupportEmailUnsubscribe(
  email: string | null | undefined,
  source: string,
): Promise<boolean> {
  if (!email) return false;
  const emailLower = email.trim().toLowerCase();
  if (!emailLower) return false;

  const pool = getPlatformPool();
  const r = await pool.query<{ source: string | null; unsubscribed_at: string }>(
    `DELETE FROM support_email_unsubscribes
       WHERE email_lower = $1
       RETURNING source, unsubscribed_at`,
    [emailLower],
  );
  const removed = (r.rowCount ?? 0) > 0;
  if (removed) {
    const prior = r.rows[0];
    try {
      await pool.query(
        `INSERT INTO support_email_unsubscribe_audit
           (email_lower, resubscribed_source, previous_unsubscribed_at, previous_source)
         VALUES ($1, $2, $3, $4)`,
        [emailLower, source, prior?.unsubscribed_at ?? null, prior?.source ?? null],
      );
    } catch (err) {
      // Non-fatal: the resubscribe (the thing the user clicked) already
      // succeeded. Missing the audit row just means ops loses the "who /
      // when / source" trail for this one event — the next resubscribe
      // for the same address will still land an audit row.
      logger.warn('Failed to record support email resubscribe audit', {
        email_lower: emailLower,
        source,
        error: String(err),
      });
    }
  }
  logger.info('Resubscribe processed', {
    email_lower: emailLower,
    source,
    removed,
  });
  return removed;
}
