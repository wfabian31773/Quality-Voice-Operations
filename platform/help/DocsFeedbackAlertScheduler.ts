import { createLogger } from '../core/logger';
import { getPlatformPool } from '../db';
import { sendEmail } from '../email/EmailService';
import { postToOpsSlackWebhook } from '../messaging/SlackWebhookNotifier';

const logger = createLogger('DOCS_FEEDBACK_ALERTS');

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 5 * 60 * 1000;
const LOOKBACK_DAYS = 7;
const MIN_VOTES_FOR_RATIO = 5;
const NOT_HELPFUL_THRESHOLD = 5;
const RATIO_THRESHOLD_PCT = 40;
const COOLDOWN_DAYS = 7;

const PENDING_REPLY_THRESHOLD_HOURS = 24;
const PENDING_REPLY_COOLDOWN_HOURS = 24;
const PENDING_REPLY_MAX_PER_ALERT = 50;

export interface UnderperformingArticle {
  article_slug: string;
  total_votes: number;
  helpful_count: number;
  not_helpful_count: number;
  helpful_ratio: number | null;
  last_vote_at: string | Date | null;
  reason: 'high_negative_votes' | 'low_helpful_ratio';
}

export async function findUnderperformingArticles(): Promise<UnderperformingArticle[]> {
  const pool = getPlatformPool();
  const r = await pool.query<{
    article_slug: string;
    total_votes: number;
    helpful_count: number;
    not_helpful_count: number;
    helpful_ratio: number | null;
    last_vote_at: Date | null;
  }>(
    `SELECT
       article_slug,
       COUNT(*)::int AS total_votes,
       COUNT(*) FILTER (WHERE vote = 'helpful')::int AS helpful_count,
       COUNT(*) FILTER (WHERE vote = 'not_helpful')::int AS not_helpful_count,
       CASE WHEN COUNT(*) > 0
            THEN ROUND(100.0 * COUNT(*) FILTER (WHERE vote = 'helpful') / COUNT(*))::int
            ELSE NULL END AS helpful_ratio,
       MAX(created_at) AS last_vote_at
     FROM docs_feedback
     WHERE created_at >= NOW() - ($1 || ' days')::interval
     GROUP BY article_slug`,
    [String(LOOKBACK_DAYS)],
  );

  const flagged: UnderperformingArticle[] = [];
  for (const row of r.rows) {
    const ratio = row.helpful_ratio;
    const meetsRatio =
      row.total_votes >= MIN_VOTES_FOR_RATIO && ratio !== null && ratio < RATIO_THRESHOLD_PCT;
    const meetsNegative = row.not_helpful_count >= NOT_HELPFUL_THRESHOLD;
    if (meetsNegative || meetsRatio) {
      flagged.push({
        ...row,
        reason: meetsNegative ? 'high_negative_votes' : 'low_helpful_ratio',
      });
    }
  }
  return flagged;
}

async function getRecentlyAlertedSlugs(slugs: string[]): Promise<Set<string>> {
  if (slugs.length === 0) return new Set();
  const pool = getPlatformPool();
  const r = await pool.query<{ article_slug: string }>(
    `SELECT article_slug FROM docs_feedback_alerts
     WHERE article_slug = ANY($1::varchar[])
       AND last_alerted_at >= NOW() - ($2 || ' days')::interval`,
    [slugs, String(COOLDOWN_DAYS)],
  );
  return new Set(r.rows.map((row) => row.article_slug));
}

