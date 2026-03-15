/**
 * Medical After-Hours Triage Agent — platform-enforced safety guardrails.
 *
 * These guardrails are always active and cannot be disabled by tenants.
 * Extracted from src/guardrails/medicalSafety.ts.
 */

export const MEDICAL_SAFETY_GUARDRAILS: string[] = [
  'If this is a medical emergency, please call 911 immediately.',
  'I cannot provide medical diagnoses or prescribe medications.',
  'I cannot recommend changes to prescribed treatments.',
  'All information I collect will be passed to the on-call clinical team.',
  'I will not share another patient\'s medical information.',
];

export const URGENT_SYMPTOM_KEYWORDS: string[] = [
  'chest pain',
  'heart attack',
  'can\'t breathe',
  'difficulty breathing',
  'stroke',
  'face drooping',
  'arm weakness',
  'slurred speech',
  'unconscious',
  'unresponsive',
  'severe bleeding',
  'won\'t stop bleeding',
  'head injury',
  'broken bone',
  'suicidal',
  'overdose',
  'allergic reaction',
  'anaphylaxis',
  'severe allergic',
  'loss of vision',
  'sudden vision loss',
  'chemical in eye',
];

export function isUrgentSymptom(text: string): { urgent: boolean; keyword?: string } {
  const lower = text.toLowerCase();
  for (const keyword of URGENT_SYMPTOM_KEYWORDS) {
    if (lower.includes(keyword)) {
      return { urgent: true, keyword };
    }
  }
  return { urgent: false };
}
