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
// answeredInfoOnly: fail-safe by structure. A call is skipped only when every
// caller content clause is wholly consumed by one of a small allowlist of
// information-question shapes (INFO_QUESTION_SHAPES). Anything the shapes don't
// cover files, so new phrasings file by default; no list has to grow for that.
// The word sets below only guard the few open slots in a shape (a service, a
// staff name, an introduced name) and only ever make a call file.
// ---------------------------------------------------------------------------

/** Weekdays and relative days (EN/ES, normalized: "miércoles" → "miercoles", "mañana" → "manana"). */
const DAY =
  '(?:mon|tues|wednes|thurs|fri|satur|sun)days?|today|tomorrow|tonight|now|(?:the )?weekends?|' +
  'lunes|martes|miercoles|jueves|viernes|sabados?|domingos?|hoy|manana|ahora|fin(?:es)? de semana';
const DAY_TOKEN = new RegExp(`^(?:${DAY})$`);

/**
 * Template parts. {S} (a service) and {N} (a staff name) are the only open
 * slots; slotsAreValid checks them. {SVC} is a closed list of service names
 * for "is X available", where an open slot would take a person or a time.
 */
const SHAPE_PARTS: Readonly<Record<string, string>> = {
  YOU: '(?:you(?: guys| all)?|yall)',
  SHOP: '(?:the |your )?(?:shop|store|office|business|place|garage|salon)',
  TIENDA: '(?:la tienda|el taller|el local|el negocio|el salon|la oficina)',
  ART: '(?:(?:a|an|the|some|any|un|una|el|la|los|las) )?',
  WHEN: `(?: (?:on |on the |this |next |right |el |los |este )?(?:${DAY}))?`,
  S: '(?<service>\\S+(?: \\S+){0,2})',
  SVC:
    '(?<service>\\S+ service|oil changes?|brakes?|alignments?|tire rotations?|inspections?|haircuts?|detailing|manicures?|pedicures?)',
  N: '(?<staff>\\S+)',
};

const shape = (template: string) =>
  new RegExp(`^${template.replace(/\{(\w+)\}/g, (_, part: string) => SHAPE_PARTS[part])}$`);

/**
 * The only clauses that can skip a ticket, matched against the whole
 * normalized clause. Each starts with what the caller asks about the shop, so
 * "can you open the garage door" fits no hours shape ("are you open", "when do
 * you open"); a word left over after a shape means no match.
 */
