import type { TenantId } from '../../../core/types';
import type { OutboxService } from '../../../integrations/outbox/OutboxService';
import { detectPriority, detectDepartmentId } from '../config/ticketingConfig';
import type { AnsweringServiceTicketingConfig } from '../config/ticketingConfig';
import { createLogger } from '../../../core/logger';

const logger = createLogger('ANSWERING_SERVICE_TOOL');

export interface CreateServiceTicketInput {
  patientFirstName: string;
  patientLastName: string;
  patientPhone: string;
  patientDob?: string;
  reasonForCall: string;
  callbackNumber?: string;
  preferredContactMethod?: string;
  lastProviderSeen?: string;
  locationOfLastVisit?: string;
  additionalNotes?: string;
}

export interface CreateServiceTicketDeps {
  tenantId: TenantId;
  callSid?: string;
  callLogId?: string;
  outbox: OutboxService;
  config: AnsweringServiceTicketingConfig;
}

/**
 * Platform-portable createServiceTicket tool handler.
 *
 * Extracted from the original answering service agent's inline tool implementation.
 * Uses the platform OutboxService instead of a hardcoded ticketing client.
 */
export async function createServiceTicket(
  input: CreateServiceTicketInput,
  deps: CreateServiceTicketDeps,
): Promise<{ success: boolean; confirmationMessage: string; outboxId?: string }> {
  const { tenantId, callSid, callLogId, outbox, config } = deps;

  const priority = detectPriority(input.reasonForCall);
  const departmentId = detectDepartmentId(input.reasonForCall, config);
  const idempotencyKey = callSid ? `answering-service:${callSid}` : undefined;

  try {
    const result = await outbox.writeToOutbox({
      tenantId,
      callSid,
      callLogId,
      idempotencyKey,
      payload: {
        type: 'answering_service_ticket',
        patientFirstName: input.patientFirstName,
        patientLastName: input.patientLastName,
        patientPhone: input.patientPhone,
        patientDob: input.patientDob,
        callbackNumber: input.callbackNumber ?? input.patientPhone,
        preferredContactMethod: input.preferredContactMethod ?? 'phone',
        reasonForCall: input.reasonForCall,
        departmentId,
        requestTypeId: config.defaultRequestTypeId,
        requestReasonId: config.defaultRequestReasonId,
        priority,
        lastProviderSeen: input.lastProviderSeen,
        locationOfLastVisit: input.locationOfLastVisit,
        additionalNotes: input.additionalNotes,
      },
    });

    logger.ticketCreated({ tenantId, callId: callLogId, ticketType: 'answering_service' });

    return {
      success: true,
      confirmationMessage: `I've submitted your request and someone from ${input.patientFirstName}'s care team will be in touch. Is there anything else I can help you with?`,
      outboxId: result.outboxId,
    };
  } catch (err) {
    logger.error('createServiceTicket failed', { tenantId, error: String(err) });
    return {
      success: false,
      confirmationMessage:
        "I'm sorry, I wasn't able to submit your request at this time. Please try calling back or have a staff member follow up with you.",
    };
  }
}
