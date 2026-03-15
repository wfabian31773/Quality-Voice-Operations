import type { TenantId } from '../../../core/types';
import type { OutboxService } from '../../../integrations/outbox/OutboxService';
import type { TriageOutcome } from '../config/triageOutcomes';
import { DEFAULT_TRIAGE_OUTCOME_MAPPINGS } from '../config/triageOutcomes';
import { createLogger } from '../../../core/logger';

const logger = createLogger('AFTER_HOURS_TOOL');

export interface CreateAfterHoursTicketInput {
  patientFirstName: string;
  patientLastName: string;
  patientDob: string;
  callbackNumber: string;
  symptomDescription: string;
  triageOutcome: TriageOutcome;
  lastProviderSeen?: string;
  locationOfLastVisit?: string;
  additionalNotes?: string;
}

export interface CreateAfterHoursTicketDeps {
  tenantId: TenantId;
  callSid?: string;
  callLogId?: string;
  outbox: OutboxService;
  afterHoursDepartmentId?: number;
}

/**
 * createAfterHoursTicket tool handler.
 * Uses the platform OutboxService for durable delivery.
 */
export async function createAfterHoursTicket(
  input: CreateAfterHoursTicketInput,
  deps: CreateAfterHoursTicketDeps,
): Promise<{ success: boolean; confirmationMessage: string; outboxId?: string }> {
  const { tenantId, callSid, callLogId, outbox } = deps;
  const outcomeConfig = DEFAULT_TRIAGE_OUTCOME_MAPPINGS[input.triageOutcome];

  try {
    const result = await outbox.writeToOutbox({
      tenantId,
      callSid,
      callLogId,
      idempotencyKey: callSid ? `after-hours:${callSid}` : undefined,
      payload: {
        type: 'after_hours_triage_ticket',
        patientFirstName: input.patientFirstName,
        patientLastName: input.patientLastName,
        patientDob: input.patientDob,
        callbackNumber: input.callbackNumber,
        symptomDescription: input.symptomDescription,
        triageOutcome: input.triageOutcome,
        triageOutcomeLabel: outcomeConfig.label,
        priority: outcomeConfig.ticketPriority,
        departmentId: deps.afterHoursDepartmentId ?? 1,
        lastProviderSeen: input.lastProviderSeen,
        locationOfLastVisit: input.locationOfLastVisit,
        additionalNotes: input.additionalNotes,
        requiresHumanTransfer: outcomeConfig.requiresHumanTransfer,
      },
    });

    logger.ticketCreated({
      tenantId,
      callId: callLogId,
      ticketType: `after_hours:${input.triageOutcome}`,
    });

    return {
      success: true,
      confirmationMessage:
        input.triageOutcome === 'callback_next_business_day'
          ? "I've documented your concern and someone from our team will follow up with you during business hours. Is there anything else I can help you with tonight?"
          : "I've documented your concern. Our team will be in touch with you as soon as possible.",
      outboxId: result.outboxId,
    };
  } catch (err) {
    logger.error('createAfterHoursTicket failed', { tenantId, error: String(err) });
    return {
      success: false,
      confirmationMessage:
        "I'm sorry, I was unable to complete your request. Please try calling back or contact the office during business hours.",
    };
  }
}
