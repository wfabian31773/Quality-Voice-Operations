import { Router, type Request, type Response } from 'express';
import { createLogger } from '../../../platform/core/logger';
import { requireAuth } from '../middleware/auth';
import { requirePlatformAdmin } from '../middleware/rbac';
import { getPlatformPool } from '../../../platform/db';
import { sendEmail, type EmailResult } from '../../../platform/email/EmailService';
import {
  runDocsFeedbackAlertCycle,
  runDocsFeedbackPendingReplyAlertCycle,
} from '../../../platform/help/DocsFeedbackAlertScheduler';
import { runDocsFeedbackReplyDigestCycle } from '../../../platform/help/DocsFeedbackReplyDigestScheduler';
import {
  buildReplyToAddress,
  generateInboundToken,
  renderOutboundTicketReplyEmail,
  escapeHtml,
} from '../../../platform/help/supportReplyEmail';
import { tryReserveRetrySlot } from '../../../platform/help/docsFeedbackRetryLimiter';
import { tryReserveSupportReplyRetrySlot } from '../../../platform/help/supportReplyRetryLimiter';
import { logError } from '../../../platform/core/observability';
import {
  REPLY_DELIVERY_ALERT_THRESHOLD,
  raiseReplyDeliveryFailureAlert,
} from '../../../platform/help/supportReplyDeliveryAlert';

const logger = createLogger('SUPPORT');
const router = Router();

