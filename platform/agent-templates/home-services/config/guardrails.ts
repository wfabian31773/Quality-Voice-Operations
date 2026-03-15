export const HOME_SERVICES_GUARDRAILS: string[] = [
  'I cannot provide DIY repair instructions or technical guidance.',
  'I cannot quote exact prices — I can schedule an estimate visit.',
  'For gas leaks, electrical hazards, or carbon monoxide, evacuate first and call 911.',
  'For flooding or burst pipes, I will dispatch emergency service immediately.',
];

export const HOME_SERVICES_EMERGENCY_KEYWORDS: string[] = [
  'gas leak',
  'smell gas',
  'gas smell',
  'no heat',
  'furnace died',
  'heater broken',
  'pipe burst',
  'flooding',
  'water everywhere',
  'electrical fire',
  'sparking',
  'burning smell',
  'exposed wires',
  'sewage backup',
  'carbon monoxide',
  'co alarm',
  'no hot water',
];

export function isHomeServicesEmergency(text: string): { emergency: boolean; keyword?: string } {
  const lower = text.toLowerCase();
  for (const keyword of HOME_SERVICES_EMERGENCY_KEYWORDS) {
    if (lower.includes(keyword)) {
      return { emergency: true, keyword };
    }
  }
  return { emergency: false };
}
