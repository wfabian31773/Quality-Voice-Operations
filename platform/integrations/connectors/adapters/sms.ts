import { createLogger } from '../../../core/logger';
import { redactPHI } from '../../../core/phi/redact';
import type { ConnectorAdapter, ConnectorConfig, ConnectorPayload, ConnectorResult, SendSmsPayload } from '../types';
import type { TenantId } from '../../../core/types';

const logger = createLogger('SMS_CONNECTOR');

export class TwilioSmsConnectorAdapter implements ConnectorAdapter {
  async execute(
    tenantId: TenantId,
    config: ConnectorConfig,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const accountSid = config.credentials.account_sid ?? '';
    const authToken = config.credentials.auth_token ?? '';
    const fromNumber = config.credentials.from_number ?? '';

    if (!accountSid || !authToken || !fromNumber) {
      logger.error('Missing SMS credentials', { tenantId });
      return { success: false, error: 'SMS connector not configured: missing account_sid, auth_token, or from_number' };
    }

    const smsPayload = payload as SendSmsPayload & { targetNumber?: string };

    const toNumber = smsPayload.to ?? smsPayload.targetNumber ?? config.credentials.to_number;
    if (!toNumber) {
      logger.error('No SMS destination number', { tenantId });
      return { success: false, error: 'No SMS destination: payload.to or connector config to_number required' };
    }

    const body = this.buildMessageBody(smsPayload);

    logger.info('Sending SMS notification', {
      tenantId,
      to: redactPHI(toNumber),
      from: redactPHI(fromNumber),
      type: smsPayload.type,
    });

    const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
    const formBody = new URLSearchParams({
      To: toNumber,
      From: fromNumber,
      Body: body,
    });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formBody.toString(),
      });

      if (!response.ok) {
        const data = await response.json() as Record<string, unknown>;
        const error = `Twilio SMS error ${response.status}: ${data.message ?? response.statusText}`;
        logger.error('SMS send failed', { tenantId, status: response.status });
        return { success: false, error };
      }

      const data = await response.json() as Record<string, unknown>;
      const messageSid = data.sid as string;
      logger.info('SMS sent successfully', { tenantId, messageSid });
      return { success: true, externalId: messageSid, meta: { messageSid } };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('SMS request failed', { tenantId, error });
      return { success: false, error };
    }
  }

  private buildMessageBody(payload: SendSmsPayload): string {
    switch (payload.type) {
      case 'escalation_notification':
        return [
          `[ESCALATION ALERT]`,
          `Session: ${payload.callSessionId ?? 'unknown'}`,
          `Reason: ${payload.reason ?? 'unspecified'}`,
          `Time: ${payload.timestamp ?? new Date().toISOString()}`,
        ].join('\n');

      case 'send_sms':
        return payload.body ?? '(no message body)';

      default:
        return payload.body as string ?? `Notification: ${payload.type}`;
    }
  }
}
