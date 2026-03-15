/**
 * Answering Service Ticketing Agent Template
 *
 * Registers the agent with a tenant's AgentRegistry.
 * The factory returned here is a thin wrapper — the actual agent implementation
 * (using @openai/agents/realtime or equivalent) is wired up by the calling layer.
 */

import type { AgentConfig } from '../../tenant/registry/types';
import type { TenantId } from '../../core/types';
import { DEFAULT_ANSWERING_SERVICE_CONFIG } from './config/ticketingConfig';
import type { AnsweringServiceTicketingConfig } from './config/ticketingConfig';

export interface AnsweringServiceTemplateOptions {
  tenantId: TenantId;
  practiceName: string;
  ticketingConfig?: Partial<AnsweringServiceTicketingConfig>;
  voice?: string;
  language?: string;
  greeting?: string;
  customInstructions?: string;
  version?: string;
}

export function createAnsweringServiceAgentConfig(
  opts: AnsweringServiceTemplateOptions,
): AgentConfig {
  const config = { ...DEFAULT_ANSWERING_SERVICE_CONFIG, ...opts.ticketingConfig };

  return {
    id: 'answering-service',
    tenantId: opts.tenantId,
    enabled: true,
    agentType: 'inbound',
    description: `Answering service ticketing agent for ${opts.practiceName}`,
    version: opts.version ?? '1.0.0',
    voice: opts.voice ?? 'sage',
    language: opts.language ?? 'en',
    greeting: opts.greeting ?? `Thank you for calling ${opts.practiceName}. How can I help you today?`,
    metadata: {
      practiceName: opts.practiceName,
      ticketingConfig: config,
      customInstructions: opts.customInstructions,
    },
    factory: () => {
      throw new Error(
        'AnsweringService agent factory must be wired to @openai/agents/realtime at the application layer.',
      );
    },
  };
}

export { buildAnsweringServiceSystemPrompt } from './prompts/systemPrompt';
export { createServiceTicket } from './tools/createServiceTicketTool';
export { DEFAULT_ANSWERING_SERVICE_CONFIG, detectPriority, detectDepartmentId } from './config/ticketingConfig';
export type { AnsweringServiceTicketingConfig };
