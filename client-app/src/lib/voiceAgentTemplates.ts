export const VOICE_AGENT_TEMPLATE_CHIPS = [
  { id: 'customer_support', name: 'Customer Support' },
  { id: 'sales_associate', name: 'Sales Associate' },
  { id: 'appointment_scheduler', name: 'Appointment Scheduler' },
  { id: 'personal_assistant', name: 'Personal Assistant' },
  { id: 'lead_qualification', name: 'Lead Qualification' },
] as const;

export type VoiceAgentTemplateChipId = (typeof VOICE_AGENT_TEMPLATE_CHIPS)[number]['id'];
