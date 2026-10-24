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

/**
 * Caller words (EN/ES) that start, or ask for, something the shop has to act
 * on: a booking or change, a callback, a person, a message, a complaint.
 * Any one of them keeps the floor ticket. "Calling" is left out ("I'm calling
 * to ask your hours"); "call" is in ("call me back").
 */
export const ACTION_WORDS: ReadonlySet<string> = new Set([
  'book', 'booking', 'booked', 'appointment', 'appointments', 'appt', 'schedule', 'reschedule', 'cancel',
  'cancellation', 'reserve', 'reservation', 'available', 'availability', 'opening', 'openings', 'spot', 'slot',
  'move', 'change', 'want', 'need', 'come', 'walk', 'fit', 'squeeze',
  'call', 'callback', 'person', 'human', 'someone', 'somebody', 'manager', 'owner', 'speak', 'talk', 'message',
  'problem', 'complaint', 'refund', 'wrong', 'late', 'urgent', 'emergency',
  'cita', 'citas', 'reservar', 'agendar', 'apartar', 'cancelar', 'cambiar', 'mover', 'disponible', 'quiero',
  'necesito', 'llamar', 'llamen', 'llame', 'persona', 'alguien', 'gerente', 'dueno', 'hablar', 'mensaje', 'recado',
  'problema', 'queja', 'reembolso', 'urgente',
  'free', 'like', 'get', 'put', 'hold', 'waitlist',
  'llamenme', 'llamada', 'devuelvan', 'regresen', 'disponibilidad', 'reserva', 'reservacion', 'quisiera', 'gustaria',
  'turno', 'espacio',
  'take', 'cut', 'sign', 'see', 'atender', 'atienden', 'atiende', 'pasar', 'ir', 'venir', 'cortar',
  'wants', 'needs', 'wanted', 'needed', 'wanna', 'room', 'space',
  'quiere', 'quieren', 'queremos', 'necesita', 'necesitan', 'necesitamos', 'lugar', 'hueco',
  'coming', 'stopping', 'drop', 'swing',
  'broken', 'broke', 'leak', 'leaking', 'stopped', 'overcharged', 'twice', 'waiting', 'waited', 'never', 'terrible',
  'funciona', 'roto', 'rota', 'descompuesto', 'esperando',
]);

/**
 * Booking phrases built on info words ("work", "open"), so they count even in
 * an hours question: "can you work me in today", "anything open tomorrow".
 */
export const ACTION_PHRASES: readonly string[] = [
  'work me in', 'fit me in', 'squeeze me in', 'anything open', 'anything available', 'algo disponible',
  'where is my', 'wheres my', 'donde esta mi',
];

/** Subjects and modals before "do" when it is a verb ("can she do my nails"), not an auxiliary ("what do you charge"). */
const DO_SUBJECTS: ReadonlySet<string> = new Set(['i', 'you', 'he', 'she', 'they', 'we', 'can', 'could', 'would', 'will']);

/** "can he", "could you", "will they": with "puede" / "puedo" / "podría", the shape of a request. */
const REQUEST_MODALS: ReadonlySet<string> = new Set(['can', 'could', 'would', 'will']);
const REQUEST_SUBJECTS: ReadonlySet<string> = new Set(['i', 'you', 'he', 'she', 'they', 'we']);
const SPANISH_REQUEST_WORDS: ReadonlySet<string> = new Set(['puede', 'pueden', 'puedo', 'podria', 'podrian']);

/**
 * A clause shaped like a request ("Can he take me?", "¿Me puede atender?",
 * "¿Puedo pasar?") with no info word, so "can you tell me your hours" stays
 * an info question.
 */
function isRequestShaped(tokens: readonly string[]): boolean {
  if (tokens.some((token) => INFO_WORDS.has(token))) return false;
  return tokens.some(
    (token, i) => SPANISH_REQUEST_WORDS.has(token) || (REQUEST_MODALS.has(token) && REQUEST_SUBJECTS.has(tokens[i + 1])),
  );
}

/**
 * Word stems (EN/ES) for the same families, so inflections count too
 * ("llámenme", "reservación", "disponibilidad", "cancelled", "agendarme",
 * "scheduling"). "cit" also takes "city", which only files a ticket.
 */
export const ACTION_PREFIXES: readonly string[] = [
  'llam', 'reserv', 'disponib', 'cancel', 'agend', 'cit', 'book', 'appoint', 'schedul', 'resched',
];

/**
 * "me llamo" / "se llamo" / "se llama" (my name is, is called) introduce a
 * name; they don't ask for a call. "me llama" is "call me", so it stays a request.
 */
const isNamingLlam = (token: string, before: string | undefined): boolean =>
  (token === 'llamo' && (before === 'me' || before === 'se')) || (token === 'llama' && before === 'se');

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

/** True when the phrase appears as a whole token run in the clause. */
const hasPhrase = (tokens: readonly string[], phrase: string): boolean => ` ${tokens.join(' ')} `.includes(` ${phrase} `);

/**
 * Words that make a clause a question about when the shop or a stylist works
 * ("what are your hours on Saturday", "does Marco work Fridays"). A day word
 * in such a clause is part of the question, not a requested time.
 */
