import { describe, expect, it } from 'vitest';
import {
  isContextualServiceTerm,
  matchServiceTerm,
  normalizeServiceName,
  normalizeServiceText,
  serviceAliases,
  serviceLabel,
  serviceNameReadings,
  SERVICE_KEYS,
  STRONG_MATCH_CONFIDENCE,
  type ServiceKey,
} from './serviceLexicon';

function keyOf(utterance: string): ServiceKey | null {
  return matchServiceTerm(utterance)?.key ?? null;
}

describe('serviceLexicon', () => {
  it('matches the exact utterances from the Oct 17 live call', () => {
    expect(matchServiceTerm("I'm looking for a fade")).toEqual({ key: 'fade', matchedText: 'fade', confidence: 0.9 });
    expect(keyOf('I need a haircut')).toBe('haircut');
    expect(keyOf('just a lineup')).toBe('lineup');
    expect(keyOf('quiero un degradado')).toBe('fade');
  });

  it.each<[string, ServiceKey]>([
    ['skin fade', 'fade'],
    ['Can I get a bald fade?', 'fade'],
    ['low fade please', 'fade'],
    ['a mid fade', 'fade'],
    ['HIGH FADE', 'fade'],
    ['drop fade', 'fade'],
    ['burst fade', 'fade'],
    ['temple fade', 'fade'],
    ['a temp fade', 'fade'],
    ['a fade cut', 'fade'],
    ['desvanecido', 'fade'],
    ['degradado bajo', 'fade'],
    ['taper', 'taper'],
    ['taper fade', 'taper'],
    ['low taper fade', 'taper'],
    ['tapered sides', 'taper'],
    ['just a taper on the sides', 'taper'],
    ['a cut', 'haircut'],
    ['a trim', 'haircut'],
    ["men's cut", 'haircut'],
    ['scissor cut', 'haircut'],
    ['clipper cut', 'haircut'],
    ['buzz cut', 'haircut'],
    ['crew cut', 'haircut'],
    ['corte de pelo', 'haircut'],
    ['un corte de cabello', 'haircut'],
    ['recorte', 'haircut'],
    ['line-up', 'lineup'],
    ['line up', 'lineup'],
    ['can I get a shape up', 'lineup'],
    ['shape-up', 'lineup'],
    ['edge up', 'lineup'],
    ['clean up my edges', 'lineup'],
    ['my hairline', 'lineup'],
    ['perfilado', 'lineup'],
    ['arreglo de contorno', 'lineup'],
    ['beard trim', 'beard_trim'],
    ['beard line-up', 'beard_trim'],
    ['beard shape up', 'beard_trim'],
    ['mustache trim', 'beard_trim'],
    ['arreglo de barba', 'beard_trim'],
    ['recorte de barba', 'beard_trim'],
    ['perfilado de barba', 'beard_trim'],
    ['cut and beard', 'cut_and_beard'],
    ['haircut and beard', 'cut_and_beard'],
    ['cut + beard', 'cut_and_beard'],
    ['give me the works', 'cut_and_beard'],
    ['corte y barba', 'cut_and_beard'],
    ['hot towel shave', 'hot_towel_shave'],
    ['straight razor shave', 'hot_towel_shave'],
    ['head shave', 'hot_towel_shave'],
    ['afeitado con toalla caliente', 'hot_towel_shave'],
    ['rasurado', 'hot_towel_shave'],
    ["kid's haircut", 'kids_cut'],
    ["children's cut", 'kids_cut'],
    ['boys cut', 'kids_cut'],
    ['a haircut for my son', 'kids_cut'],
    ['corte infantil', 'kids_cut'],
    ['blowout', 'blowout'],
    ['highlights', 'highlights'],
    ['mechas', 'highlights'],
    ['gel manicure', 'gel_manicure'],
    ['uñas de gel', 'gel_manicure'],
    ['pedicura', 'pedicure'],
  ])('%s → %s', (utterance, key) => {
    expect(keyOf(utterance)).toBe(key);
  });

  it('matches Spanish with and without accents', () => {
    expect(keyOf('corte para niños')).toBe('kids_cut');
    expect(keyOf('corte para ninos')).toBe('kids_cut');
    expect(keyOf('afeitado con toalla caliente')).toBe('hot_towel_shave');
    expect(keyOf('corte con máquina')).toBe('haircut');
    expect(keyOf('corte con maquina')).toBe('haircut');
    expect(keyOf('QUIERO UN DEGRADADO')).toBe('fade');
    expect(keyOf('coloración')).toBe('color');
    expect(keyOf('coloracion')).toBe('color');
  });

  it('only matches whole words', () => {
    expect(matchServiceTerm('that is so cute')).toBeNull();
    expect(matchServiceTerm('the shaver is broken')).toBeNull();
    expect(matchServiceTerm('I faded out for a second')).toBeNull();
    expect(matchServiceTerm('pedestrian')).toBeNull();
  });

  it('prefers the longest match', () => {
    expect(matchServiceTerm('hot towel shave')).toMatchObject({ key: 'hot_towel_shave', matchedText: 'hot towel shave' });
    expect(matchServiceTerm('just a shave')).toMatchObject({ key: 'hot_towel_shave', matchedText: 'shave' });
    expect(matchServiceTerm('beard trim')).toMatchObject({ key: 'beard_trim', matchedText: 'beard trim' });
    expect(matchServiceTerm('taper fade')).toMatchObject({ key: 'taper', matchedText: 'taper fade' });
    expect(matchServiceTerm('perfilado de barba')).toMatchObject({ key: 'beard_trim' });
  });

  it('resolves several services in one sentence', () => {
    expect(keyOf('a haircut, like a low fade')).toBe('fade');
    expect(keyOf('I want a haircut and a beard trim')).toBe('cut_and_beard');
    expect(keyOf('haircut and my beard trimmed')).toBe('cut_and_beard');
    expect(keyOf('a fade and a beard trim')).toBe('fade');
    expect(keyOf('a beard trim and a fade')).toBe('beard_trim');
  });

  it('scores confidence: whole utterance, inside a sentence, weak context', () => {
    expect(matchServiceTerm('Fade')?.confidence).toBe(1);
    expect(matchServiceTerm('I want a fade')?.confidence).toBe(0.9);
    expect(matchServiceTerm('one more for my son')).toEqual({ key: 'kids_cut', matchedText: 'for my son', confidence: 0.6 });
    expect(matchServiceTerm('una más para mi hija')?.confidence).toBeLessThan(STRONG_MATCH_CONFIDENCE);
    expect(matchServiceTerm('give me a buzz')?.confidence).toBeLessThan(STRONG_MATCH_CONFIDENCE);
  });

  it('uses lang only as a tie-breaker; both languages are always searched', () => {
    expect(keyOf('quiero un fade')).toBe('fade');
    expect(matchServiceTerm('I want a degradado', 'en')?.key).toBe('fade');
  });

  it('returns null for no service', () => {
    expect(matchServiceTerm('')).toBeNull();
    expect(matchServiceTerm('Saturday at 9')).toBeNull();
    expect(matchServiceTerm('hi, this is Wayne')).toBeNull();
  });

  it('needs service context for "line up", "edges" and "hairline" (review finding 3)', () => {
    // Everyday "line up" is not a lineup.
    for (const utterance of [
      "I'd like to line up an appointment for Friday",
      'line up a time',
      'can we line up something next week',
      'my kids are lined up at the door',
      'we should line up early',
    ]) {
      const match = matchServiceTerm(utterance);
      expect(match === null || match.confidence < STRONG_MATCH_CONFIDENCE, utterance).toBe(true);
    }
    expect(matchServiceTerm("I'd like to line up an appointment for Friday")).toEqual({
      key: 'lineup', matchedText: 'line up', confidence: 0.6,
    });
    // With service context, or said on its own, it is.
    expect(matchServiceTerm('a line up')).toEqual({ key: 'lineup', matchedText: 'line up', confidence: 1 });
    expect(matchServiceTerm('can I get a line up on Friday')).toMatchObject({ key: 'lineup', confidence: 0.9 });
    expect(matchServiceTerm('just my edges')).toMatchObject({ key: 'lineup', confidence: 0.9 });
    expect(matchServiceTerm('clean up his hairline')).toMatchObject({ key: 'lineup', confidence: 0.9 });
    expect(matchServiceTerm('edges')).toMatchObject({ key: 'lineup', confidence: 1 });
    expect(matchServiceTerm('I need a lineup')).toMatchObject({ key: 'lineup', confidence: 0.9 });
    // A real service elsewhere in the sentence still wins.
    expect(matchServiceTerm('line up a fade for Saturday')).toMatchObject({ key: 'fade', confidence: 0.9 });
    expect(matchServiceTerm('beard line up')).toMatchObject({ key: 'beard_trim' });
  });

  it('flags contextual terms', () => {
    expect(isContextualServiceTerm('line up')).toBe(true);
    expect(isContextualServiceTerm('Line-Up')).toBe(true);
    expect(isContextualServiceTerm('edges')).toBe(true);
    expect(isContextualServiceTerm('lineup')).toBe(false);
    expect(isContextualServiceTerm('fade')).toBe(false);
  });

  it('has a label in both languages and aliases for every key', () => {
    for (const key of SERVICE_KEYS) {
      expect(serviceLabel(key, 'en')).toBeTruthy();
      expect(serviceLabel(key, 'es')).toBeTruthy();
      expect(serviceAliases(key).length).toBeGreaterThan(0);
      // Every alias maps back to its own key.
      for (const alias of serviceAliases(key)) expect(keyOf(alias)).toBe(key);
    }
    expect(serviceLabel('fade', 'es')).toBe('Degradado');
  });

  it('lists aliases without weak phrases or normalized duplicates', () => {
    const fade = serviceAliases('fade');
    expect(fade).toEqual(expect.arrayContaining(['skin fade', 'bald fade', 'low fade', 'degradado', 'desvanecido']));
    expect(serviceAliases('kids_cut')).not.toContain('for my son');
    expect(serviceAliases('lineup')).toEqual(expect.arrayContaining(['lineup', 'shape-up', 'edge-up', 'perfilado']));
    // Contextual words are never catalog aliases (an alias matches anywhere in a sentence).
    for (const word of ['line-up', 'line up', 'edges', 'hairline']) expect(serviceAliases('lineup')).not.toContain(word);
    expect(serviceAliases('fade', 'es')).not.toContain('skin fade');
  });

  it('normalizes punctuation, accents, apostrophes and articles', () => {
    expect(normalizeServiceText("Kid's Line-Up!")).toBe('kids line up');
    expect(normalizeServiceText('Corte y barba')).toBe('corte and barba');
    expect(normalizeServiceText('cut + beard')).toBe('cut and beard');
    expect(normalizeServiceText('Un corte para niños')).toBe('corte para ninos');
  });

  it('judges articles as written: "uña" is never the article "una"', () => {
    expect(normalizeServiceText('una uña de gel')).toBe('una de gel');
    expect(normalizeServiceText('una manicura')).toBe('manicura');
    expect(normalizeServiceName('Uña de Gel')).toBe('una de gel');
    expect(normalizeServiceName('uñas acrílicas')).toBe('unas acrilicas');
    expect(normalizeServiceName('una manicura')).toBe('manicura');
    expect(normalizeServiceName('unas uñas de gel')).toBe('unas de gel');
    expect(normalizeServiceName('Combo A')).toBe('combo a');
    // Without the ñ, "una(s)" may be either: both readings, article first.
    expect(serviceNameReadings('unas de gel')).toEqual(['de gel', 'unas de gel']);
    expect(serviceNameReadings('la pedicura')).toEqual(['pedicura']);
    expect(serviceNameReadings('uñas de gel')).toEqual(['unas de gel']);
    expect(serviceNameReadings('una')).toEqual(['una']);
    expect(keyOf('quiero unas uñas de gel')).toBe('gel_manicure');
  });

  it('folds plurals onto a known singular only (gate re-review P2)', () => {
    expect(normalizeServiceText('fades')).toBe('fade');
    expect(normalizeServiceText('kids haircuts')).toBe('kids haircut');
    expect(normalizeServiceText('tapers lineups beards shape ups')).toBe('taper lineup beard shape up');
    expect(normalizeServiceText('cortes degradados colores')).toBe('corte degradado color');
    // Words that are already terms, or have no known singular, stay.
    expect(normalizeServiceText('highlights edges foils nails braids')).toBe('highlights edges foils nails braids');
    expect(normalizeServiceText('guys days')).toBe('guys days');
    // Extra singulars (a tenant's catalog words).
    expect(normalizeServiceText('braids', new Set(['braid']))).toBe('braid');

    expect(matchServiceTerm('fades')).toEqual({ key: 'fade', matchedText: 'fade', confidence: 1 });
    expect(keyOf('do you guys do fades?')).toBe('fade');
    expect(keyOf('kids haircuts')).toBe('kids_cut');
    expect(keyOf('tapers')).toBe('taper');
    expect(keyOf('lineups')).toBe('lineup');
    expect(keyOf('shape ups')).toBe('lineup');
    expect(keyOf('beards')).toBe('beard_trim');
    expect(keyOf('cortes')).toBe('haircut');
    expect(keyOf('degradados')).toBe('fade');
    expect(keyOf('highlights')).toBe('highlights');
    expect(keyOf('gel nails')).toBe('gel_manicure');
    // The contextual and multi-service rules are unchanged.
    expect(matchServiceTerm('edges')).toMatchObject({ key: 'lineup', confidence: 1 });
    expect(matchServiceTerm('line up an appointment')).toMatchObject({ key: 'lineup', confidence: 0.6 });
    expect(keyOf('haircuts and beards')).toBe('cut_and_beard');
    expect(matchServiceTerm('a haircut, also my beards trimmed')).toMatchObject({ key: 'cut_and_beard', confidence: 0.8 });
    expect(keyOf('fades and beards')).toBe('fade');
  });
});
