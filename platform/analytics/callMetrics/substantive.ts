// Whether a call's caller was heard and said more than their own name, judged
// by the hangup floor's own rule. Nothing here re-implements it: the lines go
// through tickets.file_floor's input schema (fileFloorInput), whose transform
// sets `substantive` from saidMoreThanTheirOwnName on the raw lines and name.

import {
  FLOOR_MAX_LINE_LENGTH,
  FLOOR_MAX_LINES,
  FLOOR_MAX_NAME_LENGTH,
  fileFloorInput,
} from '../../actions/tickets/floor';

export type CallerVerdict = 'never_heard' | 'nothing_substantive' | 'substantive';

/** One name-like word, standing in for a redacted name word when the caller's name isn't known. */
export const REDACTED_NAME_STAND_IN = 'Name';

/**
 * The most words redactPHI takes as one name (its name patterns match one to
 * three words), so the most a [NAME_REDACTED] can stand for.
 */
export const REDACTED_NAME_MAX_WORDS = 3;

/**
 * call_transcripts holds the caller's lines after redactPHI
 * (platform/core/phi/redact.ts; openaiSession.ts appendTranscript), but the
 * live floor judged the raw words. Each placeholder redactPHI emits is put
 * back as something the floor counts the way it counted what was redacted:
 *   [NAME_REDACTED]  → the caller's name when known (dropped, as the raw name
 *                      was), else REDACTED_NAME_MAX_WORDS name words. The
 *                      placeholder doesn't say how many words it replaced,
 *                      and after "I'm" / "I am" that decides the verdict
 *                      ("I'm Luis": a name; "I'm Marcus Johnson": two content
 *                      words, substantive). More name words never make the
 *                      floor's verdict less substantive, so the longest name
 *                      redactPHI can take gives the most substantive verdict
 *                      any raw line could have had: a live-substantive call is
 *                      never dropped from the denominator (which would inflate
 *                      the rate). The cost: "Hi, I'm Luis" with no name known
 *                      counts as substantive (a miss in the rate) though the
 *                      floor saw only a name. After an intro the floor drops
 *                      ("this is", "my name is", …) three words still drop.
 *   [PHONE_REDACTED] / [SSN_REDACTED] → a 10 / 9 digit token: a callback
 *                      number to the floor (hasLongNumber), as the raw one was.
 *   [DOB_REDACTED]   → a date: three number words. A date redactPHI redacts
 *                      always holds a digit, which the floor never drops as
 *                      a name, so raw and stand-in both count as content.
 *                      Dates redactPHI keeps (appointment dates) arrive raw,
 *                      exactly as the floor saw them.
 */
export function unredactForFloor(line: string, callerName: string | undefined): string {
  const unknownName = Array.from({ length: REDACTED_NAME_MAX_WORDS }, () => REDACTED_NAME_STAND_IN).join(' ');
  return line
    .replace(/\[NAME_REDACTED\]/g, () => callerName || unknownName)
    .replace(/\[PHONE_REDACTED\]/g, '0000000000')
    .replace(/\[SSN_REDACTED\]/g, '000000000')
    .replace(/\[DOB_REDACTED\]/g, '00/00/0000');
}

/**
 * The caller lines in the shape the runtime hands the floor (CallerLineBuffer,
 * server/voice-gateway/services/callerLines.ts): whitespace collapsed, each
 * line cut to FLOOR_MAX_LINE_LENGTH, blank lines dropped, the latest
 * FLOOR_MAX_LINES kept.
 */
export function floorCallerLines(lines: readonly string[]): string[] {
  const kept = lines.map((text) => text.replace(/\s+/g, ' ').trim().slice(0, FLOOR_MAX_LINE_LENGTH)).filter(Boolean);
  return kept.slice(Math.max(0, kept.length - FLOOR_MAX_LINES));
}

/**
 * never_heard when no caller line is left (the floor's first rule); else the
 * floor schema's `substantive` verdict. Lines may be stored (redacted) or raw;
 * placeholders are put back first (unredactForFloor). callerName is trimmed
 * and cut to the column size, as the runtime does before it calls the floor.
 */
export function callerVerdict(lines: readonly string[], callerName: string | undefined): CallerVerdict {
  const name = callerName?.trim().slice(0, FLOOR_MAX_NAME_LENGTH);
  const callerLines = floorCallerLines(lines.map((line) => unredactForFloor(line, name)));
  if (callerLines.length === 0) return 'never_heard';
  const parsed = fileFloorInput.parse({ callId: 'call-metrics', callerLines, ...(name ? { callerName: name } : {}) });
  return parsed.substantive ? 'substantive' : 'nothing_substantive';
}
