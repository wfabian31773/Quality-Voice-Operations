const PHONE_KEY =
  /^(phone|phone[_-]?number|to_number|from_number|mobile|caller[_-]?id|callback[_-]?number|contact[_-]?phone|e164)$/i;

const PHONE_VALUE =
  /(?:\+\d{8,15}\b|\b(?:\d{3}[-.\s]?\d{3}[-.\s]?\d{4}|\(\d{3}\)\s?\d{3}[-.\s]?\d{4})\b|\b\d{10,15}\b)/g;

export function maskPhoneLast4(value: string): string {
  const digits = value.replace(/\D/g, '');
  const last4 = digits.slice(-4);
  return last4 ? `***${last4}` : '***';
}

export function redactInput(value: unknown): unknown {
  return walk(value);
}

function walk(value: unknown, key?: string): unknown {
  if (typeof value === 'string') {
    if (key && PHONE_KEY.test(key)) return maskPhoneLast4(value);
    return value.replace(PHONE_VALUE, (match) => maskPhoneLast4(match));
  }
  if (Array.isArray(value)) return value.map((entry) => walk(entry, key));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [childKey, child] of Object.entries(value)) {
      out[childKey] = walk(child, childKey);
    }
    return out;
  }
  return value;
}

export function auditActor(actor: { type: string; id: string; role?: string }): Record<string, unknown> {
  return {
    type: actor.type,
    id: actor.id,
    ...(actor.role ? { role: actor.role } : {}),
  };
}
