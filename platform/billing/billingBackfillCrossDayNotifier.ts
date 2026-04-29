/**
 * Push notifier for the `billing_backfill_cross_day` operations alert family.
 *
 * The cross-day backfill alert lands in `operations_alerts` (and the ops
 * dashboard banner) whenever a backfill correction shifts an existing call
 * into a different calendar day. That table-only signal is fine for SREs
 * who watch the Operations page, but for finance — who only check the
 * dashboard out of band — it tends to be discovered days after the
 * billing close window has already shut. This module delivers a push
 * (email + best-effort Slack) the moment such an alert is inserted so
 * finance can react inside the close window.
 *
 * Design notes
 * ------------
 *   * Best-effort: every external call (DB row read, SMTP send, Slack POST)
 *     is wrapped so a failure cannot bubble up into the ingest transaction
 *     that produced the alert. Worst case the operator still has the
 *     ops-dashboard row to act on.
 *
 *   * Acknowledgement-aware: notifications only fire when the alert is in
 *     `acknowledged = false`. If the alert was acknowledged between insert
 *     and notify (rare race), or already notified by an earlier worker,
 *     the dispatch is skipped via a conditional `UPDATE … WHERE
 *     notified_at IS NULL AND acknowledged = false RETURNING id`. This is
 *     also the dedup primitive — the row update is atomic, so two
 *     concurrent notify calls cannot both deliver.
 *
 *   * Configurable distribution list: `FINANCE_ALERT_EMAILS` (comma- or
 *     semicolon-separated) drives the To: line. If unset, we fall back to
 *     `BILLING_ALERT_EMAILS`, then to platform-admin emails so the alert
 *     still reaches *someone* who can act, with a warn log noting the
 *     fallback. Slack uses the existing ops webhook
 *     (`OPS_SLACK_WEBHOOK_URL`); when both channels are unavailable we
 *     log and short-circuit without claiming `notified_at`, so a later
 *     reconfiguration can retry.
 */

import { createLogger } from '../core/logger';
import { getPlatformPool } from '../db';
import { sendEmail } from '../email/EmailService';
import { postToOpsSlackWebhook } from '../messaging/SlackWebhookNotifier';

const logger = createLogger('BILLING_BACKFILL_ALERT');

export const BILLING_BACKFILL_CROSS_DAY_ALERT_TYPES = [
  'billing_backfill_cross_day',
  'billing_backfill_cross_day_skipped',
] as const;

export type BillingBackfillCrossDayAlertType =
  (typeof BILLING_BACKFILL_CROSS_DAY_ALERT_TYPES)[number];

interface AlertRow {
  id: string;
  tenant_id: string;
  type: BillingBackfillCrossDayAlertType;
  severity: string;
  message: string;
  metadata: Record<string, unknown> | null;
  call_session_id: string | null;
  acknowledged: boolean;
  notified_at: Date | null;
  created_at: Date;
}

export interface FinanceBackfillNotifyResult {
  /** True when the function actually delivered to at least one channel. */
  delivered: boolean;
  /** True when the conditional UPDATE claimed this alert (i.e. we were the writer). */
  claimed: boolean;
  /** Reason we did not deliver, when relevant. Useful for tests + logs. */
  skipReason?:
    | 'alert_not_found'
    | 'already_notified'
    | 'already_acknowledged'
    | 'claim_lost'
    | 'no_recipients_or_channels'
    | 'channels_failed';
  /** True when the email send succeeded (or was logged in console mode). */
  emailDelivered: boolean;
  /** True when the Slack post succeeded. False when not configured or failed. */
  slackDelivered: boolean;
  /** Number of email recipients the message was sent to. */
  recipients: number;
}

/**
 * Splits the configured distribution-list string on either commas or
 * semicolons (both are common in pasted address lists), trims each entry,
 * dedups while preserving order, and drops anything that does not look
 * like an email address. Returning a clean `string[]` keeps the rest of
 * the module from re-implementing this trivial parsing.
 */
