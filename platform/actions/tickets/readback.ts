import type { TicketSettings } from './repo';
import type { OpenTicketInput, TicketKind } from './schemas';

const KIND_PHRASE: Record<TicketKind, string> = {
  message: 'message',
  callback: 'callback request',
  complaint: 'complaint',
  quote_request: 'quote request',
  intake: 'intake request',
  other: 'request',
};

function article(phrase: string): string {
  return /^[aeiou]/i.test(phrase) ? 'an' : 'a';
}

function spoken(value: string): string {
  return value.replace(/\s+/g, ' ').trim().replace(/[.!?,;:]+$/, '');
}

/** Digits only, with a leading US country code dropped, so "+1 (555) 010-0142" matches "5550100142". */
export function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

/**
 * The full callback number in spoken digit groups (spec §3.5): US 10-digit
 * (after dropping a leading +1) as 3-3-4, "555, 010, 0142"; 7 digits as 3-4;
 * anything else in threes (never a lone digit) with a final group of four.
 */
export function phoneDigitGroups(value: string): string {
  const digits = normalizePhone(value);
  if (digits.length === 10) return [digits.slice(0, 3), digits.slice(3, 6), digits.slice(6)].join(', ');
  if (digits.length <= 7) return digits.length > 4 ? [digits.slice(0, -4), digits.slice(-4)].join(', ') : digits;
  const head = digits.slice(0, -4);
  const groups: string[] = head.match(/.{1,3}/g) ?? [];
  if (groups.length > 1 && groups[groups.length - 1].length === 1) {
    // "123, 4" → "12, 34"
    const tail = groups.splice(-2).join('');
    groups.push(tail.slice(0, 2), tail.slice(2));
  }
  return [...groups, digits.slice(-4)].join(', ');
}

/**
 * Server-built readback for tickets.open.prepare:
 * "I'll pass this to <owner>: <kind> about <subject>, callback at <full number, digit-grouped>, <window>."
 * The window is the caller's own preference, else the business's SLA text, else omitted.
 * A message filed without a callback number says so and promises no callback window.
 */
export function buildOpenReadback(input: OpenTicketInput, settings: TicketSettings): string {
  const owner = settings.ownerName ?? settings.businessName ?? 'the team';
  const phrase = `${input.urgency === 'urgent' ? 'urgent ' : ''}${KIND_PHRASE[input.kind]}`;
  const lead = `I'll pass this to ${spoken(owner)}: ${article(phrase)} ${phrase} about ${spoken(input.subject)}`;
  if (!input.customer.phone) return `${lead}, with no callback number left.`;
  const window = input.callbackWindow ? spoken(input.callbackWindow) : settings.slaText ? spoken(settings.slaText) : '';
  const parts = [lead, `callback at ${phoneDigitGroups(input.customer.phone)}`];
  if (window) parts.push(window);
  return `${parts.join(', ')}.`;
}
