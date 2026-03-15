import { createLogger } from '../../../core/logger';
import type { TenantId } from '../../../core/types';

const logger = createLogger('LEGAL_CONSULTATION');

export interface ScheduleConsultationInput {
  callerFirstName: string;
  callerLastName: string;
  callerPhone: string;
  matterDescription: string;
  matterType?: string;
  opposingPartyNames: string[];
  preferredDate?: string;
  preferredTime?: string;
  additionalNotes?: string;
}

export interface ScheduleConsultationDeps {
  tenantId: TenantId;
  callSessionId?: string;
}

export async function scheduleConsultation(
  input: ScheduleConsultationInput,
  deps: ScheduleConsultationDeps,
): Promise<{ success: boolean; message: string; referenceId?: string }> {
  logger.info('Legal consultation scheduled (stub)', {
    tenantId: deps.tenantId,
    callSessionId: deps.callSessionId,
    matterType: input.matterType,
    opposingPartyCount: input.opposingPartyNames.length,
  });

  const referenceId = `LGL-${Date.now().toString(36).toUpperCase()}`;

  return {
    success: true,
    message: `Your consultation request has been submitted with reference number ${referenceId}. We need to complete a standard conflict-of-interest check before confirming. We will contact you at ${input.callerPhone} within one business day.`,
    referenceId,
  };
}
