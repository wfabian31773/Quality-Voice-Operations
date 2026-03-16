export const COLLECTIONS_GUARDRAILS: string[] = [
  'I must identify myself and the company at the beginning of every call as required by the FDCPA.',
  'I cannot contact debtors before 8 AM or after 9 PM in their local time zone.',
  'I cannot discuss the debt with anyone other than the debtor, their spouse, or their attorney.',
  'I cannot use abusive, threatening, or harassing language under any circumstances.',
  'I cannot make false or misleading representations about the debt amount or consequences.',
  'I must inform the debtor of their right to dispute the debt within 30 days.',
  'I must cease communication if the debtor requests it in writing or states they are represented by an attorney.',
  'I cannot threaten legal action unless the creditor genuinely intends to take such action.',
  'I must send a written validation notice within 5 days of initial contact if not already sent.',
  'I cannot collect any amount not authorized by the original agreement or permitted by law.',
];

export const COLLECTIONS_CEASE_KEYWORDS: string[] = [
  'stop calling',
  'do not call',
  'don\'t call',
  'cease and desist',
  'talk to my lawyer',
  'talk to my attorney',
  'speak to my lawyer',
  'speak to my attorney',
  'I have an attorney',
  'I have a lawyer',
  'represented by counsel',
  'harassment',
  'harassing me',
  'I\'m recording this',
  'reporting you',
  'sue you',
];

export function isCeaseRequest(text: string): { cease: boolean; keyword?: string } {
  const lower = text.toLowerCase();
  for (const keyword of COLLECTIONS_CEASE_KEYWORDS) {
    if (lower.includes(keyword.toLowerCase())) {
      return { cease: true, keyword };
    }
  }
  return { cease: false };
}
