// Whether a caller said anything beyond their own name, greetings and filler.
// Modeled on Azul's saidMoreThanTheirOwnIdentity (src/runtime/requestSweep.ts).
// It is deliberately narrow: it never tries to tell what the caller wanted,
// because a floor that needs a captured intent skips the calls it exists for.

/** Multi-word fillers, removed as whole token runs before single tokens. */
export const FILLER_PHRASES: readonly string[] = [
  'my name is',
  'this is',
  'i am',
  'thank you',
  'good morning',
  'good afternoon',
  'me llamo',
  'mi nombre es',
  'buenos dias',
  'buenas tardes',
  'buenas noches',
];

/** Single-token greetings and filler (EN/ES), after normalization ("sí" → "si", "it's" → "its", "I'm" → "im"). */
export const FILLER_WORDS: ReadonlySet<string> = new Set([
  'hi',
  'hello',
  'hey',
  'yes',
  'yeah',
  'yep',
  'no',
  'ok',
  'okay',
  'uh',
  'um',
  'hmm',
  'thanks',
  'bye',
  'its',
  'im',
  'here',
  'speaking',
  'hola',
  'si',
  'bueno',
  'gracias',
  'adios',
  'soy',
  'habla',
]);

/** Content words needed, across all lines, to count as more than a name. */
export const MIN_CONTENT_WORDS = 2;

