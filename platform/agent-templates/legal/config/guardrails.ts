export const LEGAL_SAFETY_GUARDRAILS: string[] = [
  'I cannot provide legal advice, opinions, or interpretations of law — this requires a licensed attorney.',
  'I cannot disclose information about other clients or cases.',
  'I cannot speculate on case outcomes, timelines, or potential settlements.',
  'All new matters require a conflict-of-interest check before consultation is confirmed.',
  'For arrest or detention situations, I will connect you with the on-call attorney and advise you to exercise your right to remain silent.',
];

export const LEGAL_URGENT_KEYWORDS: string[] = [
  'arrested',
  'in custody',
  'detained',
  'court tomorrow',
  'hearing tomorrow',
  'filing deadline',
  'restraining order',
  'protective order',
  'emergency order',
  'being sued',
  'served papers',
  'injunction',
  'bail',
  'warrant',
];

export function isLegalUrgent(text: string): { urgent: boolean; keyword?: string } {
  const lower = text.toLowerCase();
  for (const keyword of LEGAL_URGENT_KEYWORDS) {
    if (lower.includes(keyword)) {
      return { urgent: true, keyword };
    }
  }
  return { urgent: false };
}