function parseDistributionList(raw: string | undefined): string[] {
  if (!raw) return [];
  const parts = raw
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p.includes('@'));
  return Array.from(new Set(parts));
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
    return Array.from(
      new Set(
        r.rows
          .map((row) => row.email?.trim())
          .filter((e): e is string => !!e && e.includes('@')),
      ),
    );
  } catch (err) {
    logger.warn('Failed to load platform admin emails for finance fallback', {
      error: String(err),
    });
    return [];
  }
}

interface ResolvedRecipients {
  emails: string[];
  source: 'finance' | 'billing' | 'platform_admin' | 'none';
}

export async function resolveFinanceRecipients(): Promise<ResolvedRecipients> {
  const finance = parseDistributionList(process.env.FINANCE_ALERT_EMAILS);
  if (finance.length > 0) return { emails: finance, source: 'finance' };

  const billing = parseDistributionList(process.env.BILLING_ALERT_EMAILS);
  if (billing.length > 0) return { emails: billing, source: 'billing' };

  const admins = await getPlatformAdminEmails();
  if (admins.length > 0) return { emails: admins, source: 'platform_admin' };

  return { emails: [], source: 'none' };
}

async function loadTenantName(tenantId: string): Promise<string | null> {
  const pool = getPlatformPool();
  try {
    const r = await pool.query<{ name: string | null }>(
      `SELECT name FROM tenants WHERE id = $1`,
      [tenantId],
    );
    return r.rows[0]?.name ?? null;
  } catch (err) {
    logger.warn('Failed to load tenant name for backfill alert email', {
      tenantId,
      error: String(err),
    });
    return null;
  }
}

async function loadAlert(alertId: string): Promise<AlertRow | null> {
  const pool = getPlatformPool();
  try {
    const r = await pool.query<AlertRow>(
      `SELECT id, tenant_id, type, severity, message, metadata, call_session_id,
              acknowledged, notified_at, created_at
         FROM operations_alerts
        WHERE id = $1`,
      [alertId],
    );
    return r.rows[0] ?? null;
  } catch (err) {
    logger.warn('Failed to load operations_alert for finance notification', {
      alertId,
      error: String(err),
    });
    return null;
  }
}

/**
 * Atomically claims the notification slot BEFORE any external send. The
 * conditional WHERE clause enforces the acknowledgement-aware dedup
 * contract: if someone else already notified, or a human already
 * acknowledged, the UPDATE matches zero rows and we bail out *without*
 * dispatching the email/Slack. This is the single point that prevents
 * duplicate finance pings — two concurrent calls cannot both win the
 * UPDATE, and an ack landing between insert and notify suppresses the
 * push entirely.
 *
 * The slot starts marked with `notification_kind = 'pending'`. After the
 * channel sends complete the kind is rewritten to the comma-separated
 * list of succeeded channels (e.g. 'email,slack'), or — if every channel
 * fails — the slot is released so a future invocation can retry instead
 * of being eternally muted by a half-dispatched alert.
 */
async function claimNotificationSlot(alertId: string): Promise<boolean> {
  const pool = getPlatformPool();
  try {
    const r = await pool.query<{ id: string }>(
      `UPDATE operations_alerts
          SET notified_at = NOW(),
              notification_kind = 'pending'
        WHERE id = $1
          AND notified_at IS NULL
          AND acknowledged = FALSE
        RETURNING id`,
      [alertId],
    );
    return (r.rowCount ?? 0) > 0;
  } catch (err) {
    logger.warn('Failed to claim finance notification slot for backfill alert', {
      alertId,
      error: String(err),
    });
    return false;
  }
}

/**
 * Records the channels that successfully delivered after the claim was
 * acquired. Best-effort; a failure to overwrite the placeholder is logged
 * but never throws — the alert is still effectively muted because
 * `notified_at` is already set, which is the dedup primitive.
 */
async function finalizeNotificationKind(
  alertId: string,
  channels: string,
): Promise<void> {
  const pool = getPlatformPool();
  try {
    await pool.query(
      `UPDATE operations_alerts
          SET notification_kind = $2
        WHERE id = $1`,
      [alertId, channels],
    );
  } catch (err) {
    logger.warn('Failed to finalize notification_kind on backfill alert', {
      alertId,
      channels,
      error: String(err),
    });
  }
}