// Retry policy for the ops-team email. Backoff in ms between attempts.
const OPS_EMAIL_RETRY_DELAYS_MS = [500, 2_000, 8_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Attempt to deliver the ops-team email with exponential backoff. Returns the
 * final EmailResult plus the number of attempts made.
 */
async function sendOpsEmailWithRetry(
  to: string,
  subject: string,
  html: string,
  text: string,
  options?: { replyTo?: string; headers?: Record<string, string> },
): Promise<{ result: EmailResult; attempts: number }> {
  let last: EmailResult = { success: false, error: 'no attempts' };
  const total = OPS_EMAIL_RETRY_DELAYS_MS.length + 1;
  for (let i = 0; i < total; i++) {
    last = await sendEmail({ to, subject, html, text, ...options });
    if (last.success) return { result: last, attempts: i + 1 };
    if (i < OPS_EMAIL_RETRY_DELAYS_MS.length) {
      logger.warn('Ops support email attempt failed, retrying', {
        to, attempt: i + 1, error: last.error,
      });
      await sleep(OPS_EMAIL_RETRY_DELAYS_MS[i]);
    }
  }
  return { result: last, attempts: total };
}

/**
 * Raise a platform alert when an ops-team support email cannot be delivered.
 * Writes to error_logs (severity=critical) and, when the ticket is linked to a
 * tenant, also inserts an operations_alerts row for the in-product alert feed.
 */
async function raiseDeliveryFailureAlert(input: {
  ticketId: string;
  tenantId: string | null;
  routedTo: string;
  topic: string;
  attempts: number;
  error: string;
  userEmail: string | null;
}): Promise<void> {
  const { ticketId, tenantId, routedTo, topic, attempts, error, userEmail } = input;
  const message = `Support ticket ${ticketId}: failed to deliver email to ${routedTo} after ${attempts} attempt(s)`;
  await logError(tenantId, 'critical', message, {
    service: 'support',
    errorCode: 'support_email_delivery_failed',
    extra: { ticket_id: ticketId, routed_to: routedTo, topic, attempts, error, user_email: userEmail },
  });
  if (tenantId) {
    try {
      const pool = getPlatformPool();
      await pool.query(
        `INSERT INTO operations_alerts (tenant_id, type, severity, message, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          tenantId,
          'support_email_delivery_failed',
          'high',
          message,
          JSON.stringify({ ticket_id: ticketId, routed_to: routedTo, topic, attempts, error }),
        ],
      );
    } catch (err) {
      logger.warn('Failed to insert operations_alert for support email failure', {
        ticketId, error: String(err),
      });
    }
  }
}

const VALID_TOPICS = new Set([
  'question', 'bug', 'billing', 'integration', 'onboarding', 'feature',
]);

const FALLBACK_DESTINATION = 'support@qvo.ai';
const INBOUND_SECRET = process.env.SUPPORT_INBOUND_SECRET ?? '';

/**
 * Resolve the support destination email for a (plan, topic) pair using the
 * admin-configurable support_routing table.
 *
 * Resolution order (highest priority wins; ties broken by `priority` column):
 *   1. exact (plan, topic)
 *   2. (any plan, topic)         — plan = '*'
 *   3. (plan, any topic)         — topic = '*'
 *   4. (any plan, any topic)     — plan = '*' AND topic = '*'
 *   5. FALLBACK_DESTINATION
 */
async function resolveDestination(plan: string, topic: string): Promise<string> {
  try {
    const pool = getPlatformPool();
    const r = await pool.query<{ destination: string }>(
      `SELECT destination FROM support_routing
       WHERE (plan = $1 OR plan = '*') AND (topic = $2 OR topic = '*')
       ORDER BY
         CASE WHEN plan = $1 AND topic = $2 THEN 4
              WHEN plan = '*' AND topic = $2 THEN 3
              WHEN plan = $1 AND topic = '*' THEN 2
              ELSE 1
         END DESC,
         priority DESC
       LIMIT 1`,
      [plan, topic],
    );
    return r.rows[0]?.destination ?? FALLBACK_DESTINATION;
  } catch (err) {
    logger.warn('support_routing lookup failed, using fallback', { error: String(err) });
    return FALLBACK_DESTINATION;
  }
}

async function lookupPlan(tenantId: string): Promise<string | null> {
  try {
    const pool = getPlatformPool();
    const r = await pool.query<{ plan: string | null }>(
      'SELECT plan FROM tenants WHERE id = $1 LIMIT 1',
      [tenantId],
    );
    return r.rows[0]?.plan ?? null;
  } catch {
    return null;
  }
}

function renderTicketEmail(input: {
  ticketId: string;
  topic: string;
  plan: string;
  message: string;
  recentErrors: string | null;
  user: { email: string; userId: string; tenantId: string };
  context: Record<string, unknown>;
}): { subject: string; html: string; text: string } {
  const { ticketId, topic, plan, message, recentErrors, user, context } = input;
  const subject = `[QVO Support] ${topic.toUpperCase()} from ${user.email} (${ticketId})`;
  const ctxRows = Object.entries(context)
    .map(([k, v]) => `<tr><td style="padding:2px 8px;color:#666"><code>${escapeHtml(k)}</code></td><td style="padding:2px 8px"><code>${escapeHtml(String(v ?? ''))}</code></td></tr>`)
    .join('');
  const html = `
    <div style="font-family:system-ui,sans-serif;color:#0f172a;max-width:640px">
      <h2 style="margin:0 0 12px">New support ticket — ${escapeHtml(ticketId)}</h2>
      <p style="margin:0 0 8px"><strong>Topic:</strong> ${escapeHtml(topic)} &nbsp; <strong>Plan:</strong> ${escapeHtml(plan)}</p>
      <p style="margin:0 0 8px"><strong>From:</strong> ${escapeHtml(user.email)} (user ${escapeHtml(user.userId)})<br/><strong>Tenant:</strong> ${escapeHtml(user.tenantId)}</p>
      <h3 style="margin:16px 0 4px">Message</h3>
      <pre style="white-space:pre-wrap;background:#f5f7fa;padding:12px;border-radius:8px;font-family:inherit">${escapeHtml(message)}</pre>
      ${recentErrors ? `<h3 style="margin:16px 0 4px">Recent errors</h3><pre style="white-space:pre-wrap;background:#fef2f2;padding:12px;border-radius:8px;font-family:ui-monospace,monospace;font-size:12px">${escapeHtml(recentErrors)}</pre>` : ''}
      <h3 style="margin:16px 0 4px">Context</h3>
      <table style="font-size:12px;border-collapse:collapse">${ctxRows}</table>
    </div>`;
  const text = [
    `New support ticket — ${ticketId}`,
    `Topic: ${topic}   Plan: ${plan}`,
    `From: ${user.email} (user ${user.userId})`,
    `Tenant: ${user.tenantId}`,
    '',
    'Message:',
    message,
    recentErrors ? `\nRecent errors:\n${recentErrors}` : '',
    '\nContext:',
    ...Object.entries(context).map(([k, v]) => `  ${k}: ${String(v ?? '')}`),
  ].join('\n');
  return { subject, html, text };
}

function renderAckEmail(ticketId: string): { subject: string; html: string; text: string } {
  return {
    subject: `We received your message — ${ticketId}`,
    html: `<div style="font-family:system-ui,sans-serif;color:#0f172a">
      <p>Thanks for reaching out!</p>
      <p>We've received your support request (reference <strong>${ticketId}</strong>) and a teammate will reply within one business day.</p>
      <p style="color:#64748b;font-size:12px">— The QVO team</p>
    </div>`,
    text: `Thanks for reaching out!\n\nWe've received your support request (reference ${ticketId}) and a teammate will reply within one business day.\n\n— The QVO team`,
  };
}

router.post('/support/tickets', requireAuth, async (req: Request, res: Response) => {
  const { topic, message, recent_errors, context } = req.body ?? {};
  const user = req.user!;

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    res.status(400).json({ error: 'Message is required' });
    return;
  }
  if (message.length > 10000) {
    res.status(400).json({ error: 'Message is too long' });
    return;
  }
  const normalizedTopic = VALID_TOPICS.has(topic) ? topic : 'question';
  const plan = (user.tenantId ? await lookupPlan(user.tenantId) : null) ?? 'trial';
  const routedTo = await resolveDestination(plan.toLowerCase(), normalizedTopic);
  const ticketId = `tkt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const inboundToken = generateInboundToken();
  const safeContext = (context && typeof context === 'object') ? context : {};

  // Persist
  let persisted = true;
  try {
    const pool = getPlatformPool();
    await pool.query(
      `INSERT INTO support_tickets (id, tenant_id, user_id, user_email, plan, topic, message, recent_errors, context, routed_to, inbound_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        ticketId, user.tenantId, user.userId, user.email, plan,
        normalizedTopic, message, recent_errors || null, JSON.stringify(safeContext), routedTo, inboundToken,
      ],
    );
  } catch (err) {
    persisted = false;
    logger.error('Failed to persist support ticket', { ticketId, error: String(err) });
  }

  // Email the support inbox
  const tplOps = renderTicketEmail({
    ticketId,
    topic: normalizedTopic,
    plan,
    message,
    recentErrors: recent_errors || null,
    user,
    context: safeContext as Record<string, unknown>,
  });
  const { result: opsResult, attempts: opsAttempts } = await sendOpsEmailWithRetry(
    routedTo,
    tplOps.subject,
    tplOps.html,
    tplOps.text,
    {
      replyTo: user.email
        ? `${user.email}, ${buildReplyToAddress(inboundToken)}`
        : buildReplyToAddress(inboundToken),
      headers: { 'X-QVO-Ticket-Id': ticketId },
    },
  );

  // Update ticket with delivery state
  if (persisted) {
    try {
      const pool = getPlatformPool();
      await pool.query(
        `UPDATE support_tickets SET email_message_id = $2, email_error = $3, updated_at = NOW() WHERE id = $1`,
        [ticketId, opsResult.messageId ?? null, opsResult.success ? null : (opsResult.error ?? 'unknown')],
      );
    } catch { /* non-fatal */ }
  }

  // Failed delivery — raise a platform alert (best-effort).
  if (!opsResult.success) {
    raiseDeliveryFailureAlert({
      ticketId,
      tenantId: user.tenantId ?? null,
      routedTo,
      topic: normalizedTopic,
      attempts: opsAttempts,
      error: opsResult.error ?? 'unknown',
      userEmail: user.email ?? null,
    }).catch((err) => logger.warn('Failed to raise delivery-failure alert', {
      ticketId, error: String(err),
    }));
  }

  // Auto-acknowledge the user (best-effort)
  if (user.email) {
    const tplAck = renderAckEmail(ticketId);
    sendEmail({ to: user.email, subject: tplAck.subject, html: tplAck.html, text: tplAck.text })
      .catch((e) => logger.warn('Ack email failed', { ticketId, error: String(e) }));
  }

  logger.info('Support ticket processed', {
    ticket_id: ticketId,
    tenant_id: user.tenantId,
    topic: normalizedTopic,
    plan,
    routed_to: routedTo,
    email_delivered: opsResult.success,
    email_attempts: opsAttempts,
    persisted,
    page: (safeContext as Record<string, unknown>).page,
  });

  res.json({
    success: true,
    ticket_id: ticketId,
    routed_to: routedTo,
    email_delivered: opsResult.success,
    auto_acknowledge:
      "Thanks for reaching out — we received your message and a teammate will reply by email within one business day.",
  });
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/docs/feedback', async (req: Request, res: Response) => {
  const { article_slug, vote, comment, page_path, reply_email } = req.body ?? {};

  if (!article_slug || typeof article_slug !== 'string' || article_slug.length > 128) {
    res.status(400).json({ error: 'article_slug is required' });
    return;
  }
  if (vote !== 'helpful' && vote !== 'not_helpful') {
    res.status(400).json({ error: "vote must be 'helpful' or 'not_helpful'" });
    return;
  }
  if (comment && (typeof comment !== 'string' || comment.length > 4000)) {
    res.status(400).json({ error: 'Invalid comment' });
    return;
  }
  let normalizedReplyEmail: string | null = null;
  if (reply_email !== undefined && reply_email !== null && reply_email !== '') {
    if (typeof reply_email !== 'string' || reply_email.length > 320 || !EMAIL_RE.test(reply_email.trim())) {
      res.status(400).json({ error: 'Invalid reply_email' });
      return;
    }
    normalizedReplyEmail = reply_email.trim();
  }

  try {
    const pool = getPlatformPool();
    await pool.query(
      `INSERT INTO docs_feedback (article_slug, vote, comment, page_path, user_agent, reply_email)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        article_slug,
        vote,
        comment || null,
        page_path || null,
        req.headers['user-agent'] || null,
        normalizedReplyEmail,
      ],
    );
  } catch (err) {
    logger.warn('docs_feedback insert failed', { error: String(err) });
  }

  res.json({ success: true });
});

// ----- Platform admin: docs feedback aggregation -----
router.get('/docs/feedback/summary', requireAuth, requirePlatformAdmin, async (req, res) => {
  const sort = String(req.query.sort ?? 'lowest_ratio');
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '100'), 10) || 100, 1), 500);
  let orderBy: string;
  switch (sort) {
    case 'highest_ratio':
      orderBy = 'helpful_ratio DESC NULLS LAST, total_votes DESC';
      break;
    case 'most_votes':
      orderBy = 'total_votes DESC';
      break;
    case 'recent':
      orderBy = 'last_vote_at DESC NULLS LAST';
      break;
    case 'lowest_ratio':
    default:
      orderBy = 'helpful_ratio ASC NULLS FIRST, total_votes DESC';
  }
  try {
    const pool = getPlatformPool();
    const r = await pool.query(
      `SELECT
         article_slug,
         COUNT(*)::int AS total_votes,
         COUNT(*) FILTER (WHERE vote = 'helpful')::int AS helpful_count,
         COUNT(*) FILTER (WHERE vote = 'not_helpful')::int AS not_helpful_count,
         COUNT(*) FILTER (WHERE comment IS NOT NULL AND length(trim(comment)) > 0)::int AS comment_count,
         COUNT(*) FILTER (WHERE comment IS NOT NULL AND length(trim(comment)) > 0 AND status = 'new')::int AS new_comment_count,
         COUNT(*) FILTER (WHERE comment IS NOT NULL AND length(trim(comment)) > 0 AND status = 'resolved')::int AS resolved_comment_count,
         COUNT(*) FILTER (WHERE comment IS NOT NULL AND length(trim(comment)) > 0 AND status = 'hidden')::int AS hidden_comment_count,
         COUNT(*) FILTER (
           WHERE comment IS NOT NULL AND length(trim(comment)) > 0
             AND reply_email IS NOT NULL
             AND reply_count = 0
             AND status <> 'hidden'
         )::int AS pending_reply_count,
         CASE WHEN COUNT(*) > 0
              THEN ROUND(100.0 * COUNT(*) FILTER (WHERE vote = 'helpful') / COUNT(*))::int
              ELSE NULL END AS helpful_ratio,
         MAX(created_at) AS last_vote_at
       FROM docs_feedback
       GROUP BY article_slug
       ORDER BY ${orderBy}
       LIMIT $1`,
      [limit],
    );
    res.json({ articles: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load feedback summary', detail: String(err) });
  }
});

const VALID_FEEDBACK_STATUSES = new Set(['new', 'resolved', 'hidden']);

router.get('/docs/feedback/comments', requireAuth, requirePlatformAdmin, async (req, res) => {
  const slug = req.query.article_slug ? String(req.query.article_slug) : null;
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? '50'), 10) || 50, 1), 200);
  const statusParam = req.query.status ? String(req.query.status) : 'new';
  const pendingReply = statusParam === 'pending_reply';
  const status = (statusParam === 'all' || pendingReply)
    ? null
    : (VALID_FEEDBACK_STATUSES.has(statusParam) ? statusParam : 'new');
  const replyStateParam = req.query.reply_state ? String(req.query.reply_state) : null;
  const replyFailedOnly = replyStateParam === 'failed';
  try {
    const pool = getPlatformPool();
    const params: unknown[] = [limit];
    let where = `WHERE f.comment IS NOT NULL AND length(trim(f.comment)) > 0`;
    if (slug) {
      params.push(slug);
      where += ` AND f.article_slug = $${params.length}`;
    }
    if (status) {
      params.push(status);
      where += ` AND f.status = $${params.length}`;
    }
    if (replyFailedOnly) {
      where += ` AND lr.email_error IS NOT NULL`;
    }
    if (pendingReply) {
      where += ` AND reply_email IS NOT NULL AND reply_count = 0 AND status <> 'hidden'`;
    }
    const r = await pool.query(
      `SELECT f.id, f.article_slug, f.vote, f.comment, f.page_path, f.created_at,
              f.status, f.status_updated_at, f.status_updated_by,
              f.reply_email, f.reply_count,
              lr.created_at AS last_reply_at,
              lr.email_error AS last_reply_error,
              (lr.email_error IS NOT NULL) AS last_reply_failed
       FROM docs_feedback f
       LEFT JOIN LATERAL (
         SELECT created_at, email_error
         FROM docs_feedback_replies
         WHERE feedback_id = f.id
         ORDER BY created_at DESC
         LIMIT 1
       ) lr ON TRUE
       ${where}
       ORDER BY (lr.email_error IS NOT NULL) DESC, f.created_at DESC
       LIMIT $1`,
      params,
    );
    res.json({ comments: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load feedback comments', detail: String(err) });
  }
});

router.patch('/docs/feedback/comments/:id', requireAuth, requirePlatformAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  const status = String(req.body?.status ?? '');
  if (!VALID_FEEDBACK_STATUSES.has(status)) {
    res.status(400).json({ error: "status must be 'new', 'resolved', or 'hidden'" });
    return;
  }
  try {
    const pool = getPlatformPool();
    const actor = req.user?.email ?? req.user?.userId ?? null;
    const r = await pool.query(
      `UPDATE docs_feedback
       SET status = $2, status_updated_at = NOW(), status_updated_by = $3
       WHERE id = $1
       RETURNING id, article_slug, vote, comment, page_path, created_at,
                 status, status_updated_at, status_updated_by,
                 reply_email, reply_count`,
      [id, status, actor],
    );
    if (r.rowCount === 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json({ comment: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update comment status', detail: String(err) });
  }
});

router.get('/docs/feedback/comments/:id/replies', requireAuth, requirePlatformAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  try {
    const pool = getPlatformPool();
    const r = await pool.query(
      `SELECT id, feedback_id, sent_by, to_email, subject, body,
              email_message_id, email_error, retry_of, created_at
       FROM docs_feedback_replies
       WHERE feedback_id = $1
       ORDER BY created_at DESC`,
      [id],
    );
    res.json({ replies: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load replies', detail: String(err) });
  }
});

interface DocsFeedbackComment {
  id: number;
  article_slug: string;
  comment: string | null;
  reply_email: string | null;
}

async function loadDocsFeedbackComment(
  id: number,
): Promise<DocsFeedbackComment | null> {
  const pool = getPlatformPool();
  const r = await pool.query<DocsFeedbackComment>(
    `SELECT id, article_slug, comment, reply_email FROM docs_feedback WHERE id = $1`,
    [id],
  );
  if (r.rowCount === 0) return null;
  return r.rows[0];
}

/**
 * Send a docs-feedback reply email, persist the attempt to
 * docs_feedback_replies, and on success bump reply_count (optionally marking
 * the comment as resolved). Returns the EmailResult plus the resolved subject
 * so callers can report it back to the admin UI.
 */
async function deliverDocsFeedbackReply(input: {
  comment: DocsFeedbackComment;
  body: string;
  subject: string;
  actor: string | null;
  markResolved: boolean;
  retryOf?: number | null;
}): Promise<{ result: EmailResult; finalSubject: string }> {
  const { comment, body, subject, actor, markResolved, retryOf = null } = input;
  if (!comment.reply_email) {
    throw new Error('comment has no reply_email');
  }
  const pool = getPlatformPool();
  const escapedBody = escapeHtml(body).replace(/\n/g, '<br/>');
  const originalBlock = comment.comment
    ? `<hr style="margin:16px 0;border:none;border-top:1px solid #e5e7eb"/>
       <p style="color:#64748b;font-size:12px;margin:0 0 4px">You wrote about <code>${escapeHtml(comment.article_slug)}</code>:</p>
       <blockquote style="margin:0;padding:8px 12px;border-left:3px solid #cbd5e1;color:#475569;background:#f8fafc;font-size:13px;white-space:pre-wrap">${escapeHtml(comment.comment)}</blockquote>`
    : '';
  const html = `
    <div style="font-family:system-ui,sans-serif;color:#0f172a;max-width:640px">
      <p style="white-space:pre-wrap">${escapedBody}</p>
      ${originalBlock}
      <p style="color:#64748b;font-size:12px;margin-top:16px">— The QVO docs team</p>
    </div>`;
  const textOriginal = comment.comment
    ? `\n\n----- Your original feedback (${comment.article_slug}) -----\n${comment.comment}`
    : '';
  const text = `${body}\n${textOriginal}\n\n— The QVO docs team`;

  const result = await sendEmail({
    to: comment.reply_email,
    subject,
    html,
    text,
  });

  try {
    await pool.query(
      `INSERT INTO docs_feedback_replies
         (feedback_id, sent_by, to_email, subject, body, email_message_id, email_error, retry_of)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        comment.id,
        actor,
        comment.reply_email,
        subject,
        body,
        result.messageId ?? null,
        result.success ? null : (result.error ?? 'unknown'),
        retryOf,
      ],
    );
  } catch (err) {
    logger.error('Failed to log docs feedback reply', {
      feedback_id: comment.id,
      error: String(err),
    });
  }

  if (result.success) {
    try {
      await pool.query(
        `UPDATE docs_feedback
         SET reply_count = reply_count + 1
         ${markResolved ? `, status = 'resolved', status_updated_at = NOW(), status_updated_by = $2` : ''}
         WHERE id = $1`,
        markResolved ? [comment.id, actor] : [comment.id],
      );
    } catch (err) {
      logger.warn('Failed to bump reply_count', {
        feedback_id: comment.id,
        error: String(err),
      });
    }
  }

  return { result, finalSubject: subject };
}

