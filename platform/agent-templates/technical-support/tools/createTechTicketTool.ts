import { createLogger } from '../../../core/logger';
import type { TenantId } from '../../../core/types';

const logger = createLogger('TECH_SUPPORT_TICKET');

export interface CreateTechTicketInput {
  customerFirstName: string;
  customerLastName: string;
  customerPhone: string;
  accountNumber?: string;
  issueDescription: string;
  diagnosticsSummary?: string;
  stepsAttempted?: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  escalationTier: 'tier_2' | 'tier_3';
  additionalNotes?: string;
}

export interface CreateTechTicketDeps {
  tenantId: TenantId;
  callSessionId?: string;
}

export async function createTechTicket(
  input: CreateTechTicketInput,
  deps: CreateTechTicketDeps,
): Promise<{ success: boolean; message: string; ticketId?: string }> {
  logger.info('Tech support ticket created (stub)', {
    tenantId: deps.tenantId,
    callSessionId: deps.callSessionId,
    severity: input.severity,
    escalationTier: input.escalationTier,
  });

  const ticketId = `TECH-${Date.now().toString(36).toUpperCase()}`;

  return {
    success: true,
    message: `Your technical support ticket ${ticketId} has been created and escalated to ${input.escalationTier.replace('_', ' ')}. A specialist will contact you at ${input.customerPhone} within ${input.severity === 'critical' ? '1 hour' : '24 hours'}.`,
    ticketId,
  };
}
