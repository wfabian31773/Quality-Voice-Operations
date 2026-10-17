import { createLogger } from '../../../core/logger';
import { redactPHI } from '../../../core/phi/redact';
import type { ConnectorAdapter, ConnectorConfig, ConnectorPayload, ConnectorResult, SendSmsPayload } from '../types';
import type { TenantId } from '../../../core/types';
import { recordSmsUsage } from '../../../billing/usage/UsageRecorder';
import { sendSystemSms } from '../../../actions/sms';

const logger = createLogger('SMS_CONNECTOR');

/**
 * Staff alerts for the tenant's SMS connector (today: call escalation
 * notifications from the outbox). Sends go through the `sms.send` chokepoint
 * (messaging enabled, opt-out, quiet hours, rate limit, persistence,
 * StatusCallback), which uses the tenant's Twilio credentials and sender.
 */
export class TwilioSmsConnectorAdapter implements ConnectorAdapter {
  async execute(
    tenantId: TenantId,
    config: ConnectorConfig,
    payload: ConnectorPayload,
  ): Promise<ConnectorResult> {
    const smsPayload = payload as SendSmsPayload & { targetNumber?: string };

    const toNumber = smsPayload.to ?? smsPayload.targetNumber ?? config.credentials.to_number;
    if (!toNumber) {
      logger.error('No SMS destination number', { tenantId });
      return { success: false, error: 'No SMS destination: payload.to or connector config to_number required' };
    }

    // Template-only: free-text connector SMS (`send_sms` and other payloads)
    // would bypass the agent's template rule, so only escalation alerts go out.
    if (smsPayload.type !== 'escalation_notification') {
      logger.warn('Connector SMS payload type not sendable', { tenantId, type: smsPayload.type });
      return {
        success: false,
        error: `SMS connector only sends escalation alerts; ${smsPayload.type} must use sms.send`,
      };
    }

    logger.info('Sending SMS notification', {
      tenantId,
      to: redactPHI(toNumber),
      type: smsPayload.type,
    });

    const session = smsPayload.callSessionId ?? 'unknown';
    const time = smsPayload.timestamp ?? new Date().toISOString();

    try {
      const result = await sendSystemSms({
        tenantId,
        to: toNumber,
        templateKey: 'escalation_alert',
        vars: { session, reason: smsPayload.reason ?? 'unspecified', time },
        purpose: 'transactional',
        // Sent as the call is transferred, so it gets the live-call quiet-hours exemption window.
        ...(smsPayload.callSessionId && smsPayload.timestamp
          ? { liveCall: { callId: smsPayload.callSessionId, endedAt: smsPayload.timestamp } }
          : {}),
        relatedEntity: { type: 'escalation', id: `${session}:${time}` },
        actorId: 'sms-connector',
      });

      if (!result.ok) {
        const error = `${result.error.code}: ${result.error.message}`;
        logger.error('SMS send failed', { tenantId, code: result.error.code });
        return { success: false, error };
      }

      const messageSid = result.data.twilioSid;
      logger.info('SMS sent successfully', { tenantId, messageSid, status: result.data.status });

      if (result.data.status === 'queued') {
        recordSmsUsage(tenantId, 1).catch((err) => {
          logger.error('Failed to record SMS usage', { tenantId, error: String(err) });
        });
      }

      return {
        success: true,
        externalId: messageSid ?? result.data.messageId,
        meta: { messageSid, messageId: result.data.messageId, status: result.data.status },
      };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error('SMS request failed', { tenantId, error });
      return { success: false, error };
    }
  }
}
