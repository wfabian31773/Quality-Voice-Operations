import type { IndustryReasoningPack, IndustryReasoningRule, SlotManifest, ReasoningContext } from '../types';

const PLUMBING_EMERGENCY_KEYWORDS = [
  'burst pipe', 'flooding', 'sewage backup', 'gas smell',
  'no water', 'main line break', 'water heater leaking',
  'sewer overflow', 'frozen pipe burst',
];

function classifyPlumbingUrgency(context: ReasoningContext) {
  const utterance = context.currentUtterance.toLowerCase();

  for (const keyword of PLUMBING_EMERGENCY_KEYWORDS) {
    if (utterance.includes(keyword)) {
      return {
        triggered: true,
        action: 'escalate_to_human' as const,
        urgencyOverride: 'emergency' as const,
        additionalContext: `Plumbing emergency detected: "${keyword}". Immediate dispatch required.`,
      };
    }
  }

  const urgentPatterns = ['leak', 'dripping', 'clogged drain', 'backed up', 'running toilet', 'no hot water'];
  for (const pattern of urgentPatterns) {
    if (utterance.includes(pattern)) {
      return {
        triggered: true,
        urgencyOverride: 'urgent' as const,
        additionalContext: `Urgent plumbing issue: "${pattern}". Priority scheduling recommended.`,
      };
    }
  }

  return { triggered: false };
}

const rules: IndustryReasoningRule[] = [
  {
    id: 'plumbing_urgency_classification',
    vertical: 'plumbing',
    name: 'Plumbing Urgency Classification',
    description: 'Classify plumbing issues by urgency level',
    evaluate: classifyPlumbingUrgency,
  },
];

const slotManifests: Record<string, SlotManifest> = {
  service_request: {
    vertical: 'plumbing',
    intent: 'service_request',
    slots: [
      { name: 'caller_name', label: 'Name', required: true, prompt: 'May I have your name?' },
      { name: 'callback_number', label: 'Phone', required: true, prompt: 'What is the best number to reach you?' },
      { name: 'service_address', label: 'Address', required: true, prompt: 'What is the service address?' },
      { name: 'issue_description', label: 'Issue', required: true, prompt: 'Can you describe the plumbing issue?' },
      { name: 'water_shutoff', label: 'Water Shutoff', required: false, prompt: 'Have you been able to shut off the water?' },
      { name: 'preferred_date', label: 'Preferred Date', required: false, prompt: 'When would you like us to come out?' },
    ],
  },
};

export const plumbingPack: IndustryReasoningPack = {
  vertical: 'plumbing',
  displayName: 'Plumbing Services',
  rules,
  slotManifests,
  escalationKeywords: PLUMBING_EMERGENCY_KEYWORDS,
  prohibitedAdviceCategories: ['gas_line_work', 'sewer_main_repair'],
};