router.post('/docs/feedback/comments/:id/reply', requireAuth, requirePlatformAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid id' });
    return;
  }
  const { subject, body, mark_resolved } = req.body ?? {};
  if (!body || typeof body !== 'string' || body.trim().length === 0) {
    res.status(400).json({ error: 'body is required' });
    return;
  }
  if (body.length > 10000) {
    res.status(400).json({ error: 'body is too long' });
    return;
  }
  if (subject !== undefined && subject !== null && (typeof subject !== 'string' || subject.length > 256)) {
    res.status(400).json({ error: 'invalid subject' });
    return;
  }
  if (mark_resolved !== undefined && typeof mark_resolved !== 'boolean') {
    res.status(400).json({ error: 'mark_resolved must be a boolean' });
    return;
  }
  const shouldMarkResolved = mark_resolved === true;

  let comment: DocsFeedbackComment | null;
  try {
    comment = await loadDocsFeedbackComment(id);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load comment', detail: String(err) });
    return;
  }
  if (!comment) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  if (!comment.reply_email) {
    res.status(400).json({ error: 'No reply email captured for this comment' });
    return;
  }

  const actor = req.user?.email ?? req.user?.userId ?? null;
  const finalSubject =
    (subject && subject.trim().length > 0)
      ? subject.trim()
      : `Re: your feedback on ${comment.article_slug}`;

  const { result } = await deliverDocsFeedbackReply({
    comment,
    body,
    subject: finalSubject,
    actor,
    markResolved: shouldMarkResolved,
  });

  if (!result.success) {
    res.status(502).json({
      error: 'Failed to send reply email',
      detail: result.error,
    });
    return;
  }

  logger.info('Docs feedback reply sent', {
    feedback_id: id,
    to: comment.reply_email,
    sent_by: actor,
    message_id: result.messageId,
  });

  res.json({
    success: true,
    message_id: result.messageId,
    to: comment.reply_email,
    subject: finalSubject,
  });
});

