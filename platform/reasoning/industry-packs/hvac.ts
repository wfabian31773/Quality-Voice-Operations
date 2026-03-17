import type { IndustryReasoningPack, IndustryReasoningRule, SlotManifest, ReasoningContext } from '../types';

const HVAC_EMERGENCY_KEYWORDS = [
  'gas leak', 'carbon monoxide', 'no heat', 'frozen pipes',
  'flooding', 'electrical smell', 'burning smell', 'sparking',
  'no cooling extreme heat', 'elderly no heat', 'infant no heat',
];

function classifyRepairVsEmergency(context: ReasoningContext) {
  const utterance = context.currentUtterance.toLowerCase();

  for (const keyword of HVAC_EMERGENCY_KEYWORDS) {
    if (utterance.includes(keyword)) {
      return {
        triggered: true,
        action: 'escalate_to_human' as const,
        urgencyOverride: 'emergency' as const,
        additionalContext: `HVAC emergency detected: "${keyword}". Immediate dispatch or emergency service required.`,
      };
    }
  }

  const urgentPatterns = ['no heat', 'no cooling', 'no ac', 'no air conditioning', 'water leak', 'furnace not working'];
  for (const pattern of urgentPatterns) {
    if (utterance.includes(pattern)) {
      return {
        triggered: true,
        urgencyOverride: 'urgent' as const,
        additionalContext: `Urgent HVAC issue detected: "${pattern}". Priority scheduling recommended.`,
      };
    }
  }

  return { triggered: false };
}

function classifyMaintenanceType(context: ReasoningContext) {
  const utterance = context.currentUtterance.toLowerCase();
  const maintenanceKeywords = ['tune up', 'maintenance', 'inspection', 'filter', 'annual service', 'seasonal'];

  for (const keyword of maintenanceKeywords) {
    if (utterance.includes(keyword)) {
      return {
        triggered: true,
        urgencyOverride: 'normal' as const,
        additionalContext: 'Routine HVAC maintenance request. Standard scheduling applies.',
      };
    }
  }

  return { triggered: false };
}

const rules: IndustryReasoningRule[] = [
  {
    id: 'hvac_emergency_classification',
    vertical: 'hvac',
    name: 'Emergency vs Repair Classification',
    description: 'Classify HVAC issues as emergency, urgent repair, or routine maintenance',
    evaluate: classifyRepairVsEmergency,
  },
  {
    id: 'hvac_maintenance_classification',
    vertical: 'hvac',
    name: 'Maintenance Type Classification',
    description: 'Identify routine maintenance requests for standard scheduling',
    evaluate: classifyMaintenanceType,
  },
];

const slotManifests: Record<string, SlotManifest> = {
  service_request: {
    vertical: 'hvac',
    intent: 'service_request',
    slots: [
      { name: 'caller_name', label: 'Name', required: true, prompt: 'May I have your name?' },
      { name: 'callback_number', label: 'Phone', required: true, prompt: 'What is the best number to reach you?' },
      { name: 'service_address', label: 'Service Address', required: true, prompt: 'What is the address where service is needed?' },
      { name: 'issue_description', label: 'Issue', required: true, prompt: 'Can you describe the issue you are experiencing?' },
      { name: 'equipment_type', label: 'Equipment', required: false, prompt: 'What type of equipment is affected — furnace, AC, heat pump, or other?' },
      { name: 'preferred_date', label: 'Preferred Date', required: false, prompt: 'When would you like us to come out?' },
    ],
  },
};

export const hvacPack: IndustryReasoningPack = {
  vertical: 'hvac',
  displayName: 'HVAC Services',
  rules,
  slotManifests,
  escalationKeywords: HVAC_EMERGENCY_KEYWORDS,
  prohibitedAdviceCategories: ['electrical_work', 'gas_line_repair'],
};
