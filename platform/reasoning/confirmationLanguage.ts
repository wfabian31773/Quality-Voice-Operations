// The caller's yes to a readback, before a booking, reschedule, cancel or
// ticket commits. A safety gate: a line counts only when it opens with a clear
// affirmative and carries no negation or hedge. Anything else fails closed and
// the agent asks again.
//
// Two tiers. A plain yes ("yes", "sure", "sounds good", "sí") keeps the
// original rule, so "Yes, Friday at 3" still confirms; tightening it brings
// back the repeat-readback loop. The wider go-aheads ("book it", "go ahead",
// "dale", "resérvalo") must also carry no question, change word, day or time,
// so "Book it for Friday" and "Book it?" do not confirm.
//
// Word edges by Unicode letter, so "sí" and "está" end where they should.

// The original affirmatives. Do not narrow this list or tighten its rule.
const PLAIN_YES = /^(?:yes|yeah|yep|yup|sure|correct|right|that'?s (?:right|correct)|sounds good|perfect|ok|okay|s[ií]|claro|correcto|exacto|perfecto|de acuerdo|est[aá] bien)(?![\p{L}\p{N}])/iu;

// Every affirmative: the plain ones, the go-aheads, and a leading "um" / "well" / "bueno".
const YES = new RegExp(
  '^(?:(?:um+|uh+|oh|ah|eh|mm+|well|bueno)[\\s,.!]+)?(?:'
  // English: plain yes, and go-aheads like "book it", "go ahead", "lock it in"
  + "yes|yeah|yep|yup|sure|correct|right|that'?s (?:right|correct|fine|good|great|perfect|it)|sounds (?:good|great|perfect)"
  + '|perfect|great|ok|okay|alright|all right|absolutely|definitely|of course|please do|confirm(?:ed)?'
  + '|book (?:it|that|me|me in)|go ahead|go for it|(?:let\'?s )?do (?:it|that)|lock (?:it|that) in|that works|works for me'
  // Spanish: "sí", "dale", "está bien", "resérvalo", "adelante"
  + '|s[ií]|claro|correcto|exacto|perfecto|de acuerdo|est[aá] bien|me parece bien|dale|adelante|listo|vale|[oó]rale'
  + '|res[eé]rv[ae]l[ao]|res[eé]rv[ae]mel[ao]|h[aá]gal[ao]|hazlo|confirm(?:o|ado|ada)'
  + ')(?![\\p{L}\\p{N}])',
  'iu',
);

// Negations and hedges anywhere in the line, after any affirmative ("don't book it", "yes, wait",
// "book it but at 2", "no la reserves", "espera").
const NOT_YES = new RegExp(
  '(?<![\\p{L}\\p{N}])(?:'
  + "no|not|nope|nah|don'?t|do not|can'?t|cannot|never|wait|hold on|hang on|one sec(?:ond)?|just a (?:sec|second|minute|moment)"
  + '|maybe|perhaps|probably|not sure|i think|i guess|let me|hmm+'
  + '|actually|but|change|wrong'
  + '|pero|espera|espere|esp[eé]r[ae]me|esp[eé]rate|un momento|momento|quiz[aá]s?|tal vez|a lo mejor|creo'
  + '|cambia|todav[ií]a|mal'
  + ')(?![\\p{L}\\p{N}])',
  'iu',
);

// Change words, checked only after a go-ahead ("go ahead, a different barber", "dale, mejor otro").
const CHANGE = new RegExp(
  '(?<![\\p{L}\\p{N}])(?:'
  + 'instead|rather|make it|different|another|other'
  + '|mejor|en vez|en lugar|cambie|cambiar|otro|otra'
  + ')(?![\\p{L}\\p{N}])',
  'iu',
);

// After a go-ahead, a day or time is a correction, not a yes to the old details ("book it for Friday", "dale, mañana").
const NEW_DETAIL = new RegExp(
  '(?<![\\p{L}\\p{N}])(?:'
  + '\\d|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight|morning|afternoon|evening|noon'
  + "|a\\.m\\.|p\\.m\\.|o'?clock|at (?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)"
  + '|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|hoy|ma[nñ]ana|tarde|noche|mediod[ií]a|a las|a la una'
  + ')(?![\\p{L}\\p{N}])',
  'iu',
);

/**
 * A short affirmative with no correction in it ("Yes, that's right", "Yes, Friday at 3", "Book it.", "dale";
 * not "Yes, but make it ten", "Book it for Friday", "Book it?").
 */
export function isExplicitYes(line: string): boolean {
  const text = line.trim();
  if (NOT_YES.test(text)) return false;
  if (PLAIN_YES.test(text)) return true;
  return YES.test(text) && !text.endsWith('?') && !CHANGE.test(text) && !NEW_DETAIL.test(text);
}
