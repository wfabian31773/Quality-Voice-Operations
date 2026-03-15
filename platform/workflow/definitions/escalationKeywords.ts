/**
 * Platform-wide escalation keywords.
 * When any of these are detected the workflow short-circuits to immediate escalation
 * regardless of intent classification score.
 *
 * Agent templates and tenants can extend this list.
 */
export const BASE_ESCALATION_KEYWORDS: string[] = [
  'chest pain',
  'heart attack',
  'can\'t breathe',
  'difficulty breathing',
  'stroke',
  'unconscious',
  'not responding',
  'severe bleeding',
  'suicidal',
  'overdose',
  'anaphylaxis',
  'allergic reaction',
  'emergency',
  'call 911',
];

export function mergeEscalationKeywords(extras: string[]): string[] {
  return [...new Set([...BASE_ESCALATION_KEYWORDS, ...extras])];
}