/**
 * Releases a previously-claimed slot when every dispatch channel fails.
 * Without this, a transient SMTP+Slack outage would permanently mute the
 * alert. By clearing `notified_at` we let the next invocation re-claim
 * and retry; subsequent successful claims will still see the alert in
 * the unacknowledged state and dispatch normally.
 */
async function releaseNotificationSlot(alertId: string): Promise<void> {
  const pool = getPlatformPool();
  try {
    await pool.query(
      `UPDATE operations_alerts
          SET notified_at = NULL,
              notification_kind = NULL
        WHERE id = $1
          AND notification_kind = 'pending'`,
      [alertId],
    );
  } catch (err) {
    logger.warn('Failed to release notification slot after channel failures', {
      alertId,
      error: String(err),
    });
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildOpsAlertLink(alertType: string): string {
  const baseUrl =
    process.env.APP_URL ??
    (process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : '');
  const path = `/ops/monitor?alertType=${encodeURIComponent(alertType)}#alerts-panel`;
  return baseUrl ? `${baseUrl}${path}` : path;
}

function buildRunbookLink(runbookPath: string): string {
  // Runbooks live under the repo's `docs/` tree. They aren't served from
  // the app, so we expose the canonical path verbatim — operators open it
  // either via the wiki render or the source repo.
  return runbookPath;
}

interface RenderedAlert {
  subject: string;
  html: string;
  text: string;
  slack: { text: string; blocks: unknown[] };
}

function renderAlert(
  alert: AlertRow,
  tenantName: string | null,
  externalId: string,
  oldDate: string,
  newDate: string,
  runbookUrl: string,
  opsLink: string,
): RenderedAlert {
  const isSkipped = alert.type === 'billing_backfill_cross_day_skipped';
  const tenantLabel = tenantName ? `${tenantName} (${alert.tenant_id})` : alert.tenant_id;

  const subjectPrefix = isSkipped
    ? '[QVO Billing] Manual rebalance required'
    : '[QVO Billing] Cross-day backfill rebalanced';
  const subject = `${subjectPrefix}: call ${externalId} (${oldDate} → ${newDate})`;

  const headline = isSkipped
    ? 'A backfill correction shifted a call across midnight, but the OLD-day rollup rows were missing — the auto-rebalance was SKIPPED. Finance must rebalance manually off the runbook.'
    : 'A backfill correction shifted a call across midnight. daily_org_usage and usage_metrics were auto-rebalanced inside the same ingest transaction — please verify before the billing close window closes.';

  const callTraceLine = alert.call_session_id
    ? `<p class="muted">call_session_id: <code>${escapeHtml(alert.call_session_id)}</code></p>`
    : '';

  const html = `<!DOCTYPE html>
<html>
  <body style="font-family:system-ui,sans-serif;color:#0f172a;background:#f4f5f7;padding:24px">
    <div style="max-width:640px;margin:0 auto;background:#fff;border-radius:8px;padding:24px;border:1px solid #e5e7eb">
      <h2 style="margin:0 0 8px;color:${isSkipped ? '#b45309' : '#0f172a'}">
        ${isSkipped ? 'Manual rebalance required' : 'Cross-day backfill: verify rebalance'}
      </h2>
      <p style="margin:0 0 16px;color:#475569">${escapeHtml(headline)}</p>
      <table style="border-collapse:collapse;font-size:13px;width:100%;margin-bottom:16px">
        <tbody>
          <tr><td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;color:#64748b">Tenant</td>
              <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${escapeHtml(tenantLabel)}</td></tr>
          <tr><td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;color:#64748b">External call ID</td>
              <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb"><code>${escapeHtml(externalId)}</code></td></tr>
          <tr><td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;color:#64748b">OLD billing day</td>
              <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${escapeHtml(oldDate)}</td></tr>
          <tr><td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;color:#64748b">NEW billing day</td>
              <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${escapeHtml(newDate)}</td></tr>
          <tr><td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;color:#64748b">Severity</td>
              <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${escapeHtml(alert.severity)}</td></tr>
        </tbody>
      </table>
      <p style="margin:0 0 12px"><a href="${escapeHtml(opsLink)}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600">Open Operations alerts</a></p>
      <p style="margin:0 0 4px;color:#475569">Runbook: ${
        /^https?:\/\//i.test(runbookUrl)
          ? `<a href="${escapeHtml(runbookUrl)}" style="color:#2563eb;text-decoration:underline">${escapeHtml(runbookUrl)}</a>`
          : `<code>${escapeHtml(runbookUrl)}</code>`
      }</p>
      ${callTraceLine}
      <p style="margin:16px 0 0;color:#94a3b8;font-size:12px">
        You're receiving this because your address is on the finance distribution list (FINANCE_ALERT_EMAILS).
        Acknowledging the alert in the Operations panel suppresses repeat pings for this row.
      </p>
    </div>
  </body>
</html>`;

  const textLines = [
    headline,
    '',
    `Tenant:        ${tenantLabel}`,
    `External ID:   ${externalId}`,
    `OLD day:       ${oldDate}`,
    `NEW day:       ${newDate}`,
    `Severity:      ${alert.severity}`,
    alert.call_session_id ? `Call session:  ${alert.call_session_id}` : null,
    '',
    `Runbook: ${runbookUrl}`,
    `Open ops:  ${opsLink}`,
  ].filter((l): l is string => l !== null);

  const slackHeader = isSkipped
    ? ':rotating_light: Cross-day backfill — manual rebalance required'
    : ':warning: Cross-day backfill — verify auto-rebalance';

  const slackBlocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: slackHeader, emoji: true },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Tenant*\n${tenantLabel}` },
        { type: 'mrkdwn', text: `*External ID*\n\`${externalId}\`` },
        { type: 'mrkdwn', text: `*OLD day*\n${oldDate}` },
        { type: 'mrkdwn', text: `*NEW day*\n${newDate}` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Runbook: \`${runbookUrl}\`\n<${opsLink}|Open Operations alerts>`,
      },
    },
  ];

  return {
    subject,
    html,
    text: textLines.join('\n'),
    slack: { text: `${subjectPrefix}: ${externalId} (${oldDate} → ${newDate})`, blocks: slackBlocks },
  };
}

