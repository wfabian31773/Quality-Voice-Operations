// The caller's yes to a readback, before a booking, reschedule, cancel or
// ticket commits. A safety gate: anything that isn't a clear yes fails closed
// and the agent asks again.
//
// Before either tier: a line with a question in it ("?" or "¿" anywhere) or a
// hedge ("maybe", "I think", "probably", "tal vez", "quizás") is never a yes,
// so "Yes, maybe" and "Sounds good?" don't confirm.
//
// Two tiers. A line that opens with a plain yes ("yes", "sure", "sounds good",
// "sí") gets the original rule: it confirms unless it carries a negation or
// "but", so "Yes, Friday at 3" and "Sí, creo que sí" still confirm. Don't
// tighten it past the hedges above; that brings back the repeat-readback loop.
//
// A line that opens with a go-ahead ("book it", "go ahead", "dale",
// "resérvalo") is an allowlist: after the go-ahead only other affirmatives,
// filler ("please", "thanks", "gracias", "por favor") and punctuation may
// follow. Anything else, including a "?", is a possible change to the details
// read back ("Book it for my son", "Dale, con Marco"), so it does not confirm.
// Booking verbs ("book it", "resérvalo", "lock it in") are go-aheads only for
// a pending booking; a cancel or reschedule takes only the neutral ones.
//
// Word edges by Unicode letter, so "sí" and "está" end where they should.

// A question or a hedge anywhere in the line. Word edges as below; "quizas" may drop its accent.
const QUESTION = /[?¿]/u;
const HEDGE = /(?<![\p{L}\p{N}])(maybe|probably|i\s+think|tal\s+vez|quiz[aá]s)(?![\p{L}\p{N}])/iu;

// The original matcher. Do not narrow these lists or tighten this rule.
const PLAIN_YES = /^(yes|yeah|yep|yup|sure|correct|right|that'?s (right|correct)|sounds good|perfect|ok|okay|s[ií]|claro|correcto|exacto|perfecto|de acuerdo|est[aá] bien)(?![\p{L}\p{N}])/iu;
const NOT_YES = /(?<![\p{L}\p{N}])(no|not|wait|actually|but|change|wrong|pero|espera|cambia|mal)(?![\p{L}\p{N}])/iu;

// Every affirmative that isn't a booking verb: the plain ones and the go-aheads any readback can take.
const NEUTRAL_WORDS = [
  // English: plain yes, and go-aheads like "go ahead", "do it"
  'yes', 'yeah', 'yep', 'yup', 'sure', 'correct', 'right', "that'?s (?:right|correct|fine|good|great|perfect|it)",
  'sounds (?:good|great|perfect)', 'perfect', 'great', 'ok', 'okay', 'alright', 'all right', 'absolutely',
  'definitely', 'of course', 'please do', 'confirm(?:ed)?', 'go ahead(?: and (?:do|confirm) (?:it|that))?',
  'go for it', "(?:let'?s )?do (?:it|that)", 'that works', 'works for me',
  // Spanish: "sí", "dale", "está bien", "adelante"
  's[ií]', 'claro(?: que s[ií])?', 'correcto', 'exacto', 'perfecto', 'de acuerdo', 'est[aá] bien', 'me parece bien',
  'dale', 'adelante', 'listo', 'vale', '[oó]rale', 'h[aá]gal[ao]', 'hazlo', 'confirm(?:o|ado|ada)',
];

// Booking go-aheads ("book it", "resérvalo"). They confirm only a pending booking: said while a cancel or a
// reschedule waits for its yes, they are not a yes to it.
const BOOK_WORDS = [
  'book (?:it|that|me|me in)', 'go ahead and book (?:it|that)', 'lock (?:it|that) in',
  'res[eé]rv[ae]l[ao]', 'res[eé]rv[ae]mel[ao]',
];

// What may follow a go-ahead besides another affirmative. Affirmatives like "great" and "perfecto" are already
// in NEUTRAL_WORDS; don't repeat them here.
const FILLER_WORDS = ['please', 'thanks', 'thank you', 'now', 'then', 'cool', 'gracias', 'muchas gracias', 'por favor', 'ya', 'entonces'];

// Each word must be matchable by exactly one entry. If two entries could match the same text, the repeated group
// in GO_AHEAD can match a run of N such words 2^N ways, and a line like "Book it great great ... x" backtracks
// exponentially and blocks the voice gateway's event loop.
const word = (alternatives: string[]) => `(?:${[...new Set(alternatives)].join('|')})(?![\\p{L}\\p{N}])`;
const SEP = '[\\s,.!;:…—-]';

// A go-ahead line, optionally after "um" / "well" / "bueno", made only of affirmatives, filler and punctuation.
const goAhead = (affirm: string[]) => new RegExp(
  `^(?:(?:um+|uh+|oh|ah|eh|mm+|well|bueno)${SEP}+)?${word(affirm)}(?:${SEP}+${word([...affirm, ...FILLER_WORDS])})*${SEP}*$`,
  'iu',
);
const GO_AHEAD = goAhead(NEUTRAL_WORDS);
const BOOK_GO_AHEAD = goAhead([...NEUTRAL_WORDS, ...BOOK_WORDS]);

/** What the readback waiting for the yes will do. Unknown gets the strictest go-aheads: no booking verbs. */
export type ConfirmAction = 'book' | 'cancel' | 'reschedule';

/** A booking command, EN/ES ("book it", "resérvalo"). Not the nouns "booking" / "reserva", so "Yes, cancel my booking" still confirms a cancel. */
const BOOKING_COMMAND = /(?<!\p{L})(?:book\s+(?:it|that|this|me|us|him|her|them)|go\s+ahead\s+and\s+book|lock\s+(?:it|that)\s+in|res[eé]rv(?:a|e|ar)?(?:l[oa]s?|mel[oa]s?|nos?l[oa]s?))(?!\p{L})/iu;

/**
 * A short affirmative with no correction in it ("Yes, that's right", "Yes, Friday at 3", "¡Dale!", and for a
 * booking "Book it."; not "Yes, but make it ten", "Book it for Friday", "Book it?", "¿Sí?", "Yes, maybe", or
 * "Book it" to a cancel).
 */
export function isExplicitYes(line: string, action?: ConfirmAction): boolean {
  const text = line.trim().replace(/[‘’]/g, "'");
  // A question ("Sounds good?", "¿Sí?") or a hedge ("Yes, maybe", "Sí, tal vez") is never a yes.
  if (QUESTION.test(text) || HEDGE.test(text)) return false;
  const bare = text.replace(/^¡\s*/, '');
  // A yes that names booking ("Yes, book it", "Sí, resérvalo") is a yes to a
  // booking only; it must not confirm a pending cancel or reschedule.
  if (action !== 'book' && BOOKING_COMMAND.test(bare)) return false;
  if (PLAIN_YES.test(bare)) return !NOT_YES.test(bare);
  return (action === 'book' ? BOOK_GO_AHEAD : GO_AHEAD).test(bare);
}
