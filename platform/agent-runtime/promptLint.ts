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

const NARRATION_CUE = /\b(?:quietly|silently|softly|sotto\s+voce|whisper\w*|paus(?:e|es|ed|ing)|beat|aside|sigh\w*|laugh\w*|chuckl\w*|smil(?:e|es|ed|ing)|nod(?:s|ded|ding)?|mutter\w*|under\s+(?:your|her|his|my)\s+breath|to\s+(?:yourself|herself|himself)|internally|off[-\s]?mic)\b/i;

// Activity cues count only when they open the bracket ("(checking the
// calendar)"); elsewhere they are content ("(hearing or filing within 24-48
// hours)" in the legal template).
const LEADING_ACTIVITY_CUE = /^\s*(?:typing|filing|checking)\b/i;

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

const REMOVABLE_RULES: ReadonlySet<StageDirectionRule> = new Set(['bracketed-narration', 'asterisk-action']);

/**
 * Removes bracketed narration and *action* spans, for prompt text we don't
 * author (tenant DB prompts). Narration words such as "silently" can be real
 * instructions ("Do not silently hang up."), so they are only reported in
 * `hits`, never removed. Text with no removable hit is returned unchanged.
 */
export function stripStageDirections(text: string): { text: string; hits: StageDirectionHit[] } {
  const hits = findStageDirections(text);
  const spans: Array<{ start: number; end: number }> = [];
  for (const hit of hits) {
    if (!REMOVABLE_RULES.has(hit.rule)) continue;
    const start = hit.index;
    const end = hit.index + hit.match.length;
    const last = spans[spans.length - 1];
    if (last && start <= last.end) last.end = Math.max(last.end, end);
    else spans.push({ start, end });
  }
  if (spans.length === 0) return { text, hits };

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
  return { text: out + text.slice(cursor), hits };
}
