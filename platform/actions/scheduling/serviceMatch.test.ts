import { describe, expect, it } from 'vitest';
import type { CatalogService } from './availability';
import { resolveServiceByName } from './serviceMatch';

function svc(id: string, name: string, aliases?: string[]): CatalogService {
  return {
    id,
    name,
    durationMin: 30,
    bufferMin: 0,
    priceKind: 'hidden',
    priceCents: null,
    priceMaxCents: null,
    ...(aliases ? { aliases } : {}),
  };
}

const SHARP_LINE = {
  services: [
    svc('cut', 'Haircut', ['regular cut', "men's cut", 'corte de pelo']),
    svc('fade', 'Fade', ['skin fade', 'bald fade', 'low fade', 'degradado']),
    svc('taper', 'Taper', ['taper fade', 'low taper']),
    svc('lineup', 'Lineup', ['shape-up', 'edge up', 'perfilado']),
    svc('beard', 'Beard trim', ['beard line-up', 'arreglo de barba']),
    svc('combo', 'Haircut and beard', ['cut and beard', 'corte y barba']),
    svc('shave', 'Hot towel shave', ['straight razor shave', 'afeitado']),
    svc('kids', 'Kids cut', ["kid's haircut", 'corte para niños']),
  ],
};

function idOf(text: string, catalog: { services: CatalogService[] } = SHARP_LINE) {
  return resolveServiceByName(catalog, text).service?.id ?? null;
}

describe('resolveServiceByName', () => {
  it('matches the exact name first', () => {
    const catalog = { services: [svc('skin', 'Skin Fade'), svc('fade', 'Fade')] };
    expect(resolveServiceByName(catalog, 'fade')).toMatchObject({
      service: { id: 'fade' },
      ambiguous: false,
      matchedBy: 'name',
      lexiconKey: 'fade',
    });
    expect(resolveServiceByName(catalog, 'Skin fade')).toMatchObject({ service: { id: 'skin' }, matchedBy: 'name' });
  });

  it('then an exact alias, case- and accent-insensitive', () => {
    expect(resolveServiceByName(SHARP_LINE, 'Bald Fade')).toMatchObject({ service: { id: 'fade' }, matchedBy: 'alias' });
    expect(idOf('shape up')).toBe('lineup');
    expect(idOf('corte para ninos')).toBe('kids');
    expect(idOf('Afeitado')).toBe('shave');
  });

  it('then a name or alias inside a sentence, longest phrase first', () => {
    expect(resolveServiceByName(SHARP_LINE, "I'm looking for a fade")).toMatchObject({ service: { id: 'fade' }, matchedBy: 'name_in_text' });
    expect(idOf('can I get a haircut and beard on Saturday')).toBe('combo');
    expect(resolveServiceByName(SHARP_LINE, 'can I get a skin fade at 9')).toMatchObject({ service: { id: 'fade' }, matchedBy: 'alias_in_text' });
    expect(idOf('a low taper please')).toBe('taper');
  });

  it('falls back to the lexicon when the catalog has no matching name or alias', () => {
    const bare = {
      services: [svc('cut', 'Haircut'), svc('fade', 'Fade'), svc('line', 'Line-Up'), svc('beard', 'Beard Trim')],
    };
    expect(resolveServiceByName(bare, 'quiero un degradado')).toMatchObject({
      service: { id: 'fade' },
      matchedBy: 'lexicon',
      lexiconKey: 'fade',
    });
    expect(idOf('a mid fade', bare)).toBe('fade');
    expect(idOf('shape-up', bare)).toBe('line');
    expect(idOf('arreglo de barba', bare)).toBe('beard');
    expect(idOf('corte de pelo', bare)).toBe('cut');
  });

  it('lets a longer lexicon phrase beat a shorter name inside the text', () => {
    const bare = { services: [svc('cut', 'Haircut'), svc('kids', 'Kids Cut'), svc('fade', 'Fade')] };
    expect(idOf("my kid's haircut", bare)).toBe('kids');
    expect(idOf('a haircut, like a low fade', bare)).toBe('fade');
    const noKids = { services: [svc('cut', 'Haircut')] };
    expect(idOf("my kid's haircut", noKids)).toBe('cut');
  });

  it('prefers the plain service when several mean the same thing', () => {
    const catalog = { services: [svc('skin', 'Skin Fade'), svc('fade', 'Fade')] };
    expect(resolveServiceByName(catalog, 'degradado')).toMatchObject({ service: { id: 'fade' }, matchedBy: 'lexicon' });
    // "low fade" contains the name "Fade", which already means fade.
    expect(resolveServiceByName(catalog, 'low fade')).toMatchObject({ service: { id: 'fade' }, matchedBy: 'name_in_text' });
  });

  it('lets a longer alias inside the text beat a shorter name', () => {
    const catalog = { services: [svc('fade', 'Fade'), svc('special', 'Sharp Line Special', ['skin fade'])] };
    expect(resolveServiceByName(catalog, 'can I get a skin fade')).toMatchObject({ service: { id: 'special' }, matchedBy: 'alias_in_text' });
  });

  it('returns equal candidates as ambiguous for the agent to ask about', () => {
    const catalog = { services: [svc('skin', 'Skin Fade'), svc('bald', 'Bald Fade')] };
    const low = resolveServiceByName(catalog, 'low fade');
    expect(low.service).toBeNull();
    expect(low.ambiguous).toBe(true);
    expect(low.candidates.map((c) => c.id).sort()).toEqual(['bald', 'skin']);
    expect(low.matchedBy).toBe('lexicon');

    const twoAliases = { services: [svc('a', 'Fade', ['the usual']), svc('b', 'Taper', ['the usual'])] };
    expect(resolveServiceByName(twoAliases, 'the usual')).toMatchObject({ service: null, ambiguous: true, matchedBy: 'alias' });
  });

  it('returns no match for unknown or empty text', () => {
    expect(resolveServiceByName(SHARP_LINE, 'a pedicure')).toEqual({
      service: null,
      candidates: [],
      ambiguous: false,
      matchedBy: null,
      lexiconKey: 'pedicure',
    });
    expect(resolveServiceByName(SHARP_LINE, '').matchedBy).toBeNull();
    expect(resolveServiceByName(SHARP_LINE, 'Saturday at 9').service).toBeNull();
    expect(resolveServiceByName({ services: [] }, 'fade').service).toBeNull();
  });

  it('works on fixture catalogs without aliases', () => {
    expect(idOf('a fade', { services: [svc('fade', 'Fade')] })).toBe('fade');
  });
});