/**
 * Re-send the most recent reply for a docs-feedback comment. Used by the
 * "Retry send" button on the failed-reply banner so admins do not have to
 * copy/paste the previous reply body to try delivery again.
 */
router.post(
  '/docs/feedback/comments/:id/reply/retry',
  requireAuth,
  requirePlatformAdmin,
  async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }

    // Atomically check the per-feedback cooldown AND reserve the slot in a
    // single synchronous step before doing any awaited work. This is the
    // anti-spam gate: two concurrent retries against the same broken inbox
    // cannot both pass the limiter — Node is single-threaded, and the
    // reserve happens before any await, so the second handler always sees
    // the first handler's reservation.
    const limit = tryReserveRetrySlot(id);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      res.status(429).json({
        error: `Retry rate limit reached. Try again in ${limit.retryAfterSeconds} second${limit.retryAfterSeconds === 1 ? '' : 's'}.`,
        retry_after_seconds: limit.retryAfterSeconds,
      });
      return;
    }

    let comment: DocsFeedbackComment | null;
    try {
      comment = await loadDocsFeedbackComment(id);
    } catch (err) {
      res.status(500).json({ error: 'Failed to load comment', detail: String(err) });
      return;
    }
    if (!comment) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    if (!comment.reply_email) {
      res.status(400).json({ error: 'No reply email captured for this comment' });
      return;
    }

    const pool = getPlatformPool();
    let lastReply: {
      id: number;
      subject: string;
      body: string;
      to_email: string;
      email_error: string | null;
      retry_of: number | null;
    } | null = null;
    try {
      const r = await pool.query<{
        id: number;
        subject: string;
        body: string;
        to_email: string;
        email_error: string | null;
        retry_of: number | null;
      }>(
        `SELECT id, subject, body, to_email, email_error, retry_of
         FROM docs_feedback_replies
         WHERE feedback_id = $1
         ORDER BY created_at DESC
         LIMIT 1`,
        [id],
      );
      lastReply = r.rowCount && r.rowCount > 0 ? r.rows[0] : null;
    } catch (err) {
      res.status(500).json({ error: 'Failed to load previous reply', detail: String(err) });
      return;
    }

    if (!lastReply) {
      res.status(400).json({ error: 'No previous reply to retry' });
      return;
    }

    // Only allow retrying when the latest reply actually failed to deliver.
    // This prevents accidental duplicate sends if /retry is called directly
    // against a comment whose last reply already went through.
    if (!lastReply.email_error) {
      res.status(409).json({
        error: 'Latest reply already delivered; nothing to retry',
      });
      return;
    }

    // Point retry_of at the *chain root* so every retry of the same original
    // attempt shares the same parent. If the previous attempt was itself a
    // retry, inherit its retry_of; otherwise the previous attempt IS the root.
    const chainRoot = lastReply.retry_of ?? lastReply.id;

    const actor = req.user?.email ?? req.user?.userId ?? null;
    // The retry slot was already reserved at the top of the handler, so even
    // if SMTP fails below the cooldown is already in effect — back-to-back
    // clicks during an outage will be rejected with 429.
    const { result, finalSubject } = await deliverDocsFeedbackReply({
      comment,
      body: lastReply.body,
      subject: lastReply.subject,
      actor,
      markResolved: false,
      retryOf: chainRoot,
    });

    if (!result.success) {
      res.status(502).json({
        error: 'Failed to send reply email',
        detail: result.error,
      });
      return;
    }

    logger.info('Docs feedback reply retried', {
      feedback_id: id,
      to: comment.reply_email,
      sent_by: actor,
      message_id: result.messageId,
    });

    res.json({
      success: true,
      message_id: result.messageId,
      to: comment.reply_email,
      subject: finalSubject,
      retried: true,
    });
  },
);

