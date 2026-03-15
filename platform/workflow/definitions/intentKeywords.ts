import type { IntentType } from '../types';

/**
 * Base intent keyword map for the platform workflow engine.
 *
 * Agent templates extend this with vertical-specific terms.
 * Tenants may further extend via their agent configuration.
 */
export const BASE_INTENT_KEYWORDS: Record<IntentType, string[]> = {
  schedule_appointment: [
    'schedule', 'appointment', 'book', 'make an appointment',
    'see a doctor', 'set up', 'new patient',
  ],
  cancel_appointment: ['cancel', 'cancellation', 'cancel my appointment', 'won\'t be coming'],
  reschedule_appointment: [
    'reschedule', 'change my appointment', 'move my appointment', 'different time',
  ],
  billing_inquiry: [
    'bill', 'billing', 'invoice', 'payment', 'insurance', 'cost', 'charge', 'statement',
  ],
  prescription_refill: [
    'prescription', 'refill', 'medication', 'medicine', 'rx', 'pills',
  ],
  test_results: [
    'results', 'test results', 'lab results', 'bloodwork', 'imaging', 'scan results',
  ],
  urgent_medical: [
    'emergency', 'urgent', 'can\'t breathe', 'chest pain', 'severe pain', '911',
    'bleeding', 'unconscious', 'not responding',
  ],
  general_inquiry: [
    'question', 'information', 'hours', 'location', 'directions', 'parking', 'fax',
  ],
  speak_to_staff: [
    'speak to someone', 'talk to a person', 'human', 'operator', 'representative',
    'receptionist', 'front desk',
  ],
  unknown: [],
};

/**
 * Merge tenant/template-specific keywords with the platform base set.
 */
export function mergeIntentKeywords(
  overrides: Partial<Record<IntentType, string[]>>,
): Record<IntentType, string[]> {
  const merged = { ...BASE_INTENT_KEYWORDS };
  for (const [intent, keywords] of Object.entries(overrides) as [IntentType, string[]][]) {
    merged[intent] = [...(merged[intent] ?? []), ...keywords];
  }
  return merged;
}
