/**
 * Stage-direction lint for voice prompts.
 *
 * grok-voice-3.0 can speak narration aloud when a prompt contains it (Azul
 * heard "Filing quietly" after a tool call). Prompts must give plain
 * instructions ("Call create_ticket. Do not mention the tool.") rather than
 * stage directions ("(file the ticket quietly)", "*pauses*", "[pause]").
 *
 * Rules:
 * - parenthesized or bracketed text with a narration cue, e.g. "(pause)",
 *   "[whispers]", "(file the ticket quietly)". Checked everywhere, including
 *   inside quoted lines, because a direction inside a spoken line is read out.
 * - "*...*" action text (single asterisks), checked everywhere.
 * - the words quietly, silently, sotto voce, and whisper*, checked only outside
 *   double-quoted caller-facing lines.
 */

export type StageDirectionRule = 'bracketed-narration' | 'asterisk-action' | 'narration-word';

export interface StageDirectionHit {
  rule: StageDirectionRule;
  match: string;
  index: number;
}

const REMOVABLE_CUES = String.raw`quietly|silently|softly|sotto\s+voce|whisper\w*|paus(?:e|es|ed|ing)|typing|sigh\w*|laugh\w*|chuckl\w*|smil(?:e|es|ed|ing)|nod(?:s|ded|ding)?|mutter\w*|under\s+(?:your|her|his|my)\s+breath|to\s+(?:yourself|herself|himself)|internally|off[-\s]?mic`;

const NARRATION_CUE = new RegExp(String.raw`\b(?:${REMOVABLE_CUES}|beat|aside)\b`, 'i');

// "aside" and "beat" have plain business meanings ("(aside from holidays)",
// "(we'll beat any price)"), so the strip doesn't treat them as cues.
const REMOVABLE_NARRATION_CUE = new RegExp(String.raw`\b(?:${REMOVABLE_CUES})\b`, 'i');

// "filing"/"checking" count only within the first three words of the bracket
// ("(one moment, checking the calendar)", "(now filing the ticket)"), and not
// after "or"/"and": "(hearing or filing within 24-48 hours)" in the legal
// template is content.
const LEADING_ACTIVITY_CUE = /^\s*(?:(?!(?:or|and)\b)\w+[,\s]+){0,2}(?:filing|checking)\b/i;

const NARRATION_WORD = /\b(?:quietly|silently|sotto\s+voce|whisper\w*)\b/gi;

const BRACKETED = /\(([^()\n]*)\)|\[([^[\]\n]*)\]/g;

const ASTERISK_ACTION = /(?<![*\w])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![*\w])/g;

// Straight and curly double quotes. Single quotes are left alone because
// prompts use them as apostrophes.
const DOUBLE_QUOTED = /"[^"\n]*"|“[^”\n]*”/g;

function blankQuotedSpans(text: string): string {
  return text.replace(DOUBLE_QUOTED, (span) => ' '.repeat(span.length));
}

export function findStageDirections(text: string): StageDirectionHit[] {
  const hits: StageDirectionHit[] = [];

  for (const m of text.matchAll(BRACKETED)) {
    const inner = m[1] ?? m[2] ?? '';
    if (NARRATION_CUE.test(inner) || LEADING_ACTIVITY_CUE.test(inner)) {
      hits.push({ rule: 'bracketed-narration', match: m[0], index: m.index ?? 0 });
    }
  }

  for (const m of text.matchAll(ASTERISK_ACTION)) {
    hits.push({ rule: 'asterisk-action', match: m[0], index: m.index ?? 0 });
  }

  const unquoted = blankQuotedSpans(text);
  for (const m of unquoted.matchAll(NARRATION_WORD)) {
    const index = m.index ?? 0;
    // Already reported as part of a bracketed or asterisk hit.
    if (hits.some((hit) => index >= hit.index && index < hit.index + hit.match.length)) continue;
    hits.push({ rule: 'narration-word', match: m[0], index });
  }

  return hits.sort((a, b) => a.index - b.index);
}

// Bracketed and asterisk hits are removed only when their inner text has a
// narration cue. Other asterisk spans are usually emphasis on a business fact
// ("*Closed Sundays.*"), and "aside"/"beat" are usually content.
function isRemovable(hit: StageDirectionHit): boolean {
  if (hit.rule === 'narration-word') return false;
  const inner = hit.match.slice(1, -1);
  return REMOVABLE_NARRATION_CUE.test(inner) || LEADING_ACTIVITY_CUE.test(inner);
}

/**
 * Removes bracketed and *action* spans that hold a narration cue, for prompt
 * text we don't author (tenant DB prompts). It never deletes anything else:
 * narration words such as "silently" can be real instructions ("Do not
 * silently hang up."), and other asterisk spans are emphasis, so both are only
 * reported in `hits`. `removed` counts the spans taken out. Text with no
 * removable hit is returned unchanged.
 */
export function stripStageDirections(text: string): { text: string; hits: StageDirectionHit[]; removed: number } {
  const hits = findStageDirections(text);
  const spans: Array<{ start: number; end: number }> = [];
  for (const hit of hits) {
    if (!isRemovable(hit)) continue;
    const start = hit.index;
    const end = hit.index + hit.match.length;
    const last = spans[spans.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else spans.push({ start, end });
  }
  if (spans.length === 0) return { text, hits, removed: 0 };

  let out = '';
  let cursor = 0;
  for (const span of spans) {
    const before = out + text.slice(cursor, span.start);
    const left = before.replace(/[ \t]+$/, '');
    const after = text.slice(span.end);
    const right = after.replace(/^[ \t]+/, '');
    // One space where the span sat between words; none at a line edge or
    // before punctuation.
    const hadSpace = left.length < before.length || right.length < after.length;
    const keepSpace = hadSpace && left !== '' && !left.endsWith('\n') && right !== '' && !/^[\n.,;:!?)\]]/.test(right);
    out = keepSpace ? `${left} ` : left;
    cursor = text.length - right.length;
  }
  return { text: out + text.slice(cursor), hits, removed: spans.length };
}
