export interface AgentTemplateEntry {
  value: string;
  label: string;
}

const REGISTERED_TEMPLATES: AgentTemplateEntry[] = [
  { value: 'general', label: 'General' },
  { value: 'answering-service', label: 'Answering Service' },
  { value: 'medical-after-hours', label: 'Medical After Hours' },
  { value: 'dental', label: 'Dental' },
  { value: 'property-management', label: 'Property Management' },
  { value: 'home-services', label: 'Home Services' },
  { value: 'legal', label: 'Legal' },
  { value: 'customer-support', label: 'Customer Support' },
  { value: 'outbound-sales', label: 'Outbound Sales' },
  { value: 'technical-support', label: 'Technical Support' },
  { value: 'collections', label: 'Collections' },
  { value: 'custom', label: 'Custom' },
];

export function getRegisteredTemplates(): AgentTemplateEntry[] {
  return REGISTERED_TEMPLATES;
}

export function getRegisteredTemplateValues(): string[] {
  return REGISTERED_TEMPLATES.map((t) => t.value);
}
