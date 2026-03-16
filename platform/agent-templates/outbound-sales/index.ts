export { buildOutboundSalesSystemPrompt, getOutboundSalesGreeting } from './prompts/systemPrompt';
export { qualifyLead } from './tools/qualifyLeadTool';
export { OUTBOUND_SALES_TOOLS } from './tools/toolDefs';
export { OUTBOUND_SALES_GUARDRAILS, OUTBOUND_SALES_DNC_KEYWORDS, isDoNotCallRequest } from './config/guardrails';

export const OUTBOUND_SALES_AGENT_TYPE = 'outbound-sales' as const;
