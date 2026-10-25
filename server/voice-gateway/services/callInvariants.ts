/**
 * Per-call runtime invariants (RT-12): wires the pure RT-04 checker
 * (platform/callcore/invariants) and the RT-02 hangup floor
 * (tickets.file_floor) into the live voice runtime.
 *
 * One instance per realtime session. It owns the call's CallFacts and replaces
 * them with the RT-04 reducers' return values. It blocks hard violations
 * only, never writes speech for the caller and never picks the next question:
 * a block goes back to the model as the tool's output, carrying RT-04's fixed
 * instruction for the rule.
 *
 * - RUN (tool bridge, before a tool runs): checkRun. Legacy tools map to read
 *   or write, so the commit rules only reach two-phase platform actions.
 * - TRANSFER: checkTransfer before a tool that dials a number.
 * - END: checkEnd before a model-initiated end-call tool. A missing floor is
 *   evaluated, not refused. Silence-watchdog, max-duration and caller hangups
 *   never come through here.
 * - SAY: observe-only. Speech streams to the caller before its transcript is
 *   complete, so a finished agent turn is checked, the rule id is logged and
 *   counted, and nothing is sent to the model or cancelled.
 * - Floor: evaluateFloor() runs tickets.file_floor at most once per call, as
 *   the system actor, bounded in time, and never throws. The action decides
 *   never_heard / nothing_substantive / already_filed / filed; the runtime only
 *   skips it when a write or transfer tool on this call returned ok, because
 *   hasCallArtifact can't see every legacy write. It also sends the call end
 *   outcome, the tools run and whether the agent answered the caller's last
 *   line, for the action's answered_info rule and its subject.
 */
import {
  appendRun,
  checkEnd,
  checkRun,
  checkSay,
  checkTransfer,
  createCallFacts,
  onAgentSpoke,
  onCallerHeard,
  onExplicitYes,
  onFloorEvaluated,
  onPrepared,
  onToolResult,
  type ActionKind,
  type CallFacts,
  type CheckResult,
  type RuleId,
  type RunRecord,
  type RunRequest,
} from '../../../platform/callcore/invariants';
import {
  actionNameFromExternal,
  assignExternalToolNames,
  getAction,
  listActions,
  runAction,
  type ActionContext,
  type ActionResult,
  type ExternalToolNames,
} from '../../../platform/actions';
import {
  FILE_FLOOR,
  FLOOR_MAX_TOOLS,
  floorIdempotencyKey,
  type FileFloorInput,
  type FileFloorOutput,
} from '../../../platform/actions/tickets';
import { FLOOR_MAX_TOOL_NAME_LENGTH } from '../../../platform/actions/tickets/floor';
import type { CallOutcome } from './callOutcome';
import { envSmsSendConfig } from '../../../platform/actions/sms/deps';
import { isToolStoppedResult } from '../../../platform/tools/ToolStopGuard';
import { isPendingBookingChallenge } from '../../../platform/tools/library/handlers/createBooking';
import { isExplicitYes, type ConfirmAction } from '../../../platform/reasoning/confirmationLanguage';
import { CallerLineBuffer } from './callerLines';
import {
  infoQuestionClauses,
  infoQuestionTypes,
  isSignOffOnly,
  normalizeTokens,
  type InfoQuestionClause,
  type InfoQuestionType,
} from '../../../platform/actions/tickets/floorHeuristics';

/** The runtime's actor for system-only actions (the floor). */
export const VOICE_RUNTIME_ACTOR = { type: 'system', id: 'voice-runtime' } as const;

/** Most time evaluateFloor() may take, tool settling included. */
export const FLOOR_DEADLINE_MS = 8_000;
/** Most of that spent waiting for tools still running at hangup. */
export const FLOOR_TOOL_SETTLE_MS = 3_000;

/**
 * Legacy tools that only read, or only keep runtime bookkeeping (a language
 * note, the model's own disposition). They leave no record for the shop, so
 * they don't stop the floor. Every other legacy tool counts as a write.
 */
export const LEGACY_READ_TOOLS: ReadonlySet<string> = new Set([
  'get_current_tenant_time',
  'record_language_change',
  'record_call_outcome',
  'lookup_customer',
  'retrieve_knowledge',
  'lookupSchedule',
  // Workforce handoff: a role switch inside the same call, not a phone transfer.
  'transfer_to_agent',
]);

/**
 * Model-initiated end-call tools. No live agent exposes one today (see
 * callOutcome.ts), so END has no live effect until one is added.
 */
export const END_CALL_TOOLS: ReadonlySet<string> = new Set(['end_call']);

/** Whether this call dials a phone number: triage always does; escalate_to_human only with transfer_number. */
export function isTransferRequest(toolName: string, args: Record<string, unknown>): boolean {
  if (toolName === 'triageEscalate') return true;
  return toolName === 'escalate_to_human' && typeof args.transfer_number === 'string' && args.transfer_number.trim() !== '';
}

let externalNames: ExternalToolNames | undefined;

/** The platform action name behind a tool name (its action name, or the sanitized external name). */
function platformActionName(toolName: string): string | undefined {
  if (getAction(toolName)) return toolName;
  externalNames ??= assignExternalToolNames(listActions().map((def) => def.name));
  return actionNameFromExternal(toolName, externalNames);
}

/** A tool run's name as the floor gets it: the platform action name, capped at the floor's limit. */
function floorToolName(toolName: string): string {
  return (platformActionName(toolName) ?? toolName).slice(0, FLOOR_MAX_TOOL_NAME_LENGTH);
}

/** The two-phase platform action behind a tool name. */
function platformAction(toolName: string) {
  const name = platformActionName(toolName);
  return name ? getAction(name) : undefined;
}

function platformActionKind(toolName: string): ActionKind | undefined {
  return platformAction(toolName)?.kind;
}

// Which go-aheads a prepared readback takes: "book it" confirms only a booking.
const CONFIRM_ACTIONS: Readonly<Record<string, ConfirmAction>> = {
  'scheduling.book.prepare': 'book',
  'scheduling.cancel.prepare': 'cancel',
  'scheduling.reschedule.prepare': 'reschedule',
};

