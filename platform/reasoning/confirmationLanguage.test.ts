import { describe, expect, it } from 'vitest';
import { isExplicitYes, type ConfirmAction } from './confirmationLanguage';

// undefined: a prepared readback whose action isn't known.
const ACTIONS: Array<ConfirmAction | undefined> = ['book', 'cancel', 'reschedule', undefined];

describe('go-aheads are action-aware: booking verbs confirm only a booking', () => {
  const BOOKING_VERBS = [
    'Book it.',
    'Book that',
    'Resérvalo.',
    'Resérvamelo, por favor',
    'go ahead and book it',
    'Lock it in.',
    'Dale, resérvalo',
    '¡Resérvalo!',
  ];

  it.each(['Yes, cancel my booking', 'Sí, cancela mi reserva', 'Sí, cancela la reservación', 'Yes, move my booking to Friday', 'Yes, my booking'])('a yes naming the booking noun still confirms a cancel or reschedule: %s', (line) => {
    expect(isExplicitYes(line, 'cancel')).toBe(true);
    expect(isExplicitYes(line, 'reschedule')).toBe(true);
  });

  // A plain yes that names booking confirms only a booking, never a pending cancel or reschedule.
  it.each(['Yes, book it', 'Perfect, book it', 'Sí, resérvalo', 'Yes, go ahead and book it'])('a yes naming booking is booking-only: %s', (line) => {
    expect(isExplicitYes(line, 'book')).toBe(true);
    expect(isExplicitYes(line, 'cancel')).toBe(false);
    expect(isExplicitYes(line, 'reschedule')).toBe(false);
    expect(isExplicitYes(line)).toBe(false);
  });

  it.each(BOOKING_VERBS)('a pending booking takes it: %s', (line) => {
    expect(isExplicitYes(line, 'book')).toBe(true);
  });

  it.each(BOOKING_VERBS)('a pending cancel, reschedule or unknown action does not: %s', (line) => {
    expect(isExplicitYes(line, 'cancel')).toBe(false);
    expect(isExplicitYes(line, 'reschedule')).toBe(false);
    expect(isExplicitYes(line)).toBe(false);
  });

  it.each([
    'Yes',
    'Yes, please',
    'Go ahead.',
    'Go ahead and do it',
    'Do it.',
    'Go for it',
    'Dale.',
    'Adelante',
    'Hazlo',
    'Hágalo, por favor',
    'Sounds good.',
    'That works.',
    'Confirm.',
    'Sí, confirmo',
  ])('action-neutral go-aheads confirm every action: %s', (line) => {
    for (const action of ACTIONS) expect(isExplicitYes(line, action)).toBe(true);
  });
});

