import { describe, expect, it } from 'vitest';
import { buildServiceKeyterms, KEYTERM_MAX_COUNT, KEYTERM_MAX_LENGTH } from './serviceKeyterms';
import { serviceAliases, serviceLabel } from './serviceLexicon';

const SHARP_LINE = {
  services: [
    { name: 'Haircut', aliases: ['regular cut', "men's cut", 'corte de pelo'] },
    { name: 'Fade', aliases: ['skin fade', 'bald fade', 'low fade', 'degradado'] },
    { name: 'Lineup', aliases: ['shape-up', 'edge up', 'perfilado'] },
  ],
};

describe('buildServiceKeyterms', () => {
  it('ranks names first, then aliases round-robin across services', () => {
    expect(buildServiceKeyterms(SHARP_LINE)).toEqual([
      'Haircut', 'Fade', 'Lineup',
      'regular cut', 'skin fade', 'shape-up',
      "men's cut", 'bald fade', 'edge up',
      'corte de pelo', 'low fade', 'perfilado',
      'degradado',
    ]);
  });

  it('dedupes on normalized text, keeping the first spelling', () => {
    const terms = buildServiceKeyterms({
      services: [
        { name: 'Line-Up', aliases: ['line up', 'LINE UP', 'Shape Up'] },
        { name: 'Kids cut', aliases: ['Corte para niños', 'corte para ninos', "kid's cut"] },
        { name: 'Shape-up', aliases: [] },
      ],
    }, { lexiconFallback: false });
    expect(terms).toEqual(['Line-Up', 'Kids cut', 'Shape-up', 'Corte para niños']);
  });

  it('caps the count and skips (never truncates) phrases that are too long', () => {
    const services = Array.from({ length: 80 }, (_, i) => ({ name: `Service ${i}`, aliases: [`alias ${i}`] }));
    const terms = buildServiceKeyterms({ services });
    expect(terms).toHaveLength(KEYTERM_MAX_COUNT);
    expect(terms.slice(0, 80)).toEqual(services.map((s) => s.name));
    expect(buildServiceKeyterms({ services }, { max: 5 })).toEqual(['Service 0', 'Service 1', 'Service 2', 'Service 3', 'Service 4']);
    // Options can lower the limits but never raise them past the recognizer's.
    expect(buildServiceKeyterms({ services }, { max: 500 })).toHaveLength(KEYTERM_MAX_COUNT);

    const long = 'x'.repeat(KEYTERM_MAX_LENGTH + 1);
    const terms2 = buildServiceKeyterms({ services: [{ name: long, aliases: ['ok', 'y'.repeat(KEYTERM_MAX_LENGTH)] }] }, { maxLen: 500 });
    expect(terms2).toEqual(['ok', 'y'.repeat(KEYTERM_MAX_LENGTH)]);
    expect(buildServiceKeyterms({ services: [{ name: 'Hot towel shave' }] }, { maxLen: 10, lexiconFallback: false })).toEqual([]);
    for (const t of buildServiceKeyterms(SHARP_LINE)) expect(t.length).toBeLessThanOrEqual(KEYTERM_MAX_LENGTH);
  });

  it('fills alias-less services from the EN/ES lexicon', () => {
    const terms = buildServiceKeyterms({ services: [{ name: 'Fade' }, { name: 'Lineup' }, { name: 'Sharp Line Special' }] });
    expect(terms.slice(0, 3)).toEqual(['Fade', 'Lineup', 'Sharp Line Special']);
    expect(terms).toEqual(expect.arrayContaining(['skin fade', 'degradado', 'shape-up', 'perfilado']));
    // Contextual words never become keyterm aliases ("line up" is too common).
    expect(terms).not.toContain('line up');
    expect(terms.length).toBe(new Set(terms).size);
    expect(buildServiceKeyterms({ services: [{ name: 'Fade' }] }, { lexiconFallback: false })).toEqual(['Fade']);
    // Catalog aliases win over the lexicon.
    expect(buildServiceKeyterms({ services: [{ name: 'Fade', aliases: ['the usual'] }] })).toEqual(['Fade', 'the usual']);
  });

  it('covers a seeded-style catalog within the limits', () => {
    const keys = ['haircut', 'fade', 'taper', 'lineup', 'beard_trim', 'cut_and_beard', 'hot_towel_shave', 'kids_cut'] as const;
    const terms = buildServiceKeyterms({ services: keys.map((k) => ({ name: serviceLabel(k), aliases: serviceAliases(k) })) });
    expect(terms.length).toBeLessThanOrEqual(KEYTERM_MAX_COUNT);
    expect(terms.length).toBe(new Set(terms).size);
    expect(terms.slice(0, keys.length)).toEqual(keys.map((k) => serviceLabel(k)));
    // Round-robin: every service's first aliases make the cut.
    expect(terms).toEqual(expect.arrayContaining(['fade cut', 'shape-up', 'taper fade', 'beard', 'straight razor shave']));
  });

  it('handles an empty catalog', () => {
    expect(buildServiceKeyterms({ services: [] })).toEqual([]);
  });
});
