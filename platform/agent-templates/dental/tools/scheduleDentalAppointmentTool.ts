import { createLogger } from '../../../core/logger';
import type { TenantId } from '../../../core/types';

const logger = createLogger('DENTAL_APPOINTMENT');

export interface ScheduleDentalAppointmentInput {
  patientFirstName: string;
  patientLastName: string;
  patientPhone: string;
  isNewPatient: boolean;
  preferredDate?: string;
  preferredTime?: string;
  reasonForVisit: string;
  insuranceProvider?: string;
  additionalNotes?: string;
}

export interface ScheduleDentalAppointmentDeps {
  tenantId: TenantId;
  callSessionId?: string;
}

export async function scheduleDentalAppointment(
  input: ScheduleDentalAppointmentInput,
  deps: ScheduleDentalAppointmentDeps,
): Promise<{ success: boolean; message: string; confirmationId?: string }> {
  logger.info('Dental appointment scheduled (stub)', {
    tenantId: deps.tenantId,
    callSessionId: deps.callSessionId,
    isNewPatient: input.isNewPatient,
  });

  const confirmationId = `DNT-${Date.now().toString(36).toUpperCase()}`;

  return {
    success: true,
    message: `Your appointment request has been submitted. Your confirmation number is ${confirmationId}. The office will contact you at ${input.patientPhone} to confirm the exact time.`,
    confirmationId,
  };
}
