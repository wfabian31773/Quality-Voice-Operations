/**
 * Medical After-Hours Triage Agent Template
 *
 * Vertical logic extracted from afterHoursAgent.ts.
 * The factory stub must be wired to @openai/agents/realtime at the application layer.
 */

import type { AgentConfig } from '../../tenant/registry/types';
import type { TenantId } from '../../core/types';

export interface AfterHoursTemplateOptions {
  tenantId: TenantId;
  practiceName: string;
  onCallTransferNumber: string;
  afterHoursDepartmentId?: number;
  voice?: string;
  language?: string;
  customInstructions?: string;
  version?: string;
}

export function createAfterHoursAgentConfig(opts: AfterHoursTemplateOptions): AgentConfig {
  return {
    id: 'medical-after-hours',
    tenantId: opts.tenantId,
    enabled: true,
    agentType: 'inbound',
    description: `Medical after-hours triage agent for ${opts.practiceName}`,
    version: opts.version ?? '1.0.0',
    voice: opts.voice ?? 'sage',
    language: opts.language ?? 'en',
    greeting: `Thank you for calling ${opts.practiceName}. All offices are currently closed. If this is a medical emergency, please call 911.`,
    metadata: {
      practiceName: opts.practiceName,
      onCallTransferNumber: opts.onCallTransferNumber,
      afterHoursDepartmentId: opts.afterHoursDepartmentId ?? 1,
      customInstructions: opts.customInstructions,
    },
    factory: () => {
      throw new Error(
        'AfterHours agent factory must be wired to @openai/agents/realtime at the application layer.',
      );
    },
  };
}

export { buildAfterHoursSystemPrompt, getAfterHoursGreeting } from './prompts/systemPrompt';
export { createAfterHoursTicket } from './tools/createAfterHoursTicketTool';
export { triageEscalate } from './tools/triageEscalateTool';
export { isUrgentSymptom, MEDICAL_SAFETY_GUARDRAILS, URGENT_SYMPTOM_KEYWORDS } from './config/guardrails';
export { DEFAULT_TRIAGE_OUTCOME_MAPPINGS } from './config/triageOutcomes';
export type { TriageOutcome } from './config/triageOutcomes';