/** Lowercase, fold diacritics, drop apostrophes (' ’ ‘ ʼ), and split on everything that isn't a letter or digit. */
export function normalizeTokens(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/['’‘ʼ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

const PHRASE_TOKENS = FILLER_PHRASES.map(normalizeTokens);

function withoutPhrases(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    const phrase = PHRASE_TOKENS.find((p) => p.every((word, j) => tokens[i + j] === word));
    if (phrase) {
      i += phrase.length;
      continue;
    }
    out.push(tokens[i]);
    i += 1;
  }
  return out;
}

/**
 * Self-introductions (EN/ES) that may be followed by the caller's name at the end of a line.
 * "it's" and "I'm" are left out: "I'm running late today" or "It's urgent, call me" is a request, not a name.
 */
export const INTRO_PHRASES: readonly string[] = [
  'my name is',
  'this is',
  'mi nombre es',
  'me llamo',
  'le habla',
  'habla',
  'soy',
];

/** Most tokens taken as a name after an intro phrase. */
export const MAX_INTRO_NAME_TOKENS = 3;

/** Common words that are never part of a name, so "this is about my booking" is not read as an introduction. */
const NOT_NAME_WORDS: ReadonlySet<string> = new Set([
  'about', 'my', 'your', 'our', 'the', 'a', 'an', 'for', 'to', 'on', 'at', 'in', 'not', 'just', 'so', 'calling', 'regarding',
  'mi', 'su', 'el', 'la', 'los', 'las', 'un', 'una', 'para', 'por', 'sobre', 'de', 'del', 'con', 'que',
]);

const INTRO_TOKENS = INTRO_PHRASES.map(normalizeTokens);

const isNameToken = (token: string) => !NOT_NAME_WORDS.has(token) && !/\d/.test(token);

/** A name token, or a single-letter middle initial ("Luis A. Garcia"), even "a". */
const isNameTokenAt = (name: string[], j: number) =>
  isNameToken(name[j]) || (name[j].length === 1 && j > 0 && j < name.length - 1);

/** Drops an intro phrase and the name after it when 1–3 name-like tokens end the line ("Hi, this is Luis Garcia"). */
function withoutIntroducedName(tokens: string[]): string[] {
  for (let i = 0; i < tokens.length; i += 1) {
    const intro = INTRO_TOKENS.find((p) => p.every((word, j) => tokens[i + j] === word));
    if (!intro) continue;
    const name = tokens.slice(i + intro.length);
    if (name.length >= 1 && name.length <= MAX_INTRO_NAME_TOKENS && name.every((_, j) => isNameTokenAt(name, j))) {
      return tokens.slice(0, i);
    }
  }
  return tokens;
}

/**
 * Punctuation that ends a clause, including dashes, "…" and a spaced hyphen ("Garcia-Lopez" stays whole).
 * A name never crosses it, so "This is Luis, cancel Friday" keeps "cancel friday".
 */
const CLAUSE_BREAK = /[,;:.!?¿¡…–—]+|\s-+\s/;

/** A title or a single-letter initial whose period is part of the name ("Dr. Patel", "Luis A. Garcia"). */
const NAME_ABBREVIATION = /(?<![\p{L}\p{N}])(mr|mrs|ms|dr|sr|sra|srta|\p{L})\./giu;

/** The words left once the caller's name, greetings and filler are removed. */
export function contentWords(lines: readonly string[], callerName?: string): string[] {
  const nameTokens = new Set(callerName ? normalizeTokens(callerName) : []);
  return lines
    .flatMap((line) => {
      const clauses = line
        .replace(NAME_ABBREVIATION, '$1')
        .split(CLAUSE_BREAK)
        .map(normalizeTokens)
        .filter((tokens) => tokens.length > 0);
      let last = clauses.length - 1;
      // A closing "thanks" / "gracias" / "bye" doesn't end the introduction.
      while (last > 0 && withoutPhrases(clauses[last]).every((t) => FILLER_WORDS.has(t))) last -= 1;
      // Only that clause can end in an introduced name; the others lose filler phrases only.
      return clauses.flatMap((c, k) => withoutPhrases(k === last ? withoutIntroducedName(c) : c));
    })
    .filter((token) => !FILLER_WORDS.has(token) && !nameTokens.has(token));
}

/** Digits a whitespace-separated token must hold to count as a callback number on its own. */
export const MIN_NUMBER_DIGITS = 7;

const digitCount = (text: string) => text.match(/\d/g)?.length ?? 0;

/** True when a token holding 7+ digits appears ("5552013344", "+15552013344"). */
export function hasLongNumber(lines: readonly string[]): boolean {
  return lines.some((line) => line.split(/\s+/).some((token) => digitCount(token) >= MIN_NUMBER_DIGITS));
}

/** Digit groups joined only by spaces, dashes, dots or parentheses ("555 201 3344", "(555) 201-3344"). */
const DIGIT_RUN = /\+?\d[\d\s().-]*/g;

/**
 * hasLongNumber, or 7+ digits read out in groups ("555 201 3344"). Only the
 * answered-info rule uses it: there a grouped number keeps the ticket, while
 * the name rule (and the substantive metric that mirrors it) stays unchanged.
 */
export function hasCallbackNumber(lines: readonly string[]): boolean {
  return (
    hasLongNumber(lines) ||
    lines.some((line) => [...line.matchAll(DIGIT_RUN)].some(([run]) => digitCount(run) >= MIN_NUMBER_DIGITS))
  );
}

/** True when the caller gave a callback number, or at least MIN_CONTENT_WORDS content words remain across all lines. */
export function saidMoreThanTheirOwnName(lines: readonly string[], callerName?: string): boolean {
  return hasLongNumber(lines) || contentWords(lines, callerName).length >= MIN_CONTENT_WORDS;
}

/**
 * Tools that only answer an information question (hours, staff days,
 * services, prices, location) or keep runtime bookkeeping. An availability
 * check, a booking lookup or any write is not here: it means a booking or
 * change was started, so the floor still files. record_call_outcome is not
 * here either: its disposition can be callback_requested, follow_up_needed or
 * escalated, and the floor only sees the tool name.
 */
export const INFO_TOOLS: ReadonlySet<string> = new Set([
  'scheduling.list_staff',
  'scheduling.list_services',
  'retrieve_knowledge',
  'get_current_tenant_time',
  'record_language_change',
]);

// ---------------------------------------------------------------------------
// answeredInfoOnly: conservative by default. A call is skipped only when every
// substantive caller clause is a short information question about the shop.
// Anything else (a statement, a request, a complaint, a long or personal
// question) files. Word lists here only ever widen what files, never what skips.
// ---------------------------------------------------------------------------

/** Caller words (EN/ES) a clause needs to be an information question: hours, staff days, prices, services, location. */
export const INFO_WORDS: ReadonlySet<string> = new Set([
  'hours', 'hour', 'open', 'opens', 'close', 'closes', 'closed', 'closing', 'days', 'work', 'works', 'working',
  'price', 'prices', 'pricing', 'cost', 'costs', 'much', 'charge', 'services', 'service', 'offer', 'where',
  'address', 'located', 'location', 'directions', 'parking',
  'horario', 'horarios', 'abren', 'abre', 'abierto', 'cierran', 'cierra', 'dias', 'trabaja', 'trabajan', 'precio',
  'precios', 'cuesta', 'cuanto', 'cobran', 'servicio', 'servicios', 'ofrecen', 'donde', 'direccion', 'ubicados',
]);

/** Words that open a question (EN/ES, normalized: "qué" → "que", "están" → "estan", "what's" → "whats"). */
const QUESTION_STARTS: ReadonlySet<string> = new Set([
  'what', 'whats', 'when', 'whens', 'where', 'wheres', 'which', 'how', 'hows', 'who', 'whos',
  'do', 'does', 'are', 'is', 'can', 'could',
  'que', 'cuando', 'donde', 'cual', 'cuanto', 'cuanta', 'tienen', 'hay', 'abren', 'estan',
]);
const QUESTION_START_PHRASES: readonly string[] = ['a que hora'];

/** Most tokens an information question may hold; a longer clause is more than a quick question. */
export const MAX_INFO_QUESTION_TOKENS = 12;

/**
 * A small core of request words (EN/ES): a booking or change, a callback, a
 * message, a want or need. Inflections come from ACTION_PREFIXES.
 */
export const ACTION_WORDS: ReadonlySet<string> = new Set([
  'move', 'callback', 'call', 'message', 'want', 'wants', 'wanted', 'wanna', 'need', 'needs', 'needed',
  'available', 'availability', 'come', 'came', 'tech', 'techs', 'technician', 'technicians', 'plumber', 'plumbers',
  'quiero', 'quiere', 'queremos', 'quisiera', 'necesito', 'necesita', 'necesitamos', 'mensaje', 'recado',
  'venir', 'vengan', 'venga', 'mandar', 'manden', 'mande', 'arreglar', 'reparar',
]);
/**
 * Stems: book/booking, appointment, schedule/scheduling, reschedule, cancel/cancelled, reserv*, cita, agendar, llam*, disponib*,
 * and dispatch verbs: coming, send/sending, fix/fixing, repair, arregl*, repar*.
 */
export const ACTION_PREFIXES: readonly string[] = [
  'book', 'appoint', 'appt', 'schedul', 'resched', 'cancel', 'reserv', 'cit', 'agend', 'llam', 'disponib',
  'coming', 'send', 'fix', 'repair', 'arregl', 'repar',
];
export const ACTION_PHRASES: readonly string[] = [
  'call me back', 'would like', 'id like', 'me gustaria', 'anything open', 'how long', 'how much longer', 'cuanto falta',
];

/**
 * First-person words (EN/ES). An information question is about the shop, not
 * the caller ("Why did you charge me?", "Where is my tech?", "Can you fit me
 * in?"), so a clause holding one files. "were" is left out ("we're" folds to it).
 */
const FIRST_PERSON: ReadonlySet<string> = new Set([
  'i', 'me', 'my', 'mine', 'myself', 'im', 'ive', 'id', 'ill', 'we', 'us', 'our', 'ours',
  'yo', 'mi', 'mis', 'nos', 'nosotros', 'nuestro', 'nuestra',
]);

/** "why" / "por qué" asks for an explanation (a complaint), never for shop info. */
const WHY_WORDS: ReadonlySet<string> = new Set(['why', 'porque']);

/** Weekdays and relative days (EN/ES). "mañana" is "manana" after normalization. */
export const DAY_WORDS: ReadonlySet<string> = new Set([
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'mondays', 'tuesdays', 'wednesdays', 'thursdays', 'fridays', 'saturdays', 'sundays', 'tomorrow', 'tonight', 'today',
  'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'sabados', 'domingo', 'domingos', 'manana', 'hoy',
]);

/** Multi-word relative days (EN/ES), treated like DAY_WORDS. */
export const DAY_PHRASES: readonly string[] = [
  'this morning', 'this afternoon', 'this evening', 'this weekend', 'next week',
  'esta tarde', 'esta noche', 'este fin de semana', 'la proxima semana',
];

/**
 * Words that make a clause a question about when the shop or a stylist works
 * ("what are your hours on Saturday", "does Marco work Fridays"). A day word
 * in such a clause is part of the question, not a requested time.
 */
const SCHEDULE_QUESTION_WORDS: ReadonlySet<string> = new Set([
  'hours', 'hour', 'open', 'opens', 'close', 'closes', 'closed', 'closing', 'days', 'work', 'works', 'working',
  'horario', 'horarios', 'abren', 'abre', 'abierto', 'cierran', 'cierra', 'dias', 'trabaja', 'trabajan',
]);

/** "work" / "open" used as a job verb when followed by one of these ("work on the furnace", "open the garage door"). */
const JOB_VERBS: ReadonlySet<string> = new Set(['work', 'works', 'working', 'open']);
const JOB_OBJECT_STARTS: ReadonlySet<string> = new Set(['on', 'the', 'a', 'an', 'my']);

/** A clause about sending someone out ("can someone come out today"), so a day in it is a requested time. */
const DISPATCH_WORDS: ReadonlySet<string> = new Set([
  'someone', 'somebody', 'anyone', 'anybody', 'tech', 'techs', 'technician', 'technicians', 'alguien',
]);

/**
 * A day is part of an hours / staff-days question only when the clause has a
 * schedule word, no schedule word is used as a job verb, and nobody is being
 * sent out. Unsure cases keep the day, so they file.
 */
const isScheduleQuestion = (tokens: readonly string[]): boolean =>
  tokens.some((token) => SCHEDULE_QUESTION_WORDS.has(token)) &&
  !tokens.some((token, i) => DISPATCH_WORDS.has(token) || (JOB_VERBS.has(token) && JOB_OBJECT_STARTS.has(tokens[i + 1] ?? '')));

/** True when the phrase appears as a whole token run in the clause. */
const hasPhrase = (tokens: readonly string[], phrase: string): boolean => ` ${tokens.join(' ')} `.includes(` ${phrase} `);

/**
 * "me llamo" / "se llamo" / "se llama" (my name is, is called) introduce a
 * name; they don't ask for a call. "me llama" is "call me", so it stays a request.
 */
const isNamingLlam = (token: string, before: string | undefined): boolean =>
  (token === 'llamo' && (before === 'me' || before === 'se')) || (token === 'llama' && before === 'se');

const isActionToken = (tokens: readonly string[], i: number): boolean => {
  const token = tokens[i];
  if (ACTION_WORDS.has(token)) return true;
  if (isNamingLlam(token, tokens[i - 1])) return false;
  return ACTION_PREFIXES.some((prefix) => token.startsWith(prefix));
};

/** "a.m." / "p.m.", folded to "am" / "pm" before clauses split on periods. */
const MERIDIEM = /(?<![\p{L}\p{N}])([ap])\.\s?m\b\.?/giu;

/** A clock time: "3pm", "3 p.m." (after MERIDIEM), "at 3", "a las 4", "para las 4", "a la una". */
const isTimeAt = (tokens: readonly string[], i: number): boolean => {
  const token = tokens[i];
  const next = tokens[i + 1] ?? '';
  if (/^\d+(am|pm)$/.test(token)) return true;
  if (/^\d/.test(token) && /^(am|pm)$/.test(next)) return true;
  if (token === 'at' && /^\d/.test(next)) return true;
  return (token === 'a' || token === 'para') && (next === 'las' || (next === 'la' && tokens[i + 2] === 'una'));
};

/**
 * An action or request signal: a core action word, stem or phrase, a clock
 * time, or a day. A day in an hours / staff-days question is part of the
 * question ("what time do you close today"), not a requested time
 * ("can someone work on the furnace today").
 */
function asksForAction(tokens: readonly string[]): boolean {
  if (ACTION_PHRASES.some((phrase) => hasPhrase(tokens, phrase))) return true;
  const ignoreDay = isScheduleQuestion(tokens);
  if (!ignoreDay && DAY_PHRASES.some((phrase) => hasPhrase(tokens, phrase))) return true;
  return tokens.some((token, i) => isActionToken(tokens, i) || isTimeAt(tokens, i) || (!ignoreDay && DAY_WORDS.has(token)));
}

/** A clause left with words once filler and an introduced name are removed. */
const isContentClause = (tokens: string[]): boolean =>
  withoutPhrases(withoutIntroducedName(tokens)).some((token) => !FILLER_WORDS.has(token));

/** A '?' closes the clause, a '¿' opens it, or (leading filler aside) it starts with a question word. */
function hasQuestionForm(tokens: readonly string[], asked: boolean): boolean {
  if (asked) return true;
  const start = tokens.findIndex((token) => !FILLER_WORDS.has(token));
  const rest = start < 0 ? [] : tokens.slice(start);
  return QUESTION_STARTS.has(rest[0]) || QUESTION_START_PHRASES.some((phrase) => `${rest.join(' ')} `.startsWith(`${phrase} `));
}

/**
 * A short information question about the shop: question form, an INFO_WORDS
 * word, at most MAX_INFO_QUESTION_TOKENS tokens, and no action signal, no
 * first-person word and no "why".
 */
export function isInfoQuestion(tokens: readonly string[], asked: boolean): boolean {
  return (
    hasQuestionForm(tokens, asked) &&
    tokens.length <= MAX_INFO_QUESTION_TOKENS &&
    tokens.some((token) => INFO_WORDS.has(token)) &&
    !tokens.some((token) => FIRST_PERSON.has(token) || WHY_WORDS.has(token)) &&
    !hasPhrase(tokens, 'por que') &&
    !asksForAction(tokens)
  );
}

const CLAUSE_BREAK_KEPT = new RegExp(`(${CLAUSE_BREAK.source})`);

/** A line's clauses, each with whether a '¿' opens it or a '?' closes it. */
function lineClauses(line: string): Array<{ tokens: string[]; asked: boolean }> {
  const parts = line.replace(MERIDIEM, '$1m').split(CLAUSE_BREAK_KEPT);
  const out: Array<{ tokens: string[]; asked: boolean }> = [];
  for (let k = 0; k < parts.length; k += 2) {
    out.push({ tokens: normalizeTokens(parts[k]), asked: (parts[k - 1] ?? '').includes('¿') || (parts[k + 1] ?? '').includes('?') });
  }
  return out;
}

/** What the runtime saw on the call, beside the caller's lines. */
export interface FloorCallSignals {
  /** How the call ended (callOutcome.ts); only 'caller_hangup' can skip the floor. */
  endReason?: string;
  /** Every tool run on the call, by action name, with whether it returned ok (a blocked run is not ok). */
  tools?: ReadonlyArray<{ name: string; ok: boolean }>;
  /** The agent gave a real answer (not a question or a holding line) after the caller's last line and any tool. */
  answered?: boolean;
}

/**
 * A pure information call that was answered, so the floor files nothing.
 * Conservative: every condition must hold, and a missing signal fails it.
 * - the caller ended the call (endReason 'caller_hangup');
 * - the agent gave a real answer after the caller's last line (answered);
 * - every tool that ran is in INFO_TOOLS and returned ok (none is fine);
 * - the caller gave no callback number;
 * - every substantive caller clause is a short info question (isInfoQuestion),
 *   so any statement ("My car was damaged in your parking lot") files.
 */
export function answeredInfoOnly(lines: readonly string[], signals: FloorCallSignals): boolean {
  if (signals.endReason !== 'caller_hangup' || signals.answered !== true || !signals.tools) return false;
  if (!signals.tools.every((tool) => tool.ok && INFO_TOOLS.has(tool.name))) return false;
  if (hasCallbackNumber(lines)) return false;
  const contentClauses = lines.flatMap(lineClauses).filter(({ tokens }) => isContentClause(tokens));
  return contentClauses.length > 0 && contentClauses.every(({ tokens, asked }) => isInfoQuestion(tokens, asked));
}
