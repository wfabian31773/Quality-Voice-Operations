// The caller's yes to a readback, before a booking, reschedule, cancel or
// ticket commits. A safety gate: anything that isn't a clear yes fails closed
// and the agent asks again.
//
// Two tiers. A line that opens with a plain yes ("yes", "sure", "sounds good",
// "sí") gets the original rule unchanged: it confirms unless it carries a
// negation or "but", so "Yes, Friday at 3" and "Sí, creo que sí" still confirm.
// Tightening it brings back the repeat-readback loop.
//
// A line that opens with a go-ahead ("book it", "go ahead", "dale",
// "resérvalo") is an allowlist: after the go-ahead only other affirmatives,
// filler ("please", "thanks", "gracias", "por favor") and punctuation may
// follow. Anything else, including a "?", is a possible change to the details
// read back ("Book it for my son", "Dale, con Marco"), so it does not confirm.
//
// Word edges by Unicode letter, so "sí" and "está" end where they should.

// The original matcher. Do not narrow these lists or tighten this rule.
const PLAIN_YES = /^(yes|yeah|yep|yup|sure|correct|right|that'?s (right|correct)|sounds good|perfect|ok|okay|s[ií]|claro|correcto|exacto|perfecto|de acuerdo|est[aá] bien)(?![\p{L}\p{N}])/iu;
const NOT_YES = /(?<![\p{L}\p{N}])(no|not|wait|actually|but|change|wrong|pero|espera|cambia|mal)(?![\p{L}\p{N}])/iu;

// Every affirmative: the plain ones and the go-aheads.
const AFFIRM = '(?:'
  // English: plain yes, and go-aheads like "book it", "go ahead", "lock it in"
  + "yes|yeah|yep|yup|sure|correct|right|that'?s (?:right|correct|fine|good|great|perfect|it)|sounds (?:good|great|perfect)"
  + '|perfect|great|ok|okay|alright|all right|absolutely|definitely|of course|please do|confirm(?:ed)?'
  + '|book (?:it|that|me|me in)|go ahead(?: and (?:book|do|confirm) (?:it|that))?|go for it|(?:let\'?s )?do (?:it|that)'
  + '|lock (?:it|that) in|that works|works for me'
  // Spanish: "sí", "dale", "está bien", "resérvalo", "adelante"
  + '|s[ií]|claro(?: que s[ií])?|correcto|exacto|perfecto|de acuerdo|est[aá] bien|me parece bien|dale|adelante|listo|vale|[oó]rale'
  + '|res[eé]rv[ae]l[ao]|res[eé]rv[ae]mel[ao]|h[aá]gal[ao]|hazlo|confirm(?:o|ado|ada)'
  + ')(?![\\p{L}\\p{N}])';

// What may follow a go-ahead besides another affirmative.
const FILLER = '(?:'
  + 'please|thanks|thank you|now|then|great|perfect|cool'
  + '|gracias|muchas gracias|por favor|ya|entonces|perfecto'
  + ')(?![\\p{L}\\p{N}])';

const SEP = '[\\s,.!;:…—-]';

// A go-ahead line, optionally after "um" / "well" / "bueno", made only of affirmatives, filler and punctuation.
const GO_AHEAD = new RegExp(
  `^(?:(?:um+|uh+|oh|ah|eh|mm+|well|bueno)${SEP}+)?${AFFIRM}(?:${SEP}+(?:${AFFIRM}|${FILLER}))*${SEP}*$`,
  'iu',
);

/**
 * A short affirmative with no correction in it ("Yes, that's right", "Yes, Friday at 3", "Book it.", "¡Dale!";
 * not "Yes, but make it ten", "Book it for Friday", "Book it?", "¿Sí?").
 */
export function isExplicitYes(line: string): boolean {
  const text = line.trim().replace(/[‘’]/g, "'");
  // A Spanish question ("¿Sí?") is never a yes.
  if (text.startsWith('¿')) return false;
  const bare = text.replace(/^¡\s*/, '');
  if (PLAIN_YES.test(bare)) return !NOT_YES.test(bare);
  return GO_AHEAD.test(bare);
}
