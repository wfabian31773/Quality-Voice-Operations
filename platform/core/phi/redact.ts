const PHONE_REGEX =
  /(?:\+\d{8,15}\b|\b(?:\d{3}[-.\s]?\d{3}[-.\s]?\d{4}|\(\d{3}\)\s?\d{3}[-.\s]?\d{4})\b)/g;

const MONTH =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|' +
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|sep?tiembre|octubre|noviembre|diciembre)(?![a-z])\\.?';

/**
 * A date, with its year (if any) in a named group: numeric US/ISO, "Oct 24, 1990",
 * "24 October 1990", "24 de octubre de 1990". Yearless numeric dates ("10/24")
 * only count as dates when a birth cue is in the text (see dateIsKept).
 */
const DATE_REGEX = new RegExp(
  [
    String.raw`\b\d{1,2}[\/\-]\d{1,2}[\/\-](?<y1>\d{2,4})\b`,
    String.raw`\b(?<y2>\d{4})[\/\-]\d{1,2}[\/\-]\d{1,2}\b`,
    String.raw`\b${MONTH}\s+\d{1,2}(?:st|nd|rd|th)?\b(?:,?\s+(?<y3>\d{4})\b)?`,
    String.raw`\b\d{1,2}(?:\s+de)?\s+${MONTH}(?:,?\s+(?:de|del)?\s*(?<y4>\d{4})\b)?`,
    String.raw`\b\d{1,2}[\/\-]\d{1,2}\b`,
  ].join('|'),
  'gi',
);

/** Words that make any date in the same text a possible birth date (EN/ES, with or without accents). */
const BIRTH_CUE_REGEX =
  /(?<!\p{L})(?:born|birth\p{L}*|b-?days?|dob|d\.o\.b\.?|nac[ií](?:miento|d[oa]|[oó])?|cumplea[ñn]os|cumple)(?!\p{L})/iu;

/**
 * Appointment dates stay readable in logs; anything that could be a birth
 * date is redacted. A date is kept only when the text has no birth cue and
 * the date has no year, or a four-digit year that is the current or next
 * year. Two-digit years ("01/15/90", "10/24/26") are always redacted.
 */
function dateIsKept(groups: Record<string, string | undefined>, hasBirthCue: boolean, currentYear: number): boolean {
  if (hasBirthCue) return false;
  const year = groups.y1 ?? groups.y2 ?? groups.y3 ?? groups.y4;
  if (year === undefined) return true;
  return year.length === 4 && (Number(year) === currentYear || Number(year) === currentYear + 1);
}

/**
 * Keys that name a birth-date field once "_", "-", "." and spaces are dropped:
 * dob, d_o_b, patientDOB, date_of_birth, dateOfBirth, birthday, bday, b-day,
 * fecha_nacimiento, cumpleaños. Deliberately broad: a false hit only hides a date.
 */
const BIRTH_FIELD_REGEX = /^dob|dob$|birth|bday|nac[ií]miento|nacid[oa]|cumple/i;

export function isBirthDateField(key: string): boolean {
  return BIRTH_FIELD_REGEX.test(key.replace(/[\s_.-]/g, ''));
}

const SSN_REGEX =/\b\d{3}-\d{2}-\d{4}\b/g;

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
  return redactPHIAsOf(text, new Date());
}

/**
 * redactPHI with the clock passed in: `now` decides which years count as
 * appointment years. `birthField` marks the text as the value of a birth-date
 * field, so every date in it is redacted whatever its year.
 */
export function redactPHIAsOf(text: string, now: Date, opts: { birthField?: boolean } = {}): string {
  if (!text) return text;

  const currentYear = now.getUTCFullYear();
  const hasBirthCue = opts.birthField === true || BIRTH_CUE_REGEX.test(text);
  let redacted = text;
  redacted = redacted.replace(SSN_REGEX, '[SSN_REDACTED]');
  redacted = redacted.replace(PHONE_REGEX, '[PHONE_REDACTED]');
  redacted = redacted.replace(DATE_REGEX, (...args) => {
    const groups = args[args.length - 1] as Record<string, string | undefined>;
    return dateIsKept(groups, hasBirthCue, currentYear) ? args[0] as string : '[DOB_REDACTED]';
  });

  for (const pattern of NAME_AFTER_PATTERNS) {
    // The name is the end of the match; replace it there so a name that also
    // appears inside the lead-in ("patient pat") doesn't hit the lead-in.
    redacted = redacted.replace(pattern, (match, name: string) => (
      startsWithStopWord(name) ? match : `${match.slice(0, match.length - name.length)}[NAME_REDACTED]`
    ));
  }

  return redacted;
}

/** Redact a value stored under `key`; a birth-date key ({ dob: '2026-03-15' }) counts as a birth cue. */
export function redactPHIForField(key: string, value: string, now: Date = new Date()): string {
  return redactPHIAsOf(value, now, { birthField: isBirthDateField(key) });
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

export function redactMetadata(metadata: Record<string, unknown>, now: Date = new Date()): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === 'string') {
      result[key] = redactPHIForField(key, value, now);
    } else if (Array.isArray(value)) {
      result[key] = value.map((v) => (typeof v === 'string' ? redactPHIForField(key, v, now) : v));
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
