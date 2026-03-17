import type { IndustryReasoningPack, IndustryReasoningRule, SlotManifest, ReasoningContext } from '../types';

const INSURANCE_URGENT_KEYWORDS = [
  'accident just happened', 'car accident', 'house fire',
  'theft', 'break in', 'water damage emergency',
  'hit and run', 'total loss',
];

function classifyClaimVsQuote(context: ReasoningContext) {
  const utterance = context.currentUtterance.toLowerCase();

  const claimKeywords = ['file a claim', 'claim', 'accident', 'damage', 'loss', 'stolen', 'incident', 'claim status'];
  for (const keyword of claimKeywords) {
    if (utterance.includes(keyword)) {
      return {
        triggered: true,
        additionalContext: 'Insurance claim inquiry detected. Collect incident details and policy information.',
      };
    }
  }

  const quoteKeywords = ['quote', 'rate', 'premium', 'coverage', 'new policy', 'switch', 'compare', 'how much'];
  for (const keyword of quoteKeywords) {
    if (utterance.includes(keyword)) {
      return {
        triggered: true,
        additionalContext: 'Quote/coverage inquiry. Collect coverage needs and schedule with agent.',
      };
    }
  }

  const policyKeywords = ['cancel policy', 'change policy', 'add driver', 'remove vehicle', 'update address', 'payment'];
  for (const keyword of policyKeywords) {
    if (utterance.includes(keyword)) {
      return {
        triggered: true,
        additionalContext: 'Policy change request. Verify identity and collect change details.',
      };
    }
  }

  return { triggered: false };
}

function detectUrgentClaim(context: ReasoningContext) {
  const utterance = context.currentUtterance.toLowerCase();

  for (const keyword of INSURANCE_URGENT_KEYWORDS) {
    if (utterance.includes(keyword)) {
      return {
        triggered: true,
        action: 'escalate_to_human' as const,
        urgencyOverride: 'emergency' as const,
        additionalContext: `Urgent insurance claim: "${keyword}". Connect with claims adjuster immediately.`,
      };
    }
  }

  return { triggered: false };
}

const rules: IndustryReasoningRule[] = [
  {
    id: 'insurance_claim_vs_quote',
    vertical: 'insurance',
    name: 'Claim vs Quote Classification',
    description: 'Classify insurance calls as claims, quotes, or policy changes',
    evaluate: classifyClaimVsQuote,
  },
  {
    id: 'insurance_urgent_claim',
    vertical: 'insurance',
    name: 'Urgent Claim Detection',
    description: 'Detect urgent insurance claims requiring immediate adjuster contact',
    evaluate: detectUrgentClaim,
  },
];

const slotManifests: Record<string, SlotManifest> = {
  file_claim: {
    vertical: 'insurance',
    intent: 'file_claim',
    slots: [
      { name: 'caller_name', label: 'Name', required: true, prompt: 'May I have your full name?' },
      { name: 'callback_number', label: 'Phone', required: true, prompt: 'Best number to reach you?' },
      { name: 'policy_number', label: 'Policy Number', required: true, prompt: 'What is your policy number?', sensitive: true },
      { name: 'incident_date', label: 'Incident Date', required: true, prompt: 'When did the incident occur?' },
      { name: 'incident_description', label: 'Description', required: true, prompt: 'Can you describe what happened?' },
      { name: 'damage_estimate', label: 'Damage Estimate', required: false, prompt: 'Do you have an estimate of the damage?' },
      { name: 'police_report', label: 'Police Report', required: false, prompt: 'Was a police report filed?' },
    ],
  },
};

export const insurancePack: IndustryReasoningPack = {
  vertical: 'insurance',
  displayName: 'Insurance',
  rules,
  slotManifests,
  escalationKeywords: INSURANCE_URGENT_KEYWORDS,
  prohibitedAdviceCategories: ['coverage_guarantee', 'claim_outcome_prediction', 'policy_interpretation'],
};
