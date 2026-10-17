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

  it('needs service context for a contextual alias inside a sentence', () => {
    const catalog = { services: [svc('lineup', 'Lineup', ['line up', 'edges']), svc('fade', 'Fade')] };
    expect(resolveServiceByName(catalog, 'line up an appointment for Friday')).toMatchObject({ service: null, candidates: [] });
    expect(resolveServiceByName(catalog, 'line up a time')).toMatchObject({ service: null, candidates: [] });
    expect(resolveServiceByName(catalog, 'can I get a line up')).toMatchObject({ service: { id: 'lineup' }, matchedBy: 'alias_in_text' });
    expect(resolveServiceByName(catalog, 'just my edges')).toMatchObject({ service: { id: 'lineup' } });
    expect(resolveServiceByName(catalog, 'line up')).toMatchObject({ service: { id: 'lineup' }, matchedBy: 'alias' });
    expect(idOf('line up an appointment')).toBeNull();
  });

  it('only lets overlapping phrases compete on length', () => {
    expect(resolveServiceByName(SHARP_LINE, 'kids cut')).toMatchObject({ service: { id: 'kids' }, candidates: [{ id: 'kids' }] });
    expect(resolveServiceByName(SHARP_LINE, 'can I get a kids cut on Friday').candidates.map((c) => c.id)).toEqual(['kids']);
    expect(resolveServiceByName(SHARP_LINE, 'a skin fade please').candidates.map((c) => c.id)).toEqual(['fade']);
  });

  it('returns every service named when the menu has no combo for them', () => {
    const catalog = { services: SHARP_LINE.services.map((s) => (s.id === 'beard' ? svc('beard', 'Beard trim', ['beard', 'beard line-up']) : s)) };
    for (const text of ['fade and beard', 'skin fade and beard trim', 'a fade and a beard trim on Saturday']) {
      const r = resolveServiceByName(catalog, text);
      expect(r.service).toBeNull();
      expect(r.ambiguous).toBe(true);
      expect(r.candidates.map((c) => c.id).sort()).toEqual(['beard', 'fade']);
    }
  });

  it('returns the combo service when the menu sells the pair together', () => {
    const catalog = { services: SHARP_LINE.services.map((s) => (s.id === 'beard' ? svc('beard', 'Beard trim', ['beard']) : s)) };
    expect(idOf('haircut and beard', catalog)).toBe('combo');
    expect(idOf('corte y barba', catalog)).toBe('combo');
    // "a haircut and a beard trim" drops its articles and contains the combo's name.
    expect(resolveServiceByName(catalog, 'a haircut and a beard trim')).toMatchObject({ service: { id: 'combo' }, matchedBy: 'name_in_text' });
    expect(resolveServiceByName(catalog, 'a haircut, also my beard')).toMatchObject({ service: { id: 'combo' }, matchedBy: 'lexicon' });
    const noCombo = { services: catalog.services.filter((s) => s.id !== 'combo') };
    expect(resolveServiceByName(noCombo, 'a haircut, also my beard').candidates.map((c) => c.id).sort()).toEqual(['beard', 'cut']);
  });

  it('works on fixture catalogs without aliases', () => {
    expect(idOf('a fade', { services: [svc('fade', 'Fade')] })).toBe('fade');
  });
});
