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

const DIGIT_WORD_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${Object.keys(DIGIT_WORDS).join('|')})(?![\\p{L}\\p{N}])`, 'giu');

/**
 * Ref-shaped strings, after spoken single digits become digits:
 *   - 2–4 letters then 3+ digits: "BK-4712", "BK4712", "bk-4712", "BK 4712"
 *     (uppercase when space-separated, so "is 4712" is not a ref), "B K 4 7 1 2";
 *   - 5+ digits in a run, spaced or dashed: "47125", "4 7 1 2 5", "555-1234".
 * The leftmost alternative wins, so "BK-47125" is one ref, not "BK" + "47125".
 */
const REF_RE =
  /(?<![\p{L}\p{N}])(?:(?:[A-Za-z]{2,4}-?|[A-Z]{2,4} |(?:[A-Z][ -]){1,3}[A-Z][ -]?)\d(?:[ -]?\d){2,}|\d(?:[ -]?\d){4,})(?!\p{N})/gu;

export function findRefs(text: string): string[] {
  const withDigits = text.normalize('NFD').replace(/\p{M}+/gu, '').replace(DIGIT_WORD_RE, (w) => DIGIT_WORDS[w.toLowerCase()] ?? w);
  return [...withDigits.matchAll(REF_RE)].map((m) => m[0]);
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