/** How RUN and the call facts see a tool. */
export function toolKind(toolName: string, args: Record<string, unknown>): ActionKind {
  const platform = platformActionKind(toolName);
  if (platform) return platform;
  if (isTransferRequest(toolName, args)) return 'transfer';
  if (LEGACY_READ_TOOLS.has(toolName) || END_CALL_TOOLS.has(toolName)) return 'read';
  return 'write';
}

/**
 * An agent turn that asks rather than answers ("Which location?", "¿Qué
 * sede?", "We have two shops. Which one?"): the turn starts with "¿", or its
 * last sentence ends with "?" or starts with "¿". Such a turn never counts as
 * answering the caller, so the floor still files. A trailing courtesy closer
 * ("Anything else?", "¿Algo más?") is dropped first; a turn that is only a
 * closer answers nothing, so it counts as a question.
 */
export function isAgentQuestion(text: string): boolean {
  const sentences = text.trim().split(/(?<=[.!?…])\s+/).filter(Boolean);
  if (sentences.length > 0 && isCourtesyCloser(sentences[sentences.length - 1])) {
    sentences.pop();
    if (sentences.length === 0) return true;
  }
  if ((sentences[0] ?? '').startsWith('¿')) return true;
  const last = sentences[sentences.length - 1] ?? '';
  return /\?["'”’)]*$/.test(last) || last.startsWith('¿');
}

const COURTESY_CLOSERS: readonly RegExp[] = [
  /^(?:is there )?anything else(?: (?:that )?(?:i|we) can (?:help(?: you)?|assist(?: you)?|do for you)(?: with)?)?(?: today)?$/,
  /^(?:can|may|could) (?:i|we) (?:help|assist)(?: you)? with anything else(?: today)?$/,
  /^what else can (?:i|we) (?:help(?: you)?|assist(?: you)?) with(?: today)?$/,
  /^(?:hay )?algo m[aá]s(?: en (?:que|qu[eé]) (?:le|te|lo|la) (?:pueda|puedo|podamos|podemos) ayudar)?$/,
  /^(?:le|te|lo|la) (?:puedo|podemos) ayudar (?:en|con) algo m[aá]s$/,
  /^(?:en )?qu[eé] m[aá]s (?:le|te|lo|la) (?:puedo|podemos) ayudar$/,
];

/**
 * Holding lines (EN/ES): the agent is about to look something up, promises a
 * follow-up ("I'll have a technician reach out", "Le devolveremos la llamada"),
 * defers ("I'd need to check with the shop") or doesn't know, so nothing was
 * answered yet. Matched anywhere in the turn:
 * a turn that holds one never counts as an answer, even with more after it.
 */
const HOLDING_LINES: readonly RegExp[] = [
  /\blet me (?:check|look|see|find|pull|verify|confirm)\b/,
  /\b(?:one|just a) (?:moment|sec|second|minute)\b|\ba moment\b/,
  /\b(?:hold on|hang on|hold,? please|please hold|bear with me|give me a (?:moment|sec|second|minute)|while (?:i|we) (?:check|look))\b/,
  /\b(?:i'?ll|i will|i'?m going to|i'?m|we'?re|we are|we'?ll|we will|we'?re going to) (?:check|checking|look|looking)\b(?! forward)|\blooking into\b/,
  // A deferral: someone has to check or be asked first ("I'd need to check with the shop", "Tendría que preguntarle al encargado").
  /\b(?:need|needs|have|has) to (?:check|ask|confirm|verify)\b|\bcheck with\b|\bask (?:the|my)\b/,
  /(?<!\p{L})(?:(?:tendr[ií]a|tengo|tendr[ií]amos|tenemos) que (?:preguntar|revisar|confirmar|verificar)\p{L}*|preguntarles?)(?!\p{L})/u,
  /\bun (?:momento|momentito|segundo|segundito|minuto)\b/,
  /\b(?:d[eé]j(?:e|a)me|perm[ií]t(?:a|e)me|deje que|voy a) (?:revis|ver|chec|busc|verific|confirm)/,
  // "Permítame." on its own, "Espere", "Espéreme".
  /(?<!\p{L})(?:perm[ií]t(?:a|e)me(?=\s*(?:[,.!…]|$))|espere|esp[eé]reme)(?!\p{L})/u,
  /\b(?:lo )?(?:estoy|estamos) (?:revisando|checando|buscando|verificando|en eso)\b/,
  // A follow-up promise: any mention of calling, contacting or following up means
  // someone else answers later. Deliberately broad; an extra ticket is fine.
  /\b(?:call|calls|calling|contact|contacting|text you|reach out|reach you|get(?:ting)? back|follow(?:ing)? up|pass (?:that|this|it) along|let (?:the team|them|someone|you) know)\b/,
  /(?:llam|contact|comunic|devolv|avis)/,
  // The agent doesn't know or can't.
  /\b(?:don'?t|do not|doesn'?t) (?:have|know)\b|\bnot sure\b|\b(?:can'?t|cannot|unable to|not able to)\b/,
  /(?<!\p{L})no (?:lo |le )?(?:s[eé]|sabr[ií]a|sabemos|tengo|tenemos|cuento con|puedo|podemos|estoy segur)(?!\p{L})|no estoy segur[oa]/u,
];

/** An agent turn that only holds the line ("Let me check that", "Un momento", "Déjeme revisar"). */
export function isHoldingLine(text: string): boolean {
  const lower = text.toLowerCase().replace(/[’‘]/g, "'");
  return HOLDING_LINES.some((pattern) => pattern.test(lower));
}

/**
 * Positive evidence that a turn answered something (EN/ES): a number (a time,
 * price, address or count), a day of the week, a price word, or an
 * opening-hours or location word. Weekday abbreviations count too ("Mon–Fri",
 * "lun a vie"); those that are also ordinary words or names (sat, sun, wed,
 * mar, dom, thu, and unaccented sab, mie) only count in a range or list with
 * another day ("Sat & Sun", "Mon–Thu"). The hour one counts only with a time
 * marker after it ("one p.m.", "one o'clock") or a time preposition before it
 * ("half past one", "until one", "a la una", "una y media"); alone or after a
 * bare "at" it does not ("One moment.", "at one point", "until one of us",
 * "Es una pregunta."). Deliberately short: a turn with none of
 * these ("Sorry, I missed that.", "Good question.", "Okay.", "Buena
 * pregunta.") is not an answer, so the floor still files. A leading yes or no,
 * "free" or a landmark only counts for the question it answers
 * (TYPED_EVIDENCE). An answer that only names a staff member or service is
 * missed too; an extra ticket is fine.
 */
const FULL_DAY = String.raw`(?:mon|tues|wednes|thurs|fri|satur|sun)days?|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?`;
const UNAMBIGUOUS_DAY_ABBR = String.raw`mon|tues?|thurs?|fri|lun|mié|jue|vie|sáb`;
const ANY_DAY_ABBR = String.raw`${UNAMBIGUOUS_DAY_ABBR}|wed|thu|sat|sun|mar|mie|sab|dom`;
const DAY_TOKEN = String.raw`(?<![\p{L}'])(?:${FULL_DAY}|(?:${ANY_DAY_ABBR})\.?)(?!\p{L})`;
const DAY_JOINER = String.raw`\s*[-–—,&]\s*|\s+(?:to|through|thru|and|a|al|y)\s+`;

const ANSWER_EVIDENCE: readonly RegExp[] = [
  /\d/,
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|noon|midnight)\b/,
  /\bone(?:\s*[ap]\.?\s?m\b|[\s-]+(?:o[' ]?clock|in the (?:morning|afternoon|evening))\b)/,
  /(?<!\bone\s+)\b(?:half past|quarter (?:past|to)|until|till|til|by|before|after)\s+one\b(?![\s-]+(?:of|more|another|day|week|month)\b)/,
  /(?<!\p{L})(?:la una|una (?:de la (?:tarde|ma[ñn]ana|noche)|y (?:media|cuarto)))(?!\p{L})/u,
  /(?<!\p{L})(?:dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|doce|quince|veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|mediod[ií]a|medianoche)(?!\p{L})/u,
  /\b(?:mon|tues|wednes|thurs|fri|satur|sun)days?\b/,
  /(?<!\p{L})(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bados?|domingos?)(?!\p{L})/u,
  new RegExp(String.raw`(?<![\p{L}'])(?:${UNAMBIGUOUS_DAY_ABBR})(?!\p{L})`, "u"),
  new RegExp(`${DAY_TOKEN}(?:${DAY_JOINER})${DAY_TOKEN}`, "u"),
  /\$|\b(?:dollars?|bucks|cents)\b|(?<!\p{L})(?:d[oó]lares|pesos)(?!\p{L})/u,
  /\b(?:open|opens|close at|closed|closes|located|street|avenue|downtown)\b/,
  /(?<!\p{L})(?:abrimos|abre|abierto|abiertos|cerramos|cierra|cerrado|cerrados|calle|avenida|ubicad[oa]s?|centro)(?!\p{L})/u,
];

/** Help or acknowledgement filler ("I can help with that", "happy to", "con gusto le ayudo"): not an answer. */
const ACK_FILLER = String.raw`(?:\b(?:help|assist|happy to|glad to)\b|con (?:mucho )?gusto|ayud)`;
/** No ACK_FILLER in the rest of the first sentence, or in a second sentence that is a statement. */
const NO_ACK_FILLER = String.raw`(?![^.!?…]*${ACK_FILLER})(?![^.!?…]*[.!…]\s*[^.!?…]*${ACK_FILLER}[^.!?…]*(?:[.!…]|$))`;

/**
 * A yes or no that opens the turn. A real yes or no takes punctuation or the
 * end right after it ("Yes.", "No, we don't.", "Sí, estamos abiertos."), or a
 * subject pronoun ("Yes we are"). An acknowledgement that can also just open
 * a turn (sure, of course, claro, correct) counts only as a whole sentence
 * ("Claro.", "Of course!"), so "Sure, I can help with that." doesn't. Either
 * is vetoed by help filler after it ("Yes, I can help with that.", "Claro.
 * Con gusto le ayudo."). "No problem", "No worries" and "Si quiere..." ("if")
 * don't stand alone, so they don't count. What follows the opener is checked
 * by leadingYesNoAnswers.
 */
const LEADING_YES_NO = new RegExp(
  String.raw`^[\s"'“¡]*(?:(?:yes|yeah|yep|yup|no|nope|s[ií])(?=\s*(?:[,.!;:…—–]|$)|\s+(?:we|i|she|he|they|it|there|you)\b)` +
    String.raw`|(?:sure|of course|correct|that's right|claro(?: que s[ií])?|por supuesto|as[ií] es|exacto)(?=\s*(?:[.!…]|$)))${NO_ACK_FILLER}`,
);

/**
 * A modal or deferral (EN/ES): the yes or no hangs on someone or something
 * else ("Yes, I'd need to look that up.", "Yeah, you'd need to talk to the
 * manager.", "Sí, hay que confirmarlo con el taller.").
 */
const YES_NO_DEFERRAL =
  /\b(?:need|needs|have to|has to|would|should|might|may|could|look (?:that|it) up|find out|talk to|ask)\b|'d\b|(?<!\p{L})(?:tendr|tengo que|tienen? que|hay que|habr|necesit|consult|pregunt|deber)/u;

/** At most four words after the echo's verb ("Yes, we do oil changes."). */
const SHORT_COMPLEMENT = String.raw`(?:[\s,]+[\p{L}\d'$-]+){0,4}$`;

/**
 * A short echo of the question (EN/ES): subject pronoun and auxiliary ("we
 * are", "it's", "there is", "we don't", "he does") or a Spanish verb ("tenemos",
 * "hay", "estamos abiertos", "solo hacemos frenos", "no es"), with a short
 * complement and nothing else.
 */
const YES_NO_ECHO = new RegExp(
  String.raw`^(?:we|it|there|they|you|he|she)(?:(?:'re|'s|\s+(?:is|are|do|does|can|have|has|will))(?:n't|\s+not)?|\s+(?:can't|cannot|won't))${SHORT_COMPLEMENT}` +
    String.raw`|^(?:(?:solo|s[oó]lo|tambi[eé]n|aqu[ií]|ya)\s+)?(?:no\s+)?(?:tenemos|hay|estamos|ofrecemos|aceptamos|hacemos|trabajamos|es|est[aá]n?|abrimos|trabaja)(?!\p{L})${SHORT_COMPLEMENT}`,
  'u',
);

/** An echo that only remarks on the question ("Yes, it's a good question."). */
const GOOD_QUESTION = /\b(?:good|great|excellent|fair) question\b|(?<!\p{L})(?:buena|excelente) pregunta(?!\p{L})/u;

/**
 * An intensifier, address or apology that is the whole rest of the sentence
 * after the yes or no (EN/ES): "Yes, absolutely.", "Yes, we sure do.", "Yes,
 * ma'am.", "No, sorry.", "No, unfortunately we don't.", "No, I'm afraid
 * not.", "Sí, claro.", "Sí, sí tenemos.", "No, lo siento."
 */
const YES_NO_INTENSIFIER =
  /^(?:absolutely|definitely|of course|certainly|sure (?:do|does)|(?:we|they|he|she|it) (?:sure|certainly|definitely) (?:do|does)|ma'am|sir|sorry|unfortunately(?:,? (?:we don't|we do not|not))?|i'm afraid not|claro(?: que s[ií])?|por supuesto|s[ií] tenemos|lo siento|desafortunadamente(?:,? no)?)$/u;

/**
 * A leading yes or no (LEADING_YES_NO) that answers: the rest of its sentence
 * is (a) nothing ("Yes."), (b) a short echo (YES_NO_ECHO: "Yes, we are.",
 * "No, we don't.", "Sí, tenemos."), after an optional "and"/"y" ("Sí, y es
 * gratis."), that is no holding line ("Yes, we're checking on that.") or
 * remark on the question (GOOD_QUESTION), (c) an intensifier or apology
 * (YES_NO_INTENSIFIER: "Yes, absolutely.", "No, sorry.") when no statement
 * in the turn defers or holds, or (d) content: a place ("Yes, out back."), a
 * price statement ("Yes, and oil changes are free."), or a word of the
 * caller's question clause ("¿Ofrecen cortes de pelo?" → "Sí, aquí se corta
 * el pelo."). And neither that sentence nor a statement right after it defers
 * (YES_NO_DEFERRAL): "Yes, I'd need to look that up." or "Sí. Tiene que
 * preguntar al encargado." answers nothing.
 */
function leadingYesNoAnswers(lower: string, clauseWords: readonly string[]): boolean {
  const opener = LEADING_YES_NO.exec(lower);
  if (!opener) return false;
  const sentences = lower.slice(opener[0].length).split(/(?<=[.!?…])\s+/);
  const [first = '', second = ''] = sentences;
  const deferring = (sentence: string) => YES_NO_DEFERRAL.test(sentence);
  const asks = (sentence: string) => /\?["'”’)]*$/.test(sentence.trim());
  if (deferring(first) || (!asks(second) && deferring(second))) return false;
  const rest = first
    .replace(/[.!?…"'”’)\s]+$/, '')
    .replace(/^[\s,;:—–]+/, '')
    .replace(/^(?:and|but|also|y|pero|tambi[eé]n)\s+/u, '');
  if (!rest) return true;
  if (YES_NO_ECHO.test(rest) && !isHoldingLine(rest) && !GOOD_QUESTION.test(rest)) return true;
  if (YES_NO_INTENSIFIER.test(rest)) return !isHoldingLine(lower) && sentences.every((sentence) => asks(sentence) || !deferring(sentence));
  return PLACE_WORDS.test(rest) || FREE_PRICE.test(rest) || rest.search(NOUN_IS_FREE) >= 0 || sharesAskedWord(normalizeTokens(rest), clauseWords);
}

/**
 * Free of charge (EN/ES), only as a price statement about it, that, the thing
 * asked about, or as a sentence of its own: "It's free.", "The first one is
 * free.", "Oil changes are free." (to "How much is an oil change?"), "There's
 * no cost.", "We do it for free.", "Free with any tire purchase.", "No
 * charge.", "Es gratis.", "Son gratis.", "No tiene costo.", "Es sin costo.",
 * "Sin costo." Not an offer that names no price ("We offer free estimates",
 * "We can take a look at no cost", "Le hacemos el diagnóstico sin costo",
 * "Ofrecemos consultas gratuitas"), availability ("whenever you're free",
 * "Marco is free this afternoon", "Our barbers are free", "One is free right
 * now", "The next one is free": a bare or "next" one is a chair or slot, "the
 * first one" is the thing asked),
 * "feel free" or "toll free". A noun subject (NOUN_IS_FREE) must be a word of the caller's
 * price clause. "No tiene costo" must end the clause ("No tiene costo fijo,
 * depende" is no price).
 */
const FREE_PRICE = new RegExp(
  String.raw`\b(?:it|that|this|those|these|(?:the|that|this|first|second|last|every) ones?)(?:'s|'ll be| is| are| will be| would be)(?: (?:totally|completely|always|also|still|actually))?` +
    String.raw` (?:free|complimentary|for free|no (?:charge|cost)|on the house)\b` +
    String.raw`|\bthere(?:'s| is| will be| would be) no (?:charge|cost)\b` +
    String.raw`|\b(?:do|does|did|doing) (?:it|that|this|them|those) (?:for free|free of charge|at no (?:charge|cost))\b` +
    String.raw`|(?:^|[.!?…]\s+)[\s"'“¡]*(?:(?:totally|completely|totalmente|completamente) )?(?:free(?: of charge)?|gratis|no (?:charge|cost)|on the house|sin (?:costo|cargo))` +
    String.raw`(?=\s*(?:[,.!;:…—–]|$)|\s+(?:with|if|for|when|to you|con|si|para)\b)` +
    String.raw`|(?<!\p{L})(?:(?:es|son|ser[aá]|est[aá]n?) (?:totalmente |completamente )?(?:gratis|gratuit[oa]s?|sin (?:costo|cargo))|no tienen? (?:costo|cargo)(?=\s*(?:[,.!;:…—–]|$))` +
    String.raw`|(?:lo|la|los|las) (?:hacemos|hace|hacen) (?:gratis|sin (?:costo|cargo)))(?!\p{L})`,
  'u',
);

/** "{noun} is/are free": the noun is checked against the caller's price clause. */
const NOUN_IS_FREE = /(?<![\p{L}'])(\p{L}{4,}) (?:is|are)(?: (?:totally|completely|always|also|still|actually))? (?:free|complimentary)(?!\p{L})/gu;
/** Question words too common to name what was asked. */
const NOT_SUBJECT_WORDS: ReadonlySet<string> = new Set(['much', 'many', 'what', 'when', 'where', 'does', 'have', 'your', 'there', 'this', 'that', 'cost', 'costs', 'price']);

/**
 * A noun subject of "is/are free" that shares its stem with a word of the
 * caller's price clause ("oil changes" / "oil change"). Only that clause:
 * "Is there parking? How much is an oil change?" → "Parking is free." prices nothing asked.
 */
function nounFreeAnswersQuestion(lower: string, clauseWords: readonly string[]): boolean {
  return sharesAskedWord([...lower.matchAll(NOUN_IS_FREE)].map(([, noun]) => noun), clauseWords);
}

/** A word that shares its stem with a word of the caller's clause, past the common question words. */
function sharesAskedWord(words: readonly string[], clauseWords: readonly string[]): boolean {
  const asked = clauseWords.filter((word) => word.length >= 4 && !NOT_SUBJECT_WORDS.has(word));
  return words.some((said) =>
    said.length >= 4 && !NOT_SUBJECT_WORDS.has(said) && asked.some((word) => said.startsWith(word) || word.startsWith(said)),
  );
}

/**
 * A denial of "free" ("It's not free.", "We don't do it for free.", "No es
 * gratis.", "Nunca es gratis.", "Tampoco es gratis."), or no one being free
 * ("No one is free right now.", "Neither one is free."): a negation earlier in
 * the same clause vetoes FREE_PRICE. A comma ends the clause, so "No, es
 * gratis." and "Don't worry, it's free." still count.
 */
const NOT_FREE = new RegExp(
  String.raw`\b(?:not|never|no longer|no one|nobody|neither|none|isn't|aren't|wasn't|weren't|won't|wouldn't|don't|doesn't|didn't|do not|does not|did not|can't|cannot)\b` +
    String.raw`[^.!?…,;]*\b(?:free|complimentary)\b` +
    String.raw`|(?<!\p{L})(?:no|nunca|tampoco|jam[aá]s)(?!\p{L})[^.!?…,;]*(?<!\p{L})(?:gratis|gratuit[oa]s?|sin (?:costo|cargo))(?!\p{L})`,
  'u',
);

/** Where something is (EN/ES), beside the street words and numbers ANSWER_EVIDENCE already takes. */
const PLACE_WORDS =
  /\b(?:address|near|next to|out (?:back|front)|across (?:the street )?from|corner of|behind|in front of|road|blvd|boulevard|highway|plaza|mall|suite|shopping center)\b|(?<!\p{L})(?:direcci[oó]n|cerca|junto|enfrente|frente a|al lado|esquina|detr[aá]s|atr[aá]s|carretera|plaza|bulevar|centro comercial)(?!\p{L})/u;

/**
 * The agent didn't catch the caller or the line is bad ("Sorry, I missed that.", "I didn't quite catch
 * that.", "You're breaking up.", "Lo siento, no le escuché.", "Se corta."): never a typed answer.
 */
const DID_NOT_HEAR =
  /\b(?:missed (?:that|it|you)|(?:didn't|did not) (?:\w+ )?(?:catch|hear|get|understand)|(?:couldn't|could not|can't|cannot) (?:\w+ )?(?:hear|understand|make out)|breaking up|cutting out|(?:you|it|line|call) cut out|bad (?:connection|line)|(?:say|repeat) that)\b|(?<!\p{L})(?:no (?:le |te |lo |se )?(?:entend|escuch|o[iíy])|se (?:le )?corta(?=\s*(?:[,.!…]|$)| la (?:llamada|l[ií]nea|se[ñn]al|voz))|se (?:le )?est[aá] cortando|perd[oó]n|disculp|repet)/u;

/**
 * Evidence that only answers some questions, by what the caller asked
 * (infoQuestionTypes): a leading yes or no answers a yes/no question or "does
 * {N} work Saturdays" ("Is there parking?" → "Yes, out back."), but not "what
 * days does {N} work", which is a time question; "free" answers a price
 * question, a landmark answers a location question. Added to ANSWER_EVIDENCE,
 * never instead of it: a time, day, price or place word answers any question,
 * as before. So "Yes." alone answers no hours or price question, and "It's
 * free." no hours question.
 */
const TYPED_EVIDENCE: Readonly<Partial<Record<InfoQuestionType, (lower: string, clauseWords: readonly string[]) => boolean>>> = {
  yes_no: leadingYesNoAnswers,
  staff: leadingYesNoAnswers,
  price: (lower, clauseWords) => (FREE_PRICE.test(lower) || nounFreeAnswersQuestion(lower, clauseWords)) && !NOT_FREE.test(lower),
  location: (lower) => PLACE_WORDS.test(lower),
};

/**
 * A turn that carries answer-shaped content for what the caller asked ("We
 * open at nine.", "Un corte cuesta $30.", "Yes, we are." to "Are you open
 * Saturday?"). Typed evidence must cover every type asked: "Is there parking?
 * How much is an oil change?" → "Yes, there is." leaves the price unanswered.
 * Each type's evidence sees only the words of the clauses that asked it
 * (infoQuestionClauses of the caller's line).
 */
function hasAnswerEvidence(text: string, asked: readonly InfoQuestionType[], clauses: readonly InfoQuestionClause[]): boolean {
  const lower = text.toLowerCase().replace(/[’‘]/g, "'");
  if (ANSWER_EVIDENCE.some((pattern) => pattern.test(lower))) return true;
  if (DID_NOT_HEAR.test(lower)) return false;
  const wordsOf = (type: InfoQuestionType) => clauses.filter((clause) => clause.type === type).flatMap(({ tokens }) => tokens);
  return asked.length > 0 && asked.every((type) => TYPED_EVIDENCE[type]?.(lower, wordsOf(type)) ?? false);
}

/** A turn made only of courtesy closers ("Anything else?"): it neither answers nor asks, so an earlier answer stands. */
function isOnlyCourtesyCloser(text: string): boolean {
  const sentences = text.trim().split(/(?<=[.!?…])\s+/).filter(Boolean);
  return sentences.length > 0 && sentences.every(isCourtesyCloser);
}

/** A sentence that only offers more help: "Anything else I can help with?", "¿Le puedo ayudar en algo más?". */
function isCourtesyCloser(sentence: string): boolean {
  const core = sentence
    .toLowerCase()
    .replace(/^[¿\s"'“‘(]+/, '')
    .replace(/[?!.…"'”’)\s]+$/, '')
    .replace(/\s+/g, ' ');
  return COURTESY_CLOSERS.some((pattern) => pattern.test(core));
}

function parseObject(output: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(output);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Whether a tool output is a success: not `success:false` / `ok:false`, not
 * the stop guard's result, not a booking readback still waiting for a yes.
 * Output that isn't a JSON object counts as a success (the bridge always
 * returns JSON), which keeps the floor on the no-double-filing side.
 */
export function toolOutputOk(output: string): boolean {
  const parsed = parseObject(output);
  if (!parsed) return true;
  if (parsed.success === false || parsed.ok === false) return false;
  if (isToolStoppedResult(parsed)) return false;
  return !isPendingBookingChallenge(parsed as { pending?: boolean; status?: string });
}

function confirmationTokenOf(value: Record<string, unknown> | null | undefined): string | undefined {
  if (!value) return undefined;
  const direct = value.confirmationToken;
  if (typeof direct === 'string' && direct) return direct;
  const data = value.data;
  if (data && typeof data === 'object') {
    const nested = (data as Record<string, unknown>).confirmationToken;
    if (typeof nested === 'string' && nested) return nested;
  }
  return undefined;
}

/** Tool argument keys that carry the caller's own name (legacy ticket and booking tools). */
const NAME_ARG_KEYS = ['callerName', 'customerName', 'customer_name', 'contactName', 'contact_name'];
const MAX_CALLER_NAME_LENGTH = 255;

function callerNameFromArgs(args: Record<string, unknown>): string | undefined {
  for (const key of NAME_ARG_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, MAX_CALLER_NAME_LENGTH);
  }
  return undefined;
}

function floorLanguage(value: unknown): 'en' | 'es' | undefined {
  if (typeof value !== 'string') return undefined;
  const code = value.trim().toLowerCase();
  if (code.startsWith('es')) return 'es';
  if (code.startsWith('en')) return 'en';
  return undefined;
}

export { isExplicitYes };

export type FloorOutcome =
  | FileFloorOutput['reason']
  | 'skipped_tool_write'
  | 'skipped_tool_in_flight'
  | 'skipped_outbound'
  | 'action_failed'
  | 'timeout'
  | 'error';

export type FloorActionRunner = (ctx: ActionContext, input: FileFloorInput) => Promise<ActionResult>;

/** Production: the platform action layer with its default registry, store and tenant transaction. */
const runFloorThroughActions: FloorActionRunner = (ctx, input) => runAction(FILE_FLOOR, ctx, input);

export interface InvariantLogger {
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
}

export interface CallInvariantsAgent {
  tools: ReadonlyArray<{ name: string }>;
  metadata?: Record<string, unknown>;
  language?: string;
  preferredLanguage?: string;
  timeZone?: string;
}

export interface CallInvariantsInit {
  tenantId: string;
  /** call_sessions.id: what hasCallArtifact and the floor ticket's call_id key on. */
  callId: string;
  agent: CallInvariantsAgent;
  callerNumber?: string;
  calledNumber?: string;
  /**
   * The floor protects a caller's lost request, so it only runs on inbound
   * calls; an outbound callee never gets a floor ticket. Defaults to inbound.
   */
  direction?: 'inbound' | 'outbound';
  log: InvariantLogger;
  /** Tests inject a fake; production runs the action through platform/actions. */
  runFloorAction?: FloorActionRunner;
  /** Existing SMS kill switch (SMS_ENABLED); read once per call. */
  smsEnabled?: () => boolean;
  now?: () => Date;
  floorDeadlineMs?: number;
  toolSettleMs?: number;
  /**
   * Runs once the tools in flight have settled, before the floor decides:
   * the session flushes its bookkeeping queue here (bounded, never rejects),
   * so every row a tool queued is written before the floor reads the call.
   */
  beforeFloor?: () => Promise<unknown>;
  /**
   * The call end outcome recorded so far (callOutcome.ts), read when the
   * floor runs. Phone teardown records it first, so the floor can tell a
   * caller hangup from a time-limit or system end.
   */
  endReason?: () => CallOutcome | null;
  /**
   * True when the transport confirms playback ('twilio_mark' on the phone):
   * an answer then only counts once agentPlaybackConfirmed() reports its
   * audio played. Otherwise (the widget's 'response_done' mode has no
   * playback signal) the completed transcript is the signal.
   */
  awaitPlayback?: boolean;
}

/** Process-wide SAY observations by rule, for metrics. */
const sayObservedTotals = new Map<RuleId, number>();

export function sayObservedTotal(rule: RuleId): number {
  return sayObservedTotals.get(rule) ?? 0;
}

type ToolHandler = (name: string, args: Record<string, unknown>) => Promise<string>;

/** A timer the caller always cancels once the race it bounds is over. */
function sleep(ms: number): { promise: Promise<'timeout'>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export class CallInvariants {
  private state: CallFacts;
  private history: RunRecord[] = [];
  private readonly callerLines = new CallerLineBuffer();
  private readonly inFlight = new Map<Promise<unknown>, ActionKind>();
  private readonly sayCounts = new Map<RuleId, number>();
  /** A write, commit or transfer tool returned ok on this call (legacy writes hasCallArtifact may not see). */
  private filedByTool = false;
  /** Every tool run on the call, by platform action name when it has one; a blocked run is not ok. */
  private readonly toolRuns: Array<{ name: string; ok: boolean }> = [];
  /**
   * The agent gave a real answer (answer evidence, not a question or a holding
   * line) after the caller's last line and after the last tool started, and
   * its audio played.
   */
  private answered = false;
  /** The latest agent turn is an answer whose playback is not confirmed yet. */
  private answerAwaitingPlayback = false;
  /** The caller barged in since their last completed line. */
  private playbackInterrupted = false;
  /** What the caller's last line asked (infoQuestionTypes): which replies count as answering it. */
  private asked: readonly InfoQuestionType[] = ['other'];
  /** The clauses of the caller line `asked` came from, by type (infoQuestionClauses). */
  private askedClauses: readonly InfoQuestionClause[] = [];
  /**
   * answered as it stood when the caller started speaking: a sign-off line
   * ("Thank you!") restores it once transcribed. A tool, or an agent
   * question or holding line, clears it.
   */
  private answeredBeforeSpeech = false;
  private callerName: string | undefined;
  private language: 'en' | 'es' | undefined;
  private lastPreparedToken: string | undefined;
  private lastPreparedAction: ConfirmAction | undefined;
  private spokeSincePrepare = false;
  private floor: Promise<FloorOutcome> | undefined;
  private readonly runFloor: FloorActionRunner;
  private readonly now: () => Date;

  constructor(private readonly init: CallInvariantsInit) {
    const meta = init.agent.metadata ?? {};
    const transferNumber = nonEmpty(meta.onCallTransferNumber);
    this.state = createCallFacts({
      callId: init.callId,
      // The number the existing transfer paths dial (stream.ts onEscalation).
      transferNumberConfigured: Boolean(transferNumber),
      // No agent config sets it today; D7's default is refs texted, not spoken.
      voiceRefs: meta.voiceRefs === true,
      smsEnabled: (init.smsEnabled ?? envSmsSendConfig.smsEnabled)(),
      allowedActions: init.agent.tools.map((tool) => tool.name),
      speakableNumbers: [init.calledNumber, init.callerNumber, transferNumber, nonEmpty(meta.businessPhone)].filter(
        (n): n is string => Boolean(n && n.trim()),
      ),
    });
    this.language = floorLanguage(init.agent.preferredLanguage ?? init.agent.language);
    this.runFloor = init.runFloorAction ?? runFloorThroughActions;
    this.now = init.now ?? (() => new Date());
  }

  get facts(): CallFacts {
    return this.state;
  }

  /** SAY rules observed on this call, by rule. */
  get sayObservations(): ReadonlyMap<RuleId, number> {
    return this.sayCounts;
  }

  get callerLineCount(): number {
    return this.callerLines.size;
  }

  /** A workforce handoff exposed a new tool list to the model. */
  setExposedTools(tools: ReadonlyArray<{ name: string }>): void {
    this.state = { ...this.state, allowedActions: tools.map((tool) => tool.name) };
  }

  /** A caller transcript completed. */
  callerTranscribed(text: string): void {
    if (!text.trim()) return;
    this.state = onCallerHeard(this.state);
    this.callerLines.push(text);
    // A line of only thanks, sign-offs or filler asks nothing new: the
    // earlier answer and what it answered stand.
    if (isSignOffOnly(text)) {
      this.answered = this.answered || this.answeredBeforeSpeech;
    } else {
      this.asked = infoQuestionTypes(text);
      this.askedClauses = infoQuestionClauses(text);
      this.answered = false;
    }
    this.answeredBeforeSpeech = false;
    this.answerAwaitingPlayback = false;
    this.playbackInterrupted = false;
    if (this.lastPreparedToken && this.spokeSincePrepare && isExplicitYes(text, this.lastPreparedAction)) {
      this.state = onExplicitYes(this.state, this.lastPreparedToken);
    }
  }

  /**
   * Server VAD heard the caller start speaking. Their words may never be
   * transcribed (they hang up first), so an earlier answer no longer covers
   * their last line.
   */
  callerSpeechStarted(): void {
    this.answeredBeforeSpeech = this.answeredBeforeSpeech || this.answered;
    this.answered = false;
    this.answerAwaitingPlayback = false;
  }

  /** An agent turn's transcript completed: SAY (observe-only), then the pending result counts as voiced. */
  agentTurnCompleted(text: string): void {
    if (text.trim()) {
      const said = checkSay(this.state, text);
      if (!said.ok) {
        const count = (this.sayCounts.get(said.rule) ?? 0) + 1;
        this.sayCounts.set(said.rule, count);
        sayObservedTotals.set(said.rule, (sayObservedTotals.get(said.rule) ?? 0) + 1);
        this.init.log.info('invariant_say_observed', { rule: said.rule, count });
      }
      // A clarifying question or a holding line never sets answered, and clears
      // an earlier one ("Sorry, could you repeat that?" after speech that was
      // never transcribed). A pure courtesy closer keeps it. Any other turn
      // only counts with answer evidence; one without it ("Sorry, I missed
      // that.") neither sets nor clears an answer.
      const question = isAgentQuestion(text);
      const holding = isHoldingLine(text);
      if (holding || (question && !isOnlyCourtesyCloser(text))) {
        this.answered = false;
        this.answeredBeforeSpeech = false;
      }
      if (question || holding) this.answerAwaitingPlayback = false;
      else if (hasAnswerEvidence(text, this.asked, this.askedClauses)) this.answerAwaitingPlayback = true;
      if (!this.init.awaitPlayback) this.agentPlaybackConfirmed();
    }
    this.state = onAgentSpoke(this.state);
    this.spokeSincePrepare = true;
  }

  /** The latest agent turn's audio played (the Twilio mark echo): an answer in it now counts. */
  agentPlaybackConfirmed(): void {
    if (this.answerAwaitingPlayback && !this.playbackInterrupted) this.answered = true;
    this.answerAwaitingPlayback = false;
  }

  /**
   * The caller barged in and the turn's audio was cleared: its answer was not
   * heard. Its truncated transcript and a mark echoed after the clear may
   * still arrive, so no answer counts until the caller's next line.
   */
  agentPlaybackInterrupted(): void {
    this.answerAwaitingPlayback = false;
    this.playbackInterrupted = true;
  }

  /**
   * Wraps the tool bridge: RUN, TRANSFER and END run before the tool, and the
   * real result updates the facts after it. A block returns the instruction
   * without running the tool, so ToolStopGuard never counts it.
   */
  wrapToolHandler(handler: ToolHandler): ToolHandler {
    return (name, args) => {
      // Whatever was said before a tool, the caller has not had its result yet.
      this.answered = false;
      this.answerAwaitingPlayback = false;
      this.answeredBeforeSpeech = false;
      const kind = toolKind(name, args);
      const work = this.runTool(handler, name, args, kind);
      // The end-call tool evaluates the floor itself; it must not wait on itself.
      if (END_CALL_TOOLS.has(name)) return work;
      // In flight from the moment the bridge has it, so a teardown landing
      // during the gate still waits for it.
      const tracked = work.then(
        () => undefined,
        () => undefined,
      );
      this.inFlight.set(tracked, kind);
      void tracked.then(() => this.inFlight.delete(tracked));
      return work;
    };
  }

  private async runTool(handler: ToolHandler, name: string, args: Record<string, unknown>, kind: ActionKind): Promise<string> {
    const run: RunRequest = { action: name, kind, confirmationToken: confirmationTokenOf(args), args };
    const gate = await this.gate(run);
    if (!gate.ok) {
      this.toolRuns.push({ name: floorToolName(name), ok: false });
      return this.blocked(name, gate);
    }

    const callerName = callerNameFromArgs(args);
    if (callerName) this.callerName = callerName;

    let output: string | undefined;
    try {
      output = await handler(name, args);
      return output;
    } finally {
      this.afterTool(name, args, run, output);
    }
  }

  private async gate(run: RunRequest): Promise<CheckResult> {
    const ran = checkRun(this.state, run, this.history);
    if (!ran.ok) return ran;
    if (run.kind === 'transfer') {
      const transfer = checkTransfer(this.state);
      if (!transfer.ok) return transfer;
    }
    if (END_CALL_TOOLS.has(run.action)) return this.beforeAgentEnd();
    return { ok: true };
  }

  /**
   * END for a model-initiated hangup. The floor runs first if it hasn't, so
   * the call is never refused for it; an unvoiced tool result returns the
   * instruction so she speaks it before hanging up. By design this floor
   * always files when nothing else was: its end reason is not caller_hangup,
   * so answered_info never skips an agent-initiated end.
   */
  async beforeAgentEnd(): Promise<CheckResult> {
    let result = checkEnd(this.state, 'agent_goodbye');
    if (!result.ok && result.rule === 'end.floor_not_evaluated') {
      await this.evaluateFloor();
      result = checkEnd(this.state, 'agent_goodbye');
    }
    return result;
  }

  private blocked(toolName: string, result: Extract<CheckResult, { ok: false }>): string {
    this.init.log.warn('invariant_block', { rule: result.rule, tool: toolName });
    return JSON.stringify({ success: false, code: 'INVARIANT_BLOCKED', rule: result.rule, message: result.instruction });
  }

  private afterTool(name: string, args: Record<string, unknown>, run: RunRequest, output: string | undefined): void {
    const parsed = output === undefined ? null : parseObject(output);
    const ok = output !== undefined && toolOutputOk(output);
    // A transfer only counts once the caller was actually connected.
    const factOk = run.kind === 'transfer' ? ok && parsed?.transferred !== false : ok;
    this.state = onToolResult(this.state, {
      action: name,
      kind: run.kind,
      ok: factOk,
      confirmationToken: run.kind === 'commit' ? run.confirmationToken : undefined,
    });
    this.history = appendRun(this.history, run, ok);
    this.toolRuns.push({ name: floorToolName(name), ok });
    if (ok && (run.kind === 'write' || run.kind === 'commit' || run.kind === 'transfer')) this.filedByTool = true;
    if (ok && run.kind === 'prepare') {
      const token = confirmationTokenOf(parsed);
      if (token) {
        this.state = onPrepared(this.state, token);
        this.lastPreparedToken = token;
        const action = platformAction(name)?.name;
        this.lastPreparedAction = action ? CONFIRM_ACTIONS[action] : undefined;
        this.spokeSincePrepare = false;
      }
    }
    if (ok && name === 'record_language_change') this.language = floorLanguage(args.language) ?? this.language;
  }

  /**
   * The hangup floor, at most once per call (later calls get the first
   * outcome). Waits briefly for tools still running, then runs
   * tickets.file_floor. Bounded by the deadline; never throws. Logs only the
   * outcome code.
   */
  evaluateFloor(): Promise<FloorOutcome> {
    this.floor ??= this.runFloorOnce();
    return this.floor;
  }

  private async runFloorOnce(): Promise<FloorOutcome> {
    const deadline = sleep(this.init.floorDeadlineMs ?? FLOOR_DEADLINE_MS);
    let outcome: FloorOutcome;
    try {
      outcome = await Promise.race([this.floorSteps(), deadline.promise]);
    } catch {
      outcome = 'error';
    } finally {
      deadline.cancel();
    }
    this.state = onFloorEvaluated(this.state);
    this.init.log.info('floor_evaluated', { outcome });
    return outcome;
  }

  private async floorSteps(): Promise<FloorOutcome> {
    // Covers both teardown and a model-initiated END on an outbound call.
    if (this.init.direction === 'outbound') return 'skipped_outbound';
    if (this.inFlight.size > 0) {
      const settle = sleep(this.init.toolSettleMs ?? FLOOR_TOOL_SETTLE_MS);
      await Promise.race([Promise.all([...this.inFlight.keys()]), settle.promise]);
      settle.cancel();
    }
    await this.init.beforeFloor?.();
    if (this.filedByTool) return 'skipped_tool_write';
    if ([...this.inFlight.values()].some((kind) => kind !== 'read')) return 'skipped_tool_in_flight';

    const ctx: ActionContext = {
      tenantId: this.init.tenantId,
      actor: { ...VOICE_RUNTIME_ACTOR },
      now: this.now(),
      tenantTimezone: this.init.agent.timeZone || 'UTC',
      callId: this.init.callId,
      idempotencyKey: floorIdempotencyKey(this.init.callId),
      ...(this.language ? { locale: this.language } : {}),
    };
    const endReason = this.init.endReason?.();
    const input: FileFloorInput = {
      callId: this.init.callId,
      callerLines: this.callerLines.lines(),
      ...(this.callerName ? { callerName: this.callerName } : {}),
      ...(this.language ? { language: this.language } : {}),
      ...(endReason ? { endReason } : {}),
      // Past the cap, or with a read (an availability check) still running, the
      // list is left out, which never lets the floor skip.
      ...(this.toolRuns.length <= FLOOR_MAX_TOOLS && this.inFlight.size === 0 ? { tools: [...this.toolRuns] } : {}),
      answered: this.answered,
    };
    const result = await this.runFloor(ctx, input);
    if (!result.ok) {
      this.init.log.warn('floor_action_failed', { code: result.error.code });
      return 'action_failed';
    }
    return (result.data as FileFloorOutput).reason;
  }
}
