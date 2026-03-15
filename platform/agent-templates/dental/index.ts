export { buildDentalSystemPrompt, getDentalGreeting } from './prompts/systemPrompt';
export { scheduleDentalAppointment } from './tools/scheduleDentalAppointmentTool';
export { DENTAL_TOOLS } from './tools/toolDefs';
export { DENTAL_SAFETY_GUARDRAILS, DENTAL_EMERGENCY_KEYWORDS, isDentalEmergency } from './config/guardrails';

export const DENTAL_AGENT_TYPE = 'dental' as const;
