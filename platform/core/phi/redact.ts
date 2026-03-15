const PHONE_REGEX =
  /\b(\d{3}[-.\s]?\d{3}[-.\s]?\d{4}|\(\d{3}\)\s?\d{3}[-.\s]?\d{4}|\+1\s?\d{3}[-.\s]?\d{3}[-.\s]?\d{4})\b/g;

const DOB_REGEX =
  /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})\b/g;

const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/g;

const NAME_AFTER_PATTERNS: RegExp[] = [
  /\b(?:my name is|this is|i'm|i am|patient|caller|name:\s*)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/gi,
  /\b(?:Mrs?\.|Ms\.|Dr\.)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g,
];

/**
 * Redact PHI tokens from a string.
 * Pure function — no side effects, no tenant context required.
 * Platform policy: PHI redaction is ALWAYS applied before logging; tenants cannot disable it.
 */
export function redactPHI(text: string): string {
  if (!text) return text;

  let redacted = text;
  redacted = redacted.replace(SSN_REGEX, '[SSN_REDACTED]');
  redacted = redacted.replace(PHONE_REGEX, '[PHONE_REDACTED]');
  redacted = redacted.replace(DOB_REGEX, '[DOB_REDACTED]');

  for (const pattern of NAME_AFTER_PATTERNS) {
    redacted = redacted.replace(pattern, (match, name) => match.replace(name, '[NAME_REDACTED]'));
  }

  return redacted;
}

export function redactGraderResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;

  const obj = result as Record<string, unknown>;
  const redacted = { ...obj };

  if (typeof redacted.reason === 'string') {
    redacted.reason = redactPHI(redacted.reason);
  }
  if (redacted.metadata && typeof redacted.metadata === 'object') {
    redacted.metadata = redactMetadata(redacted.metadata as Record<string, unknown>);
  }

  return redacted;
}

export function redactMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string') {
      result[key] = redactPHI(value);
    } else if (Array.isArray(value)) {
      result[key] = value.map((v) => (typeof v === 'string' ? redactPHI(v) : v));
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function redactGraderResults(results: unknown): unknown {
  if (!results || typeof results !== 'object') return results;
  const obj = results as Record<string, unknown>;
  const redacted = { ...obj };
  if (Array.isArray(redacted.graders)) {
    redacted.graders = redacted.graders.map(redactGraderResult);
  }
  return redacted;
}
