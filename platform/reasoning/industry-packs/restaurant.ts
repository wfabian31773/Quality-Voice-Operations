import type { IndustryReasoningPack, IndustryReasoningRule, SlotManifest, ReasoningContext } from '../types';

const RESTAURANT_URGENT_KEYWORDS = [
  'food poisoning', 'allergic reaction', 'choking',
  'severe allergic', 'anaphylaxis',
];

function classifyReservationVsInquiry(context: ReasoningContext) {
  const utterance = context.currentUtterance.toLowerCase();

  const reservationKeywords = ['reservation', 'book a table', 'table for', 'party of', 'reserve', 'dining'];
  for (const keyword of reservationKeywords) {
    if (utterance.includes(keyword)) {
      return {
        triggered: true,
        additionalContext: 'Reservation request detected. Collect party size, date, time, and special requests.',
      };
    }
  }

  const allergyKeywords = ['allergy', 'allergies', 'gluten free', 'nut free', 'dairy free', 'vegan', 'vegetarian', 'dietary'];
  for (const keyword of allergyKeywords) {
    if (utterance.includes(keyword)) {
      return {
        triggered: true,
        additionalContext: 'Dietary/allergy inquiry. Flag for kitchen attention and note in reservation.',
      };
    }
  }

  return { triggered: false };
}

function detectLargeParty(context: ReasoningContext) {
  const utterance = context.currentUtterance.toLowerCase();
  const largePartyPatterns = ['large party', 'group of', 'private event', 'private dining', 'catering', 'banquet', 'party of 8', 'party of 10', 'party of 12', 'party of 15', 'party of 20'];

  for (const pattern of largePartyPatterns) {
    if (utterance.includes(pattern)) {
      return {
        triggered: true,
        additionalContext: 'Large party or event inquiry. May require manager approval or special event coordinator.',
      };
    }
  }

  return { triggered: false };
}

const rules: IndustryReasoningRule[] = [
  {
    id: 'restaurant_reservation_classification',
    vertical: 'restaurant',
    name: 'Reservation vs Inquiry',
    description: 'Classify restaurant calls as reservations, dietary inquiries, or general questions',
    evaluate: classifyReservationVsInquiry,
  },
  {
    id: 'restaurant_large_party',
    vertical: 'restaurant',
    name: 'Large Party Detection',
    description: 'Detect large party or event inquiries requiring special handling',
    evaluate: detectLargeParty,
  },
];

const slotManifests: Record<string, SlotManifest> = {
  make_reservation: {
    vertical: 'restaurant',
    intent: 'make_reservation',
    slots: [
      { name: 'caller_name', label: 'Name', required: true, prompt: 'What name should the reservation be under?' },
      { name: 'callback_number', label: 'Phone', required: true, prompt: 'What is a good callback number?' },
      { name: 'party_size', label: 'Party Size', required: true, prompt: 'How many guests will be dining?' },
      { name: 'reservation_date', label: 'Date', required: true, prompt: 'What date would you like to dine?' },
      { name: 'reservation_time', label: 'Time', required: true, prompt: 'What time works best?' },
      { name: 'special_requests', label: 'Special Requests', required: false, prompt: 'Any dietary restrictions or special requests?' },
    ],
  },
};

export const restaurantPack: IndustryReasoningPack = {
  vertical: 'restaurant',
  displayName: 'Restaurant',
  rules,
  slotManifests,
  escalationKeywords: RESTAURANT_URGENT_KEYWORDS,
  prohibitedAdviceCategories: ['food_safety_guarantee'],
};