// ----- Platform admin: support ticket inbox -----
const TICKET_STATUSES = new Set(['open', 'in_progress', 'resolved', 'closed']);

router.get('/support/tickets', requireAuth, requirePlatformAdmin, async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : null;
  const limit = Math.min(parseInt(String(req.query.limit ?? '100'), 10) || 100, 500);
  if (status && status !== 'all' && !TICKET_STATUSES.has(status)) {
    res.status(400).json({ error: 'invalid status filter' });
    return;
  }
  try {
    const pool = getPlatformPool();
    const params: unknown[] = [];
    let where = '';
    if (status && status !== 'all') {
      params.push(status);
      where = `WHERE t.status = $${params.length}`;
    }
    params.push(limit);
    const r = await pool.query(
      `SELECT t.id, t.tenant_id, t.user_id, t.user_email, t.plan, t.topic, t.message,
              t.recent_errors, t.context, t.routed_to, t.status, t.email_message_id,
              t.email_error, t.created_at, t.updated_at,
              tn.name AS tenant_name
       FROM support_tickets t
       LEFT JOIN tenants tn ON tn.id = t.tenant_id
       ${where}
       ORDER BY t.created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    res.json({ tickets: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load tickets', detail: String(err) });
  }
});

router.get('/support/tickets/stats', requireAuth, requirePlatformAdmin, async (_req, res) => {
  try {
    const pool = getPlatformPool();
    // Initial-send failures live on support_tickets.email_error. Outbound
    // reply failures live on support_ticket_replies.email_error and are
    // counted separately so the admin banner can call them out.
    const r = await pool.query<{
      total: number;
      open: number;
      email_failed: number;
      email_failed_open: number;
      reply_email_failed: number;
      reply_email_failed_open: number;
    }>(
      `WITH reply_failures AS (
         SELECT DISTINCT t.id AS ticket_id, t.status AS ticket_status
         FROM support_ticket_replies r
         JOIN support_tickets t ON t.id = r.ticket_id
         WHERE r.direction = 'outbound'
           AND r.email_error IS NOT NULL
       )
       SELECT
         (SELECT COUNT(*)::int FROM support_tickets) AS total,
         (SELECT COUNT(*)::int FROM support_tickets WHERE status IN ('open','in_progress')) AS open,
         (SELECT COUNT(*)::int FROM support_tickets WHERE email_error IS NOT NULL) AS email_failed,
         (SELECT COUNT(*)::int FROM support_tickets WHERE email_error IS NOT NULL AND status IN ('open','in_progress')) AS email_failed_open,
         (SELECT COUNT(*)::int FROM reply_failures) AS reply_email_failed,
         (SELECT COUNT(*)::int FROM reply_failures WHERE ticket_status IN ('open','in_progress')) AS reply_email_failed_open`,
    );
    res.json(r.rows[0] ?? {
      total: 0,
      open: 0,
      email_failed: 0,
      email_failed_open: 0,
      reply_email_failed: 0,
      reply_email_failed_open: 0,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load ticket stats', detail: String(err) });
  }
});

router.patch('/support/tickets/:id/status', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body ?? {};
  if (!status || typeof status !== 'string' || !TICKET_STATUSES.has(status)) {
    res.status(400).json({ error: 'invalid status' });
    return;
  }
  try {
    const pool = getPlatformPool();
    const before = await pool.query<{ status: string }>(
      `SELECT status FROM support_tickets WHERE id = $1`,
      [id],
    );
    if (before.rowCount === 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const previousStatus = before.rows[0].status;
    const r = await pool.query(
      `UPDATE support_tickets SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, status],
    );
    if (previousStatus !== status) {
      const actorEmail = req.user?.email ?? null;
      const actorId = req.user?.userId ?? null;
      const actorLabel = actorEmail ?? actorId ?? 'admin';
      const verbMap: Record<string, string> = {
        open: 'Reopened',
        in_progress: 'Marked in progress',
        resolved: 'Resolved',
        closed: 'Closed',
      };
      const verb = verbMap[status] ?? `Status changed to ${status}`;
      const body = `${verb} by ${actorLabel}`;
      try {
        await pool.query(
          `INSERT INTO support_ticket_replies
             (ticket_id, direction, author_user_id, author_email, body, source)
           VALUES ($1, 'system', $2, $3, $4, 'status_change')`,
          [id, actorId, actorEmail, body],
        );
      } catch (err) {
        logger.warn('Failed to record system status entry', { ticketId: id, error: String(err) });
      }
    }
    res.json({ ticket: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update ticket', detail: String(err) });
  }
});

