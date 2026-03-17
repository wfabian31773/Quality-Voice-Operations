import type { IndustryReasoningPack, IndustryReasoningRule, SlotManifest, ReasoningContext } from '../types';

const PM_EMERGENCY_KEYWORDS = [
  'flooding', 'fire', 'gas leak', 'carbon monoxide',
  'no heat dangerous', 'broken pipe', 'sewage backup',
  'electrical fire', 'structural damage', 'break in',
  'locked out', 'water main break',
];

function classifyMaintenanceUrgency(context: ReasoningContext) {
  const utterance = context.currentUtterance.toLowerCase();

  for (const keyword of PM_EMERGENCY_KEYWORDS) {
    if (utterance.includes(keyword)) {
      return {
        triggered: true,
        action: 'escalate_to_human' as const,
        urgencyOverride: 'emergency' as const,
        additionalContext: `Property emergency detected: "${keyword}". Contact emergency maintenance immediately.`,
      };
    }
  }

  const urgentPatterns = ['no heat', 'no hot water', 'no water', 'leak', 'pest infestation', 'mold', 'broken lock', 'broken window'];
  for (const pattern of urgentPatterns) {
    if (utterance.includes(pattern)) {
      return {
        triggered: true,
        urgencyOverride: 'urgent' as const,
        additionalContext: `Urgent maintenance issue: "${pattern}". Priority work order recommended.`,
      };
    }
  }

  return { triggered: false };
}

const rules: IndustryReasoningRule[] = [
  {
    id: 'pm_maintenance_urgency',
    vertical: 'property-management',
    name: 'Maintenance Urgency Classification',
    description: 'Classify property maintenance requests by urgency',
    evaluate: classifyMaintenanceUrgency,
  },
];

const slotManifests: Record<string, SlotManifest> = {
  maintenance_request: {
    vertical: 'property-management',
    intent: 'maintenance_request',
    slots: [
      { name: 'caller_name', label: 'Tenant Name', required: true, prompt: 'May I have your name?' },
      { name: 'callback_number', label: 'Phone', required: true, prompt: 'Best number to reach you?' },
      { name: 'unit_number', label: 'Unit Number', required: true, prompt: 'What is your unit or apartment number?' },
      { name: 'property_address', label: 'Property', required: true, prompt: 'What is the property address?' },
      { name: 'issue_description', label: 'Issue', required: true, prompt: 'Can you describe the maintenance issue?' },
      { name: 'permission_to_enter', label: 'Permission to Enter', required: false, prompt: 'Do we have permission to enter your unit if you are not home?' },
    ],
  },
};

export const propertyManagementPack: IndustryReasoningPack = {
  vertical: 'property-management',
  displayName: 'Property Management',
  rules,
  slotManifests,
  escalationKeywords: PM_EMERGENCY_KEYWORDS,
  prohibitedAdviceCategories: ['legal_tenant_rights', 'eviction_advice'],
};