async function recordAlert(article: UnderperformingArticle): Promise<void> {
  const pool = getPlatformPool();
  await pool.query(
    `INSERT INTO docs_feedback_alerts (
       article_slug, last_alerted_at, last_total_votes, last_not_helpful_count,
       last_helpful_ratio, last_reason, alert_count
     ) VALUES ($1, NOW(), $2, $3, $4, $5, 1)
     ON CONFLICT (article_slug) DO UPDATE SET
       last_alerted_at = NOW(),
       last_total_votes = EXCLUDED.last_total_votes,
       last_not_helpful_count = EXCLUDED.last_not_helpful_count,
       last_helpful_ratio = EXCLUDED.last_helpful_ratio,
       last_reason = EXCLUDED.last_reason,
       alert_count = docs_feedback_alerts.alert_count + 1,
       updated_at = NOW()`,
    [
      article.article_slug,
      article.total_votes,
      article.not_helpful_count,
      article.helpful_ratio,
      article.reason,
    ],
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

function reasonLabel(reason: UnderperformingArticle['reason']): string {
  return reason === 'high_negative_votes'
    ? `${NOT_HELPFUL_THRESHOLD}+ "not helpful" votes in ${LOOKBACK_DAYS} days`
    : `helpfulness below ${RATIO_THRESHOLD_PCT}%`;
}

function renderAlertEmail(articles: UnderperformingArticle[]): {
  subject: string;
  html: string;
  text: string;
} {
  const subject =
    articles.length === 1
      ? `[QVO Docs] "${articles[0].article_slug}" needs attention`
      : `[QVO Docs] ${articles.length} help articles need attention`;

  const rows = articles
    .map((a) => {
      const ratio = a.helpful_ratio === null ? '—' : `${a.helpful_ratio}%`;
      return `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb"><code>${escapeHtml(a.article_slug)}</code></td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right">${a.total_votes}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right;color:#b91c1c">${a.not_helpful_count}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right">${ratio}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${escapeHtml(reasonLabel(a.reason))}</td>
      </tr>`;
    })
    .join('');

  const html = `
    <div style="font-family:system-ui,sans-serif;color:#0f172a;max-width:720px">
      <h2 style="margin:0 0 8px">Help articles flagged by readers</h2>
      <p style="margin:0 0 12px;color:#475569">
        The following articles crossed the negative-feedback threshold over the last ${LOOKBACK_DAYS} days.
        Review the Docs Feedback panel to see comments and decide on edits.
      </p>
      <table style="border-collapse:collapse;font-size:13px;width:100%">
        <thead>
          <tr style="background:#f1f5f9;text-align:left">
            <th style="padding:8px 10px">Article</th>
            <th style="padding:8px 10px;text-align:right">Votes</th>
            <th style="padding:8px 10px;text-align:right">Not helpful</th>
            <th style="padding:8px 10px;text-align:right">Helpful %</th>
            <th style="padding:8px 10px">Why flagged</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin:16px 0 0;color:#64748b;font-size:12px">
        Each article is muted for ${COOLDOWN_DAYS} days after an alert so this inbox does not get spammed.
      </p>
    </div>`;

  const textLines = [
    'Help articles flagged by readers',
    `Window: last ${LOOKBACK_DAYS} days`,
    '',
    ...articles.map((a) => {
      const ratio = a.helpful_ratio === null ? '—' : `${a.helpful_ratio}%`;
      return `- ${a.article_slug}: ${a.not_helpful_count} not-helpful / ${a.total_votes} total (${ratio}) — ${reasonLabel(a.reason)}`;
    }),
    '',
    `Each article is muted for ${COOLDOWN_DAYS} days after alerting.`,
  ];

  return { subject, html, text: textLines.join('\n') };
}

export interface PendingReplyComment {
  id: number;
  article_slug: string;
  reply_email: string;
  comment: string | null;
  page_path: string | null;
  created_at: Date;
  hours_waiting: number;
}

export async function findPendingReplyComments(): Promise<PendingReplyComment[]> {
  const pool = getPlatformPool();
  const r = await pool.query<{
    id: number;
    article_slug: string;
    reply_email: string;
    comment: string | null;
    page_path: string | null;
    created_at: Date;
    hours_waiting: number;
  }>(
    `SELECT
       id,
       article_slug,
       reply_email,
       comment,
       page_path,
       created_at,
       EXTRACT(EPOCH FROM (NOW() - created_at)) / 3600.0 AS hours_waiting
     FROM docs_feedback
     WHERE reply_email IS NOT NULL
       AND reply_count = 0
       AND status <> 'hidden'
       AND created_at <= NOW() - ($1 || ' hours')::interval
       AND (
         pending_reply_alerted_at IS NULL
         OR pending_reply_alerted_at <= NOW() - ($2 || ' hours')::interval
       )
     ORDER BY created_at ASC
     LIMIT $3`,
    [
      String(PENDING_REPLY_THRESHOLD_HOURS),
      String(PENDING_REPLY_COOLDOWN_HOURS),
      PENDING_REPLY_MAX_PER_ALERT,
    ],
  );
  return r.rows.map((row) => ({
    ...row,
    hours_waiting: Number(row.hours_waiting),
  }));
}

async function markPendingReplyAlerted(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const pool = getPlatformPool();
  await pool.query(
    `UPDATE docs_feedback
     SET pending_reply_alerted_at = NOW()
     WHERE id = ANY($1::int[])`,
    [ids],
  );
}

function renderPendingReplyEmail(comments: PendingReplyComment[]): {
  subject: string;
  html: string;
  text: string;
} {
  const subject =
    comments.length === 1
      ? `[QVO Docs] 1 reader is waiting on a reply`
      : `[QVO Docs] ${comments.length} readers are waiting on a reply`;

  const rows = comments
    .map((c) => {
      const waited = c.hours_waiting >= 48
        ? `${Math.round(c.hours_waiting / 24)}d`
        : `${Math.round(c.hours_waiting)}h`;
      const snippet = (c.comment ?? '').slice(0, 160);
      return `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb"><code>${escapeHtml(c.article_slug)}</code></td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${escapeHtml(c.reply_email)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;color:#b45309">${escapeHtml(waited)}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;color:#475569">${escapeHtml(snippet)}</td>
      </tr>`;
    })
    .join('');

  const baseUrl =
    process.env.APP_URL ??
    (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : '');
  const inboxPath = '/admin/help#docs-feedback?status=pending_reply';
  const inboxLink = baseUrl ? `${baseUrl}${inboxPath}` : inboxPath;

  const html = `
    <div style="font-family:system-ui,sans-serif;color:#0f172a;max-width:720px">
      <h2 style="margin:0 0 8px">Docs feedback waiting on a reply</h2>
      <p style="margin:0 0 12px;color:#475569">
        These readers left a contact email more than ${PENDING_REPLY_THRESHOLD_HOURS} hours ago
        and have not received a reply. Open the
        <a href="${inboxLink}">Docs Feedback inbox (Pending Reply)</a> to respond.
      </p>
      <table style="border-collapse:collapse;font-size:13px;width:100%">
        <thead>
          <tr style="background:#f1f5f9;text-align:left">
            <th style="padding:8px 10px">Article</th>
            <th style="padding:8px 10px">Reader</th>
            <th style="padding:8px 10px">Waiting</th>
            <th style="padding:8px 10px">Comment</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin:16px 0 0;color:#64748b;font-size:12px">
        Each comment is only re-alerted every ${PENDING_REPLY_COOLDOWN_HOURS} hours.
      </p>
    </div>`;

  const textLines = [
    'Docs feedback waiting on a reply',
    `Threshold: ${PENDING_REPLY_THRESHOLD_HOURS}h, cooldown: ${PENDING_REPLY_COOLDOWN_HOURS}h`,
    '',
    ...comments.map((c) => {
      const waited = c.hours_waiting >= 48
        ? `${Math.round(c.hours_waiting / 24)}d`
        : `${Math.round(c.hours_waiting)}h`;
      const snippet = (c.comment ?? '').slice(0, 160).replace(/\s+/g, ' ');
      return `- ${c.article_slug} → ${c.reply_email} (waiting ${waited}): ${snippet}`;
    }),
    '',
    `Open: ${inboxLink}`,
  ];

  return { subject, html, text: textLines.join('\n') };
}

function renderPendingReplySlackMessage(comments: PendingReplyComment[]): {
  text: string;
  blocks: unknown[];
} {
  const baseUrl =
    process.env.APP_URL ??
    (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : '');
  const inboxPath = '/admin/help#docs-feedback?status=pending_reply';
  const inboxLink = baseUrl ? `${baseUrl}${inboxPath}` : inboxPath;

  const headerText =
    comments.length === 1
      ? '1 reader is waiting on a docs reply'
      : `${comments.length} readers are waiting on docs replies`;

  const fallbackText = `[QVO Docs] ${headerText}`;

  const previewLimit = 5;
  const preview = comments.slice(0, previewLimit);
  const moreCount = comments.length - preview.length;

  const lines = preview.map((c) => {
    const waited =
      c.hours_waiting >= 48
        ? `${Math.round(c.hours_waiting / 24)}d`
        : `${Math.round(c.hours_waiting)}h`;
    const snippet = (c.comment ?? '').slice(0, 140).replace(/\s+/g, ' ').trim();
    const snippetSuffix = snippet ? ` — ${snippet}` : '';
    return `• \`${c.article_slug}\` → ${c.reply_email} (waiting ${waited})${snippetSuffix}`;
  });

  if (moreCount > 0) {
    lines.push(`…and ${moreCount} more.`);
  }

  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: ':inbox_tray: Docs feedback waiting on a reply', emoji: true },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${headerText}. Threshold ${PENDING_REPLY_THRESHOLD_HOURS}h, cooldown ${PENDING_REPLY_COOLDOWN_HOURS}h.`,
      },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: lines.join('\n') },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `<${inboxLink}|Open Docs Feedback inbox (Pending Reply)>` },
      ],
    },
  ];

  return { text: fallbackText, blocks };
}

export interface PendingReplyAlertResult {
  pending: number;
  alerted: number;
  emailDelivered: boolean;
  slackDelivered: boolean;
  recipients: number;
}

export async function runDocsFeedbackPendingReplyAlertCycle(): Promise<PendingReplyAlertResult> {
  const pending = await findPendingReplyComments();
  if (pending.length === 0) {
    logger.debug('No pending-reply docs feedback comments past threshold');
    return {
      pending: 0,
      alerted: 0,
      emailDelivered: false,
      slackDelivered: false,
      recipients: 0,
    };
  }

  let slackDelivered = false;
  try {
    const slackTpl = renderPendingReplySlackMessage(pending);
    const slackResult = await postToOpsSlackWebhook({
      text: slackTpl.text,
      blocks: slackTpl.blocks,
    });
    slackDelivered = slackResult.success;
    if (!slackResult.success && !slackResult.skipped) {
      logger.warn('Failed to deliver docs feedback pending-reply alert to Slack', {
        error: slackResult.error,
      });
    }
  } catch (err) {
    logger.warn('Slack notification threw while alerting pending-reply comments', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const recipients = await getPlatformAdminEmails();
  let emailDelivered = false;

  if (recipients.length === 0) {
    logger.warn(
      'No platform admin recipients found; marking pending-reply comments as alerted anyway to avoid repeat logging',
      { pending: pending.length },
    );
  } else {
    const tpl = renderPendingReplyEmail(pending);
    const result = await sendEmail({
      to: recipients.join(', '),
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    });
    emailDelivered = result.success;
    if (!result.success) {
      logger.error('Failed to deliver docs feedback pending-reply alert email', {
        error: result.error,
      });
    }
  }

  if (emailDelivered || recipients.length === 0) {
    try {
      await markPendingReplyAlerted(pending.map((c) => c.id));
    } catch (err) {
      logger.warn('Failed to mark pending-reply comments as alerted', { error: String(err) });
    }
  }

  logger.info('Docs feedback pending-reply alert cycle complete', {
    pending: pending.length,
    recipients: recipients.length,
    emailDelivered,
    slackDelivered,
  });

  return {
    pending: pending.length,
    alerted: emailDelivered || recipients.length === 0 ? pending.length : 0,
    emailDelivered,
    slackDelivered,
    recipients: recipients.length,
  };
}

export interface AlertCycleResult {
  flagged: number;
  alerted: number;
  skippedCooldown: number;
  emailDelivered: boolean;
  recipients: number;
}

export async function runDocsFeedbackAlertCycle(): Promise<AlertCycleResult> {
  const flagged = await findUnderperformingArticles();
  if (flagged.length === 0) {
    logger.debug('No underperforming articles found');
    return { flagged: 0, alerted: 0, skippedCooldown: 0, emailDelivered: false, recipients: 0 };
  }

  const recentlyAlerted = await getRecentlyAlertedSlugs(flagged.map((a) => a.article_slug));
  const toAlert = flagged.filter((a) => !recentlyAlerted.has(a.article_slug));
  const skippedCooldown = flagged.length - toAlert.length;

  if (toAlert.length === 0) {
    logger.info('All flagged articles still in cooldown', {
      flagged: flagged.length,
      skippedCooldown,
    });
    return {
      flagged: flagged.length,
      alerted: 0,
      skippedCooldown,
      emailDelivered: false,
      recipients: 0,
    };
  }

  const recipients = await getPlatformAdminEmails();
  let emailDelivered = false;

  if (recipients.length === 0) {
    logger.warn('No platform admin recipients found; skipping email but recording alert state', {
      articles: toAlert.length,
    });
  } else {
    const tpl = renderAlertEmail(toAlert);
    const result = await sendEmail({
      to: recipients.join(', '),
      subject: tpl.subject,
      html: tpl.html,
      text: tpl.text,
    });
    emailDelivered = result.success;
    if (!result.success) {
      logger.error('Failed to deliver docs feedback alert email', { error: result.error });
    }
  }

  if (emailDelivered || recipients.length === 0) {
    for (const article of toAlert) {
      try {
        await recordAlert(article);
      } catch (err) {
        logger.warn('Failed to record alert state', {
          article_slug: article.article_slug,
          error: String(err),
        });
      }
    }
  }

  logger.info('Docs feedback alert cycle complete', {
    flagged: flagged.length,
    alerted: toAlert.length,
    skippedCooldown,
    recipients: recipients.length,
    emailDelivered,
  });

  return {
    flagged: flagged.length,
    alerted: toAlert.length,
    skippedCooldown,
    emailDelivered,
    recipients: recipients.length,
  };
}

let timer: ReturnType<typeof setInterval> | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;

export function startDocsFeedbackAlertScheduler(intervalMs: number = CHECK_INTERVAL_MS): void {
  if (timer) return;

  initialTimer = setTimeout(() => {
    runDocsFeedbackAlertCycle().catch((err) => {
      logger.error('Initial docs feedback alert cycle failed', { error: String(err) });
    });
    runDocsFeedbackPendingReplyAlertCycle().catch((err) => {
      logger.error('Initial docs feedback pending-reply alert cycle failed', {
        error: String(err),
      });
    });
  }, INITIAL_DELAY_MS);

  timer = setInterval(() => {
    runDocsFeedbackAlertCycle().catch((err) => {
      logger.error('Docs feedback alert cycle failed', { error: String(err) });
    });
    runDocsFeedbackPendingReplyAlertCycle().catch((err) => {
      logger.error('Docs feedback pending-reply alert cycle failed', { error: String(err) });
    });
  }, intervalMs);

  logger.info('Docs feedback alert scheduler started', { intervalMs });
}

export function stopDocsFeedbackAlertScheduler(): void {
  if (initialTimer) {
    clearTimeout(initialTimer);
    initialTimer = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
    logger.info('Docs feedback alert scheduler stopped');
  }
}
