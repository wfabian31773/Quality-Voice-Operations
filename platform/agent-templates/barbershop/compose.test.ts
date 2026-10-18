// barbershop@1 through the generic composer (RT-09): the composed prompt for
// a fixture shop in English and Spanish, linted like every voice prompt, and
// naming no tool the agent doesn't have.
import { describe, expect, it } from 'vitest';
import { compose, RUNTIME_TOOL_NAMES } from '../../agent-runtime/composer';
import { findStageDirections } from '../../agent-runtime/promptLint';
import { listActions } from '../../actions';
import { CONTRACTS } from '../../callcore/contracts';
import { findRefs, normalizeSpeech, STAGE_DIRECTION_PATTERNS, STAGE_DIRECTION_WORDS } from '../../callcore/invariants';
import { CALLER_ID_TOKEN } from '../../reasoning/sessionBinding';
import { TOOL_LIBRARY_NAMES } from '../../tools/library/catalog';
import { buildCallerIdPromptLine } from '../salon';
import { BARBERSHOP_TEMPLATE_V1, TEMPLATE_LANGUAGES, type TemplateLanguage } from './index';

const SHOP = {
  businessName: 'Sharp Line Barbers',
  businessDetails: [
    'Services: men\'s cut $30, 30 minutes; beard trim $15, 15 minutes; cut and beard $40.',
    'Barbers: Marco, Dee and Luis.',
    'Hours: Tuesday to Saturday, 9 AM to 7 PM. Closed Sunday and Monday.',
    'Address: 412 Main Street, next to the bakery.',
  ].join('\n'),
};
const CALLER_ID_LINE = buildCallerIdPromptLine('+15555550142');

function composeFor(language: TemplateLanguage) {
  return compose(BARBERSHOP_TEMPLATE_V1, undefined, SHOP, { language, callerIdLine: CALLER_ID_LINE });
}

/** Dotted or snake_case identifiers: how a prompt names a tool (scheduling.book.prepare, get_current_tenant_time). */
const TOOL_SHAPED = /\b[a-z][a-z0-9]+(?:[._][a-z0-9]+)+\b/g;
/** Tool-shaped words that are values, not tools. */
const NOT_TOOLS = new Set([CALLER_ID_TOKEN]);

/** Tool-shaped names in a prompt that the agent's tool list doesn't have (by tool name or its action name). */
function unknownToolMentions(prompt: string, tools: readonly string[], actions: Readonly<Record<string, string>>): string[] {
  const known = new Set([...tools, ...Object.values(actions)]);
  return [...new Set(prompt.match(TOOL_SHAPED) ?? [])].filter((name) => !NOT_TOOLS.has(name) && !known.has(name));
}

const REF_PHRASING: readonly RegExp[] = [
  /\byour\s+(?:confirmation|reference|ref|booking|appointment|ticket)\s+(?:number|code|id)\b/i,
  /\b(?:confirmation|reference|booking|appointment|ticket)\s+(?:number|code|id)\s+(?:is|will be)\b/i,
  /\b(?:su|tu)\s+(?:número|codigo|código)\s+de\s+(?:confirmación|reserva|referencia|cita|ticket)\b/i,
  /\b(?:número|código)\s+de\s+(?:confirmación|reserva|referencia|cita|ticket)\s+es\b/i,
];

/**
 * promptLint, the SAY stage-direction words and patterns, and ref checks. The
 * caller-ID line is the runtime's shared one (salon path too): it quotes a
 * spoken example in parentheses, which promptLint accepts in a prompt but the
 * SAY pattern (meant for speech) would flag, so only that pattern skips it.
 */
function lintIssues(text: string): string[] {
  const issues = findStageDirections(text).map((h) => `${h.rule}: ${h.match}`);
  const authored = CALLER_ID_LINE ? text.replace(CALLER_ID_LINE, '') : text;
  for (const re of STAGE_DIRECTION_PATTERNS) {
    const m = authored.match(re);
    if (m) issues.push(`pattern: ${m[0]}`);
  }
  const norm = ` ${normalizeSpeech(text)} `;
  for (const w of STAGE_DIRECTION_WORDS.map(normalizeSpeech)) if (norm.includes(` ${w} `)) issues.push(`word: ${w}`);
  issues.push(...findRefs(text).map((r) => `ref: ${r}`));
  issues.push(...REF_PHRASING.filter((re) => re.test(text)).map((re) => `ref phrasing: ${re}`));
  return issues;
}

describe('barbershop@1 composed for a fixture shop', () => {
  for (const lang of TEMPLATE_LANGUAGES) {
    describe(lang, () => {
      const c = composeFor(lang);

      it('prompt snapshot: persona, tool rules, shop facts, caller ID', () => {
        expect(c.prompt).toMatchSnapshot();
      });

      it('has the persona in the call language, the shop facts and the caller-ID line', () => {
        expect(c.prompt.startsWith(BARBERSHOP_TEMPLATE_V1.persona[lang])).toBe(true);
        expect(c.prompt).toContain('Sharp Line Barbers');
        expect(c.prompt).toContain(SHOP.businessDetails);
        expect(c.prompt).toContain(CALLER_ID_LINE);
        expect(CALLER_ID_LINE).toContain('ending in 0142');
      });

      it('passes the prompt lint and the invariant phrase checks', () => {
        expect(lintIssues(c.prompt)).toEqual([]);
        expect(lintIssues(c.greeting)).toEqual([]);
      });

      it('names only tools in its own tool list', () => {
        expect(unknownToolMentions(c.prompt, c.tools.map((t) => t.name), c.contractTools.actions)).toEqual([]);
      });
    });
  }

  it('the tool list is the five contracts\' actions plus the runtime tools, no library tool', () => {
    const c = composeFor('en');
    expect(c.tools.map((t) => t.name)).toEqual([
      'scheduling_book_prepare',
      'scheduling_book_commit',
      'scheduling_find_bookings',
      'scheduling_reschedule_prepare',
      'scheduling_reschedule_commit',
      'scheduling_cancel_prepare',
      'scheduling_cancel_commit',
      'tickets_open_prepare',
      'tickets_open_commit',
      ...RUNTIME_TOOL_NAMES,
    ]);
    expect(Object.values(c.contractTools.actions)).toEqual(
      CONTRACTS.flatMap((k) => (k.confirm ? [k.confirm.prepare, k.confirm.commit] : [k.action!])),
    );
    const library = TOOL_LIBRARY_NAMES.filter((n) => !(RUNTIME_TOOL_NAMES as readonly string[]).includes(n));
    expect(c.tools.filter((t) => library.includes(t.name))).toEqual([]);
  });

  it('every askId of its contracts is phrased in the binding', () => {
    const askIds = CONTRACTS.flatMap((k) => k.slots.map((s) => s.askId));
    expect(Object.keys(composeFor('en').contractTools.asks).sort()).toEqual([...new Set(askIds)].sort());
  });

  it('the tool-mention check catches a tool the agent does not have', () => {
    const c = composeFor('en');
    const names = c.tools.map((t) => t.name);
    expect(unknownToolMentions('For hours, call business.get_info.', names, c.contractTools.actions)).toEqual(['business.get_info']);
    expect(unknownToolMentions('Use create_booking.', names, c.contractTools.actions)).toEqual(['create_booking']);
    expect(unknownToolMentions('Call scheduling.book.prepare, then get_current_tenant_time.', names, c.contractTools.actions)).toEqual([]);
    // Every registry action name is tool-shaped, so none slips past the pattern.
    for (const def of listActions()) expect(def.name.match(TOOL_SHAPED)).toEqual([def.name]);
  });
});
