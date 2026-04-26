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
    <p>Open the Connectors page to review the error and re-authorize the integration:</p>
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
    <p>To restore the integration, sign in again and re-enable it from the Connectors page:</p>
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
    <p>Open the Connectors page to reauthorize the integration. We've linked you straight to it:</p>
    <p><a href="${params.reconnectUrl}" class="btn">Reconnect ${params.providerLabel}</a></p>
    <p class="muted">You won't get another email about this integration for 24 hours, even if the next refresh attempt also fails.</p>
  `);

  const text = `${subject}\n\nThe ${params.providerLabel} integration for ${org} needs to be reconnected. Until you reauthorize it, calls and events that depend on this integration will not sync.\n\n${safeError ? `Reason: ${safeError}\n` : ''}Detected at ${params.detectedAt}\n\nReconnect: ${params.reconnectUrl}\n\nYou won't get another email about this integration for 24 hours.`;

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
