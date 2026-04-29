/**
 * Carrier-accurate SMS segment counting.
 *
 * Originally lived alongside the dispatch merge tokens (task #824),
 * but the same risk — a non-GSM character or a paste that tips the
 * body over 160 chars silently doubles the next Twilio bill — applies
 * everywhere the product composes outbound SMS. Moved into
 * `shared/sms/` so the dispatch template editor and the SMS-inbox
 * composer can share one source of truth without one importing from
 * the other's domain folder.
 *
 * `shared/dispatch/mergeTokens.ts` re-exports {@link countSmsSegments},
 * {@link SmsEncoding}, and {@link SmsSegmentInfo} for backward
 * compatibility; new callers should import from this module directly.
 */

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
// characters. This is what catches operators who paste a curly brace
// or a Euro sign and don't realize their 159-char message suddenly
// costs 2 segments.
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
 * Surfaces this so a user who pastes a slightly-too-long message (or
 * sneaks in a non-GSM character like an em-dash or emoji) sees the
 * segment count jump immediately, instead of finding out from the
 * next Twilio bill.
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
