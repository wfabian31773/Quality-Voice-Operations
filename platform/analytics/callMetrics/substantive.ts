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

/** Stands in for a redacted name when the caller's name isn't known: one name-like word, as most redacted names are. */
export const REDACTED_NAME_STAND_IN = 'Name';

/**
 * call_transcripts holds the caller's lines after redactPHI
 * (platform/core/phi/redact.ts; openaiSession.ts appendTranscript), but the
 * live floor judged the raw words. Each placeholder redactPHI emits is put
 * back as something the floor counts the way it counted what was redacted:
 *   [NAME_REDACTED]  → the caller's name when known (dropped, as the raw name
 *                      was), else one name word. "[NAME_REDACTED]" as is
 *                      would be two content words, so "Hi, I'm Luis" would
 *                      turn substantive.
 *   [PHONE_REDACTED] / [SSN_REDACTED] → a 10 / 9 digit token: a callback
 *                      number to the floor (hasLongNumber), as the raw one was.
 *   [DOB_REDACTED]   → a date: three number words, as any matched date was.
 */
export function unredactForFloor(line: string, callerName: string | undefined): string {
  return line
    .replace(/\[NAME_REDACTED\]/g, () => callerName || REDACTED_NAME_STAND_IN)
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
