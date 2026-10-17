export interface SessionIdentity {
  tenantId: string;
  agentId: string;
  callerNumber: string;
  transcript: string;
}

export interface SessionBindingResult {
  ok: boolean;
  args: Record<string, unknown>;
  reason?: string;
}

const IDENTITY_FIELDS: Record<string, 'tenant' | 'agent'> = {
  tenantId: 'tenant',
  tenant_id: 'tenant',
  tenant: 'tenant',
  agentId: 'agent',
  agent_id: 'agent',
  agentSlug: 'agent',
  agent_slug: 'agent',
};

const CALLER_PHONE_FIELDS = [
  'contactPhone',
  'contact_phone',
  'toNumber',
  'to_number',
  'callback_number',
  'callbackNumber',
  'callerPhone',
  'caller_phone',
  'phoneNumber',
  'phone',
];

/**
 * What the prompt tells the model to pass for "use the number I'm calling
 * from". The server swaps it (or an empty value) for the session caller ID,
 * so the full number never has to be in the prompt.
 */
export const CALLER_ID_TOKEN = 'caller_id';

const CALLER_ID_PHRASE = /\b(?:caller[\s_-]?id|calling|caller'?s?|this number|same number|current number)\b/i;

/**
 * True when a phone argument points at the caller ID instead of carrying a
 * number: missing, empty, the token, or a phrase like "calling number"
 * (what the model passed on the Oct 16 test call). Anything with a digit is
 * a real number and is left to the normal checks.
 */
export function isCallerIdReference(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  const text = String(value).trim();
  if (!text) return true;
  if (/\d/.test(text)) return false;
  return CALLER_ID_PHRASE.test(text);
}

/** The phone to use for a tool argument: the caller ID for a caller-ID reference, otherwise the value. */
export function resolveCallerPhone(value: unknown, callerNumber?: string | null): string {
  if (isCallerIdReference(value)) return String(callerNumber ?? '').trim();
  return String(value).trim();
}

export function phoneDigits(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

export function phonesMatch(left: string, right: string): boolean {
  const a = phoneDigits(left);
  const b = phoneDigits(right);
  if (!a || !b) return false;
  return a === b || a.endsWith(b) || b.endsWith(a);
}

export function transcriptIncludesPhone(transcript: string, phone: string): boolean {
  const target = phoneDigits(phone);
  if (target.length < 10) return false;
  const haystack = transcript.replace(/\D/g, '');
  return haystack.includes(target) || haystack.includes(target.slice(-10));
}

function expectedIdentity(session: SessionIdentity, kind: 'tenant' | 'agent'): string {
  return kind === 'tenant' ? session.tenantId : session.agentId;
}

/**
 * Bind library-tool arguments to the live call session.
 * Tenant, agent, and caller phone come from Twilio/session state.
 * A different phone is allowed only when the caller said that number.
 */
export function bindSessionToolArgs(
  args: Record<string, unknown>,
  session: SessionIdentity,
): SessionBindingResult {
  const next: Record<string, unknown> = { ...args };

  for (const [field, kind] of Object.entries(IDENTITY_FIELDS)) {
    if (!(field in next)) continue;
    const supplied = String(next[field] ?? '').trim();
    delete next[field];
    if (!supplied) continue;
    const expected = expectedIdentity(session, kind);
    if (supplied !== expected) {
      return {
        ok: false,
        args: next,
        reason: `Model supplied ${field}="${supplied}" which does not match the call session ${kind}`,
      };
    }
  }

  for (const field of CALLER_PHONE_FIELDS) {
    const supplied = typeof next[field] === 'string' ? String(next[field]).trim() : '';
    if (!supplied || isCallerIdReference(supplied)) {
      if (session.callerNumber) next[field] = session.callerNumber;
      else if (supplied) next[field] = '';
      continue;
    }
    if (phonesMatch(supplied, session.callerNumber)) {
      next[field] = session.callerNumber;
      continue;
    }
    if (!transcriptIncludesPhone(session.transcript, supplied)) {
      return {
        ok: false,
        args: next,
        reason: `Model supplied ${field} that does not match the session caller and was not spoken on the call`,
      };
    }
  }

  if (!CALLER_PHONE_FIELDS.some((field) => typeof next[field] === 'string' && String(next[field]).trim()) && session.callerNumber) {
    next.contactPhone = session.callerNumber;
  }

  return { ok: true, args: next };
}

export function sessionTranscriptFrom(context: {
  transcript: string[];
  currentUtterance?: string;
}): string {
  return [...context.transcript, context.currentUtterance ?? ''].filter(Boolean).join(' ');
}
