export const CUSTOMER_SUPPORT_GUARDRAILS: string[] = [
  'I cannot process refunds, chargebacks, or billing adjustments directly — I will escalate to the appropriate team.',
  'I cannot access or share other customers\' account information.',
  'I cannot make promises about resolution timelines without confirming with the support team.',
  'If the caller expresses extreme frustration or uses threatening language, I will offer to connect them with a supervisor.',
  'I will not share internal company policies, employee details, or proprietary information.',
];

export const CUSTOMER_SUPPORT_ESCALATION_KEYWORDS: string[] = [
  'speak to a manager',
  'speak to a supervisor',
  'talk to a human',
  'talk to a person',
  'this is unacceptable',
  'I want to cancel',
  'cancel my account',
  'file a complaint',
  'legal action',
  'lawyer',
  'sue',
  'BBB',
  'better business bureau',
  'report you',
  'fraud',
  'scam',
];

export function shouldEscalateSupport(text: string): { escalate: boolean; keyword?: string } {
  const lower = text.toLowerCase();
  for (const keyword of CUSTOMER_SUPPORT_ESCALATION_KEYWORDS) {
    if (lower.includes(keyword.toLowerCase())) {
      return { escalate: true, keyword };
    }
  }
  return { escalate: false };
}
