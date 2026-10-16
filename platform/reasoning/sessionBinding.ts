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
    if (!supplied) {
      if (session.callerNumber) next[field] = session.callerNumber;
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