const INFO_QUESTION_SHAPES: readonly RegExp[] = [
  // Hours: "what are your hours (on Saturday)", "what time do you close (today)", "are you open on Saturday".
  '(?:what (?:are|is) |whats )?(?:your |the )?(?:business |store |shop |opening )?hours(?: of operation)?{WHEN}',
  '(?:what time|when) (?:do {YOU}|does {SHOP}) (?:open|close){WHEN}',
  '(?:are {YOU}|is {SHOP}) (?:open|closed|still open){WHEN}',
  '(?:how late|what time|until what time) (?:are {YOU}|is {SHOP}) open(?: until| till)?{WHEN}',
  'what days (?:are {YOU} open|do {YOU} work)',
  // Staff days: "what days does Marco work", "does Marco work Saturdays", "is Marco in today".
  // {N} must be capitalized in the caller's own words (staffNameIsValid).
  '(?:what|which) days does {N} work',
  'does {N} work{WHEN}',
  'is {N} (?:in|working){WHEN}',
  // Horario: "¿a qué hora cierran?", "¿cuál es su horario?", "¿abren hoy?", "¿qué días trabaja Marco?".
  '(?:a |hasta )?que hora (?:abren|cierran|abre|cierra)(?: ustedes| {TIENDA})?{WHEN}',
  '(?:cual es |cuales son |que )?(?:su |sus |el |los )?horarios?(?: de atencion| de trabajo)?(?: tienen)?{WHEN}',
  '(?:cuando )?(?:abren|cierran|estan abiertos|estan cerrados|esta abiert[oa] {TIENDA})(?: ustedes)?{WHEN}',
  'que dias (?:abren|trabajan|estan abiertos)',
  'que dias trabaja {N}',
  // Location and contact: "where are you located", "where is the shop", "what's your phone number", "website".
  '(?:where (?:are {YOU}|is {SHOP})|wheres {SHOP})(?: located| at)?',
  '(?:what (?:is|are) |whats )?(?:your |the )?(?:address|location|phone number|phone|number|website|web site|email(?: address)?)',
  'is there parking',
  'donde (?:estan|esta|quedan|queda|se encuentran)(?: ubicad[oa]s?| {TIENDA})?',
  '(?:cual es )?(?:su |la |el )?(?:direccion|ubicacion|numero(?: de telefono)?|telefono|pagina(?: web)?|sitio web|correo(?: electronico)?)',
  // Price: "how much is an oil change", "how much does a fade cost", "¿cuánto cuesta un cambio de aceite?".
  'how much (?:is|are|does|do|for|would) {ART}{S}(?: cost| costs| be| run)?',
  '(?:how much|what) do {YOU} charge(?: for {ART}{S})?',
  '(?:what (?:is|are) |whats )?(?:the |your )?(?:price|prices|pricing|cost|rate|rates)(?: (?:of|for|on) {ART}{S})?',
  'what does {ART}{S} cost',
  'cuanto (?:cuesta|cuestan|vale|valen|sale|salen|cobran(?: por)?) {ART}{S}',
  '(?:cual es |cuales son )?(?:el |los |su |sus )?(?:precio|precios|costo|costos)(?: (?:de|del|por) {ART}{S})?',
  // Services: "do you offer brake service", "is brake service available", "what services do you offer", "¿ofrecen ...?".
  // "have" / "carry" / "tienen" take no open slot: "do you have a tow truck", "¿tienen grúa?" is a dispatch ask.
  'do {YOU} (?:offer|do|sell|provide) {ART}{S}',
  'is {ART}{SVC} available',
  'what (?:services|kind of services|kinds of services|types of services) do {YOU} (?:offer|have|do|provide)',
  'what do {YOU} offer',
  '(?:ustedes )?(?:ofrecen|hacen|venden|manejan) {ART}{S}',
  'que (?:servicios )?(?:ofrecen|tienen|hacen)',
  'do {YOU} have (?:a |an )?(?:website|web site|email(?: address)?|parking|phone number)',
  '(?:ustedes )?tienen (?:una |un )?(?:pagina(?: web)?|sitio web|estacionamiento|parqueo|correo(?: electronico)?)',
].map(shape);

/**
 * Closed-class words (articles, pronouns, prepositions, indefinites) and
 * availability nouns: never a service or a name, so "do you have anything
 * open", "how much is it" or "this is my booking" fits no slot.
 */
const NOT_SLOT_WORDS: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'it', 'its', 'my', 'your', 'our', 'his', 'her', 'their',
  'i', 'me', 'im', 'ive', 'id', 'we', 'us', 'you', 'yall', 'guys', 'he', 'she', 'him', 'they', 'them',
  'for', 'to', 'on', 'at', 'in', 'of', 'with', 'from', 'about', 'by', 'and', 'or', 'but', 'so', 'if', 'there', 'here',
  'what', 'when', 'where', 'which', 'who', 'why', 'how', 'please',
  'anyone', 'anybody', 'someone', 'somebody', 'everyone', 'everybody', 'nobody',
  'mine', 'ours', 'yours', 'theirs', 'hers', 'myself', 'ready',
  'anything', 'something', 'everything', 'nothing', 'time', 'times', 'room', 'rooms', 'space', 'spaces', 'spot', 'spots',
  'slot', 'slots', 'free',
  'el', 'la', 'los', 'las', 'lo', 'un', 'una', 'unos', 'unas', 'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'eso', 'esto',
  'mi', 'mis', 'su', 'sus', 'tu', 'tus', 'yo', 'te', 'se', 'nos', 'le', 'les', 'usted', 'ustedes',
  'mio', 'mia', 'mios', 'mias', 'nuestro', 'nuestra', 'nuestros', 'nuestras', 'listo', 'lista', 'listos', 'listas',
  'de', 'del', 'al', 'en', 'con', 'por', 'para', 'sin', 'sobre', 'y', 'o', 'que', 'quien',
  'alguien', 'algo', 'nada', 'nadie', 'todo', 'tiempo', 'espacio', 'espacios', 'lugar', 'lugares', 'cupo', 'cupos',
  'hueco', 'huecos', 'turno', 'turnos',
  // The caller's own job or account: "how much is the bill", "how much is left".
  'bill', 'balance', 'left', 'invoice', 'order', 'pedido',
]);

