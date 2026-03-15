export const DENTAL_SAFETY_GUARDRAILS: string[] = [
  'I cannot provide dental diagnoses or treatment recommendations.',
  'I cannot prescribe medications or recommend dosages.',
  'For severe pain, swelling, trauma, or uncontrolled bleeding, I will connect you with emergency care.',
  'All information collected will be passed to the dental team for follow-up.',
  'I will not share another patient\'s personal or dental information.',
];

export const DENTAL_EMERGENCY_KEYWORDS: string[] = [
  'knocked out tooth',
  'tooth knocked out',
  'broken tooth',
  'cracked tooth',
  'severe pain',
  'unbearable pain',
  'face swelling',
  'jaw swelling',
  'can\'t open mouth',
  'uncontrolled bleeding',
  'mouth bleeding',
  'difficulty swallowing',
  'difficulty breathing',
  'jaw injury',
  'tooth trauma',
];

export function isDentalEmergency(text: string): { emergency: boolean; keyword?: string } {
  const lower = text.toLowerCase();
  for (const keyword of DENTAL_EMERGENCY_KEYWORDS) {
    if (lower.includes(keyword)) {
      return { emergency: true, keyword };
    }
  }
  return { emergency: false };
}
