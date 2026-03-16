export { buildCollectionsSystemPrompt, getCollectionsGreeting } from './prompts/systemPrompt';
export { lookupAccountStatus } from './tools/lookupAccountStatusTool';
export { COLLECTIONS_TOOLS } from './tools/toolDefs';
export { COLLECTIONS_GUARDRAILS, COLLECTIONS_CEASE_KEYWORDS, isCeaseRequest } from './config/guardrails';

export const COLLECTIONS_AGENT_TYPE = 'collections' as const;
