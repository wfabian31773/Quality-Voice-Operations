// barbershop@1 through the generic composer (RT-09): the composed prompt for
// a fixture shop in English and Spanish, linted like every voice prompt, and
// naming no tool the agent doesn't have.
import { describe, expect, it } from 'vitest';
import { compose, RUNTIME_TOOL_NAMES } from '../../agent-runtime/composer';
import { findStageDirections } from '../../agent-runtime/promptLint';
import { getAction, listActions } from '../../actions';
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

/** NO-UNCHECKED-PROMISES: a test call said "back-to-back works great" after checking one slot. */
const NO_UNCHECKED_PROMISES: Record<TemplateLanguage, readonly string[]> = {
  en: [
    "Never confirm a time or an arrangement that a tool result didn't show.",
    'Two services for one person are one appointment: check and book them together.',
    'check availability for each and say it works only if the results show they fit the way the caller asked',
    // Codex P2: back-to-back means no gap; a gap is said aloud and okayed first.
    "at the same time with different barbers, or back-to-back with the second starting exactly at the first one's blockedUntil time.",
    "If the closest opening for the second leaves a gap, say both times and how long the gap is, and get the caller's okay before booking; never call it back-to-back.",
    // Codex P2: staffId 'any' gives one barber per start time, so the second check names another barber.
    'For two people at the same time, check the second with a different barber who does that service, by their staffId from the staff list, not any barber.',
    'book them one at a time: read back each one and get its own clear yes',
    "If they don't fit, say so and offer the closest times from the results.",
    "If the second can't be booked after the first is done, say plainly the first one is booked and offer the closest times for the second.",
  ],
  es: [
    'Nunca confirme una hora ni un acuerdo que el resultado de una herramienta no haya mostrado.',
    'Dos servicios para una misma persona son una sola cita: revíselos y agéndelos juntos.',
    'revise la disponibilidad de cada una y diga que se puede solo si los resultados muestran que caben como lo pidió la persona',
    'a la misma hora con barberos distintos, o seguidas, con la segunda empezando justo a la hora blockedUntil de la primera.',
    'Si la hora más cercana para la segunda deja un tiempo libre entre las dos, diga ambas horas y cuánto tiempo queda entre ellas, y espere que la persona acepte antes de agendar; nunca diga que son seguidas.',
    'Para dos personas a la misma hora, revise la segunda con otro barbero que haga ese servicio, por su staffId de la lista del personal, no con cualquier barbero.',
    'agéndelas una por una: lea los detalles de cada una y espere su propio sí claro',
    'Si no caben, dígalo y ofrezca las horas más cercanas que dieron los resultados.',
    'Si la segunda no se puede agendar después de hecha la primera, diga claramente que la primera ya quedó agendada y ofrezca las horas más cercanas para la segunda.',
  ],
};

function composeFor(language: TemplateLanguage) {
  return compose(BARBERSHOP_TEMPLATE_V1, undefined, SHOP, { language, callerIdLine: CALLER_ID_LINE });
}

/** Dotted or snake_case identifiers: how a prompt names a tool (scheduling.book.prepare, get_current_tenant_time). */
const TOOL_SHAPED = /\b[a-z][a-z0-9]+(?:[._][a-z0-9]+)+\b/g;
/** Tool-shaped words that are values, not tools (find_bookings' `needs: "name_date_time"`). */
const NOT_TOOLS = new Set([CALLER_ID_TOKEN, 'name_date_time']);

/**
 * Tool-shaped names in a prompt or tool description that the agent's tool
 * list doesn't have: by tool name, action name, or the action name without
 * its namespace (action descriptions say "check_availability").
 */
function unknownToolMentions(prompt: string, tools: readonly string[], actions: Readonly<Record<string, string>>): string[] {
  const actionNames = Object.values(actions);
  const known = new Set([...tools, ...actionNames, ...actionNames.map((a) => a.slice(a.indexOf('.') + 1))]);
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

      it('confirms nothing unchecked: several appointments are each checked, must fit as asked (same time or back-to-back), and book one at a time', () => {
        for (const line of NO_UNCHECKED_PROMISES[lang]) expect(c.prompt).toContain(line);
        expect(c.prompt).not.toMatch(lang === 'en' ? /at or after the first one's blockedUntil/ : /blockedUntil de la primera o más tarde/);
      });

      it('passes the prompt lint and the invariant phrase checks', () => {
        expect(lintIssues(c.prompt)).toEqual([]);
        expect(lintIssues(c.greeting)).toEqual([]);
      });

      it('names only tools in its own tool list', () => {
        expect(unknownToolMentions(c.prompt, c.tools.map((t) => t.name), c.contractTools.actions)).toEqual([]);
      });

      it('every composed tool\'s description names only tools in its own tool list', () => {
        const names = c.tools.map((t) => t.name);
        for (const tool of c.tools) {
          expect(unknownToolMentions(tool.description, names, c.contractTools.actions), tool.name).toEqual([]);
        }
      });
    });
  }

  it('the booking reads are agent-permitted read actions', () => {
    expect(BARBERSHOP_TEMPLATE_V1.reads).toEqual(['scheduling.list_services', 'scheduling.list_staff', 'scheduling.check_availability']);
    for (const name of BARBERSHOP_TEMPLATE_V1.reads!) {
      const def = getAction(name);
      expect(def?.kind, name).toBe('read');
      expect(def?.permissions.agent, name).toBe(true);
    }
  });

  it('the tool list is the five contracts\' actions, the booking reads and the runtime tools, no library tool', () => {
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
      'scheduling_list_services',
      'scheduling_list_staff',
      'scheduling_check_availability',
      ...RUNTIME_TOOL_NAMES,
    ]);
    expect(Object.values(c.contractTools.actions)).toEqual([
      ...CONTRACTS.flatMap((k) => (k.confirm ? [k.confirm.prepare, k.confirm.commit] : [k.action!])),
      ...BARBERSHOP_TEMPLATE_V1.reads!,
    ]);
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
    expect(unknownToolMentions('Use a time from check_availability.', names, c.contractTools.actions)).toEqual([]);
    // Without the template's reads, book.prepare's own description names a missing tool.
    const noReads = compose({ ...BARBERSHOP_TEMPLATE_V1, reads: undefined }, undefined, SHOP, { language: 'en' });
    const prepare = noReads.tools.find((t) => t.name === 'scheduling_book_prepare')!;
    expect(unknownToolMentions(prepare.description, noReads.tools.map((t) => t.name), noReads.contractTools.actions)).toEqual(['check_availability']);
    // Every registry action name is tool-shaped, so none slips past the pattern.
    for (const def of listActions()) expect(def.name.match(TOOL_SHAPED)).toEqual([def.name]);
  });
});