/** Times of day and clock numbers (EN/ES): "does noon work" offers a booking time, it names no one. */
const TIME_WORDS: ReadonlySet<string> = new Set([
  'noon', 'midnight', 'morning', 'mornings', 'afternoon', 'afternoons', 'evening', 'evenings', 'night', 'nights',
  'early', 'earlier', 'late', 'later', 'soon', 'sooner', 'anytime', 'oclock',
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
  'mediodia', 'medianoche', 'temprano', 'tarde', 'noche',
  'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce',
]);

/** People and vehicles (EN/ES): "do you offer a mechanic", "¿hacen grúa?" asks for someone or something to come out. */
const ROLE_VEHICLE_WORDS: ReadonlySet<string> = new Set([
  'guy', 'man', 'men', 'person', 'people', 'mechanic', 'mechanics', 'electrician', 'electricians', 'locksmith',
  'locksmiths', 'manager', 'owner', 'boss', 'supervisor', 'staff', 'employee', 'employees', 'worker', 'workers',
  'driver', 'drivers', 'truck', 'trucks', 'tow', 'towing', 'wrecker', 'van', 'roadside',
  'grua', 'gruas', 'electricista', 'electricistas', 'mecanico', 'mecanicos', 'cerrajero', 'cerrajeros', 'gerente',
  'dueno', 'duena', 'encargado', 'encargada', 'camion', 'chofer', 'persona', 'personal',
]);

/**
 * Request and dispatch words (EN/ES stems): book, cancel, schedule, cita, call,
 * fix, repair, send, come, check, open, quote, need, want, a tech... In a slot
 * they make the clause a request ("how much is the repair", "¿cuánto cobran por venir?").
 */
const ACTION_SLOT_WORD =
  /^(?:book\w*|appoint\w*|appts?|schedul\w*|resched\w*|cancel\w*|reserv\w*|citas?|agend\w*|call|calls|calling|callback|llam\w*|availab\w*|disponib\w*|fix\w*|repair\w*|arregl\w*|repar\w*|send\w*|sent|mand\w*|come|comes|coming|came|venir|veng\w*|check\w*|revis\w*|open\w*|abr\w*|clos\w*|cerr\w*|cierr\w*|instal\w*|visit\w*|quotes?|cotiz\w*|estimat\w*|presupuest\w*|dispatch\w*|need\w*|want\w*|quier\w*|quis\w*|necesit\w*|help\w*|ayud\w*|tech|techs|technicians?|tecnicos?|plumbers?|plomeros?)$/;

/** Problem and complaint words (EN/ES). One anywhere in the caller's lines files the call. */
const PROBLEM_WORDS: ReadonlySet<string> = new Set([
  'broken', 'broke', 'leak', 'leaks', 'leaking', 'leaky', 'damaged', 'damage', 'flooded', 'flooding', 'stuck',
  'not', 'isnt', 'doesnt', 'dont', 'wont', 'cant', 'didnt', 'arent', 'wasnt',
  'problem', 'problems', 'issue', 'issues', 'urgent', 'emergency', 'important', 'complaint', 'terrible', 'wrong',
  'unacceptable', 'ridiculous',
  'roto', 'rota', 'rotos', 'rotas', 'danado', 'danada', 'fuga', 'gotea', 'goteando', 'inundado', 'atascado', 'atorado',
  'descompuesto', 'descompuesta', 'falla', 'problema', 'problemas', 'urgente', 'emergencia', 'importante', 'queja',
  'pesimo', 'mal', 'inaceptable',
]);
/** Spanish "no ..." problems; "no" alone is filler ("no, gracias"). */
const PROBLEM_PHRASES: readonly string[] = ['no funciona', 'no sirve', 'no prende', 'no enciende', 'no abre', 'no cierra'];

/** True when the phrase appears as a whole token run in the clause. */
const hasPhrase = (tokens: readonly string[], phrase: string): boolean => ` ${tokens.join(' ')} `.includes(` ${phrase} `);

function hasProblemWord(lines: readonly string[]): boolean {
  return lines.some((line) => {
    const tokens = normalizeTokens(line);
    return tokens.some((token) => PROBLEM_WORDS.has(token)) || PROBLEM_PHRASES.some((phrase) => hasPhrase(tokens, phrase));
  });
}

/**
 * A word that can fill an open slot: letters only, not a closed-class word, a
 * day or time, a person or vehicle, a request or a problem.
 */
const isSlotWord = (token: string): boolean =>
  /^\p{L}+$/u.test(token) &&
  !NOT_SLOT_WORDS.has(token) &&
  !DAY_TOKEN.test(token) &&
  !TIME_WORDS.has(token) &&
  !ROLE_VEHICLE_WORDS.has(token) &&
  !ACTION_SLOT_WORD.test(token) &&
  !PROBLEM_WORDS.has(token);

