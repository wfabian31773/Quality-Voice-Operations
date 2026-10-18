import { describe, expect, it } from 'vitest';
import { contentWords, normalizeTokens, saidMoreThanTheirOwnName } from './floorHeuristics';

describe('normalizeTokens', () => {
  it('lowercases, folds diacritics and strips punctuation', () => {
    expect(normalizeTokens('¡Sí! Adiós, José… it’s OK?')).toEqual(['si', 'adios', 'jose', 'its', 'ok']);
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
    expect(contentWords(['José here, José Pérez'], 'Jose Perez')).toEqual(['here']);
  });

  it('removes filler phrases only as whole runs', () => {
    // "this" and "is" alone are content; only the "this is" run is filler.
    expect(contentWords(['is this open'])).toEqual(['is', 'this', 'open']);
    expect(contentWords(['this is Luis'])).toEqual(['luis']);
  });
});
