import { createLogger } from '../../../core/logger';
import type { TenantId } from '../../../core/types';

const logger = createLogger('CUSTOMER_SUPPORT_TICKET');

export interface CreateSupportTicketInput {
  customerFirstName: string;
  customerLastName: string;
  customerPhone: string;
  customerEmail?: string;
  accountNumber?: string;
  issueCategory: string;
  issueDescription: string;
  priority?: string;
  additionalNotes?: string;
}

export interface CreateSupportTicketDeps {
  tenantId: TenantId;
  callSessionId?: string;
}

export async function createSupportTicket(
  input: CreateSupportTicketInput,
  deps: CreateSupportTicketDeps,
): Promise<{ success: boolean; message: string; ticketId?: string }> {
  logger.info('Support ticket created (stub)', {
    tenantId: deps.tenantId,
    callSessionId: deps.callSessionId,
    issueCategory: input.issueCategory,
    priority: input.priority ?? 'medium',
  });

  const ticketId = `SUP-${Date.now().toString(36).toUpperCase()}`;

  return {
    success: true,
    message: `Your support ticket has been created with reference number ${ticketId}. A team member will follow up with you at ${input.customerPhone} within 24 hours.`,
    ticketId,
  };
}
