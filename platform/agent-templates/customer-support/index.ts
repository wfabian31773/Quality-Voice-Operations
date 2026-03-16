export { buildCustomerSupportSystemPrompt, getCustomerSupportGreeting } from './prompts/systemPrompt';
export { createSupportTicket } from './tools/createSupportTicketTool';
export { CUSTOMER_SUPPORT_TOOLS } from './tools/toolDefs';
export { CUSTOMER_SUPPORT_GUARDRAILS, CUSTOMER_SUPPORT_ESCALATION_KEYWORDS, shouldEscalateSupport } from './config/guardrails';

export const CUSTOMER_SUPPORT_AGENT_TYPE = 'customer-support' as const;
