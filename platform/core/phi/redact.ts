const PHONE_REGEX =
  /(?:\+\d{8,15}\b|\b(?:\d{3}[-.\s]?\d{3}[-.\s]?\d{4}|\(\d{3}\)\s?\d{3}[-.\s]?\d{4})\b)/g;

const DOB_REGEX =
  /\b(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})\b/g;

const SSN_REGEX = /\b\d{3}-\d{2}-\d{4}\b/g;

/**
 * Words that follow a name lead-in without being a name ("I'm Looking for a
 * fade" as STT capitalized it, "I'm Good", "caller from"). Compared
 * lower-case against the first word of a candidate name.
 */
export const NAME_STOP_WORDS: ReadonlySet<string> = new Set([
  'looking', 'calling', 'trying', 'just', 'here', 'wondering', 'interested',
  'good', 'fine', 'ok', 'okay', 'sorry', 'not', 'so', 'really', 'gonna',
  'going', 'about', 'from', 'on', 'in', 'with', 'available', 'free', 'ready',
  'done', 'new', 'back', 'the', 'a',
]);

function startsWithStopWord(candidate: string): boolean {
  const first = candidate.trim().split(/\s+/)[0] ?? '';
  return NAME_STOP_WORDS.has(first.toLowerCase());
}

// \p{L} / \p{Lu}\p{Ll} keep accented names such as "Maria José".
const NAME_AFTER_PATTERNS: RegExp[] = [
  // Unambiguous lead-ins take lowercase names too, because STT often
  // lowercases them ("my name is maria lopez", "patient john smith").
  /\b(?:my\s+name\s+is|patient|caller|name:\s*)\s+(\p{L}{2,}(?:\s+\p{L}{2,}){0,2})/giu,
  // Ambiguous lead-ins need a capitalized name (no `i` flag), so "I'm
  // looking for a fade" and "the one I'm calling from" are not names.
  /\b(?:[Tt]his\s+[Ii]s|[Ii]['’]m|[Ii]\s+[Aa]m)\s+(\p{Lu}\p{Ll}+(?:\s+\p{Lu}\p{Ll}+){0,2})/gu,
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
    // The name is the end of the match; replace it there so a name that also
    // appears inside the lead-in ("patient pat") doesn't hit the lead-in.
    redacted = redacted.replace(pattern, (match, name: string) => (
      startsWithStopWord(name) ? match : `${match.slice(0, match.length - name.length)}[NAME_REDACTED]`
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
