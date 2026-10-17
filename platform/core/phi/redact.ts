const PHONE_REGEX =
  /(?:\+\d{8,15}\b|\b(?:\d{3}[-.\s]?\d{3}[-.\s]?\d{4}|\(\d{3}\)\s?\d{3}[-.\s]?\d{4})\b)/g;

const DOB_REGEX =
  /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})\b/g;

const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/g;

/**
 * Words that follow "I'm" / "this is" without being a name ("I'm looking
 * for a fade", "I'm calling from", "I'm Good"). Compared lower-case against
 * the first word of a candidate name.
 */
export const NAME_STOP_WORDS: ReadonlySet<string> = new Set([
  'looking', 'calling', 'trying', 'just', 'here', 'wondering', 'interested',
  'good', 'fine', 'ok', 'okay', 'sorry', 'not', 'so', 'really', 'gonna',
  'going', 'about', 'from', 'on', 'in', 'with', 'available', 'free', 'ready',
  'done', 'new', 'back', 'the', 'a',
]);

/** True when a capitalized candidate after "I'm" / "this is" can be a name. */
export function isLikelyIntroducedName(candidate: string): boolean {
  const first = candidate.trim().split(/\s+/)[0] ?? '';
  return /^\p{Lu}/u.test(first) && !NAME_STOP_WORDS.has(first.toLowerCase());
}

// The lead-in is case-insensitive by spelling; the name itself must start
// with a capital letter (no `i` flag), so "I'm looking for a fade" is not a
// name. \p{Lu}\p{Ll} keeps accented names such as "Maria José".
const NAME_AFTER_PATTERNS: RegExp[] = [
  /\b(?:[Mm]y\s+[Nn]ame\s+[Ii]s|[Tt]his\s+[Ii]s|[Ii]['’]m|[Ii]\s+[Aa]m|[Pp]atient|[Cc]aller|[Nn]ame:\s*)\s+(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+){0,2})/gu,
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
    redacted = redacted.replace(pattern, (match, name: string) => (
      isLikelyIntroducedName(name) ? match.replace(name, '[NAME_REDACTED]') : match
    ));
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
