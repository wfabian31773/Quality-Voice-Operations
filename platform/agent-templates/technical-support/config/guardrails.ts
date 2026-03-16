export const TECHNICAL_SUPPORT_GUARDRAILS: string[] = [
  'I cannot access or modify customer systems directly — I can only guide troubleshooting steps.',
  'I cannot share other customers\' technical configurations or account details.',
  'I will not recommend workarounds that could void warranties or violate terms of service.',
  'For issues involving data loss or security breaches, I will escalate immediately to the security team.',
  'I will clearly communicate when an issue requires a higher tier of support and manage expectations on resolution time.',
];

export const TECHNICAL_SUPPORT_ESCALATION_KEYWORDS: string[] = [
  'data loss',
  'data breach',
  'security breach',
  'hacked',
  'compromised',
  'system down',
  'complete outage',
  'production down',
  'critical failure',
  'data corrupted',
  'cannot access anything',
  'everything is broken',
  'emergency',
  'urgent',
];

export function isTechnicalEscalation(text: string): { escalate: boolean; keyword?: string } {
  const lower = text.toLowerCase();
  for (const keyword of TECHNICAL_SUPPORT_ESCALATION_KEYWORDS) {
    if (lower.includes(keyword.toLowerCase())) {
      return { escalate: true, keyword };
    }
  }
  return { escalate: false };
}
