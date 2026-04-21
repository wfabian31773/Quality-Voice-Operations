import { createLogger } from '../core/logger';
import { getPlatformPool } from '../db';
import { sendEmail } from '../email/EmailService';

const logger = createLogger('DOCS_FEEDBACK_REPLY_DIGEST');

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

function renderDigestEmail(replies: FailedReply[]): {
  subject: string;
  html: string;
  text: string;
} {
  const subject =
    replies.length === 1
      ? `[QVO Docs] 1 feedback reply failed to send`
      : `[QVO Docs] ${replies.length} feedback replies failed to send`;

  const rows = replies
    .map((r) => {
      return `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb"><code>${escapeHtml(r.article_slug)}</code></td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${escapeHtml(r.to_email)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${escapeHtml(new Date(r.created_at).toISOString())}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;color:#b91c1c">${escapeHtml(r.email_error)}</td>
      </tr>`;
    })
    .join('');

  const html = `
    <div style="font-family:system-ui,sans-serif;color:#0f172a;max-width:720px">
      <h2 style="margin:0 0 8px">Docs feedback replies that never reached the reader</h2>
      <p style="margin:0 0 12px;color:#475569">
        The following reply emails were recorded as failed. Open the Docs Feedback
        inbox to retry them or contact the reader another way.
      </p>
      <table style="border-collapse:collapse;font-size:13px;width:100%">
        <thead>
          <tr style="background:#f1f5f9;text-align:left">
            <th style="padding:8px 10px">Article</th>
            <th style="padding:8px 10px">To</th>
            <th style="padding:8px 10px">Attempted</th>
            <th style="padding:8px 10px">Error</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin:16px 0 0;color:#64748b;font-size:12px">
        Each failure is only reported once in this digest. New failures will appear in the next run.
      </p>
    </div>`;

  const textLines = [
    'Docs feedback replies that failed to send',
    '',
    ...replies.map(
      (r) =>
        `- ${r.article_slug} → ${r.to_email} @ ${new Date(r.created_at).toISOString()}: ${r.email_error}`,
    ),
    '',
    'Each failure is only reported once in this digest.',
  ];

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
