import { createLogger } from '../../../core/logger';
import type { TenantId } from '../../../core/types';

const logger = createLogger('MAINTENANCE_REQUEST');

export interface SubmitMaintenanceRequestInput {
  tenantName: string;
  unitAddress: string;
  issueDescription: string;
  urgency: 'low' | 'medium' | 'high' | 'emergency';
  contactPhone: string;
  preferredAccessTime?: string;
  additionalNotes?: string;
}

export interface SubmitMaintenanceRequestDeps {
  tenantId: TenantId;
  callSessionId?: string;
}

export async function submitMaintenanceRequest(
  input: SubmitMaintenanceRequestInput,
  deps: SubmitMaintenanceRequestDeps,
): Promise<{ success: boolean; message: string; requestId?: string }> {
  logger.info('Maintenance request submitted (stub)', {
    tenantId: deps.tenantId,
    callSessionId: deps.callSessionId,
    urgency: input.urgency,
  });

  const requestId = `MNT-${Date.now().toString(36).toUpperCase()}`;

  return {
    success: true,
    message: `Your maintenance request has been submitted with ID ${requestId}. ${input.urgency === 'emergency' ? 'Our emergency maintenance team has been notified and will respond shortly.' : 'Our maintenance team will contact you to schedule the repair.'}`,
    requestId,
  };
}
