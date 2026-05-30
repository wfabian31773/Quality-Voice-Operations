/**
 * Email-based alert dispatcher for cost-reconciliation + general ops
 * alerts (cost audit fix #5, commit 2/4).
 *
 * Two public surfaces:
 *
 *   1. `sendReconciliationAlert(ctx, options)` — used by the cron
 *      scheduler in commit 3. Encapsulates the dedup state machine
 *      (don't re-email an already-alerted row unless severity went up)
 *      and the email body construction.
 *
 *   2. `sendOpsAlert(params)` — generic ops alert. Used by commit 4
 *      to reroute the legacy `StripePriceVerificationScheduler` and
 *      `billingBackfillCrossDayNotifier` off the dead
 *      `OPS_SLACK_WEBHOOK_URL` (no Slack workspace exists) onto the
 *      same email-service path.
 *
 * Both ultimately call into `platform/email/sendEmail`, which logs to
 * console when SMTP is unset — so the alert is visible in dev logs
 * even without SMTP creds.
 */

import { sendEmail, type EmailResult } from '../../email';
import { createLogger } from '../../core/logger';
import { alertSeverity } from './ReconciliationService';
import type { AlertContext, AlertReason } from './types';

const logger = createLogger('ALERT_DISPATCHER');

const DEFAULT_RECIPIENT = 'fabianwayne1@gmail.com';

function resolveMarginAlertRecipient(): string {
  const override = (process.env.MARGIN_ALERT_EMAIL ?? '').trim();
  return override.length > 0 ? override : DEFAULT_RECIPIENT;
}

function resolveOpsAlertRecipient(): string {
  // Prefer a dedicated ops mailbox if set, otherwise fall back to the
  // margin-alert recipient so the same inbox catches everything.
  const opsOverride = (process.env.OPS_ALERT_EMAIL ?? '').trim();
  if (opsOverride.length > 0) return opsOverride;
  return resolveMarginAlertRecipient();
}

// -----------------------------------------------------------------------
// Dedup state machine (pure, exported for tests)
// -----------------------------------------------------------------------

export interface AlertDecision {
  shouldSend: boolean;
  /**
   * Human-readable reason for the decision. Telemetry / logs only;
   * not user-facing.
   */
  reason:
    | 'no_alert'              // currentReason is null
    | 'first_alert'           // not previously triggered
    | 'escalation'            // previously triggered, severity went up
    | 'severity_unchanged'    // previously triggered, same or lower severity
    | 'no_recipient';         // misconfig: no MARGIN_ALERT_EMAIL set AND DEFAULT removed
}

/**
 * Decide whether the dispatcher should fire an email for this row.
 *
 * Rules:
 *   * currentReason = null  → never send (recovered or never breached)
 *   * not previously triggered → send (first time entering an alert state)
 *   * already triggered AND severity escalated → send (e.g.
 *     'below_healthy_floor' → 'losing_money')
 *   * already triggered AND same-or-lower severity → no send (dedup)
 *
 * The scheduler in commit 3 also handles the "alert cleared" case:
 * when currentReason is null, the UPSERT resets `alert_triggered =
 * FALSE` so the next breach re-alerts cleanly.
 */
export function shouldSendAlert(
  currentReason: AlertReason | null,
  previousAlertTriggered: boolean,
  previousReason: AlertReason | null,
): AlertDecision {
  if (currentReason === null) {
    return { shouldSend: false, reason: 'no_alert' };
  }
  if (!previousAlertTriggered) {
    return { shouldSend: true, reason: 'first_alert' };
  }
  if (alertSeverity(currentReason) > alertSeverity(previousReason)) {
    return { shouldSend: true, reason: 'escalation' };
  }
  return { shouldSend: false, reason: 'severity_unchanged' };
}

// -----------------------------------------------------------------------
// Reconciliation alert email — subject + body construction
// -----------------------------------------------------------------------

function severityPrefix(reason: AlertReason): string {
  switch (reason) {
    case 'losing_money':
      return '🚨 LOSING MONEY';
    case 'unbilled_cost_threshold':
      return '🚨 UNBILLED COSTS';
    case 'below_healthy_floor':
      return '⚠ Margin below floor';
  }
}

