function baseLayout(content: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>
  body { margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f4f5f7; color: #1a1a2e; }
  .container { max-width: 560px; margin: 40px auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  .header { background: #1a1a2e; padding: 24px 32px; }
  .header h1 { margin: 0; color: #ffffff; font-size: 20px; font-weight: 600; }
  .body { padding: 32px; }
  .body p { margin: 0 0 16px; line-height: 1.6; color: #374151; font-size: 15px; }
  .btn { display: inline-block; background: #2563eb; color: #ffffff; text-decoration: none; padding: 12px 28px; border-radius: 8px; font-weight: 600; font-size: 15px; margin: 8px 0 16px; }
  .footer { padding: 16px 32px; border-top: 1px solid #e5e7eb; text-align: center; }
  .footer p { margin: 0; font-size: 12px; color: #9ca3af; }
  .muted { color: #6b7280; font-size: 13px; }
  .alert-warn { border-left: 4px solid #f59e0b; padding: 12px 16px; background: #fffbeb; border-radius: 6px; margin: 16px 0; }
  .alert-error { border-left: 4px solid #ef4444; padding: 12px 16px; background: #fef2f2; border-radius: 6px; margin: 16px 0; }
</style>
</head>
<body>
<div class="container">
  <div class="header"><h1>Quality Voice Operations</h1></div>
  <div class="body">${content}</div>
  <div class="footer"><p>&copy; ${new Date().getFullYear()} Quality Voice Operations. All rights reserved.</p></div>
</div>
</body>
</html>`;
}

export function invitationEmail(params: {
  inviterName?: string;
  role: string;
  tenantName?: string;
  signupUrl: string;
  expiresInHours: number;
}): { subject: string; html: string; text: string } {
  const inviter = params.inviterName ?? 'A team administrator';
  const org = params.tenantName ?? 'your organization';

  const html = baseLayout(`
    <p>Hi there,</p>
    <p>${inviter} has invited you to join <strong>${org}</strong> on Quality Voice Operations as a <strong>${params.role}</strong>.</p>
    <p>Click below to accept the invitation and set up your account:</p>
    <p><a href="${params.signupUrl}" class="btn">Accept Invitation</a></p>
    <p class="muted">This invitation expires in ${params.expiresInHours} hours. If you didn't expect this email, you can safely ignore it.</p>
  `);

  const text = `${inviter} has invited you to join ${org} on Quality Voice Operations as a ${params.role}.\n\nAccept the invitation: ${params.signupUrl}\n\nThis link expires in ${params.expiresInHours} hours.`;

  return { subject: `You're invited to join ${org}`, html, text };
}

export function emailVerificationEmail(params: {
  verificationUrl: string;
  name?: string;
}): { subject: string; html: string; text: string } {
  const greeting = params.name ? `Hi ${params.name},` : 'Hi,';

  const html = baseLayout(`
    <p>${greeting}</p>
    <p>Welcome to Quality Voice Operations! Please verify your email address to activate your trial account.</p>
    <p><a href="${params.verificationUrl}" class="btn">Verify Email Address</a></p>
    <p class="muted">If you didn't create an account, you can safely ignore this email.</p>
  `);

  const text = `${greeting}\n\nWelcome to Quality Voice Operations! Please verify your email address to activate your trial account.\n\nVerify here: ${params.verificationUrl}`;

  return { subject: 'Verify your email address', html, text };
}

export function passwordResetEmail(params: {
  resetUrl: string;
  expiresInMinutes: number;
}): { subject: string; html: string; text: string } {
  const html = baseLayout(`
    <p>Hi,</p>
    <p>We received a request to reset your password. Click the button below to choose a new password:</p>
    <p><a href="${params.resetUrl}" class="btn">Reset Password</a></p>
    <p class="muted">This link expires in ${params.expiresInMinutes} minutes. If you didn't request a password reset, no action is needed — your account is still secure.</p>
  `);

  const text = `We received a request to reset your password.\n\nReset your password: ${params.resetUrl}\n\nThis link expires in ${params.expiresInMinutes} minutes.`;

  return { subject: 'Reset your password', html, text };
}

export function billingAlertEmail(params: {
  alertType: 'usage_warning' | 'usage_critical' | 'payment_failed';
  tenantName?: string;
  percentUsed?: number;
  currentSpend?: string;
  budgetLimit?: string;
  failureReason?: string;
  dashboardUrl: string;
}): { subject: string; html: string; text: string } {
  const org = params.tenantName ?? 'Your organization';
  let subject: string;
  let alertContent: string;

  switch (params.alertType) {
    case 'usage_warning': {
      const pct = params.percentUsed ?? 80;
      subject = `Usage alert: ${pct}% of budget used`;
      alertContent = `
        <div class="alert-warn">
          <p style="margin:0"><strong>Usage Warning</strong></p>
          <p style="margin:4px 0 0">${org} has used <strong>${pct}%</strong> of its monthly budget${params.currentSpend ? ` ($${params.currentSpend} of $${params.budgetLimit})` : ''}.</p>
        </div>
        <p>Review your usage and adjust your plan if needed.</p>
      `;
      break;
    }
    case 'usage_critical': {
      const pct = params.percentUsed ?? 95;
      subject = `Critical: ${pct}% of budget used`;
      alertContent = `
        <div class="alert-error">
          <p style="margin:0"><strong>Critical Usage Alert</strong></p>
          <p style="margin:4px 0 0">${org} has used <strong>${pct}%</strong> of its monthly budget. Services may be restricted soon.</p>
        </div>
        <p>Upgrade your plan or reduce usage to avoid service interruption.</p>
      `;
      break;
    }
    case 'payment_failed': {
      subject = 'Payment failed — action required';
      alertContent = `
        <div class="alert-error">
          <p style="margin:0"><strong>Payment Failed</strong></p>
          <p style="margin:4px 0 0">We were unable to process payment for ${org}${params.failureReason ? `: ${params.failureReason}` : ''}.</p>
        </div>
        <p>Please update your payment method to avoid service interruption.</p>
      `;
      break;
    }
  }

  const html = baseLayout(`
    <p>Hi,</p>
    ${alertContent}
    <p><a href="${params.dashboardUrl}" class="btn">View Dashboard</a></p>
  `);

  const text = `${subject}\n\nVisit your dashboard: ${params.dashboardUrl}`;

  return { subject, html, text };
}

export function connectorSyncErrorEmail(params: {
  tenantName?: string;
  providerLabel: string;
  errorMessage: string;
  reconnectUrl: string;
  detectedAt: string;
}): { subject: string; html: string; text: string } {
  const org = params.tenantName ?? 'your organization';
  const subject = `Action required: ${params.providerLabel} sync is failing`;
  const safeError = (params.errorMessage || 'Sync failed').slice(0, 500);

  const html = baseLayout(`
    <p>Hi,</p>
    <p>The <strong>${params.providerLabel}</strong> integration for <strong>${org}</strong> just failed to sync. Calls and other workflows that depend on this integration may be affected until you reconnect.</p>
    <div class="alert-error">
      <p style="margin:0"><strong>Latest error</strong></p>
      <p style="margin:4px 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:13px;">${safeError}</p>
      <p style="margin:8px 0 0" class="muted">Detected at ${params.detectedAt}</p>
    </div>
    <p>The link below jumps straight to the ${params.providerLabel} card on your Connectors page so you can re-authorize without hunting for it:</p>
    <p><a href="${params.reconnectUrl}" class="btn">Reconnect ${params.providerLabel}</a></p>
    <p class="muted">You won't get another email about this integration for 24 hours, even if it keeps failing.</p>
  `);

  const text = `${subject}\n\nThe ${params.providerLabel} integration for ${org} just failed to sync.\n\nLatest error: ${safeError}\nDetected at ${params.detectedAt}\n\nReconnect: ${params.reconnectUrl}\n\nYou won't get another email about this integration for 24 hours.`;

  return { subject, html, text };
}

export function connectorAutoDisabledEmail(params: {
  tenantName?: string;
  providerLabel: string;
  daysFailing: number;
  reconnectUrl: string;
  disabledAt: string;
  lastErrorMessage?: string | null;
}): { subject: string; html: string; text: string } {
  const org = params.tenantName ?? 'your organization';
  const subject = `${params.providerLabel} integration has been disabled`;
  const safeError = params.lastErrorMessage
    ? params.lastErrorMessage.slice(0, 500)
    : null;
  const errorBlock = safeError
    ? `<div class="alert-error">
         <p style="margin:0"><strong>Last recorded error</strong></p>
         <p style="margin:4px 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:13px;">${safeError}</p>
       </div>`
    : '';
  const errorTextLine = safeError ? `\nLast recorded error: ${safeError}\n` : '';

  const html = baseLayout(`
    <p>Hi,</p>
    <p>The <strong>${params.providerLabel}</strong> integration for <strong>${org}</strong> has been failing to authenticate for <strong>${params.daysFailing} day${params.daysFailing === 1 ? '' : 's'}</strong>. To stop wasting tool budget on calls that can't succeed, we've automatically <strong>disabled</strong> this connector.</p>
    <p>Events that depend on this integration will no longer be dispatched until it is reconnected and re-enabled.</p>
    ${errorBlock}
    <p class="muted">Auto-disabled at ${params.disabledAt}</p>
    <p>The link below jumps straight to the ${params.providerLabel} card on your Connectors page — sign in again and re-enable it from there:</p>
    <p><a href="${params.reconnectUrl}" class="btn">Reconnect ${params.providerLabel}</a></p>
    <p class="muted">This is the final automated email about this connector. You will not get more reminders unless it is reconnected and fails again.</p>
  `);

  const text = `${subject}\n\n` +
    `The ${params.providerLabel} integration for ${org} has been failing to authenticate for ${params.daysFailing} day${params.daysFailing === 1 ? '' : 's'}, ` +
    `so it has been automatically disabled. Events to this integration will no longer be dispatched until it is reconnected.\n` +
    errorTextLine +
    `\nAuto-disabled at ${params.disabledAt}\n\n` +
    `Reconnect: ${params.reconnectUrl}\n\n` +
    `This is the final automated email about this connector.`;

  return { subject, html, text };
}

export function connectorReconnectNeededEmail(params: {
  tenantName?: string;
  providerLabel: string;
  errorMessage?: string | null;
  reconnectUrl: string;
  detectedAt: string;
}): { subject: string; html: string; text: string } {
  const org = params.tenantName ?? 'your organization';
  const subject = `Action required: reconnect ${params.providerLabel}`;
  const safeError = (params.errorMessage ?? '').slice(0, 500);
  const errorBlock = safeError
    ? `
    <div class="alert-error">
      <p style="margin:0"><strong>Why we couldn't refresh automatically</strong></p>
      <p style="margin:4px 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:13px;">${safeError}</p>
      <p style="margin:8px 0 0" class="muted">Detected at ${params.detectedAt}</p>
    </div>`
    : `
    <div class="alert-error">
      <p style="margin:0"><strong>Authorization expired</strong></p>
      <p style="margin:4px 0 0">We tried to refresh the access automatically and couldn't.</p>
      <p style="margin:8px 0 0" class="muted">Detected at ${params.detectedAt}</p>
    </div>`;

  const html = baseLayout(`
    <p>Hi,</p>
    <p>The <strong>${params.providerLabel}</strong> integration for <strong>${org}</strong> needs to be reconnected. Until you reauthorize it, calls, events, and other workflows that depend on this integration will not sync.</p>
    ${errorBlock}
    <p>The link below jumps straight to the ${params.providerLabel} card on your Connectors page so you can reauthorize without hunting for it:</p>
    <p><a href="${params.reconnectUrl}" class="btn">Reconnect ${params.providerLabel}</a></p>
    <p class="muted">You won't get another email about this integration for 24 hours, even if the next refresh attempt also fails.</p>
  `);

  const text = `${subject}\n\nThe ${params.providerLabel} integration for ${org} needs to be reconnected. Until you reauthorize it, calls and events that depend on this integration will not sync.\n\n${safeError ? `Reason: ${safeError}\n` : ''}Detected at ${params.detectedAt}\n\nReconnect: ${params.reconnectUrl}\n\nYou won't get another email about this integration for 24 hours.`;

  return { subject, html, text };
}

export function connectorSyncDigestEmail(params: {
  tenantName?: string;
  connectorsUrl: string;
  generatedAt: string;
  failures: Array<{
    provider: string;
    providerLabel: string;
    name: string | null;
    errorMessage: string;
    detectedAt: string | null;
  }>;
}): { subject: string; html: string; text: string } {
  const org = params.tenantName ?? 'your organization';
  const count = params.failures.length;
  const subject =
    count === 1
      ? `Daily integration digest: 1 connector failing`
      : `Daily integration digest: ${count} connectors failing`;

  // Per-row deep link mirrors the per-event reconnect surfaces (email, SMS,
  // in-app) so a tenant can one-click straight to the failing connector card
  // instead of landing on the index. Built from `connectorsUrl` (already
  // `${baseUrl}/connectors`) so the host respects APP_URL/REPLIT_DEV_DOMAIN.
  const baseConnectorsUrl = params.connectorsUrl.replace(/[?#].*$/, '');
  const reconnectUrlFor = (provider: string): string =>
    `${baseConnectorsUrl}?provider=${encodeURIComponent(provider)}`;

  const rowsHtml = params.failures
    .map((f) => {
      const safeError = (f.errorMessage || 'Sync failed').slice(0, 240);
      const detected = f.detectedAt ? `<p style="margin:4px 0 0" class="muted">Last error ${f.detectedAt}</p>` : '';
      const subtitle = f.name && f.name !== f.providerLabel ? ` — ${f.name}` : '';
      const href = reconnectUrlFor(f.provider);
      return `
        <a href="${href}" style="display:block; text-decoration:none; color:inherit;">
          <div class="alert-error">
            <p style="margin:0"><strong>${f.providerLabel}${subtitle}</strong></p>
            <p style="margin:4px 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:13px;">${safeError}</p>
            ${detected}
            <p style="margin:8px 0 0; color:#2563eb; font-size:13px; font-weight:600;">Reconnect ${f.providerLabel} →</p>
          </div>
        </a>`;
    })
    .join('');

  const rowsText = params.failures
    .map((f) => {
      const detected = f.detectedAt ? ` (last error ${f.detectedAt})` : '';
      const subtitle = f.name && f.name !== f.providerLabel ? ` — ${f.name}` : '';
      return `• ${f.providerLabel}${subtitle}${detected}\n  ${(f.errorMessage || 'Sync failed').slice(0, 240)}\n  Reconnect: ${reconnectUrlFor(f.provider)}`;
    })
    .join('\n\n');

  const html = baseLayout(`
    <p>Hi,</p>
    <p>This is your daily digest of integration failures for <strong>${org}</strong>. ${count === 1 ? 'One connector is' : `${count} connectors are`} currently failing to sync. Click any row below to jump straight to that connector and reconnect it.</p>
    ${rowsHtml}
    <p><a href="${params.connectorsUrl}" class="btn">Open Connectors</a></p>
    <p class="muted">Digest generated ${params.generatedAt}. You're receiving one email per day instead of one per failure because digest mode is enabled in Settings → Notifications.</p>
  `);

  const text = `${subject}\n\nThis is your daily digest of integration failures for ${org}. ${count === 1 ? 'One connector is' : `${count} connectors are`} currently failing to sync.\n\n${rowsText}\n\nOpen Connectors: ${params.connectorsUrl}\n\nDigest generated ${params.generatedAt}. Digest mode is enabled in Settings → Notifications.`;

  return { subject, html, text };
}

export function connectorSyncRecoveryEmail(params: {
  tenantName?: string;
  providerLabel: string;
  connectorsUrl: string;
  recoveredAt: string;
  outageDescription?: string | null;
}): { subject: string; html: string; text: string } {
  const org = params.tenantName ?? 'your organization';
  const subject = `${params.providerLabel} integration is back online`;
  const outageLine = params.outageDescription
    ? `<p>The integration was failing for approximately <strong>${params.outageDescription}</strong>.</p>`
    : '';
  const outageTextLine = params.outageDescription
    ? `\nThe integration was failing for approximately ${params.outageDescription}.`
    : '';

  const html = baseLayout(`
    <p>Hi,</p>
    <p>Good news — the <strong>${params.providerLabel}</strong> integration for <strong>${org}</strong> just synced successfully again. No further action is needed.</p>
    ${outageLine}
    <p class="muted">Recovered at ${params.recoveredAt}</p>
    <p><a href="${params.connectorsUrl}" class="btn">View Connectors</a></p>
    <p class="muted">You'll only get one of these recovery emails per integration during a 24-hour window, even if the connector recovers again.</p>
  `);

  const text = `${subject}\n\nThe ${params.providerLabel} integration for ${org} is syncing successfully again. No action needed.${outageTextLine}\n\nRecovered at ${params.recoveredAt}\n\nView connectors: ${params.connectorsUrl}`;

  return { subject, html, text };
}

export function connectorSchedulingDriftEmail(params: {
  tenantName?: string;
  connectorsUrl: string;
  detectedAt: string;
  /**
   * Each entry is one agent or phone number whose chosen scheduling provider
   * doesn't match any enabled scheduling integration on the tenant. We bundle
   * them into a single per-tenant email so an admin gets one nudge with the
   * full list rather than one email per drifted target.
   */
  drifted: Array<{
    refType: 'agent' | 'phone_number';
    name: string;
    providerLabel: string;
  }>;
}): { subject: string; html: string; text: string } {
  const org = params.tenantName ?? 'your organization';
  const count = params.drifted.length;
  const subject =
    count === 1
      ? `Action required: 1 calendar booking target for ${org} has no connected calendar`
      : `Action required: ${count} calendar booking targets for ${org} have no connected calendar`;

  const rowsHtml = params.drifted
    .map((d) => {
      const targetLabel = d.refType === 'phone_number' ? 'Phone number' : 'Agent';
      const safeName = (d.name || 'Unnamed').slice(0, 200);
      const safeProvider = (d.providerLabel || 'Unknown calendar').slice(0, 80);
      return `
        <li style="margin:0 0 6px;">
          <strong>${targetLabel}:</strong> ${safeName}
          <span class="muted">→ ${safeProvider} (not connected)</span>
        </li>`;
    })
    .join('');

  const rowsText = params.drifted
    .map((d) => {
      const targetLabel = d.refType === 'phone_number' ? 'Phone number' : 'Agent';
      const safeName = (d.name || 'Unnamed').slice(0, 200);
      const safeProvider = (d.providerLabel || 'Unknown calendar').slice(0, 80);
      return `• ${targetLabel}: ${safeName} → ${safeProvider} (not connected)`;
    })
    .join('\n');

  const html = baseLayout(`
    <p>Hi,</p>
    <p>${count === 1 ? 'One booking target' : `${count} booking targets`} for <strong>${org}</strong> ${count === 1 ? 'is' : 'are'} configured to book into a calendar that is no longer connected. Until the calendar is reconnected (or the target is pointed at a different calendar), bookings made by these agents and numbers won't actually land on a calendar.</p>
    <div class="alert-error">
      <p style="margin:0 0 8px"><strong>Affected agents and phone numbers</strong></p>
      <ul style="margin:0; padding-left:20px; color:#374151; font-size:14px; line-height:1.6;">
        ${rowsHtml}
      </ul>
      <p style="margin:8px 0 0" class="muted">Detected at ${params.detectedAt}</p>
    </div>
    <p>Open the Connectors page to reconnect the missing calendars or change the booking target's calendar selection:</p>
    <p><a href="${params.connectorsUrl}" class="btn">Open Connectors</a></p>
    <p class="muted">You won't get another email about scheduling drift for 24 hours, even if more targets become misconfigured. Reconnect the calendar or change the assigned calendar to clear this warning.</p>
  `);

  const text =
    `${subject}\n\n` +
    `${count === 1 ? 'One booking target' : `${count} booking targets`} for ${org} ${count === 1 ? 'is' : 'are'} configured to book into a calendar that is no longer connected. ` +
    `Until the calendar is reconnected, bookings made by these agents and numbers won't actually land on a calendar.\n\n` +
    `Affected agents and phone numbers:\n${rowsText}\n\n` +
    `Detected at ${params.detectedAt}\n\n` +
    `Open Connectors: ${params.connectorsUrl}\n\n` +
    `You won't get another email about scheduling drift for 24 hours.`;

  return { subject, html, text };
}

export function escalationAlertEmail(params: {
  tenantName?: string;
  reason: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  agentSlug?: string | null;
  callerPhone?: string | null;
  toolName?: string | null;
  callSessionId: string;
  escalationsUrl: string;
  raisedAt: string;
}): { subject: string; html: string; text: string } {
  const org = params.tenantName ?? 'your organization';
  const safeReason = (params.reason || 'A live call needs human attention').slice(0, 500);
  const priorityLabel = params.priority.charAt(0).toUpperCase() + params.priority.slice(1);
  const subject =
    params.priority === 'critical' || params.priority === 'high'
      ? `[${priorityLabel}] Human escalation needed for ${org}`
      : `Human escalation queued for ${org}`;

  const detailRows: string[] = [
    `<li><strong>Priority:</strong> ${priorityLabel}</li>`,
  ];
  if (params.agentSlug) detailRows.push(`<li><strong>Agent:</strong> ${params.agentSlug}</li>`);
  if (params.callerPhone) detailRows.push(`<li><strong>Caller:</strong> ${params.callerPhone}</li>`);
  if (params.toolName) detailRows.push(`<li><strong>Triggering tool:</strong> ${params.toolName}</li>`);
  detailRows.push(`<li><strong>Call session:</strong> ${params.callSessionId}</li>`);
  detailRows.push(`<li><strong>Raised at:</strong> ${params.raisedAt}</li>`);

  const html = baseLayout(`
    <p>Hi,</p>
    <p>A live call for <strong>${org}</strong> needs a human to step in.</p>
    <div class="alert-error">
      <p style="margin:0"><strong>Reason</strong></p>
      <p style="margin:4px 0 0">${safeReason}</p>
    </div>
    <ul style="margin:0 0 16px; padding-left:20px; color:#374151; font-size:14px; line-height:1.6;">
      ${detailRows.join('\n      ')}
    </ul>
    <p><a href="${params.escalationsUrl}" class="btn">Open Escalation Queue</a></p>
    <p class="muted">You're receiving this because escalation alerts are enabled in your notification preferences. You can opt out from Settings &rarr; Notifications.</p>
  `);

  const detailLines: string[] = [`Priority: ${priorityLabel}`];
  if (params.agentSlug) detailLines.push(`Agent: ${params.agentSlug}`);
  if (params.callerPhone) detailLines.push(`Caller: ${params.callerPhone}`);
  if (params.toolName) detailLines.push(`Triggering tool: ${params.toolName}`);
  detailLines.push(`Call session: ${params.callSessionId}`);
  detailLines.push(`Raised at: ${params.raisedAt}`);

  const text =
    `${subject}\n\n` +
    `A live call for ${org} needs a human to step in.\n\n` +
    `Reason: ${safeReason}\n\n` +
    detailLines.join('\n') +
    `\n\nOpen the escalation queue: ${params.escalationsUrl}\n\n` +
    `Opt out anytime from Settings > Notifications.`;

  return { subject, html, text };
}

export function dataExportEmail(params: {
  tenantName?: string;
  generatedAt: string;
  rowCounts: { users: number; agents: number; phone_numbers: number; calls: number; audit: number };
  bytes: number;
  ipAddress?: string | null;
  settingsUrl: string;
}): { subject: string; html: string; text: string } {
  const org = params.tenantName ?? 'your organization';
  const sizeKb = Math.max(1, Math.round(params.bytes / 1024));
  const ipLine = params.ipAddress ? ` from IP <strong>${params.ipAddress}</strong>` : '';

  const html = baseLayout(`
    <p>Hi,</p>
    <p>A data export was just generated for <strong>${org}</strong>${ipLine} on ${params.generatedAt}.</p>
    <p>The download contained:</p>
    <ul style="margin:0 0 16px; padding-left:20px; color:#374151; font-size:14px; line-height:1.6;">
      <li>${params.rowCounts.users} users</li>
      <li>${params.rowCounts.agents} agents</li>
      <li>${params.rowCounts.phone_numbers} phone numbers</li>
      <li>${params.rowCounts.calls} call sessions</li>
      <li>${params.rowCounts.audit} audit log entries</li>
      <li>Approximate size: ${sizeKb} KB</li>
    </ul>
    <div class="alert-warn">
      <p style="margin:0"><strong>Didn't recognize this?</strong></p>
      <p style="margin:4px 0 0">If you didn't request this export, change your password immediately and review your account activity.</p>
    </div>
    <p><a href="${params.settingsUrl}" class="btn">Review Account Activity</a></p>
    <p class="muted">This is a security notification — you'll always be told when sensitive data leaves your account.</p>
  `);

  const text = `A data export was generated for ${org} on ${params.generatedAt}.\n` +
    `Rows: users=${params.rowCounts.users}, agents=${params.rowCounts.agents}, phone_numbers=${params.rowCounts.phone_numbers}, calls=${params.rowCounts.calls}, audit=${params.rowCounts.audit}.\n` +
    `Size: ~${sizeKb} KB.\n\n` +
    `If you didn't request this, change your password and review activity: ${params.settingsUrl}`;

  return { subject: `Data export generated for ${org}`, html, text };
}

export function deletionScheduledEmail(params: {
  tenantName?: string;
  scheduledFor: string;
  reason?: string | null;
  ipAddress?: string | null;
  cancellationUrl: string;
}): { subject: string; html: string; text: string } {
  const org = params.tenantName ?? 'your organization';
  const ipLine = params.ipAddress ? ` from IP <strong>${params.ipAddress}</strong>` : '';
  const reasonLine = params.reason
    ? `<p class="muted">Reason provided: ${params.reason}</p>`
    : '';

  const html = baseLayout(`
    <p>Hi,</p>
    <p>An account deletion has been scheduled for <strong>${org}</strong>${ipLine}.</p>
    <div class="alert-error">
      <p style="margin:0"><strong>Scheduled deletion date</strong></p>
      <p style="margin:4px 0 0">${params.scheduledFor}</p>
    </div>
    <p>On this date, all account data — including users, agents, phone numbers, call recordings, transcripts, and audit logs — will be permanently erased. This cannot be undone.</p>
    <p>You have until then to cancel the request:</p>
    <p><a href="${params.cancellationUrl}" class="btn">Cancel Deletion Request</a></p>
    ${reasonLine}
    <p class="muted">If you didn't schedule this, cancel it now and change your password — your account may be compromised.</p>
  `);

  const text = `An account deletion has been scheduled for ${org}.\n` +
    `Scheduled for: ${params.scheduledFor}\n` +
    (params.reason ? `Reason: ${params.reason}\n` : '') +
    `\nCancel the request: ${params.cancellationUrl}\n\n` +
    `If you didn't schedule this, cancel immediately and change your password.`;

  return { subject: `Account deletion scheduled for ${org}`, html, text };
}

export function deletionCancelledEmail(params: {
  tenantName?: string;
  cancelledAt: string;
  ipAddress?: string | null;
  settingsUrl: string;
}): { subject: string; html: string; text: string } {
  const org = params.tenantName ?? 'your organization';
  const ipLine = params.ipAddress ? ` from IP <strong>${params.ipAddress}</strong>` : '';

  const html = baseLayout(`
    <p>Hi,</p>
    <p>The pending account deletion for <strong>${org}</strong> has been cancelled${ipLine} on ${params.cancelledAt}.</p>
    <p>Your account and all associated data are safe. No further action is required.</p>
    <p><a href="${params.settingsUrl}" class="btn">Open Account Settings</a></p>
    <p class="muted">If you didn't cancel this and still want your account deleted, you can re-submit the request from your account settings.</p>
  `);

  const text = `The pending account deletion for ${org} was cancelled on ${params.cancelledAt}.\n` +
    `Your account and data are safe.\n\n` +
    `Open settings: ${params.settingsUrl}`;

  return { subject: `Account deletion cancelled for ${org}`, html, text };
}

export function verifiedCallerExpiringEmail(params: {
  tenantName?: string;
  phoneNumber: string;
  friendlyName?: string | null;
  daysRemaining: number;
  expiresAt: string;
  trustedCallersUrl: string;
  detail?: string | null;
}): { subject: string; html: string; text: string } {
  const org = params.tenantName ?? 'your organization';
  const label = params.friendlyName
    ? `${params.friendlyName} (${params.phoneNumber})`
    : params.phoneNumber;
  const subject =
    params.daysRemaining <= 0
      ? `Verified caller ${params.phoneNumber} has expired`
      : `Verified caller ${params.phoneNumber} expires in ${params.daysRemaining} day${params.daysRemaining === 1 ? '' : 's'}`;

  const banner =
    params.daysRemaining <= 0
      ? `<div class="alert-error">
           <p style="margin:0"><strong>Attestation expired</strong></p>
           <p style="margin:4px 0 0">Outbound calls dialed from <strong>${label}</strong> will be attested at level C until you re-register the number.</p>
           <p style="margin:8px 0 0" class="muted">Expired ${params.expiresAt}</p>
         </div>`
      : `<div class="alert-warn">
           <p style="margin:0"><strong>Heads up — re-register soon</strong></p>
           <p style="margin:4px 0 0">The Trust Hub product backing <strong>${label}</strong> for <strong>${org}</strong> expires in <strong>${params.daysRemaining} day${params.daysRemaining === 1 ? '' : 's'}</strong>.</p>
           <p style="margin:8px 0 0" class="muted">Expires ${params.expiresAt}</p>
         </div>`;

  const detailBlock = params.detail
    ? `<p class="muted">${params.detail}</p>`
    : '';

  const html = baseLayout(`
    <p>Hi,</p>
    <p>One of your verified outbound caller IDs needs attention. Without re-registration, carriers will downgrade STIR/SHAKEN attestation from <strong>A</strong> to <strong>C</strong> and downstream calls will start landing in spam folders.</p>
    ${banner}
    ${detailBlock}
    <p>The link below jumps straight to the Trusted Callers page so you can rotate or re-verify the number:</p>
    <p><a href="${params.trustedCallersUrl}" class="btn">Open Trusted Callers</a></p>
    <p class="muted">You won't get another email about this caller for 7 days, even if it stays in this state.</p>
  `);

  const text = `${subject}\n\n` +
    `${label} for ${org} ${params.daysRemaining <= 0 ? 'has expired' : `expires in ${params.daysRemaining} day${params.daysRemaining === 1 ? '' : 's'}`} (${params.expiresAt}).\n` +
    (params.detail ? `${params.detail}\n` : '') +
    `\nReview: ${params.trustedCallersUrl}\n\n` +
    `You won't get another email about this caller for 7 days.`;

  return { subject, html, text };
}

export function verifiedCallerRevokedEmail(params: {
  tenantName?: string;
  phoneNumber: string;
  friendlyName?: string | null;
  trustedCallersUrl: string;
  detail: string;
}): { subject: string; html: string; text: string } {
  const org = params.tenantName ?? 'your organization';
  const label = params.friendlyName
    ? `${params.friendlyName} (${params.phoneNumber})`
    : params.phoneNumber;
  const subject = `Verified caller ${params.phoneNumber} was revoked by Twilio`;

  const html = baseLayout(`
    <p>Hi,</p>
    <p>Twilio no longer reports <strong>${label}</strong> as a verified outbound caller for <strong>${org}</strong>. Outbound campaigns dialing from this number will start being attested at level <strong>C</strong> — carriers may flag those calls as spam — until the number is re-verified.</p>
    <div class="alert-error">
      <p style="margin:0"><strong>Why we caught this</strong></p>
      <p style="margin:4px 0 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:13px;">${params.detail}</p>
    </div>
    <p>Open Trusted Callers to either re-verify the number with Twilio or rotate the campaign onto a fresh, verified number:</p>
    <p><a href="${params.trustedCallersUrl}" class="btn">Open Trusted Callers</a></p>
    <p class="muted">You won't get another email about this caller for 7 days, even if it remains revoked.</p>
  `);

  const text = `${subject}\n\n` +
    `Twilio no longer reports ${label} as a verified outbound caller for ${org}. ` +
    `Outbound campaigns will fall back to level-C attestation until the number is re-verified.\n\n` +
    `Reason: ${params.detail}\n\n` +
    `Re-verify: ${params.trustedCallersUrl}\n\n` +
    `You won't get another email about this caller for 7 days.`;

  return { subject, html, text };
}

export function deletionExecutedEmail(params: {
  tenantName?: string;
  executedAt: string;
  contactEmail?: string;
}): { subject: string; html: string; text: string } {
  const org = params.tenantName ?? 'your organization';
  const contact = params.contactEmail ?? 'privacy@qvo.example';

  const html = baseLayout(`
    <p>Hi,</p>
    <p>The account for <strong>${org}</strong> has been permanently deleted on ${params.executedAt}, as scheduled.</p>
    <div class="alert-error">
      <p style="margin:0"><strong>What was removed</strong></p>
      <p style="margin:4px 0 0">All users, agents, phone numbers, call sessions, recordings, transcripts, and audit logs associated with this account.</p>
    </div>
    <p>Some records may persist briefly in encrypted backups before being aged out under our retention policy, and a minimal record of this deletion is retained for legal and compliance purposes.</p>
    <p>If you have any questions, reach out to <a href="mailto:${contact}">${contact}</a>. Thank you for being a customer.</p>
  `);

  const text = `The account for ${org} has been permanently deleted on ${params.executedAt}, as scheduled.\n\n` +
    `All users, agents, phone numbers, call sessions, recordings, transcripts, and audit logs were removed. ` +
    `Some data may persist briefly in encrypted backups, and a minimal deletion record is retained for compliance.\n\n` +
    `Questions: ${contact}`;

  return { subject: `Account permanently deleted: ${org}`, html, text };
}

export function encryptionInitializationReminderEmail(params: {
  tenantName?: string;
  ownerName?: string | null;
  initializeUrl: string;
  senderName?: string | null;
}): { subject: string; html: string; text: string } {
  const org = params.tenantName ?? 'your organization';
  const greeting = params.ownerName ? `Hi ${params.ownerName},` : 'Hi,';
  const sender = params.senderName ?? 'The Quality Voice Operations team';
  const subject = `Action recommended: enable data encryption for ${org}`;

  const html = baseLayout(`
    <p>${greeting}</p>
    <p>We noticed that <strong>${org}</strong> has not yet initialized a data encryption key. Quality Voice Operations encrypts sensitive tenant data — connector credentials, caller PII, and integration secrets — with a per-tenant AES-256-GCM key. Until you turn on encryption, those fields are stored without that extra protection layer.</p>
    <div class="alert-warn">
      <p style="margin:0"><strong>Why this matters</strong></p>
      <p style="margin:4px 0 0">Activating encryption is a one-click action that takes effect immediately. New writes are encrypted automatically, and your security posture report will reflect the change.</p>
    </div>
    <p>You can enable encryption from the Compliance &amp; Security view:</p>
    <p><a href="${params.initializeUrl}" class="btn">Initialize Encryption</a></p>
    <p class="muted">If you have questions or would like us to enable it on your behalf, just reply to this email.</p>
    <p class="muted">— ${sender}</p>
  `);

  const text = `${greeting}\n\n` +
    `We noticed that ${org} has not yet initialized a data encryption key. Quality Voice Operations encrypts sensitive tenant data with a per-tenant AES-256-GCM key. Until you turn on encryption, those fields are stored without that extra protection layer.\n\n` +
    `Activating encryption is a one-click action that takes effect immediately.\n\n` +
    `Initialize encryption: ${params.initializeUrl}\n\n` +
    `If you have questions or would like us to enable it on your behalf, just reply to this email.\n\n— ${sender}`;

  return { subject, html, text };
}
