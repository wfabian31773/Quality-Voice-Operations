import { describe, expect, it } from 'vitest';
import { contentWords, normalizeTokens, saidMoreThanTheirOwnName } from './floorHeuristics';

describe('normalizeTokens', () => {
  it('lowercases, folds diacritics and strips punctuation', () => {
    expect(normalizeTokens('¡Sí! Adiós, José… it’s OK?')).toEqual(['si', 'adios', 'jose', 'its', 'ok']);
  });

  it('drops the U+2018 and U+02BC apostrophes too, so "it‘s" and "Iʼm" stay one token', () => {
    expect(normalizeTokens('it‘s')).toEqual(['its']);
    expect(normalizeTokens('Iʼm Luis')).toEqual(['im', 'luis']);
  });
});

describe('saidMoreThanTheirOwnName', () => {
  it('is false for nothing at all', () => {
    expect(saidMoreThanTheirOwnName([])).toBe(false);
    expect(saidMoreThanTheirOwnName(['', '  ...  '])).toBe(false);
  });

  it('is false for a greeting and a name, with or without the name supplied', () => {
    expect(saidMoreThanTheirOwnName(['Hi, this is Luis.'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['Hi, this is Luis.'], 'Luis')).toBe(false);
    expect(saidMoreThanTheirOwnName(['Hola, soy Ana'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['Hola', 'me llamo Ana María'], 'Ana María')).toBe(false);
    expect(saidMoreThanTheirOwnName(['Hello?', 'My name is Luis Garcia', 'yes', 'thank you, bye'], 'Luis Garcia')).toBe(false);
    expect(saidMoreThanTheirOwnName(["it's José"], 'Jose')).toBe(false);
  });

  it('is false for filler only', () => {
    expect(saidMoreThanTheirOwnName(['uh', 'um, hmm', 'okay, yeah', 'sí, bueno, gracias', 'adiós'])).toBe(false);
  });

  it('is true once two content words remain across all lines', () => {
    expect(saidMoreThanTheirOwnName(['I need a fade Friday'])).toBe(true);
    expect(saidMoreThanTheirOwnName(['quiero una cita el viernes'])).toBe(true);
    expect(saidMoreThanTheirOwnName(['Hi, this is Luis', 'haircut', 'tomorrow'], 'Luis')).toBe(true);
  });

  it('needs two words, not one', () => {
    expect(contentWords(['Hi this is Luis', 'haircut'], 'Luis')).toEqual(['haircut']);
    expect(saidMoreThanTheirOwnName(['Hi this is Luis', 'haircut'], 'Luis')).toBe(false);
  });

  it('removes name tokens wherever they appear, accent-insensitively', () => {
    expect(contentWords(['José speaking, José Pérez, call me'], 'Jose Perez')).toEqual(['call', 'me']);
  });

  it('is false for common self-introductions and greetings without a supplied name', () => {
    expect(saidMoreThanTheirOwnName(["Hi, I'm Luis"])).toBe(false);
    expect(saidMoreThanTheirOwnName(['Hi, I‘m Luis'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['I am Luis'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['mi nombre es Ana'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['Luis here'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['Luis speaking'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['habla Ana'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['buenos días'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['Good morning', 'good afternoon'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['Buenas tardes', 'buenas noches'])).toBe(false);
  });

  it('is true for a self-introduction followed by a request ("Hi, I\'m Luis, I need a fade")', () => {
    expect(contentWords(["Hi, I'm Luis, I need a fade"])).toEqual(['luis', 'i', 'need', 'a', 'fade']);
    expect(saidMoreThanTheirOwnName(["Hi, I'm Luis, I need a fade"])).toBe(true);
    expect(saidMoreThanTheirOwnName(["Hi, I'm Luis, I need a fade"], 'Luis')).toBe(true);
  });

  it('removes filler phrases only as whole runs', () => {
    // "this" and "is" alone are content; only the "this is" run is filler.
    expect(contentWords(['is this open'])).toEqual(['is', 'this', 'open']);
    expect(contentWords(['this is for Friday'])).toEqual(['for', 'friday']);
  });

  it('counts a contiguous callback number (7+ digits in one token) as substantive on its own', () => {
    expect(saidMoreThanTheirOwnName(['Hi, this is Luis, 5552013344'], 'Luis')).toBe(true);
    expect(saidMoreThanTheirOwnName(['Hi, this is Luis +15552013344'], 'Luis')).toBe(true);
    expect(saidMoreThanTheirOwnName(['Hi, this is Luis (555)201-3344'], 'Luis')).toBe(true);
    expect(saidMoreThanTheirOwnName(['Luis 42'], 'Luis')).toBe(false);
    expect(saidMoreThanTheirOwnName(['Hi, this is Luis, 555201'], 'Luis')).toBe(false);
  });

  it('drops a multi-word name after an intro phrase when it ends the line (no callerName)', () => {
    expect(contentWords(['Hi, this is Luis Garcia'])).toEqual([]);
    expect(saidMoreThanTheirOwnName(['Hi, this is Luis Garcia'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['My name is Luis Garcia Lopez'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['Hello, this is Luis Garcia'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['this is Luis Garcia'])).toBe(false);
    expect(contentWords(['Hola, habla María José López'])).toEqual([]);
    expect(saidMoreThanTheirOwnName(['Hola, habla María José López'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['Buenas tardes, le habla Ana Ruiz'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['Hola, soy Ana Ruiz'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['me llamo Ana María Ruiz'])).toBe(false);
    expect(saidMoreThanTheirOwnName(['mi nombre es Ana Ruiz'])).toBe(false);
  });

  it('keeps everything after the name, and never swallows a request as a name', () => {
    expect(contentWords(['Hi, this is Luis Garcia, I need a fade Friday'])).toEqual(['luis', 'garcia', 'i', 'need', 'a', 'fade', 'friday']);
    expect(saidMoreThanTheirOwnName(['Hi, this is Luis Garcia, I need a fade Friday'])).toBe(true);
    expect(saidMoreThanTheirOwnName(['Hola, habla María José López, quiero una cita'])).toBe(true);
    expect(contentWords(['this is about my booking Friday'])).toEqual(['about', 'my', 'booking', 'friday']);
    expect(saidMoreThanTheirOwnName(['this is about my booking Friday'])).toBe(true);
    // More than 3 tokens, or a common word in the tail, is not a name.
    expect(saidMoreThanTheirOwnName(['this is my booking'])).toBe(true);
    expect(saidMoreThanTheirOwnName(['soy de la tienda'])).toBe(true);
    // The name only counts when it ends the line; a later line still counts.
    expect(saidMoreThanTheirOwnName(['Hi, this is Luis Garcia', 'haircut tomorrow'])).toBe(true);
  });

  it.each([undefined, 'Luis'])('does not read "I\'m ..." as an introduction (callerName %s)', (callerName) => {
    expect(saidMoreThanTheirOwnName(["I'm canceling tomorrow"], callerName)).toBe(true);
    expect(saidMoreThanTheirOwnName(["I'm running late today"], callerName)).toBe(true);
    expect(saidMoreThanTheirOwnName(['Hi, this is Luis Garcia'], callerName)).toBe(false);
  });

  describe('never swallows a request as a name', () => {
    it('still drops a name that ends the last clause', () => {
      expect(saidMoreThanTheirOwnName(['Hi, this is Luis Garcia'])).toBe(false);
      expect(saidMoreThanTheirOwnName(['Hola, habla María José López'])).toBe(false);
      expect(saidMoreThanTheirOwnName(['Hi, this is Luis Garcia.'])).toBe(false);
      expect(saidMoreThanTheirOwnName(['Hi, this is Luis'])).toBe(false);
      expect(saidMoreThanTheirOwnName(['Hi, this is Luis Garcia-Lopez'])).toBe(false);
    });

    describe('still drops a name that ends the last clause', () => {
      it.each([
        'Hi, this is Luis Garcia, thanks',
        'Hola, habla Ana Ruiz, gracias',
        'Hi, this is Luis Garcia. Bye.',
        'Hi, this is Luis Garcia."',
        'Hi, this is Dr. Patel',
        'This is Luis A. Garcia',
      ])('"%s" is not substantive with no callerName', (line) => {
        expect(saidMoreThanTheirOwnName([line])).toBe(false);
      });

      it.each([
        // A closing "thanks" is skipped, so the request clause is the last one.
        'Hi, this is Ana, running late, thanks',
        // "Ana." is not an abbreviation, so the period still breaks the clause.
        'This is Ana. Cancel Friday',
      ])('"%s" is substantive with callerName "Ana"', (line) => {
        expect(saidMoreThanTheirOwnName([line], 'Ana')).toBe(true);
      });
    });

    it.each([
      ['This is Luis, cancel Friday', 'Luis'],
      ['Hi, this is Ana, running late', 'Ana'],
      ['Soy Ana, quiero cita', 'Ana'],
      ['This is Luis — cancel Friday', 'Luis'],
      ['Soy Ana… quiero cita', 'Ana'],
      ['Hi, this is Ana - running late', 'Ana'],
    ])('"%s" is substantive, with no callerName and with callerName %s', (line, callerName) => {
      expect(saidMoreThanTheirOwnName([line])).toBe(true);
      expect(saidMoreThanTheirOwnName([line], callerName)).toBe(true);
    });

    it.each([
      // With callerName "Ana" only "cancelo" is left (one word), as at 412e33c3.
      'Buenas tardes, habla Ana, cancelo',
      'soy cliente nuevo, quiero una cita',
    ])('"%s" is substantive with no callerName', (line) => {
      expect(saidMoreThanTheirOwnName([line])).toBe(true);
    });

    it('keeps the request after the name in the content words', () => {
      expect(contentWords(['This is Luis, cancel Friday'], 'Luis')).toEqual(['cancel', 'friday']);
      expect(contentWords(['Soy Ana, quiero cita'], 'Ana')).toEqual(['quiero', 'cita']);
    });
  });
});