router.post('/docs/feedback/alerts/run', requireAuth, requirePlatformAdmin, async (_req, res) => {
  try {
    const result = await runDocsFeedbackAlertCycle();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: 'Failed to run docs feedback alert cycle', detail: String(err) });
  }
});

router.post(
  '/docs/feedback/pending-replies/run',
  requireAuth,
  requirePlatformAdmin,
  async (_req, res) => {
    try {
      const result = await runDocsFeedbackPendingReplyAlertCycle();
      res.json({ success: true, ...result });
    } catch (err) {
      res.status(500).json({
        error: 'Failed to run docs feedback pending-reply alert cycle',
        detail: String(err),
      });
    }
  },
);

router.post(
  '/docs/feedback/reply-failures/run',
  requireAuth,
  requirePlatformAdmin,
  async (_req, res) => {
    try {
      const result = await runDocsFeedbackReplyDigestCycle();
      res.json({ success: true, ...result });
    } catch (err) {
      res
        .status(500)
        .json({ error: 'Failed to run docs feedback reply digest cycle', detail: String(err) });
    }
  },
);

router.get('/docs/feedback/alerts', requireAuth, requirePlatformAdmin, async (_req, res) => {
  try {
    const pool = getPlatformPool();
    const r = await pool.query(
      `SELECT article_slug, last_alerted_at, last_total_votes, last_not_helpful_count,
              last_helpful_ratio, last_reason, alert_count
       FROM docs_feedback_alerts
       ORDER BY last_alerted_at DESC
       LIMIT 200`,
    );
    res.json({ alerts: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load alert history', detail: String(err) });
  }
});

// ----- Platform admin: configurable routing (global config; not tenant-scoped) -----
router.get('/support/routing', requireAuth, requirePlatformAdmin, async (_req, res) => {
  try {
    const pool = getPlatformPool();
    const r = await pool.query(
      `SELECT id, plan, topic, destination, priority, notes, updated_at
       FROM support_routing ORDER BY priority DESC, plan, topic`,
    );
    res.json({ routing: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load routing', detail: String(err) });
  }
});

router.put('/support/routing/:id', requireAuth, requirePlatformAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { destination, priority, notes } = req.body ?? {};
  if (!destination || typeof destination !== 'string') {
    res.status(400).json({ error: 'destination is required' });
    return;
  }
  try {
    const pool = getPlatformPool();
    const r = await pool.query(
      `UPDATE support_routing
       SET destination = $2, priority = COALESCE($3, priority), notes = COALESCE($4, notes), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id, destination, typeof priority === 'number' ? priority : null, notes ?? null],
    );
    if (r.rowCount === 0) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    res.json({ routing: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update routing', detail: String(err) });
  }
});

router.post('/support/routing', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { plan, topic, destination, priority, notes } = req.body ?? {};
  if (!plan || !topic || !destination) {
    res.status(400).json({ error: 'plan, topic, and destination are required' });
    return;
  }
  try {
    const pool = getPlatformPool();
    const r = await pool.query(
      `INSERT INTO support_routing (plan, topic, destination, priority, notes)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (plan, topic) DO UPDATE SET destination = EXCLUDED.destination, priority = EXCLUDED.priority, notes = EXCLUDED.notes, updated_at = NOW()
       RETURNING *`,
      [plan, topic, destination, typeof priority === 'number' ? priority : 0, notes ?? null],
    );
    res.json({ routing: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to upsert routing', detail: String(err) });
  }
});

// ----- Platform admin: ticket replies -----

router.get('/support/tickets/:id/replies', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const pool = getPlatformPool();
    const r = await pool.query(
      `SELECT id, ticket_id, direction, author_user_id, author_email, body,
              email_message_id, email_error, source, created_at
       FROM support_ticket_replies
       WHERE ticket_id = $1
       ORDER BY created_at ASC`,
      [id],
    );
    res.json({ replies: r.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load replies', detail: String(err) });
  }
});

router.post('/support/tickets/:id/replies', requireAuth, requirePlatformAdmin, async (req, res) => {
  const { id } = req.params;
  const { body } = req.body ?? {};
  const user = req.user!;

  if (!body || typeof body !== 'string' || body.trim().length === 0) {
    res.status(400).json({ error: 'Reply body is required' });
    return;
  }
  if (body.length > 20000) {
    res.status(400).json({ error: 'Reply is too long' });
    return;
  }

  let ticket: {
    id: string;
    user_email: string | null;
    topic: string;
    inbound_token: string | null;
    status: string;
  };
  try {
    const pool = getPlatformPool();
    const r = await pool.query<typeof ticket>(
      `SELECT id, user_email, topic, inbound_token, status FROM support_tickets WHERE id = $1 LIMIT 1`,
      [id],
    );
    if (r.rowCount === 0) {
      res.status(404).json({ error: 'Ticket not found' });
      return;
    }
    ticket = r.rows[0];
  } catch (err) {
    res.status(500).json({ error: 'Failed to load ticket', detail: String(err) });
    return;
  }

  if (!ticket.user_email) {
    res.status(400).json({ error: 'Ticket has no user email to reply to' });
    return;
  }

  // Make sure the ticket has an inbound token so future replies thread back here.
  let token = ticket.inbound_token;
  if (!token) {
    token = generateInboundToken();
    try {
      const pool = getPlatformPool();
      await pool.query(`UPDATE support_tickets SET inbound_token = $2 WHERE id = $1`, [id, token]);
    } catch { /* non-fatal */ }
  }

  const { subject, html, text } = renderOutboundTicketReplyEmail({
    ticketId: ticket.id,
    topic: ticket.topic,
    body,
  });

  const result = await sendEmail({
    to: ticket.user_email,
    subject,
    html,
    text,
    replyTo: buildReplyToAddress(token),
    headers: { 'X-QVO-Ticket-Id': ticket.id },
  });

  let replyRow: unknown = null;
  try {
    const pool = getPlatformPool();
    const ins = await pool.query(
      `INSERT INTO support_ticket_replies
         (ticket_id, direction, author_user_id, author_email, body, email_message_id, email_error, source)
       VALUES ($1, 'outbound', $2, $3, $4, $5, $6, 'admin_console')
       RETURNING id, ticket_id, direction, author_user_id, author_email, body,
                 email_message_id, email_error, source, created_at`,
      [
        id,
        user.userId,
        user.email,
        body,
        result.messageId ?? null,
        result.success ? null : (result.error ?? 'unknown'),
      ],
    );
    replyRow = ins.rows[0];

    // Auto-advance status: open -> in_progress on first admin reply.
    if (ticket.status === 'open') {
      await pool.query(
        `UPDATE support_tickets SET status = 'in_progress', updated_at = NOW() WHERE id = $1`,
        [id],
      );
    } else {
      await pool.query(`UPDATE support_tickets SET updated_at = NOW() WHERE id = $1`, [id]);
    }
  } catch (err) {
    logger.error('Failed to persist support reply', { ticketId: id, error: String(err) });
    res.status(500).json({ error: 'Failed to record reply', detail: String(err) });
    return;
  }

  logger.info('Support reply sent', {
    ticket_id: id,
    by: user.email,
    email_delivered: result.success,
  });

  res.json({ success: true, email_delivered: result.success, reply: replyRow });
});

/**
 * One-click retry for a failed outbound admin reply. Re-sends the same body to
 * the same recipient via the existing SMTP path and updates the existing reply
 * row's email_message_id / email_error so the badge in the admin UI flips from
 * Failed → Sent on success.
 */
router.post(
  '/support/tickets/:id/replies/:replyId/retry',
  requireAuth,
  requirePlatformAdmin,
  async (req, res) => {
    const { id, replyId } = req.params;
    // Strict digits-only check so values like "42abc" are rejected outright
    // rather than silently becoming 42 via parseInt.
    if (!/^\d+$/.test(replyId)) {
      res.status(400).json({ error: 'Invalid replyId' });
      return;
    }
    const replyIdNum = parseInt(replyId, 10);
    if (!Number.isFinite(replyIdNum) || replyIdNum <= 0) {
      res.status(400).json({ error: 'Invalid replyId' });
      return;
    }

    // Atomically check the per-reply cooldown AND reserve the slot in a
    // single synchronous step before doing any awaited work. Mirrors the
    // docs-feedback retry limiter: two concurrent retries against the same
    // failed reply cannot both pass the gate — Node is single-threaded, and
    // the reserve happens before any await, so the second handler always
    // observes the first handler's reservation. This is the anti-spam gate
    // that keeps an admin mashing the Retry button from re-sending to a
    // bouncing recipient on every click.
    const limit = tryReserveSupportReplyRetrySlot(replyIdNum);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      res.status(429).json({
        error: `Retry rate limit reached. Try again in ${limit.retryAfterSeconds} second${limit.retryAfterSeconds === 1 ? '' : 's'}.`,
        retry_after_seconds: limit.retryAfterSeconds,
      });
      return;
    }

    const pool = getPlatformPool();

    // Load the reply and verify it belongs to this ticket and is a previously
    // failed outbound message. We never re-send already-Sent replies (that would
    // duplicate emails to the customer) and never touch inbound messages.
    let reply: {
      id: number;
      ticket_id: string;
      direction: string;
      body: string;
      email_message_id: string | null;
      email_error: string | null;
      retry_count: number | null;
    };
    try {
      const r = await pool.query<typeof reply>(
        `SELECT id, ticket_id, direction, body, email_message_id, email_error, retry_count
         FROM support_ticket_replies
         WHERE id = $1 AND ticket_id = $2
         LIMIT 1`,
        [replyIdNum, id],
      );
      if (r.rowCount === 0) {
        res.status(404).json({ error: 'Reply not found' });
        return;
      }
      reply = r.rows[0];
    } catch (err) {
      res.status(500).json({ error: 'Failed to load reply', detail: String(err) });
      return;
    }

    if (reply.direction !== 'outbound') {
      res.status(400).json({ error: 'Only outbound replies can be retried' });
      return;
    }
    if (!reply.email_error) {
      res.status(409).json({ error: 'Reply did not fail to send — nothing to retry' });
      return;
    }

    // Load the ticket for the recipient address, topic, and inbound token.
    // tenant_id is needed to write the operations_alerts row when this retry
    // is the one that crosses the persistent-failure threshold.
    let ticket: {
      id: string;
      user_email: string | null;
      topic: string;
      inbound_token: string | null;
      tenant_id: string | null;
    };
    try {
      const r = await pool.query<typeof ticket>(
        `SELECT id, user_email, topic, inbound_token, tenant_id FROM support_tickets WHERE id = $1 LIMIT 1`,
        [id],
      );
      if (r.rowCount === 0) {
        res.status(404).json({ error: 'Ticket not found' });
        return;
      }
      ticket = r.rows[0];
    } catch (err) {
      res.status(500).json({ error: 'Failed to load ticket', detail: String(err) });
      return;
    }

    if (!ticket.user_email) {
      res.status(400).json({ error: 'Ticket has no user email to reply to' });
      return;
    }

    let token = ticket.inbound_token;
    if (!token) {
      token = generateInboundToken();
      try {
        await pool.query(`UPDATE support_tickets SET inbound_token = $2 WHERE id = $1`, [id, token]);
      } catch { /* non-fatal */ }
    }

    const { subject, html, text } = renderOutboundTicketReplyEmail({
      ticketId: ticket.id,
      topic: ticket.topic,
      body: reply.body,
    });

    const result = await sendEmail({
      to: ticket.user_email,
      subject,
      html,
      text,
      replyTo: buildReplyToAddress(token),
      headers: { 'X-QVO-Ticket-Id': ticket.id },
    });

    // The UPDATE bumps retry_count/last_retry_at in the same statement that
    // records the new delivery state. Both the manual /retry path and the
    // background SupportReplyRetryScheduler share this counter so persistent-
    // failure alerts can fire correctly regardless of who triggered the send.
    let updatedRow: { retry_count?: number | null } & Record<string, unknown> = {};
    let newRetryCount = 0;
    try {
      const upd = await pool.query<{ retry_count: number } & Record<string, unknown>>(
        `UPDATE support_ticket_replies
         SET email_message_id = $2, email_error = $3, retry_count = retry_count + 1, last_retry_at = NOW()
         WHERE id = $1
         RETURNING id, ticket_id, direction, author_user_id, author_email, body,
                   email_message_id, email_error, retry_count, last_retry_at,
                   source, created_at`,
        [
          replyIdNum,
          result.messageId ?? null,
          result.success ? null : (result.error ?? 'unknown'),
        ],
      );
      updatedRow = upd.rows[0] ?? {};
      newRetryCount = Number(updatedRow.retry_count ?? 0);
      // Bump ticket updated_at so dashboards reflect the activity.
      await pool.query(`UPDATE support_tickets SET updated_at = NOW() WHERE id = $1`, [id]);
    } catch (err) {
      logger.error('Failed to update support reply after retry', {
        ticketId: id, replyId: replyIdNum, error: String(err),
      });
      res.status(500).json({ error: 'Failed to record retry result', detail: String(err) });
      return;
    }

    // Boundary-cross alert: when this failed retry is the one that pushes
    // the reply's total attempt count to the persistent-failure threshold,
    // raise an operations_alerts row + critical error_log so ops can step in.
    // Strict equality dedupes — retry_count only ever increases, so the
    // threshold is crossed exactly once per reply across both retry paths.
    if (!result.success && newRetryCount === REPLY_DELIVERY_ALERT_THRESHOLD) {
      raiseReplyDeliveryFailureAlert({
        replyId: replyIdNum,
        ticketId: ticket.id,
        tenantId: ticket.tenant_id ?? null,
        customerEmail: ticket.user_email ?? null,
        attempts: newRetryCount,
        error: result.error ?? 'unknown',
      }).catch((alertErr) => {
        logger.warn('Failed to raise support reply delivery alert', {
          ticket_id: id, reply_id: replyIdNum, error: String(alertErr),
        });
      });
    }

    logger.info('Support reply retry attempted', {
      ticket_id: id,
      reply_id: replyIdNum,
      by: req.user?.email,
      email_delivered: result.success,
      retry_count: newRetryCount,
    });

    res.json({ success: true, email_delivered: result.success, reply: updatedRow });
  },
);

// ----- Inbound email webhook (provider: SendGrid Inbound Parse, Mailgun, etc.) -----
//
// Expected payload (form-encoded or JSON):
//   from, to, subject, text, html
// We identify the ticket by:
//   1. the `support+<token>@...` address in `to`
//   2. the `(tkt_xxxxxx)` substring in `subject`
//
// Auth: SUPPORT_INBOUND_SECRET MUST be set in production. The provider must
// include a matching shared secret as either the `X-Webhook-Secret` header or
// the `?secret=` query parameter. In non-production environments the secret is
// optional (left unset for local dev/testing), but if the env var is set the
// request must still carry a matching value.
//
// Provider configuration: SendGrid Inbound Parse is the expected provider.
// Configure the Inbound Parse webhook URL with the secret as a query string:
//   https://app.qvo.ai/api/admin/support/inbound?secret=<SUPPORT_INBOUND_SECRET>
// (Postmark/Mailgun also work — they can send the secret as the
// `X-Webhook-Secret` header.) See replit.md "Inbound support email webhook"
// for the full integration recipe and curl test.
router.post('/support/inbound', async (req, res) => {
  const isProduction = process.env.NODE_ENV === 'production';
  if (isProduction && !INBOUND_SECRET) {
    logger.error('SUPPORT_INBOUND_SECRET is not configured in production — rejecting inbound webhook');
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (INBOUND_SECRET) {
    const provided = (req.headers['x-webhook-secret'] as string | undefined)
      ?? (typeof req.query.secret === 'string' ? req.query.secret : undefined);
    if (provided !== INBOUND_SECRET) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
  }

  const payload = (req.body ?? {}) as Record<string, unknown>;
  const from = String(payload.from ?? payload.sender ?? '').trim();
  const to = String(payload.to ?? payload.recipient ?? '').trim();
  const subject = String(payload.subject ?? '').trim();
  const text = String(payload.text ?? payload['stripped-text'] ?? '').trim();
  const html = String(payload.html ?? payload['stripped-html'] ?? '').trim();

  const body = text || html;
  if (!body) {
    res.status(400).json({ error: 'empty body' });
    return;
  }

  // Try to extract the ticket — prefer the inbound token, then fall back to the subject ref.
  let ticketId: string | null = null;
  const tokenMatch = to.match(/support\+([a-f0-9]{12,64})@/i);
  if (tokenMatch) {
    try {
      const pool = getPlatformPool();
      const r = await pool.query<{ id: string }>(
        `SELECT id FROM support_tickets WHERE inbound_token = $1 LIMIT 1`,
        [tokenMatch[1].toLowerCase()],
      );
      ticketId = r.rows[0]?.id ?? null;
    } catch { /* fall through */ }
  }
  if (!ticketId) {
    const subjMatch = subject.match(/\((tkt_[A-Za-z0-9]+)\)/i);
    if (subjMatch) {
      try {
        const pool = getPlatformPool();
        // Match case-insensitively so users replying from email clients that
        // normalize the subject still thread back to the same ticket.
        const r = await pool.query<{ id: string }>(
          `SELECT id FROM support_tickets WHERE LOWER(id) = LOWER($1) LIMIT 1`,
          [subjMatch[1]],
        );
        ticketId = r.rows[0]?.id ?? null;
      } catch { /* fall through */ }
    }
  }

  if (!ticketId) {
    logger.warn('Inbound support email did not match a ticket', { to, subject, from });
    res.status(202).json({ matched: false });
    return;
  }

  // Strip a sender address out of headers like "Name <user@x.com>"
  const fromMatch = from.match(/<([^>]+)>/);
  const authorEmail = (fromMatch ? fromMatch[1] : from).toLowerCase();

  try {
    const pool = getPlatformPool();
    await pool.query(
      `INSERT INTO support_ticket_replies
         (ticket_id, direction, author_email, body, source)
       VALUES ($1, 'inbound', $2, $3, 'email_webhook')`,
      [ticketId, authorEmail, body],
    );
    // Re-open if previously resolved/closed; nudge updated_at otherwise.
    await pool.query(
      `UPDATE support_tickets
       SET status = CASE WHEN status IN ('resolved', 'closed') THEN 'open' ELSE status END,
           updated_at = NOW()
       WHERE id = $1`,
      [ticketId],
    );
  } catch (err) {
    logger.error('Failed to persist inbound reply', { ticketId, error: String(err) });
    res.status(500).json({ error: 'persist failed' });
    return;
  }

  logger.info('Inbound support reply recorded', { ticket_id: ticketId, from: authorEmail });
  res.json({ matched: true, ticket_id: ticketId });
});

export default router;