describe('confirmation language', () => {
  it.each([
    // Oct 22 2026 test call: "Book it." was not taken as a yes and the readback ran a third time.
    'Book it.',
    'book it',
    'Yes, book it.',
    'Go ahead.',
    'Yeah, go ahead and book it',
    'Do it.',
    "Let's do it!",
    'Lock it in.',
    'Sounds good.',
    'Yes please',
    'That works.',
    'Works for me',
    "That's perfect, thanks",
    'Perfect, book it',
    'Okay, sounds good',
    'Um, yes',
    'Absolutely',
    'Yes, that is right',
    'that’s right',
    'Go ahead and book it, thanks',
    'Book it now, please',
    'Confirm.',
  ])('English yes: %s', (line) => {
    expect(isExplicitYes(line, 'book')).toBe(true);
  });

  it.each([
    'sí',
    'Sí, perfecto',
    'Dale.',
    'Dale, resérvalo',
    'Está bien.',
    'Resérvalo.',
    'Resérvela, por favor',
    'Adelante',
    'Claro que sí',
    'De acuerdo',
    'Bueno, sí',
    'Listo',
    '¡Dale!',
    '¡Sí, resérvalo!',
    'Dale, gracias',
    'Perfecto, resérvalo entonces, muchas gracias',
  ])('Spanish yes: %s', (line) => {
    expect(isExplicitYes(line, 'book')).toBe(true);
  });

  it.each([
    "Don't book it.",
    'Do not book it',
    'No, book it for Friday instead.',
    'Wait.',
    'Yes, wait',
    'Maybe.',
    'Book it, maybe',
    'Can you book it?',
    'Book it?',
    'Dale?',
    'Hold on.',
    'Go ahead... actually hold on',
    'Yes but make it ten',
    'Friday at nine',
    'Hmm, I guess',
    'Don’t book it',
    'No la reserves.',
    'No, espera',
    'Sí, pero a las 3',
    'Dale, tal vez',
    'Todavía no',
    '¿Sí?',
  ])('negation, hedge or question: %s', (line) => {
    for (const action of ACTIONS) expect(isExplicitYes(line, action)).toBe(false);
  });

  it.each([
    'Book it but at 2',
    'Book it for Friday',
    'Go ahead, but with Marco',
    'Go ahead, a different barber',
    'Book it for another day',
    'Lock it in for tomorrow morning',
    'Do it at two',
    'Dale, mañana',
    'Dale, mejor otro',
    'Resérvalo para el viernes',
    'Um, yes, Friday at 3',
    // After a go-ahead only affirmatives, filler and punctuation may follow.
    'Book it for my son',
    'Resérvalo para mi hijo',
    'Dale, para mi hijo',
    'Book it with Marco',
    'Dale, con Marco',
    'Resérvalo con Marco',
    'Book it for next week',
    'Dale, para la semana que viene',
    'Book it for the weekend',
    'Go ahead and book my son too',
    'Book it for two',
    'That works? What about the price',
    'Confirm with my wife first',
  ])('a correction after a go-ahead does not confirm the old details: %s', (line) => {
    for (const action of ACTIONS) expect(isExplicitYes(line, action)).toBe(false);
  });

  // Lines that open with a plain yes and carry a hedge. The original matcher took them; they must still confirm.
  it.each([
    'Yes, I think so.',
    'Sí, creo que sí.',
    'Sure, let me know by text',
    'Yes, I guess that works',
    'Sí, un momento lo anoto',
    'Sure, let me check my calendar',
  ])('a hedged plain yes still confirms: %s', (line) => {
    expect(isExplicitYes(line, 'book')).toBe(true);
  });

  // The matcher before go-aheads were added. For every line that opens with a plain yes the result must be the same:
  // a line it took that we reject brings back the readback loop, and a line it rejected that we take is a false yes.
  const MAIN_YES = /^(yes|yeah|yep|yup|sure|correct|right|that'?s (right|correct)|sounds good|perfect|ok|okay|s[ií]|claro|correcto|exacto|perfecto|de acuerdo|est[aá] bien)(?![\p{L}\p{N}])/iu;
  const MAIN_NOT_YES = /(?<![\p{L}\p{N}])(no|not|wait|actually|but|change|wrong|pero|espera|cambia|mal)(?![\p{L}\p{N}])/iu;
  const mainIsExplicitYes = (line: string) => {
    const text = line.trim();
    return MAIN_YES.test(text) && !MAIN_NOT_YES.test(text);
  };

  const PLAIN_YES_CORPUS = [
    // English, taken by the original matcher
    'Yes',
    'yes.',
    'Yeah',
    'Yep!',
    'Yup, that works',
    'Sure',
    'Sure, book it',
    'Correct',
    'Right',
    "That's right",
    'Thats correct',
    'Sounds good',
    'Perfect',
    'OK',
    'Okay, thanks',
    'Yes, Friday at 3',
    'yes, tomorrow at 3 is great',
    'Yes, will I get a text?',
    'Sounds good?',
    'Yes, at 3 instead',
    'Sounds good, make it 4pm',
    'Perfect, book it for Friday',
    'Yes, I think so.',
    'Yes, I guess that works',
    'Sure, let me know by text',
    'Sure, let me check my calendar',
    'Yeah, probably fine',
    'Okay, hold on a sec',
    'Yes, maybe',
    // English, rejected by the original matcher
    'Yes, but make it ten',
    'Yes, wait',
    'Yes, no wait',
    'Okay, perfect, I can’t wait',
    'Sure, actually make it Friday',
    'Right, not that one',
    'Okay, change it to 4',
    'Yes, wrong day though',
    // Spanish, taken by the original matcher
    'Sí',
    'si',
    'Sí, perfecto',
    'Claro',
    'Claro que sí',
    'Correcto',
    'Exacto',
    'Perfecto, gracias',
    'De acuerdo',
    'Está bien',
    'Esta bien, resérvalo',
    'Sí, creo que sí.',
    'Sí, un momento lo anoto',
    'Sí, resérvalo para el viernes',
    'Sí, mejor otro día',
    'Sí, a las 3',
    'Sí, tal vez',
    'Claro, todavía me sirve',
    // Spanish, rejected by the original matcher
    'Sí, pero a las 3',
    'Sí, espera',
    'Sí, no',
    'Claro, cambia la hora',
    'Correcto, está mal el nombre',
  ];

  it('the parity corpus is wide and every line opens with a plain yes', () => {
    expect(PLAIN_YES_CORPUS.length).toBeGreaterThanOrEqual(40);
    for (const line of PLAIN_YES_CORPUS) expect(MAIN_YES.test(line.trim()), line).toBe(true);
  });

  it.each(PLAIN_YES_CORPUS)('a line opening with a plain yes gets the original result: %s', (line) => {
    expect(isExplicitYes(line, 'book')).toBe(mainIsExplicitYes(line));
    // Non-booking actions match main except that a yes naming booking is refused.
    const namesBooking = /(?<!\p{L})(?:book\s+(?:it|that|this|me|us|him|her|them)|go\s+ahead\s+and\s+book|lock\s+(?:it|that)\s+in|res[eé]rv(?:a|e|ar)?(?:l[oa]s?|mel[oa]s?|nos?l[oa]s?))(?!\p{L})/iu.test(line);
    for (const action of ['cancel', 'reschedule'] as const)
      expect(isExplicitYes(line, action)).toBe(namesBooking ? false : mainIsExplicitYes(line));
  });

  // "great", "perfect" and "perfecto" used to be in both the affirmative and the filler lists, so each repeat could
  // match two ways and a line of 40 of them ending in a non-word took 2^40 steps to reject, freezing the gateway.
  const repeat = (head: string, words: string[], n: number) => head + Array.from({ length: n }, (_, i) => ` ${words[i % words.length]}`).join('');
  it.each<[string, string[]]>([
    ['Book it', ['great']],
    ['Book it', ['perfect']],
    ['Dale', ['perfecto']],
    ['Book it', ['great', 'perfect', 'thanks', 'yes']],
    ['Go ahead', ['great,', 'perfect!', 'please']],
    ['Resérvalo', ['perfecto', 'gracias', 'sí']],
    ['¡Dale', ['perfecto,', 'listo', 'por favor']],
  ])('a long run of affirmatives is fast: %s + %j', (head, words) => {
    for (const n of [40, 200]) {
      const tail = repeat(head, words, n);
      let start = performance.now();
      expect(isExplicitYes(tail, 'book')).toBe(true);
      expect(performance.now() - start).toBeLessThan(50);
      for (const end of [' x', ' para mi hijo', '?']) {
        start = performance.now();
        expect(isExplicitYes(tail + end, 'book')).toBe(false);
        expect(performance.now() - start).toBeLessThan(50);
      }
    }
  });

  it.each<[string, string[]]>([
    ['Go ahead', ['great', 'perfect', 'thanks', 'yes']],
    ['Dale', ['perfecto,', 'listo', 'por favor']],
    ['Book it', ['great', 'go ahead']],
  ])('a long run is fast without booking verbs too: %s + %j', (head, words) => {
    for (const action of ['cancel', 'reschedule', undefined] as const) {
      for (const n of [40, 200]) {
        const tail = repeat(head, words, n);
        for (const end of ['', ' x', ' para mi hijo', '?']) {
          const start = performance.now();
          expect(isExplicitYes(tail + end, action)).toBe(end === '' && head !== 'Book it');
          expect(performance.now() - start).toBeLessThan(50);
        }
      }
    }
  });
});
