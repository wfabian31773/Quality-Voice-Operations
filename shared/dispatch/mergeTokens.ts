/**
 * Single source of truth for the merge tokens that
 * `fireNotifications` (in `server/admin-api/routes/dispatch.ts`) is
 * able to substitute when it renders a dispatch notification template.
 *
 * The dispatch SMS/email template editor uses this list to:
 *   - render the help text (so dispatchers always see the live list of
 *     known tokens, no hand-maintained docs to drift),
 *   - flag unknown `{{...}}` tokens with an inline warning, and
 *   - block the save (server-side too) so a typo like
 *     `{{tracking_link}}` can never escape into a customer-facing SMS.
 *
 * Keep this list in lockstep with the substitution chain in
 * `fireNotifications` — the renderer pulls keys from the same constant
 * to guarantee the editor and the renderer can't drift apart.
 */

export const DISPATCH_MERGE_TOKENS = [
  'job_title',
  'contact_name',
  'eta',
  'eta_drive_minutes',
  'eta_arrival_time',
  'resource_name',
  'status',
  'address',
  'tracking_url',
] as const;

export type DispatchMergeToken = (typeof DISPATCH_MERGE_TOKENS)[number];

const KNOWN_TOKEN_SET: ReadonlySet<string> = new Set(DISPATCH_MERGE_TOKENS);

export function isKnownDispatchMergeToken(name: string): name is DispatchMergeToken {
  return KNOWN_TOKEN_SET.has(name);
}

// Match anything between `{{` and `}}` so we also catch malformed
// names like `{{tracking-url}}` or `{{ tracking link }}` — the
// renderer's substitute() only swaps tokens whose normalized name is
// in the allowlist, so any other braced sequence would otherwise leak
// through as raw text. Inner whitespace is normalized so
// `{{ contact_name }}` matches the allowlist exactly.
const MERGE_TOKEN_RE = /\{\{([^{}]*?)\}\}/g;

/**
 * Returns the deduped, ordered list of `{{token}}` references in
 * `template` whose names are NOT in {@link DISPATCH_MERGE_TOKENS}.
 *
 * Catches both unknown identifiers (`{{tracking_link}}`) and
 * malformed token shapes the renderer can't substitute
 * (`{{tracking-url}}`, `{{ tracking link }}`).
 *
 * Returns `[]` for any non-string input so callers can pass raw form
 * state without a guard.
 */
export function findUnknownDispatchMergeTokens(template: unknown): string[] {
  if (typeof template !== 'string' || template.length === 0) return [];
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (const match of template.matchAll(MERGE_TOKEN_RE)) {
    const inner = match[1].trim();
    // Skip empty `{{}}` — there's nothing to flag and no substitution
    // would happen either way.
    if (inner.length === 0) continue;
    if (KNOWN_TOKEN_SET.has(inner)) continue;
    if (seen.has(inner)) continue;
    seen.add(inner);
    unknown.push(inner);
  }
  return unknown;
}

/**
 * Obvious-fake sample values used by the template editor's live
 * preview. They're deliberately recognizable as placeholders ("Jane
 * Doe", "Today 3:45 PM") so a dispatcher reviewing the preview can't
 * mistake it for a real customer message.
 *
 * Keep one entry per {@link DISPATCH_MERGE_TOKENS} key — the typed
 * Record makes it a compile error to add a new merge token without
 * giving the preview something to substitute.
 */
export const DISPATCH_MERGE_TOKEN_SAMPLES: Record<DispatchMergeToken, string> = {
  job_title: 'Kitchen sink leak repair',
  contact_name: 'Jane Doe',
  eta: 'Today 3:45 PM',
  eta_drive_minutes: '12',
  eta_arrival_time: 'Today 3:45 PM',
  resource_name: 'Alex Rivera',
  status: 'en route',
  address: '123 Main St, Springfield',
  tracking_url: 'https://example.com/track/abc123',
};

/**
 * Substitute `{{token}}` references in `template` using the supplied
 * value map. Mirrors the server-side `substitute()` helper in
 * `fireNotifications` so the editor's preview can't drift from what
 * customers actually receive: same tolerant whitespace handling
 * (`{{ contact_name }}`), same allowlist-only substitution (unknown
 * tokens are left as raw text so they show up in the preview the same
 * way they would in production).
 */
export function renderDispatchTemplate(
  template: string,
  values: Record<DispatchMergeToken, string> = DISPATCH_MERGE_TOKEN_SAMPLES,
): string {
  if (typeof template !== 'string' || template.length === 0) return '';
  let out = template;
  for (const token of DISPATCH_MERGE_TOKENS) {
    const re = new RegExp(`\\{\\{\\s*${token}\\s*\\}\\}`, 'g');
    out = out.replace(re, values[token]);
  }
  return out;
}

