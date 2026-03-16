import { createLogger } from '../../../core/logger';
import type { TenantId } from '../../../core/types';

const logger = createLogger('OUTBOUND_SALES_LEAD');

export interface QualifyLeadInput {
  prospectFirstName: string;
  prospectLastName: string;
  prospectPhone: string;
  prospectEmail?: string;
  companyName?: string;
  painPoints?: string;
  currentSolution?: string;
  isDecisionMaker?: boolean;
  leadScore: 'hot' | 'warm' | 'cold';
  additionalNotes?: string;
}

export interface QualifyLeadDeps {
  tenantId: TenantId;
  callSessionId?: string;
}

export async function qualifyLead(
  input: QualifyLeadInput,
  deps: QualifyLeadDeps,
): Promise<{ success: boolean; message: string; leadId?: string }> {
  logger.info('Lead qualified (stub)', {
    tenantId: deps.tenantId,
    callSessionId: deps.callSessionId,
    leadScore: input.leadScore,
    isDecisionMaker: input.isDecisionMaker,
  });

  const leadId = `LEAD-${Date.now().toString(36).toUpperCase()}`;

  return {
    success: true,
    message: `Lead record created with ID ${leadId}. Qualification: ${input.leadScore}.`,
    leadId,
  };
}
