export { buildPropertyManagementSystemPrompt, getPropertyManagementGreeting } from './prompts/systemPrompt';
export { submitMaintenanceRequest } from './tools/submitMaintenanceRequestTool';
export { PROPERTY_MANAGEMENT_TOOLS } from './tools/toolDefs';
export { PROPERTY_MANAGEMENT_GUARDRAILS, PROPERTY_EMERGENCY_KEYWORDS, isPropertyEmergency } from './config/guardrails';

export const PROPERTY_MANAGEMENT_AGENT_TYPE = 'property-management' as const;
