/** Platform-wide shared type primitives. */

export type TenantId = string;

export type AgentType = 'inbound' | 'outbound';

export type CallState =
  | 'initiated'
  | 'ringing'
  | 'in_progress'
  | 'ending'
  | 'completed'
  | 'failed';

/**
 * Normalize a phone number to 10-digit US format (digits only).
 * Returns the original string if normalization is not possible.
 */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  if (digits.length === 10) return digits;
  return phone;
}

export function formatPhoneLast4(phone?: string): string {
  return phone ? `***${phone.slice(-4)}` : 'unknown';
}
