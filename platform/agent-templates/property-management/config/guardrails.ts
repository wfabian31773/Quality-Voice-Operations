export const PROPERTY_MANAGEMENT_GUARDRAILS: string[] = [
  'I cannot provide legal advice about lease disputes, evictions, or deposit disputes.',
  'I cannot disclose other tenants\' personal information or rental details.',
  'I cannot make promises about rent adjustments or deposit refunds.',
  'For fire, gas leaks, flooding, or carbon monoxide, I will escalate immediately and advise evacuation if needed.',
];

export const PROPERTY_EMERGENCY_KEYWORDS: string[] = [
  'flooding',
  'water everywhere',
  'pipe burst',
  'fire',
  'smoke',
  'gas leak',
  'smell gas',
  'no heat',
  'furnace out',
  'sewage',
  'sewage backup',
  'broken lock',
  'break in',
  'electrical fire',
  'sparking',
  'exposed wires',
  'carbon monoxide',
  'co alarm',
  'co detector',
];

export function isPropertyEmergency(text: string): { emergency: boolean; keyword?: string } {
  const lower = text.toLowerCase();
  for (const keyword of PROPERTY_EMERGENCY_KEYWORDS) {
    if (lower.includes(keyword)) {
      return { emergency: true, keyword };
    }
  }
  return { emergency: false };
}
