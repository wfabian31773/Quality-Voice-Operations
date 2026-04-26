import { createLogger } from '../core/logger';
import { getPlatformPool } from '../db';
import { sendEmail } from '../email/EmailService';
import { isDocsFeedbackReplyPermanentFailure } from '../email/smtpErrorClass';

const logger = createLogger('DOCS_FEEDBACK_REPLY_DIGEST');

/**
 * Auto-retry gating helper.
 *
 * Used by both this digest (to group failures by transient vs permanent so
 * ops can prioritise the hard bounces — no point asking a human to retry
 * "550 user unknown") and by `DocsFeedbackReplyRetryScheduler` (to skip
 * auto-retries on hard failures so we don't burn sender reputation and get
 * the next batch throttled).
 *
 * Internally delegates to the row-level `isDocsFeedbackReplyPermanentFailure`
 * helper in `smtpErrorClass` so this string-shaped wrapper, the digest's
 * row-shaped partition step, and the retry scheduler's row-shaped pre-check
 * all share one definition of "permanent docs-feedback reply failure". If
 * the rule ever grows extra signals (e.g. an explicit `hard_bounce` column),
 * editing the row-level helper updates every caller in lock-step. The
 * underlying SMTP classifier is `isPermanentSmtpError` from `smtpErrorClass`.
 */
export function shouldAutoRetryFailedDocsFeedbackReply(
  emailError: string | null | undefined,
): boolean {
  return !isDocsFeedbackReplyPermanentFailure({ email_error: emailError });
}

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 7 * 60 * 1000;
const LOOKBACK_DAYS = 14;

export interface FailedReply {
  reply_id: number;
  feedback_id: number;
  article_slug: string;
  to_email: string;
  subject: string;
  email_error: string;
  sent_by: string | null;
  created_at: Date;
}

export async function findUnnotifiedFailedReplies(): Promise<FailedReply[]> {
  const pool = getPlatformPool();
  const r = await pool.query<FailedReply>(
    `SELECT r.id AS reply_id,
            r.feedback_id,
            f.article_slug,
            r.to_email,
            r.subject,
            r.email_error,
            r.sent_by,
            r.created_at
     FROM docs_feedback_replies r
     JOIN docs_feedback f ON f.id = r.feedback_id
     WHERE r.email_error IS NOT NULL
       AND r.digest_notified_at IS NULL
       AND r.created_at >= NOW() - ($1 || ' days')::interval
     ORDER BY r.created_at ASC`,
    [String(LOOKBACK_DAYS)],
  );
  return r.rows;
}

async function markNotified(replyIds: number[]): Promise<void> {
  if (replyIds.length === 0) return;
  const pool = getPlatformPool();
  await pool.query(
    `UPDATE docs_feedback_replies
     SET digest_notified_at = NOW()
     WHERE id = ANY($1::int[])`,
    [replyIds],
  );
}

