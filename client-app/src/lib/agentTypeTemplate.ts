import type { IndustryTemplateKey } from './agentBuilderI18n';

// Shared by Onboarding.tsx and Agents.tsx so the wizard and the quick-create
// modal seed the same starter graph for a given agent type.
export const AGENT_TYPE_TO_TEMPLATE: Record<string, IndustryTemplateKey> = {
  'medical-after-hours': 'medical',
  'dental': 'dental',
  'property-management': 'propertymanagement',
  'home-services': 'hvac',
  'legal': 'legal',
  'real-estate': 'realestate',
  'restaurant': 'restaurant',
  'salon': 'salon',
  'customer-support': 'customer-support',
  'outbound-sales': 'outbound-sales',
  'technical-support': 'technical-support',
  'collections': 'collections',
};