// GSM 03.38 default alphabet — every character that fits in 7 bits
// when an SMS is encoded as GSM-7 (one billed character apiece).
const GSM7_BASIC_CHARS = new Set<string>([
  '@', '£', '$', '¥', 'è', 'é', 'ù', 'ì', 'ò', 'Ç', '\n', 'Ø', 'ø', '\r', 'Å', 'å',
  'Δ', '_', 'Φ', 'Γ', 'Λ', 'Ω', 'Π', 'Ψ', 'Σ', 'Θ', 'Ξ',
  ' ', '!', '"', '#', '¤', '%', '&', "'", '(', ')', '*', '+', ',', '-', '.', '/',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  ':', ';', '<', '=', '>', '?', '¡',
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M',
  'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
  'Ä', 'Ö', 'Ñ', 'Ü', '§', '¿',
  'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
  'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
  'ä', 'ö', 'ñ', 'ü', 'à',
]);

// GSM 03.38 extension table — each character is still GSM-7-safe but
// is encoded as ESC + char on the wire, so carriers bill it as two
// characters. This is what catches dispatchers who paste a curly
// brace or a Euro sign and don't realize their 159-char message
// suddenly costs 2 segments.
const GSM7_EXTENSION_CHARS = new Set<string>([
  '\f', '^', '{', '}', '\\', '[', '~', ']', '|', '€',
]);

export type SmsEncoding = 'GSM-7' | 'UCS-2';

export interface SmsSegmentInfo {
  /** Wire encoding the carrier would pick for this body. */
  encoding: SmsEncoding;
  /**
   * Billed character count. For GSM-7 this counts extension-table
   * characters (`{`, `}`, `€`, …) as 2 since they're sent as
   * ESC+char. For UCS-2 this is the UTF-16 code-unit count, which is
   * how carriers actually meter the message (a non-BMP emoji counts
   * as 2).
   */
  characters: number;
  /**
   * How many billed characters fit into a single segment at the
   * current encoding/segment-count. Single-segment GSM-7 is 160 and
   * UCS-2 is 70; anything that spills into a second segment drops to
   * 153 / 67 because each part now carries a 6-byte UDH.
   */
  charactersPerSegment: number;
  /** Number of SMS segments the carrier would bill. 0 for empty input. */
  segments: number;
  /**
   * Characters of headroom before the message tips into another
   * segment. Useful for "10 chars until segment 2" hints.
   */
  remaining: number;
}

/**
 * Compute how a rendered SMS body would be billed by carriers.
 *
 * The dispatch template editor's live preview surfaces this so a
 * dispatcher who pastes a slightly-too-long message (or sneaks in a
 * non-GSM character like an em-dash or emoji) sees the segment count
 * jump immediately, instead of finding out from the next Twilio bill.
 *
 * Mirrors carrier behavior:
 *   - GSM-7: 160 chars in a single segment, 153 per segment when
 *     concatenated. Extension-table characters (`{`, `}`, `€`,
 *     `\`, `[`, `]`, `~`, `|`, `^`, form-feed) count as 2.
 *   - UCS-2: triggered by the FIRST non-GSM character. 70 chars
 *     single-segment, 67 per segment when concatenated, counted in
 *     UTF-16 code units (so a 😀 emoji counts as 2).
 *
 * Returns a zero-segment GSM-7 result for empty / non-string input
 * so callers can pass raw form state without a guard.
 */
export function countSmsSegments(text: unknown): SmsSegmentInfo {
  if (typeof text !== 'string' || text.length === 0) {
    return {
      encoding: 'GSM-7',
      characters: 0,
      charactersPerSegment: 160,
      segments: 0,
      remaining: 160,
    };
  }

  let isGsm7 = true;
  let gsmCharacters = 0;
  // Iterate by code point so a surrogate pair (e.g. an emoji)
  // registers as a single non-GSM character and trips us into UCS-2
  // mode immediately, instead of being misclassified as two unknown
  // halves.
  for (const ch of text) {
    if (GSM7_BASIC_CHARS.has(ch)) {
      gsmCharacters += 1;
    } else if (GSM7_EXTENSION_CHARS.has(ch)) {
      gsmCharacters += 2;
    } else {
      isGsm7 = false;
      break;
    }
  }

  if (isGsm7) {
    return computeSegmentInfo('GSM-7', gsmCharacters, 160, 153);
  }

  // UCS-2: carriers meter UTF-16 code units, which is exactly what
  // JavaScript's `string.length` returns. A non-BMP emoji takes 2.
  return computeSegmentInfo('UCS-2', text.length, 70, 67);
}

function computeSegmentInfo(
  encoding: SmsEncoding,
  characters: number,
  singleLimit: number,
  multiLimit: number,
): SmsSegmentInfo {
  if (characters === 0) {
    return {
      encoding,
      characters: 0,
      charactersPerSegment: singleLimit,
      segments: 0,
      remaining: singleLimit,
    };
  }
  if (characters <= singleLimit) {
    return {
      encoding,
      characters,
      charactersPerSegment: singleLimit,
      segments: 1,
      remaining: singleLimit - characters,
    };
  }
  const segments = Math.ceil(characters / multiLimit);
  return {
    encoding,
    characters,
    charactersPerSegment: multiLimit,
    segments,
    remaining: segments * multiLimit - characters,
  };
}