const isCapitalized = (rawToken: string) => /^\p{Lu}/u.test(rawToken);

/**
 * A staff name is one slot word that the caller's own text capitalizes every
 * time it appears ("does Marco work" but not "does noon work"). With no
 * original-case tokens there is no evidence of a name, so it is not one.
 */
function staffNameIsValid(staff: string, rawTokens: readonly string[]): boolean {
  const said = rawTokens.filter((raw) => raw.toLowerCase() === staff);
  return isSlotWord(staff) && said.length > 0 && said.every(isCapitalized);
}

/** A service is 1–3 slot words; a middle "de" / "del" is fine ("cambio de aceite"). */
function slotsAreValid(groups: Record<string, string | undefined> | undefined, rawTokens: readonly string[]): boolean {
  const service = groups?.service?.split(' ') ?? [];
  const serviceOk = service.every((token, i) => isSlotWord(token) || (i > 0 && i < service.length - 1 && /^del?$/.test(token)));
  return serviceOk && (groups?.staff === undefined || staffNameIsValid(groups.staff, rawTokens));
}

/**
 * True when one INFO_QUESTION_SHAPES shape consumes the whole clause and its
 * slots hold valid words. rawTokens are the clause's tokens in the caller's
 * original case; without them no staff-name shape can match.
 */
export function isInfoQuestion(tokens: readonly string[], rawTokens: readonly string[] = []): boolean {
  const clause = tokens.join(' ');
  return INFO_QUESTION_SHAPES.some((re) => {
    const match = re.exec(clause);
    return match !== null && slotsAreValid(match.groups, rawTokens);
  });
}

/**
 * Greetings, thanks and lead-in words trimmed from either end of a clause ("And what are your hours", "hours, please").
 * Yes / no is not here: a leading Spanish "no" negates what follows ("No está abierto el taller").
 */
const EDGE_FILLER: readonly string[][] = [
  'thank you', 'good morning', 'good afternoon', 'good evening', 'buenos dias', 'buenas tardes', 'buenas noches', 'por favor',
  'hi', 'hello', 'hey', 'ok', 'okay', 'uh', 'um', 'hmm', 'oh', 'well', 'so', 'and', 'also',
  'thanks', 'bye', 'please', 'hola', 'bueno', 'gracias', 'adios', 'oye', 'pues', 'y', 'tambien',
].map(normalizeTokens);

/** A yes or no that is the whole clause, before any trimming ("No, thanks." is dropped; "Yes please" is not). */
const WHOLE_CLAUSE_YES_NO: ReadonlySet<string> = new Set(['yes', 'yeah', 'yep', 'no', 'si']);

/** The [start, end) token range left once EDGE_FILLER is trimmed from both ends. */
function edgeFillerBounds(tokens: readonly string[]): [number, number] {
  let start = 0;
  let end = tokens.length;
  const at = (i: number) => EDGE_FILLER.find((p) => i + p.length <= end && p.every((word, j) => tokens[i + j] === word));
  const endingAt = (k: number) => EDGE_FILLER.find((p) => k - p.length >= start && p.every((word, j) => tokens[k - p.length + j] === word));
  for (let p = at(start); start < end && p; p = at(start)) start += p.length;
  for (let p = endingAt(end); end > start && p; p = endingAt(end)) end -= p.length;
  return [start, end];
}