const SCHEDULE_QUESTION_WORDS: ReadonlySet<string> = new Set([
  'hours', 'hour', 'open', 'opens', 'close', 'closes', 'closed', 'closing', 'days', 'work', 'works', 'working',
  'horario', 'horarios', 'abren', 'abre', 'abierto', 'cierran', 'cierra', 'dias', 'trabaja', 'trabajan',
]);

const isActionToken = (tokens: readonly string[], i: number): boolean => {
  const token = tokens[i];
  // "a cut" / "the cut" is the service asked about ("how much for a cut"), not "cut my hair".
  if (token === 'cut' && (tokens[i - 1] === 'a' || tokens[i - 1] === 'the')) return false;
  if (ACTION_WORDS.has(token)) return true;
  if (token === 'do') return DO_SUBJECTS.has(tokens[i - 1]);
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
 * True when a clause asks for something the shop has to act on: an action
 * word, stem or phrase, a request shape, a clock time, or a day. Info-only
 * callers rarely name a day or a time, so either keeps the ticket. A day in an
 * hours / staff-days question is ignored ("are you open today" skips like
 * "what time do you close today"); answeredInfoOnly only gets here when every
 * content clause of the call is an info question.
 */
function asksForAction(tokens: readonly string[]): boolean {
  if (isRequestShaped(tokens) || ACTION_PHRASES.some((phrase) => hasPhrase(tokens, phrase))) return true;
  const ignoreDay = tokens.some((token) => SCHEDULE_QUESTION_WORDS.has(token));
  if (!ignoreDay && DAY_PHRASES.some((phrase) => hasPhrase(tokens, phrase))) return true;
  return tokens.some(
    (token, i) => isActionToken(tokens, i) || isTimeAt(tokens, i) || (!ignoreDay && DAY_WORDS.has(token)),
  );
}

/** A clause left with words once filler and an introduced name are removed. */
const isContentClause = (tokens: string[]): boolean =>
  withoutPhrases(withoutIntroducedName(tokens)).some((token) => !FILLER_WORDS.has(token));

/** Caller words (EN/ES) that make a line an information question: hours, staff days, prices, services, location. */
export const INFO_WORDS: ReadonlySet<string> = new Set([
  'hours', 'hour', 'open', 'opens', 'close', 'closes', 'closed', 'closing', 'days', 'work', 'works', 'working',
  'price', 'prices', 'pricing', 'cost', 'costs', 'much', 'charge', 'services', 'service', 'offer', 'where',
  'address', 'located', 'location', 'directions', 'parking',
  'horario', 'horarios', 'abren', 'abre', 'abierto', 'cierran', 'cierra', 'dias', 'trabaja', 'trabajan', 'precio',
  'precios', 'cuesta', 'cuanto', 'cobran', 'servicios', 'ofrecen', 'donde', 'direccion', 'ubicados',
]);

/** "Work" info words that report a fault, not a schedule, after a negation ("my heater isn't working", "no trabaja"). */
const WORK_WORDS: ReadonlySet<string> = new Set(['work', 'works', 'working', 'trabaja', 'trabajan']);
const NEGATIONS: ReadonlySet<string> = new Set(['not', 'isnt', 'doesnt', 'dont', 'wont', 'stopped', 'no', 'nunca']);

/** An INFO_WORDS word, unless it is a work word within 2 tokens after a negation. */
const isInfoTokenAt = (tokens: readonly string[], i: number): boolean =>
  INFO_WORDS.has(tokens[i]) &&
  !(WORK_WORDS.has(tokens[i]) && tokens.slice(Math.max(0, i - 2), i).some((token) => NEGATIONS.has(token)));

/** What the runtime saw on the call, beside the caller's lines. */
export interface FloorCallSignals {
  /** How the call ended (callOutcome.ts); only 'caller_hangup' can skip the floor. */
  endReason?: string;
  /** Every tool run on the call, by action name, with whether it returned ok (a blocked run is not ok). */
  tools?: ReadonlyArray<{ name: string; ok: boolean }>;
  /** The agent finished a turn after the caller's last line. */
  answered?: boolean;
}

/**
 * A pure information call that was answered, so the floor files nothing.
 * Conservative: every condition must hold, and a missing signal fails it.
 * - the caller ended the call (endReason 'caller_hangup');
 * - the agent spoke after the caller's last line;
 * - every tool that ran is in INFO_TOOLS and returned ok (none is fine);
 * - the caller gave no callback number;
 * - every content clause holds an INFO_WORDS word, so "I left my wallet
 *   there. What time do you close?" files;
 * - no clause asks for an action (asksForAction).
 */
export function answeredInfoOnly(lines: readonly string[], signals: FloorCallSignals): boolean {
  if (signals.endReason !== 'caller_hangup' || signals.answered !== true || !signals.tools) return false;
  if (!signals.tools.every((tool) => tool.ok && INFO_TOOLS.has(tool.name))) return false;
  if (hasCallbackNumber(lines)) return false;
  const clauses = lines
    .flatMap((line) => line.replace(MERIDIEM, '$1m').split(CLAUSE_BREAK))
    .map(normalizeTokens);
  const isInfoClause = (tokens: string[]) => tokens.some((_, i) => isInfoTokenAt(tokens, i));
  const contentClauses = clauses.filter(isContentClause);
  if (contentClauses.length === 0 || !contentClauses.every(isInfoClause)) return false;
  return !clauses.some(asksForAction);
}