async function getPlatformAdminEmails(): Promise<string[]> {
  const pool = getPlatformPool();
  try {
    const r = await pool.query<{ email: string }>(
      `SELECT email FROM users
       WHERE is_platform_admin = TRUE
         AND COALESCE(is_active, TRUE) = TRUE
         AND email IS NOT NULL`,
    );
    const emails = r.rows.map((row) => row.email).filter((e) => !!e && e.includes('@'));
    return Array.from(new Set(emails));
  } catch (err) {
    logger.warn('Failed to load platform admin emails', { error: String(err) });
    return [];
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Split failed replies into permanent (hard bounces — 5xx, mailbox unknown,
 * recipient rejected, …) and transient (timeout, 4xx greylisting, connection
 * refused, …) buckets using the shared SMTP classifier. Same rules as the
 * support-reply retry scheduler so operators see one consistent definition
 * of "this is worth retrying" across both pipelines.
 */
export function partitionFailuresByPermanence(replies: FailedReply[]): {
  permanent: FailedReply[];
  transient: FailedReply[];
} {
  const permanent: FailedReply[] = [];
  const transient: FailedReply[] = [];
  for (const r of replies) {
    if (isDocsFeedbackReplyPermanentFailure(r)) {
      permanent.push(r);
    } else {
      transient.push(r);
    }
  }
  return { permanent, transient };
}

function renderRow(r: FailedReply): string {
  return `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb"><code>${escapeHtml(r.article_slug)}</code></td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${escapeHtml(r.to_email)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${escapeHtml(new Date(r.created_at).toISOString())}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;color:#b91c1c">${escapeHtml(r.email_error)}</td>
      </tr>`;
}

function renderSection(
  title: string,
  blurb: string,
  badgeColor: string,
  rows: FailedReply[],
): string {
  if (rows.length === 0) return '';
  const body = rows.map(renderRow).join('');
  return `
      <h3 style="margin:20px 0 4px;color:${badgeColor}">${escapeHtml(title)} (${rows.length})</h3>
      <p style="margin:0 0 8px;color:#475569;font-size:13px">${escapeHtml(blurb)}</p>
      <table style="border-collapse:collapse;font-size:13px;width:100%">
        <thead>
          <tr style="background:#f1f5f9;text-align:left">
            <th style="padding:8px 10px">Article</th>
            <th style="padding:8px 10px">To</th>
            <th style="padding:8px 10px">Attempted</th>
            <th style="padding:8px 10px">Error</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>`;
}

const PERMANENT_TITLE = 'Permanent failures (hard bounces — do not auto-retry)';
const PERMANENT_BLURB =
  'These addresses returned a hard SMTP error (5xx, mailbox unknown, recipient rejected, …). Re-sending will only burn sender reputation — reach the reader another way or close the loop.';
const TRANSIENT_TITLE = 'Transient failures (safe to retry)';
const TRANSIENT_BLURB =
  'Timeouts, 4xx greylisting, connection refused, … — sending again later usually works. Retry from the Docs Feedback inbox.';

export function renderDigestEmail(replies: FailedReply[]): {
  subject: string;
  html: string;
  text: string;
} {
  const { permanent, transient } = partitionFailuresByPermanence(replies);

  const subject =
    replies.length === 1
      ? `[QVO Docs] 1 feedback reply failed to send`
      : `[QVO Docs] ${replies.length} feedback replies failed to send` +
        ` (${permanent.length} permanent, ${transient.length} transient)`;

  const html = `
    <div style="font-family:system-ui,sans-serif;color:#0f172a;max-width:720px">
      <h2 style="margin:0 0 8px">Docs feedback replies that never reached the reader</h2>
      <p style="margin:0 0 12px;color:#475569">
        ${replies.length} failure${replies.length === 1 ? '' : 's'} recorded —
        ${permanent.length} permanent, ${transient.length} transient. Open the
        Docs Feedback inbox to retry transient ones or contact the reader
        another way for the hard bounces.
      </p>
      ${renderSection(PERMANENT_TITLE, PERMANENT_BLURB, '#b91c1c', permanent)}
      ${renderSection(TRANSIENT_TITLE, TRANSIENT_BLURB, '#92400e', transient)}
      <p style="margin:16px 0 0;color:#64748b;font-size:12px">
        Each failure is only reported once in this digest. New failures will appear in the next run.
      </p>
    </div>`;

  const textLines: string[] = [
    'Docs feedback replies that failed to send',
    '',
    `Total: ${replies.length} (${permanent.length} permanent, ${transient.length} transient)`,
    '',
  ];
  if (permanent.length > 0) {
    textLines.push(`${PERMANENT_TITLE}:`);
    for (const r of permanent) {
      textLines.push(
        `- ${r.article_slug} → ${r.to_email} @ ${new Date(r.created_at).toISOString()}: ${r.email_error}`,
      );
    }
    textLines.push('');
  }
  if (transient.length > 0) {
    textLines.push(`${TRANSIENT_TITLE}:`);
    for (const r of transient) {
      textLines.push(
        `- ${r.article_slug} → ${r.to_email} @ ${new Date(r.created_at).toISOString()}: ${r.email_error}`,
      );
    }
    textLines.push('');
  }
  textLines.push('Each failure is only reported once in this digest.');

  return { subject, html, text: textLines.join('\n') };
}

export interface ReplyDigestCycleResult {
  failed: number;
  notified: number;
  emailDelivered: boolean;
  recipients: number;
}

export async function runDocsFeedbackReplyDigestCycle(): Promise<ReplyDigestCycleResult> {
  const failures = await findUnnotifiedFailedReplies();
  if (failures.length === 0) {
    logger.debug('No unnotified failed docs feedback replies');
    return { failed: 0, notified: 0, emailDelivered: false, recipients: 0 };
  }

  const recipients = await getPlatformAdminEmails();
  let emailDelivered = false;

  if (recipients.length === 0) {
    logger.warn(
      'No platform admin recipients found; marking failed replies as notified anyway to avoid repeat logging',
      { failures: failures.length },
    );
  } else {
    const tpl = renderDigestEmail(failures);
    const result = await sendEmail({
      to: recipients.join(', '),
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    });
    emailDelivered = result.success;
    if (!result.success) {
      logger.error('Failed to deliver docs feedback reply digest email', { error: result.error });
    }
  }

  if (emailDelivered || recipients.length === 0) {
    try {
      await markNotified(failures.map((r) => r.reply_id));
    } catch (err) {
      logger.warn('Failed to mark failed replies as notified', { error: String(err) });
    }
  }

  logger.info('Docs feedback reply digest cycle complete', {
    failed: failures.length,
    recipients: recipients.length,
    emailDelivered,
  });

  return {
    failed: failures.length,
    notified: emailDelivered || recipients.length === 0 ? failures.length : 0,
    emailDelivered,
    recipients: recipients.length,
  };
}

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

export function startDocsFeedbackReplyDigestScheduler(
  intervalMs: number = CHECK_INTERVAL_MS,
): void {
  if (timer) return;

  initialTimer = setTimeout(() => {
    runDocsFeedbackReplyDigestCycle().catch((err) => {
      logger.error('Initial docs feedback reply digest cycle failed', { error: String(err) });
    });
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    runDocsFeedbackReplyDigestCycle().catch((err) => {
      logger.error('Docs feedback reply digest cycle failed', { error: String(err) });
    });
  }, intervalMs);

  logger.info('Docs feedback reply digest scheduler started', { intervalMs });
}

export function stopDocsFeedbackReplyDigestScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Docs feedback reply digest scheduler stopped');
  }
}
