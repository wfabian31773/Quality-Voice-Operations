import { DIGIT_WORDS } from './phrases';

/**
 * Lowercase, strip diacritics and apostrophes, turn every other non-letter,
 * non-digit run into one space. "¡Ya quedó, you’re booked!" → "ya quedo youre booked".
 */
export function normalizeSpeech(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/['‘’ʼ`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Precompile a phrase list into normalized forms. */
export function normalizePhrases(phrases: readonly string[]): readonly string[] {
  return phrases.map(normalizeSpeech).filter((p) => p.length > 0);
}

/** First phrase found as whole words in already-normalized text, if any. */
export function findPhrase(normalizedText: string, normalizedPhrases: readonly string[]): string | undefined {
  const padded = ` ${normalizedText} `;
  return normalizedPhrases.find((p) => padded.includes(` ${p} `));
}

/**
 * Normalized text before a colon that opens the line or a sentence:
 * "Great. Confirmed: Friday at 3" → ["confirmed"]. Sentences end at . , ! ? ; ¡ ¿ or a newline.
 */
export function leadingLabels(text: string): string[] {
  return text
    .split(/[.,!?;¡¿\n]+/)
    .map((sentence) => {
      const colon = sentence.search(/[:：]/);
      return colon < 0 ? '' : normalizeSpeech(sentence.slice(0, colon));
    })
    .filter((label) => label.length > 0);
}

/**
 * Raw sentences, split at . ! ? ; ¡ ¿ or a newline (not commas):
 * "I'll text you now; once texting is enabled, …" → ["I'll text you now", " once texting is enabled, …"].
 */
export function sentences(text: string): string[] {
  return text.split(/[.!?;¡¿\n]+/).filter((s) => s.trim().length > 0);
}

/**
 * Normalized clauses, split at . , : ; ! ? ¡ ¿ — – or a newline, so a "No," that
 * answers something else never reads as negating what follows:
 * "No, quedó reservada. ¿Algo más?" → ["no", "quedo reservada", "algo mas"].
 */
export function clauses(text: string): string[] {
  return text
    .split(/[.,:;!?¡¿\n—–]+/)
    .map(normalizeSpeech)
    .filter((c) => c.length > 0);
}

const DIGIT_WORD_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${Object.keys(DIGIT_WORDS).join('|')})(?![\\p{L}\\p{N}])`, 'giu');

// EN/ES month names and abbreviations, diacritics already stripped.
const MONTH =
  '(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec|' +
  'enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre|ene|abr|ago|dic)\\.?';
const YEAR = '(?:19|20)\\d{2}';

/**
 * Date spans, blanked before the ref check so "10 17 2026" isn't read as a 5+ digit ref:
 *   - month name + day + optional year: "October 17 2026", "Oct. 17th, 2026";
 *   - day + month name + optional year: "17 October 2026", "17 de octubre de 2026";
 *   - ISO "2026-10-17";
 *   - numeric M/D/YYYY or D/M/YYYY with one separator (/, - or space), checked in
 *     dateParts.
 * A digit group next to any of them ("555 12 12 2026", "4 8 2 1 3 may") means it isn't a date.
 */
const DATE_RES: readonly RegExp[] = [
  new RegExp(`(?<![\\p{L}\\p{N}])${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+${YEAR})?(?![\\p{L}\\p{N}]|[ -]\\p{N})`, 'giu'),
  new RegExp(`(?<![\\p{L}\\p{N}]|\\p{N}[ -])\\d{1,2}\\s+(?:de\\s+)?${MONTH}(?:,?\\s+(?:del?\\s+)?${YEAR})?(?![\\p{L}\\p{N}])`, 'giu'),
  new RegExp(`(?<![\\p{L}\\p{N}]|\\p{N}[ -])${YEAR}-(?:0?[1-9]|1[0-2])-(?:0?[1-9]|[12]\\d|3[01])(?![\\p{L}\\p{N}]|[ -]\\p{N})`, 'gu'),
];
const NUMERIC_DATE_RE = new RegExp(`(?<![\\p{L}\\p{N}]|\\p{N}[ -])(\\d{1,2})([/ -])(\\d{1,2})\\2${YEAR}(?![\\p{L}\\p{N}]|[ -]\\p{N})`, 'gu');

function dateParts(a: number, b: number): boolean {
  const day = (n: number) => n >= 1 && n <= 31;
  const month = (n: number) => n >= 1 && n <= 12;
  return (month(a) && day(b)) || (day(a) && month(b));
}

function blankDates(text: string): string {
  const blanked = DATE_RES.reduce((t, re) => t.replace(re, ' | '), text);
  return blanked.replace(NUMERIC_DATE_RE, (m, a: string, _sep: string, b: string) => (dateParts(Number(a), Number(b)) ? ' | ' : m));
}

/**
 * Ref-shaped strings, after spoken single digits become digits and dates are blanked:
 *   - 2–4 letters then 3+ digits: "BK-4712", "BK4712", "bk-4712", "BK 4712"
 *     (uppercase when space-separated, so "is 4712" is not a ref), "B K 4 7 1 2";
 *   - 5+ digits in a run, spaced or dashed: "47125", "4 7 1 2 5", "555-1234";
 *   - letters and digits alternating at least twice: "A1B2C3", "x9y8".
 * The leftmost alternative wins, so "BK-47125" is one ref, not "BK" + "47125".
 */
const REF_RE =
  /(?<![\p{L}\p{N}])(?:(?:(?:[A-Za-z]{2,4}-?|[A-Z]{2,4} |(?:[A-Z][ -]){1,3}[A-Z][ -]?)\d(?:[ -]?\d){2,}|\d(?:[ -]?\d){4,})(?!\p{N})|(?:[A-Za-z]+\d+){2,}[A-Za-z]*(?![\p{L}\p{N}]))/gu;

export function findRefs(text: string): string[] {
  const withDigits = text.normalize('NFD').replace(/\p{M}+/gu, '').replace(DIGIT_WORD_RE, (w) => DIGIT_WORDS[w.toLowerCase()] ?? w);
  return [...blankDates(withDigits).matchAll(REF_RE)].map((m) => m[0]);
}

/** Compare refs ignoring case, spaces and dashes: "bk 4712" === "BK-4712". */
export function canonicalRef(ref: string): string {
  return ref.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function canonicalArg(value: unknown): unknown {
  if (typeof value === 'string') return value.trim().replace(/\s+/g, ' ').toLowerCase();
  if (Array.isArray(value)) return value.map(canonicalArg);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalArg(v);
    }
    return out;
  }
  return value ?? null;
}

/** Stable key for tool args: sorted keys, trimmed lowercase strings, undefined dropped. */
export function normalizeArgs(args: unknown): string {
  return JSON.stringify(canonicalArg(args ?? {}));
}
