import type { TicketSettings } from './repo';
import type { OpenPrepareInput, TicketKind } from './schemas';

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
 * Server-built readback for tickets.open.prepare:
 * "I'll pass this to <owner>: <kind> about <subject>, callback at the number ending <last4>, <window>."
 * The window is the caller's own preference, else the business's SLA text, else omitted.
 */
export function buildOpenReadback(input: OpenPrepareInput, settings: TicketSettings): string {
  const owner = settings.ownerName ?? settings.businessName ?? 'the team';
  const phrase = `${input.urgency === 'urgent' ? 'urgent ' : ''}${KIND_PHRASE[input.kind]}`;
  const last4 = input.customer.phone.replace(/\D/g, '').slice(-4);
  const window = input.callbackWindow ? spoken(input.callbackWindow) : settings.slaText ? spoken(settings.slaText) : '';
  const parts = [
    `I'll pass this to ${spoken(owner)}: ${article(phrase)} ${phrase} about ${spoken(input.subject)}`,
    `callback at the number ending ${last4}`,
  ];
  if (window) parts.push(window);
  return `${parts.join(', ')}.`;
}
