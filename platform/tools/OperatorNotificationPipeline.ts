import { createLogger } from '../core/logger';
import { createInAppNotification } from '../autopilot/NotificationService';
import { onToolFailure, type ToolFailureEvent } from './RetryOrchestrator';
import type { TenantId } from '../core/types';

const logger = createLogger('OPERATOR_NOTIFICATION_PIPELINE');

interface SmsConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
}

function getTwilioConfig(): SmsConfig | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_SMS_FROM || process.env.TWILIO_PHONE_NUMBER;
  if (accountSid && authToken && fromNumber) {
    return { accountSid, authToken, fromNumber };
  }
  return null;
}

async function sendSmsAlert(config: SmsConfig, to: string, message: string): Promise<boolean> {
  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${config.accountSid}/Messages.json`;
    const body = new URLSearchParams({
      To: to,
      From: config.fromNumber,
      Body: message,
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      logger.error('SMS alert send failed', { status: response.status });
      return false;
    }
    return true;
  } catch (err) {
    logger.error('SMS alert send error', { error: String(err) });
    return false;
  }
}

const tenantSmsRecipients = new Map<string, string[]>();

export function setOperatorSmsRecipients(tenantId: TenantId, phoneNumbers: string[]): void {
  tenantSmsRecipients.set(tenantId, phoneNumbers);
}

export function getOperatorSmsRecipients(tenantId: TenantId): string[] {
  return tenantSmsRecipients.get(tenantId) ?? [];
}

async function handleToolFailureNotification(event: ToolFailureEvent): Promise<void> {
  if (!event.finalFailure) return;

  try {
    const severity = 'critical';
    const title = `Tool Failure: ${event.toolName}`;
    const body = `Tool "${event.toolName}" failed after ${event.retryCount} attempt(s) during call session ${event.callSessionId}. ` +
      `Error: ${event.error.substring(0, 200)}` +
      (event.fallbackAttempted ? (event.fallbackSuccess ? ' (fallback succeeded)' : ' (fallback also failed)') : '');

    await createInAppNotification(event.tenantId, {
      severity,
      title,
      body,
    });

    logger.info('In-app tool failure notification created', {
      tenantId: event.tenantId,
      tool: event.toolName,
      callId: event.callSessionId,
    });
  } catch (err) {
    logger.error('Failed to create in-app notification for tool failure', {
      tenantId: event.tenantId,
      error: String(err),
    });
  }

  const smsRecipients = getOperatorSmsRecipients(event.tenantId);
  if (smsRecipients.length === 0) return;

  const twilioConfig = getTwilioConfig();
  if (!twilioConfig) {
    logger.info('Twilio not configured — skipping SMS alerts for tool failure', {
      tenantId: event.tenantId,
    });
    return;
  }

  const smsMessage = `[QVO Alert] Tool "${event.toolName}" failed ${event.retryCount} time(s) on call ${event.callSessionId.substring(0, 8)}. ${event.error.substring(0, 100)}. Log in to review.`;

  for (const phone of smsRecipients) {
    try {
      await sendSmsAlert(twilioConfig, phone, smsMessage);
      logger.info('SMS alert sent for tool failure', {
        tenantId: event.tenantId,
        tool: event.toolName,
      });
    } catch (err) {
      logger.error('Failed to send SMS alert', {
        tenantId: event.tenantId,
        error: String(err),
      });
    }
  }
}

let initialized = false;

export function initOperatorNotificationPipeline(): void {
  if (initialized) return;
  onToolFailure(handleToolFailureNotification);
  initialized = true;
  logger.info('Operator notification pipeline initialized');
}
