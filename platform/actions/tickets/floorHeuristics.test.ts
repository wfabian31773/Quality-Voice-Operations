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
    expect(contentWords(['this is Luis'])).toEqual(['luis']);
  });
});
