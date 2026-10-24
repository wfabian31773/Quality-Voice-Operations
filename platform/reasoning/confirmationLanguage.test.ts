import { describe, expect, it } from 'vitest';
import { isExplicitYes } from './confirmationLanguage';

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
  ])('English yes: %s', (line) => {
    expect(isExplicitYes(line)).toBe(true);
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
  ])('Spanish yes: %s', (line) => {
    expect(isExplicitYes(line)).toBe(true);
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
    'Sure, let me check my calendar',
    'No la reserves.',
    'No, espera',
    'Sí, pero a las 3',
    'Dale, tal vez',
    'Todavía no',
    '¿Sí?',
  ])('negation, hedge or question: %s', (line) => {
    expect(isExplicitYes(line)).toBe(false);
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
  ])('a correction after a go-ahead does not confirm the old details: %s', (line) => {
    expect(isExplicitYes(line)).toBe(false);
  });

  // The matcher before go-aheads were added. Every line it took must still confirm, or the readback repeats.
  const MAIN_YES = /^(yes|yeah|yep|yup|sure|correct|right|that'?s (right|correct)|sounds good|perfect|ok|okay|s[ií]|claro|correcto|exacto|perfecto|de acuerdo|est[aá] bien)(?![\p{L}\p{N}])/iu;
  const MAIN_NOT_YES = /(?<![\p{L}\p{N}])(no|not|wait|actually|but|change|wrong|pero|espera|cambia|mal)(?![\p{L}\p{N}])/iu;

  it.each([
    'Yes, Friday at 3',
    'yes, tomorrow at 3 is great',
    'Yes, will I get a text?',
    'Sounds good?',
    'Yes, at 3 instead',
    'Sounds good, make it 4pm',
    'Perfect, book it for Friday',
    'Sí, resérvalo para el viernes',
    'Sí, mejor otro día',
    'Sí, a las 3',
  ])('a line the original matcher took still confirms: %s', (line) => {
    expect(MAIN_YES.test(line) && !MAIN_NOT_YES.test(line)).toBe(true);
    expect(isExplicitYes(line)).toBe(true);
  });
});
