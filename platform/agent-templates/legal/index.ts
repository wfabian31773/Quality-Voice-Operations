export { buildLegalSystemPrompt, getLegalGreeting } from './prompts/systemPrompt';
export { scheduleConsultation } from './tools/scheduleConsultationTool';
export { LEGAL_TOOLS } from './tools/toolDefs';
export { LEGAL_SAFETY_GUARDRAILS, LEGAL_URGENT_KEYWORDS, isLegalUrgent } from './config/guardrails';

export const LEGAL_AGENT_TYPE = 'legal' as const;
