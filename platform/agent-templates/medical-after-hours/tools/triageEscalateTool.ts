import { createLogger } from '../../../core/logger';
import type { TenantId } from '../../../core/types';

const logger = createLogger('AFTER_HOURS_TRIAGE');

export interface TriageEscalateInput {
  patientFirstName: string;
  patientLastName: string;
  patientDob: string;
  callbackNumber: string;
  urgentConcern: string;
}

export interface TriageEscalateDeps {
  tenantId: TenantId;
  callLogId?: string;
  callSid?: string;
  onCallTransferNumber: string;
  /**
   * Initiate a Twilio call transfer.
   * Injected by the application layer so this tool stays platform-agnostic.
   */
  initiateTransfer: (toNumber: string, callSid?: string) => Promise<{ success: boolean }>;
}

/**
 * triageEscalate tool handler.
 * Transfers the caller to the on-call team when urgency is confirmed.
 */
export async function triageEscalate(
  input: TriageEscalateInput,
  deps: TriageEscalateDeps,
): Promise<{ success: boolean; message: string }> {
  const { tenantId, callLogId, callSid, onCallTransferNumber, initiateTransfer } = deps;

  logger.handoffInitiated({
    callId: callLogId,
    tenantId,
    targetNumber: onCallTransferNumber,
    reason: input.urgentConcern,
  });

  try {
    const result = await initiateTransfer(onCallTransferNumber, callSid);

    if (result.success) {
      logger.handoffCompleted({ callId: callLogId, tenantId, success: true });
      return {
        success: true,
        message: `I'm connecting you with our on-call team now. Please hold.`,
      };
    }

    logger.handoffCompleted({ callId: callLogId, tenantId, success: false });
    return {
      success: false,
      message: `I was unable to reach the on-call team directly. I've documented your concern as urgent and they will contact you at ${input.callbackNumber} as soon as possible.`,
    };
  } catch (err) {
    logger.error('triageEscalate transfer failed', { tenantId, error: String(err) });
    return {
      success: false,
      message: `I'm sorry, there was an issue connecting you. Your concern has been marked urgent and our team will contact you shortly.`,
    };
  }
}