/**
 * Public entry point. Called from `recordBackfillCrossDayAlert` immediately
 * after the operations_alerts row is inserted. Always best-effort: the
 * caller does not await success and a thrown error here must not bubble
 * up into the ingest pipeline.
 */
export async function notifyFinanceOfBackfillCrossDayAlert(
  alertId: string,
): Promise<FinanceBackfillNotifyResult> {
  const baseResult: FinanceBackfillNotifyResult = {
    delivered: false,
    claimed: false,
    emailDelivered: false,
    slackDelivered: false,
    recipients: 0,
  };

  const alert = await loadAlert(alertId);
  if (!alert) {
    return { ...baseResult, skipReason: 'alert_not_found' };
  }
  if (alert.notified_at) {
    return { ...baseResult, skipReason: 'already_notified' };
  }
  if (alert.acknowledged) {
    return { ...baseResult, skipReason: 'already_acknowledged' };
  }

  const metadata = (alert.metadata ?? {}) as Record<string, unknown>;
  const externalId = typeof metadata.external_id === 'string' ? metadata.external_id : 'unknown';
  const oldDate = typeof metadata.old_date === 'string' ? metadata.old_date : 'unknown';
  const newDate = typeof metadata.new_date === 'string' ? metadata.new_date : 'unknown';
  const runbookUrl =
    typeof metadata.runbook_url === 'string'
      ? buildRunbookLink(metadata.runbook_url)
      : 'docs/runbooks/billing-backfill-cross-day-rebalance.md';
  const opsLink = buildOpsAlertLink(alert.type);

  const tenantName = await loadTenantName(alert.tenant_id);
  const recipientsResolved = await resolveFinanceRecipients();
  const slackConfigured = !!(
    process.env.OPS_SLACK_WEBHOOK_URL ??
    process.env.SLACK_WEBHOOK_URL ??
    process.env.SLACK_WEBHOOK
  );

  if (recipientsResolved.emails.length === 0 && !slackConfigured) {
    logger.warn(
      'Finance backfill alert has no email recipients AND no Slack webhook configured — skipping notification',
      { alertId, tenantId: alert.tenant_id, externalId },
    );
    return { ...baseResult, skipReason: 'no_recipients_or_channels' };
  }

  if (recipientsResolved.source === 'platform_admin') {
    logger.warn(
      'FINANCE_ALERT_EMAILS / BILLING_ALERT_EMAILS not configured — falling back to platform admin recipients',
      { alertId, tenantId: alert.tenant_id, recipientCount: recipientsResolved.emails.length },
    );
  } else if (recipientsResolved.source === 'billing') {
    logger.info(
      'FINANCE_ALERT_EMAILS not configured — falling back to BILLING_ALERT_EMAILS',
      { alertId, tenantId: alert.tenant_id, recipientCount: recipientsResolved.emails.length },
    );
  }

  // CRITICAL ORDERING: claim the slot BEFORE any external send. The
  // conditional UPDATE here is the only thing that prevents:
  //   * an ack landing between loadAlert() and notify dispatching anyway,
  //   * two concurrent invocations both pushing to finance.
  // If the claim fails (zero rows updated), we have already lost the race
  // or the alert was acknowledged — return without dispatching ANY channel.
  const claimed = await claimNotificationSlot(alertId);
  if (!claimed) {
    return {
      ...baseResult,
      skipReason: 'claim_lost',
      recipients: recipientsResolved.emails.length,
    };
  }

  const rendered = renderAlert(
    alert,
    tenantName,
    externalId,
    oldDate,
    newDate,
    runbookUrl,
    opsLink,
  );

  let emailDelivered = false;
  if (recipientsResolved.emails.length > 0) {
    try {
      const r = await sendEmail({
        to: recipientsResolved.emails.join(', '),
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      });
      emailDelivered = r.success;
      if (!r.success) {
        logger.warn('Finance backfill alert email send failed', {
          alertId,
          error: r.error,
          permanent: r.permanent,
        });
      }
    } catch (err) {
      logger.warn('Finance backfill alert email send threw', {
        alertId,
        error: String(err),
      });
    }
  }

  let slackDelivered = false;
  if (slackConfigured) {
    try {
      const r = await postToOpsSlackWebhook({
        text: rendered.slack.text,
        blocks: rendered.slack.blocks,
      });
      slackDelivered = r.success;
      if (!r.success && !r.skipped) {
        logger.warn('Finance backfill alert Slack post failed', {
          alertId,
          error: r.error,
        });
      }
    } catch (err) {
      logger.warn('Finance backfill alert Slack post threw', {
        alertId,
        error: String(err),
      });
    }
  }

  const channels: string[] = [];
  if (emailDelivered) channels.push('email');
  if (slackDelivered) channels.push('slack');

  if (channels.length === 0) {
    // Every channel failed after we claimed the slot. Release the slot so
    // a future invocation can retry instead of being permanently muted by
    // a half-dispatched alert. This is the only path where `claimed` is
    // true but `delivered` is false.
    await releaseNotificationSlot(alertId);
    return {
      ...baseResult,
      recipients: recipientsResolved.emails.length,
      skipReason: 'channels_failed',
      claimed: false,
      emailDelivered,
      slackDelivered,
    };
  }

  // Replace the 'pending' placeholder with the actual succeeded channel
  // list. notified_at stays where it was set during the claim, so the
  // dedup contract holds even if this UPDATE fails.
  await finalizeNotificationKind(alertId, channels.join(','));

  return {
    delivered: true,
    claimed: true,
    emailDelivered,
    slackDelivered,
    recipients: recipientsResolved.emails.length,
  };
}