function formatCentsAsUsd(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  // Centralised dollars-from-cents formatter would be ideal here, but
  // this is a single .toFixed call inside an alert body — not the kind
  // of multi-place math the `no-cents-divided-by-100` lint rule was
  // protecting against. Kept inline with an explicit disable + reason.
  // eslint-disable-next-line local/no-cents-divided-by-100 -- one-shot display formatter inside alert email body
  const dollars = cents / 100;
  return dollars.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

function formatPercent(percent: number | null): string {
  if (percent === null) return '—';
  return `${percent.toFixed(1)}%`;
}

function buildSubject(ctx: AlertContext): string {
  const { row, tenantName } = ctx;
  if (row.alertReason === null) {
    // shouldSendAlert filters this out, but defensive default.
    return `Billing reconciliation: ${tenantName}`;
  }
  const month = row.periodStart.toISOString().slice(0, 7); // YYYY-MM
  const prefix = severityPrefix(row.alertReason);
  switch (row.alertReason) {
    case 'losing_money':
      return `${prefix}: ${tenantName} (${formatCentsAsUsd(row.marginCents)} margin · ${month})`;
    case 'unbilled_cost_threshold':
      return `${prefix}: ${tenantName} (${formatCentsAsUsd(row.internalCostCents)} · ${month})`;
    case 'below_healthy_floor':
      return `${prefix}: ${tenantName} (${formatPercent(row.marginPercent)} · ${month})`;
  }
}

function buildHtml(ctx: AlertContext): string {
  const { row, tenantName, tenantId, adminUrl } = ctx;
  const month = row.periodStart.toISOString().slice(0, 7);
  const periodEnd = new Date(row.periodEnd.getTime() - 1).toISOString().slice(0, 10);
  const periodStart = row.periodStart.toISOString().slice(0, 10);
  const invoiceIdsStr = row.stripeInvoiceIds.length > 0
    ? row.stripeInvoiceIds.join(', ')
    : '(none)';
  const avgOpenAiCents = row.conversationCount > 0
    ? Math.round(row.openaiCostCents / row.conversationCount)
    : 0;
  const avgTwilioCents = row.conversationCount > 0 && row.twilioCostCents !== null
    ? Math.round(row.twilioCostCents / row.conversationCount)
    : 0;

  const estimateWarning = row.estimateRowCount > 0
    ? `<p style="background:#fff7ed;border-left:4px solid #f97316;padding:8px 12px;margin:16px 0;">
        ⚠ <strong>${row.estimateRowCount}</strong> of <strong>${row.conversationCount}</strong>
        conversations used ESTIMATE token counts — margin may be off until
        those rows are re-attributed via response.done.usage (cost audit fix #3).
       </p>`
    : '';

  const adminLink = adminUrl
    ? `<p><a href="${adminUrl}">View row in Platform Admin →</a></p>`
    : '';

  return `<!doctype html>
<html><body style="font-family:system-ui,Segoe UI,sans-serif;color:#111;max-width:640px;margin:0 auto;padding:24px;">
<h2 style="margin:0 0 16px;">${severityPrefix(row.alertReason!)}</h2>

<p><strong>Tenant:</strong> ${tenantName} <code style="color:#666;">(${tenantId})</code><br/>
<strong>Billing status:</strong> <code>${row.billingStatus}</code><br/>
<strong>Period:</strong> ${periodStart} → ${periodEnd} (${month})</p>

<table style="border-collapse:collapse;margin:16px 0;">
  <tr><td style="padding:4px 12px 4px 0;">Revenue</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;">${formatCentsAsUsd(row.invoiceTotalCents)}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666;">Stripe invoices</td>
      <td style="text-align:right;color:#666;font-size:0.85em;">${invoiceIdsStr}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;">Stripe fee (est)</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;">-${formatCentsAsUsd(row.stripeFeeCents)}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;">Internal cost</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;">-${formatCentsAsUsd(row.internalCostCents)}</td></tr>
  <tr><td style="padding:4px 12px 4px 0;color:#666;">Conversations</td>
      <td style="text-align:right;color:#666;">${row.conversationCount}</td></tr>
  <tr><td colspan="2" style="border-top:1px solid #ddd;padding:4px 0;"></td></tr>
  <tr><td style="padding:4px 12px 4px 0;"><strong>Margin</strong></td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;"><strong>${formatCentsAsUsd(row.marginCents)} (${formatPercent(row.marginPercent)})</strong></td></tr>
</table>

<h3 style="margin:16px 0 8px;">Cost breakdown</h3>
<table style="border-collapse:collapse;">
  <tr><td style="padding:4px 12px 4px 0;">OpenAI</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;">${formatCentsAsUsd(row.openaiCostCents)}</td>
      <td style="padding-left:12px;color:#666;">avg ${formatCentsAsUsd(avgOpenAiCents)}/call</td></tr>
  <tr><td style="padding:4px 12px 4px 0;">Twilio</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;">${row.twilioCostCents !== null ? formatCentsAsUsd(Math.round(row.twilioCostCents)) : '—'}</td>
      <td style="padding-left:12px;color:#666;">avg ${formatCentsAsUsd(avgTwilioCents)}/call</td></tr>
  <tr><td style="padding:4px 12px 4px 0;">Infra</td>
      <td style="text-align:right;font-variant-numeric:tabular-nums;">${formatCentsAsUsd(row.infraCostCents)}</td>
      <td style="padding-left:12px;color:#666;">placeholder allocation, audit §2.5</td></tr>
</table>

${estimateWarning}

${adminLink}

<p style="color:#888;font-size:0.85em;margin-top:24px;">
This is an automated alert from the QVO cost-reconciliation scheduler.
Threshold tuning: <code>OPS_MARGIN_HEALTHY_PCT</code> (default 20),
<code>UNBILLED_COST_CEILING_CENTS</code> (default 5000 = $50). Recipient:
<code>MARGIN_ALERT_EMAIL</code> (default ${DEFAULT_RECIPIENT}).
</p>
</body></html>`;
}

// -----------------------------------------------------------------------
// Public dispatcher
// -----------------------------------------------------------------------

export interface DispatchResult {
  sent: boolean;
  decision: AlertDecision;
  emailResult?: EmailResult;
}

/**
 * Send a reconciliation alert email if the dedup state machine says
 * we should. Caller (scheduler in commit 3) flips `alert_triggered`
 * to TRUE on the DB row when `sent = true`.
 */
export async function sendReconciliationAlert(
  ctx: AlertContext,
  previous: { triggered: boolean; reason: AlertReason | null },
): Promise<DispatchResult> {
  const decision = shouldSendAlert(ctx.row.alertReason, previous.triggered, previous.reason);

  if (!decision.shouldSend) {
    logger.debug('Skipping reconciliation alert', {
      tenantId: ctx.tenantId,
      currentReason: ctx.row.alertReason,
      previousReason: previous.reason,
      decision: decision.reason,
    });
    return { sent: false, decision };
  }

  const subject = buildSubject(ctx);
  const html = buildHtml(ctx);
  const recipient = resolveMarginAlertRecipient();

  if (recipient.length === 0) {
    logger.warn('No MARGIN_ALERT_EMAIL recipient configured; skipping send', {
      tenantId: ctx.tenantId,
    });
    return { sent: false, decision: { shouldSend: false, reason: 'no_recipient' } };
  }

  const emailResult = await sendEmail({ to: recipient, subject, html });

  logger.info('Reconciliation alert dispatched', {
    tenantId: ctx.tenantId,
    alertReason: ctx.row.alertReason,
    decisionReason: decision.reason,
    recipient,
    emailSuccess: emailResult.success,
    messageId: emailResult.messageId,
  });

  return { sent: emailResult.success, decision, emailResult };
}

// -----------------------------------------------------------------------
// Generic ops alert — for commit 4 to reroute the existing Slack feeds
// -----------------------------------------------------------------------

export interface OpsAlertParams {
  /** Drives the emoji prefix on the subject line. */
  severity: 'info' | 'warning' | 'urgent';
  /** Plain subject. Severity emoji is prepended automatically. */
  subject: string;
  /** Pre-formatted HTML body. The email-service handles MIME headers. */
  bodyHtml: string;
  /** Optional plain-text alternative for clients that strip HTML. */
  bodyText?: string;
  /**
   * Optional source tag for telemetry — e.g. 'stripe_price_drift',
   * 'billing_backfill_cross_day'. Helps Wayne grep the inbox.
   */
  source?: string;
}

/**
 * Generic ops alert dispatcher. Commit 4 will retarget
 * `StripePriceVerificationScheduler` and
 * `billingBackfillCrossDayNotifier` from
 * `postToOpsSlackWebhook(...)` (no-op without a Slack workspace) to
 * this function so their alerts land in the same inbox.
 */
export async function sendOpsAlert(params: OpsAlertParams): Promise<EmailResult | { success: false; error: string }> {
  const recipient = resolveOpsAlertRecipient();
  if (recipient.length === 0) {
    logger.warn('No ops alert recipient configured; skipping send', {
      source: params.source,
    });
    return { success: false, error: 'no_recipient' };
  }

  const emojiPrefix =
    params.severity === 'urgent' ? '🚨 ' : params.severity === 'warning' ? '⚠ ' : 'ℹ ';
  const subject = `${emojiPrefix}${params.subject}`;

  const headers: Record<string, string> = {};
  if (params.source) {
    headers['X-QVO-Alert-Source'] = params.source;
  }

  const result = await sendEmail({
    to: recipient,
    subject,
    html: params.bodyHtml,
    text: params.bodyText,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  });

  logger.info('Ops alert dispatched', {
    source: params.source,
    severity: params.severity,
    recipient,
    success: result.success,
    messageId: result.messageId,
  });

  return result;
}
