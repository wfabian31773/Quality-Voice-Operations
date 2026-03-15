import { createLogger } from '../../../platform/core/logger';
import { redactPHI } from '../../../platform/core/phi/redact';
import type { TenantId } from '../../../platform/core/types';
import type { OutboxService } from '../../../platform/integrations/outbox/OutboxService';

const logger = createLogger('ESCALATION');

export interface EscalationContext {
  tenantId: TenantId;
  callSessionId: string;
  callSid: string;
  targetNumber: string;
  reason: string;
  patientName?: string;
}

export interface TwilioTransferAdapter {
  initiateTransfer(callSid: string, toNumber: string): Promise<{ success: boolean; error?: string }>;
}

export class EscalationController {
  constructor(
    private readonly twilioAdapter: TwilioTransferAdapter,
    private readonly outboxService?: OutboxService,
  ) {}

  async escalateCall(ctx: EscalationContext): Promise<{ success: boolean; message: string }> {
    const { tenantId, callSessionId, callSid, targetNumber, reason } = ctx;

    logger.info('Escalation initiated', {
      callId: callSessionId,
      tenantId,
      targetNumber: redactPHI(targetNumber),
      reason: redactPHI(reason),
    });

    try {
      const result = await this.twilioAdapter.initiateTransfer(callSid, targetNumber);

      if (result.success) {
        logger.info('Escalation transfer succeeded', { callId: callSessionId, tenantId });

        if (this.outboxService) {
          try {
            await this.outboxService.writeToOutbox({
              tenantId,
              callSid,
              callLogId: callSessionId,
              payload: {
                type: 'escalation_notification',
                targetNumber,
                reason: redactPHI(reason),
                callSessionId,
                timestamp: new Date().toISOString(),
              },
            });
            logger.info('Escalation notification enqueued to outbox', { callId: callSessionId, tenantId });
          } catch (err) {
            logger.error('Failed to enqueue escalation notification', { callId: callSessionId, tenantId, error: String(err) });
          }
        }

        return { success: true, message: "I'm connecting you with our team now. Please hold." };
      }

      logger.info('Escalation transfer failed', { callId: callSessionId, tenantId });
      return {
        success: false,
        message:
          "I was unable to reach the team directly. I've documented your concern as urgent and they will contact you as soon as possible.",
      };
    } catch (err) {
      logger.error('Escalation transfer error', { tenantId, callId: callSessionId, error: String(err) });
      return {
        success: false,
        message:
          "I'm sorry, there was an issue connecting you. Your concern has been marked urgent and our team will contact you shortly.",
      };
    }
  }
}
