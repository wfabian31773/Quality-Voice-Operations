import type { IndustryReasoningPack, IndustryReasoningRule, SlotManifest, ReasoningContext } from '../types';

const LEGAL_URGENT_KEYWORDS = [
  'arrested', 'in custody', 'court tomorrow', 'deadline today',
  'restraining order', 'protective order', 'imminent danger',
  'child custody emergency', 'deportation',
];

function distinguishConsultationVsUrgent(context: ReasoningContext) {
  const utterance = context.currentUtterance.toLowerCase();

  for (const keyword of LEGAL_URGENT_KEYWORDS) {
    if (utterance.includes(keyword)) {
      return {
        triggered: true,
        action: 'escalate_to_human' as const,
        urgencyOverride: 'emergency' as const,
        additionalContext: `Urgent legal matter detected: "${keyword}". Connect with on-call attorney immediately.`,
      };
    }
  }

  const consultationPatterns = ['consultation', 'free consultation', 'meet with an attorney', 'legal question', 'need a lawyer', 'looking for representation'];
  for (const pattern of consultationPatterns) {
    if (utterance.includes(pattern)) {
      return {
        triggered: true,
        urgencyOverride: 'normal' as const,
        additionalContext: 'Consultation request. Collect intake information and schedule consultation.',
      };
    }
  }

  return { triggered: false };
}

function detectCaseType(context: ReasoningContext) {
  const utterance = context.currentUtterance.toLowerCase();
  const caseTypes: Record<string, string[]> = {
    'personal_injury': ['accident', 'injury', 'hurt', 'slip and fall', 'car accident', 'medical malpractice'],
    'family_law': ['divorce', 'custody', 'child support', 'alimony', 'separation', 'adoption'],
    'criminal_defense': ['criminal', 'dui', 'dwi', 'arrested', 'charges', 'felony', 'misdemeanor'],
    'estate_planning': ['will', 'trust', 'estate', 'power of attorney', 'probate'],
    'business_law': ['business', 'contract', 'partnership', 'llc', 'incorporation'],
    'immigration': ['immigration', 'visa', 'green card', 'citizenship', 'deportation', 'asylum'],
  };

  for (const [caseType, keywords] of Object.entries(caseTypes)) {
    for (const keyword of keywords) {
      if (utterance.includes(keyword)) {
        return {
          triggered: true,
          additionalContext: `Case type identified: ${caseType}. Route to appropriate practice area.`,
        };
      }
    }
  }

  return { triggered: false };
}

const rules: IndustryReasoningRule[] = [
  {
    id: 'legal_consultation_vs_urgent',
    vertical: 'legal',
    name: 'Consultation vs Urgent Matter',
    description: 'Distinguish between routine consultation requests and urgent legal matters',
    evaluate: distinguishConsultationVsUrgent,
  },
  {
    id: 'legal_case_type',
    vertical: 'legal',
    name: 'Case Type Detection',
    description: 'Identify the type of legal case for routing',
    evaluate: detectCaseType,
  },
];

const slotManifests: Record<string, SlotManifest> = {
  schedule_consultation: {
    vertical: 'legal',
    intent: 'schedule_consultation',
    slots: [
      { name: 'caller_name', label: 'Name', required: true, prompt: 'May I have your full name?' },
      { name: 'callback_number', label: 'Phone', required: true, prompt: 'What is the best number to reach you?' },
      { name: 'email', label: 'Email', required: false, prompt: 'Do you have an email address we can use?' },
      { name: 'case_type', label: 'Case Type', required: true, prompt: 'What type of legal matter do you need help with?' },
      { name: 'reason_for_call', label: 'Brief Description', required: true, prompt: 'Can you briefly describe your situation?' },
      { name: 'preferred_date', label: 'Preferred Date', required: false, prompt: 'When would you like to schedule?' },
      { name: 'referred_by', label: 'Referral Source', required: false, prompt: 'How did you hear about us?' },
    ],
  },
};

export const legalPack: IndustryReasoningPack = {
  vertical: 'legal',
  displayName: 'Legal Services',
  rules,
  slotManifests,
  escalationKeywords: LEGAL_URGENT_KEYWORDS,
  prohibitedAdviceCategories: ['legal_advice', 'case_outcome_prediction', 'settlement_recommendation'],
};
