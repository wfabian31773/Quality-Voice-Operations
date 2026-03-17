import type { IndustryReasoningPack, IndustryReasoningRule, SlotManifest, ReasoningContext } from '../types';

function classifyLeadType(context: ReasoningContext) {
  const utterance = context.currentUtterance.toLowerCase();

  const buyerKeywords = ['looking to buy', 'home for sale', 'buying a house', 'purchase', 'first-time buyer', 'pre-approved'];
  for (const keyword of buyerKeywords) {
    if (utterance.includes(keyword)) {
      return {
        triggered: true,
        additionalContext: 'Buyer lead detected. Collect budget, location preferences, and timeline.',
      };
    }
  }

  const sellerKeywords = ['sell my home', 'selling', 'list my property', 'market analysis', 'home value', 'what is my home worth'];
  for (const keyword of sellerKeywords) {
    if (utterance.includes(keyword)) {
      return {
        triggered: true,
        additionalContext: 'Seller lead detected. Collect property details and schedule listing consultation.',
      };
    }
  }

  const rentalKeywords = ['rental', 'rent', 'lease', 'apartment', 'tenant', 'looking to rent'];
  for (const keyword of rentalKeywords) {
    if (utterance.includes(keyword)) {
      return {
        triggered: true,
        additionalContext: 'Rental inquiry detected. Collect requirements and schedule viewing.',
      };
    }
  }

  return { triggered: false };
}

const rules: IndustryReasoningRule[] = [
  {
    id: 'real_estate_lead_type',
    vertical: 'real-estate',
    name: 'Lead Type Classification',
    description: 'Classify real estate calls as buyer, seller, or rental inquiries',
    evaluate: classifyLeadType,
  },
];

const slotManifests: Record<string, SlotManifest> = {
  schedule_viewing: {
    vertical: 'real-estate',
    intent: 'schedule_viewing',
    slots: [
      { name: 'caller_name', label: 'Name', required: true, prompt: 'May I have your name?' },
      { name: 'callback_number', label: 'Phone', required: true, prompt: 'What is the best number to reach you?' },
      { name: 'email', label: 'Email', required: false, prompt: 'What is your email address?' },
      { name: 'property_interest', label: 'Property Interest', required: true, prompt: 'Which property are you interested in?' },
      { name: 'budget_range', label: 'Budget', required: false, prompt: 'Do you have a budget range in mind?' },
      { name: 'preferred_date', label: 'Preferred Date', required: false, prompt: 'When would you like to schedule a viewing?' },
      { name: 'pre_approved', label: 'Pre-Approved', required: false, prompt: 'Have you been pre-approved for financing?' },
    ],
  },
};

export const realEstatePack: IndustryReasoningPack = {
  vertical: 'real-estate',
  displayName: 'Real Estate',
  rules,
  slotManifests,
  escalationKeywords: [],
  prohibitedAdviceCategories: ['property_value_guarantee', 'mortgage_advice', 'investment_advice'],
};