/** Like normalizeTokens, but keeping the caller's case ("Maria" stays "Maria"). */
function caseTokens(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/['’‘ʼ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/** A caller clause: normalized tokens, and the same tokens in the caller's case (empty when they don't line up). */
interface Clause {
  tokens: string[];
  raw: string[];
}

function toClause(text: string): Clause {
  const tokens = normalizeTokens(text);
  const raw = caseTokens(text);
  const aligned = raw.length === tokens.length && raw.every((r, i) => r.toLowerCase() === tokens[i]);
  if (tokens.length === 1 && WHOLE_CLAUSE_YES_NO.has(tokens[0])) return { tokens: [], raw: [] };
  const [start, end] = edgeFillerBounds(tokens);
  return { tokens: tokens.slice(start, end), raw: aligned ? raw.slice(start, end) : [] };
}

/** Intros whose name is taken as said: "my name is Ana", "me llamo Ana", "soy Ana". */
const NAMING_INTROS = ['my name is', 'mi nombre es', 'me llamo', 'soy'].map(normalizeTokens);
/** Intros that also open a statement ("this is horrible"), so the name must be capitalized or be the callerName. */
const PRESENTING_INTROS = ['this is', 'le habla', 'habla'].map(normalizeTokens);

/** Judgments a caller says about the call or the shop, never a name ("this is horrible", "esto es ridículo"). */
const NOT_NAME_ADJECTIVES: ReadonlySet<string> = new Set([
  'horrible', 'bad', 'awful', 'outrageous', 'ridiculous', 'frustrating', 'frustrated', 'annoying', 'annoyed', 'overdue',
  'upset', 'angry', 'mad', 'disappointing', 'disappointed', 'unbelievable', 'insane', 'crazy', 'absurd', 'confusing',
  'confused', 'late', 'new', 'great', 'good', 'fine', 'weird', 'strange', 'serious', 'insulting', 'disgusting',
  'frustrante', 'ridiculo', 'ridicula', 'absurdo', 'absurda', 'increible', 'molesto', 'molesta', 'enojado', 'enojada',
  'nuevo', 'nueva', 'malo', 'mala',
]);

/**
 * A clause that is only a self-introduction with a 1–2 word name, nothing else.
 * "my name is" / "me llamo" / "mi nombre es" / "soy" take any name word.
 * "this is" / "habla" / "le habla" need the name capitalized in the caller's
 * text or made of callerName's tokens, so "This is horrible" stays a content
 * clause. A problem word or an adjective is never a name.
 */
function isIntroduction({ tokens, raw }: Clause, callerNameTokens: ReadonlySet<string>): boolean {
  const starts = (p: string[]) => p.every((word, j) => tokens[j] === word);
  const naming = NAMING_INTROS.find(starts);
  const presenting = naming ? undefined : PRESENTING_INTROS.find(starts);
  const intro = naming ?? presenting;
  if (!intro) return false;
  const name = tokens.slice(intro.length);
  if (name.length < 1 || name.length > 2 || !name.every((t) => isSlotWord(t) && !NOT_NAME_ADJECTIVES.has(t))) return false;
  if (naming) return true;
  const rawName = raw.slice(intro.length);
  return (rawName.length === name.length && rawName.every(isCapitalized)) || name.every((t) => callerNameTokens.has(t));
}

/** What the runtime saw on the call, beside the caller's lines. */
export interface FloorCallSignals {
  /** How the call ended (callOutcome.ts); only 'caller_hangup' can skip the floor. */
  endReason?: string;
  /** Every tool run on the call, by action name, with whether it returned ok (a blocked run is not ok). */
  tools?: ReadonlyArray<{ name: string; ok: boolean }>;
  /** The agent gave a real answer (not a question or a holding line) after the caller's last line and any tool. */
  answered?: boolean;
  /** The caller's name as the runtime captured it; "this is <name>" matching it counts as an introduction. */
  callerName?: string;
}

/**
 * A pure information call that was answered, so the floor files nothing.
 * Conservative: every condition must hold, and a missing signal fails it.
 * - the caller ended the call (endReason 'caller_hangup');
 * - the agent gave a real answer after the caller's last line (answered);
 * - every tool that ran is in INFO_TOOLS and returned ok (none is fine);
 * - the caller gave no callback number and used no problem word;
 * - every caller clause, once a lone yes/no is dropped, greetings and thanks
 *   are trimmed and pure self-introductions dropped, is an allowlisted info
 *   question (isInfoQuestion), so any statement or request ("My car was
 *   damaged in your parking lot") files.
 */
export function answeredInfoOnly(lines: readonly string[], signals: FloorCallSignals): boolean {
  if (signals.endReason !== 'caller_hangup' || signals.answered !== true || !signals.tools) return false;
  if (!signals.tools.every((tool) => tool.ok && INFO_TOOLS.has(tool.name))) return false;
  if (hasCallbackNumber(lines) || hasProblemWord(lines)) return false;
  const callerNameTokens = new Set(signals.callerName ? normalizeTokens(signals.callerName) : []);
  const contentClauses = lines
    .flatMap((line) => line.split(CLAUSE_BREAK).map(toClause))
    .filter((clause) => clause.tokens.length > 0 && !isIntroduction(clause, callerNameTokens));
  return contentClauses.length > 0 && contentClauses.every((clause) => isInfoQuestion(clause.tokens, clause.raw));
}
