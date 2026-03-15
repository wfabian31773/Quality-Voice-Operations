import { createLogger } from '../../../core/logger';
import type { TenantId } from '../../../core/types';

const logger = createLogger('HOME_SERVICE_BOOKING');

export interface BookServiceAppointmentInput {
  customerFirstName: string;
  customerLastName: string;
  customerPhone: string;
  serviceAddress: string;
  serviceType: string;
  issueDescription: string;
  urgency: 'routine' | 'urgent' | 'emergency';
  preferredDate?: string;
  preferredTimeWindow?: string;
  additionalNotes?: string;
}

export interface BookServiceAppointmentDeps {
  tenantId: TenantId;
  callSessionId?: string;
}

export async function bookServiceAppointment(
  input: BookServiceAppointmentInput,
  deps: BookServiceAppointmentDeps,
): Promise<{ success: boolean; message: string; bookingId?: string }> {
  logger.info('Service appointment booked (stub)', {
    tenantId: deps.tenantId,
    callSessionId: deps.callSessionId,
    serviceType: input.serviceType,
    urgency: input.urgency,
  });

  const bookingId = `SVC-${Date.now().toString(36).toUpperCase()}`;

  const urgencyMessage =
    input.urgency === 'emergency'
      ? 'Our emergency dispatch team has been notified and a technician will be on the way shortly.'
      : input.urgency === 'urgent'
        ? 'We have flagged this as urgent and will prioritize scheduling.'
        : `We will contact you at ${input.customerPhone} to confirm your appointment time.`;

  return {
    success: true,
    message: `Your service request has been submitted with booking ID ${bookingId}. ${urgencyMessage}`,
    bookingId,
  };
}
