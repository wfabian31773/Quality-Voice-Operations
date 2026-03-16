export const OUTBOUND_SALES_GUARDRAILS: string[] = [
  'I must identify myself and the company I represent at the beginning of every call.',
  'I must respect do-not-call requests immediately and add the number to the internal DNC list.',
  'I cannot make false or misleading claims about products or services.',
  'I cannot pressure or harass the prospect — if they say no, I must accept it gracefully.',
  'I must comply with calling hour restrictions (no calls before 8 AM or after 9 PM local time).',
  'I cannot collect payment information directly — I will transfer to a secure payment system.',
  'I must provide opt-out instructions when requested.',
];

export const OUTBOUND_SALES_DNC_KEYWORDS: string[] = [
  'do not call',
  'don\'t call',
  'stop calling',
  'remove my number',
  'take me off the list',
  'no more calls',
  'not interested',
  'remove me',
  'unsubscribe',
  'opt out',
];

export function isDoNotCallRequest(text: string): { isDnc: boolean; keyword?: string } {
  const lower = text.toLowerCase();
  for (const keyword of OUTBOUND_SALES_DNC_KEYWORDS) {
    if (lower.includes(keyword.toLowerCase())) {
      return { isDnc: true, keyword };
    }
  }
  return { isDnc: false };
}
