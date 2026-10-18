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
 * floor schema's `substantive` verdict. callerName is trimmed and cut to the
 * column size, as the runtime does before it calls the floor.
 */
export function callerVerdict(lines: readonly string[], callerName: string | undefined): CallerVerdict {
  const callerLines = floorCallerLines(lines);
  if (callerLines.length === 0) return 'never_heard';
  const name = callerName?.trim().slice(0, FLOOR_MAX_NAME_LENGTH);
  const parsed = fileFloorInput.parse({ callId: 'call-metrics', callerLines, ...(name ? { callerName: name } : {}) });
  return parsed.substantive ? 'substantive' : 'nothing_substantive';
}
