export { buildTechnicalSupportSystemPrompt, getTechnicalSupportGreeting } from './prompts/systemPrompt';
export { createTechTicket } from './tools/createTechTicketTool';
export { TECHNICAL_SUPPORT_TOOLS } from './tools/toolDefs';
export { TECHNICAL_SUPPORT_GUARDRAILS, TECHNICAL_SUPPORT_ESCALATION_KEYWORDS, isTechnicalEscalation } from './config/guardrails';

export const TECHNICAL_SUPPORT_AGENT_TYPE = 'technical-support' as const;
