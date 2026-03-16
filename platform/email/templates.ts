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
