// Spoken service text → one of the tenant's catalog services.
//
// Order of evidence, strongest first:
//   1. exact name        "Skin Fade" said as "skin fade"
//   2. exact alias       "bald fade" listed in the service's aliases
//   3. name or alias     "can I get a bald fade on Saturday" (of two
//      inside text       overlapping phrases the longer wins; separate
//                        phrases for different services → their combo
//                        service if the menu has one, else all of them)
//   4. lexicon key       "degradado" → fade → the service whose name or
//                        aliases mean fade (shared/scheduling/serviceLexicon)
// The first tier with any candidate decides. Several candidates (a tie, or
// several services named) come back as ambiguous (service: null) so the
// agent asks instead of guessing. Plurals fold onto a known singular on both
// sides ("fades" = "Fade"). Pure: no I/O.

import {
  isContextualServiceTerm,
  matchServiceTerm,
  normalizeServiceText,
  serviceLabel,
  type ServiceKey,
  type ServiceLang,
} from '../../../shared/scheduling/serviceLexicon';
import type { CatalogService } from './availability';

export type ServiceMatchSource = 'name' | 'alias' | 'name_in_text' | 'alias_in_text' | 'lexicon';

export interface ServiceMatchResult {
  /** The service to use, or null when nothing matched or the match is ambiguous. */
  service: CatalogService | null;
  /** Every service tied at the deciding tier (one entry when unambiguous). */
  candidates: CatalogService[];
  ambiguous: boolean;
  matchedBy: ServiceMatchSource | null;
  /** Lexicon key of the spoken text, when it has one. */
  lexiconKey: ServiceKey | null;
}

type MatchableService = Pick<CatalogService, 'id' | 'name' | 'aliases'>;

function phrases(service: MatchableService, source: 'name' | 'alias', singulars: ReadonlySet<string>): string[] {
  const list = source === 'name' ? [service.name] : service.aliases ?? [];
  return list.map((p) => normalizeServiceText(p, singulars)).filter((p) => p.length > 0);
}

/**
 * Every word in the catalog's names and aliases. A plural in the text or the
 * catalog folds onto one of these as well as onto a lexicon word ("braids"
 * → "braid" when the menu lists "Braid").
 */
function catalogWords(services: MatchableService[]): Set<string> {
  const words = new Set<string>();
  for (const service of services) {
    for (const phrase of [service.name, ...(service.aliases ?? [])]) {
      for (const word of normalizeServiceText(phrase).split(' ')) if (word) words.add(word);
    }
  }
  return words;
}

interface InTextHit<S> {
  service: S;
  source: 'name' | 'alias';
  phrase: string;
  start: number;
  end: number;
}

/**
 * Every name/alias occurrence in the text (token positions), keeping a hit
 * unless it overlaps a longer kept one. Equal-length overlaps all stay, so
 * two services sharing a phrase come back tied.
 */
function inTextHits<S extends MatchableService>(
  services: S[],
  text: string,
  singulars: ReadonlySet<string>,
  counts: (phrase: string) => boolean,
): InTextHit<S>[] {
  const tokens = text.split(' ');
  const all: InTextHit<S>[] = [];
  for (const service of services) {
    for (const source of ['name', 'alias'] as const) {
      for (const phrase of phrases(service, source, singulars)) {
        if (!counts(phrase)) continue;
        const words = phrase.split(' ');
        for (let i = 0; i + words.length <= tokens.length; i += 1) {
          if (words.every((w, j) => tokens[i + j] === w)) {
            all.push({ service, source, phrase, start: i, end: i + words.length });
          }
        }
      }
    }
  }
  all.sort((a, b) => b.phrase.length - a.phrase.length);
  const kept: InTextHit<S>[] = [];
  for (const hit of all) {
    const beaten = kept.some((k) => k.phrase.length > hit.phrase.length && hit.start < k.end && k.start < hit.end);
    if (!beaten) kept.push(hit);
  }
  return kept;
}

/** Specific haircut styles; a generic haircut named next to one is dropped. */
const STYLED = new Set<string>(['fade', 'taper', 'kids_cut']);

/** Lexicon combos: services a shop also sells as one (same rule as matchServiceTerm). */
const COMBOS: Partial<Record<ServiceKey, ServiceKey[]>> = { cut_and_beard: ['haircut', 'beard_trim'] };

/** The catalog's combo service for exactly these service keys, plain one preferred. */
function comboFor<S extends MatchableService>(services: S[], keys: (ServiceKey | null)[]): S[] {
  const named = new Set(keys);
  for (const [combo, parts] of Object.entries(COMBOS) as [ServiceKey, ServiceKey[]][]) {
    if (named.size !== parts.length || !parts.every((p) => named.has(p))) continue;
    const sameKey = services
      .map((s) => ({ service: s, meaning: serviceKeyOf(s) }))
      .filter((s) => s.meaning?.key === combo);
    const generic = sameKey.filter((s) => s.meaning!.generic);
    return (generic.length > 0 ? generic : sameKey).map((s) => s.service);
  }
  return [];
}

function result<S extends MatchableService>(
  candidates: S[],
  matchedBy: ServiceMatchSource,
  lexiconKey: ServiceKey | null,
): ServiceMatchResult {
  const unique = [...new Map(candidates.map((c) => [c.id, c])).values()] as unknown as CatalogService[];
  const ambiguous = unique.length > 1;
  return { service: ambiguous ? null : unique[0], candidates: unique, ambiguous, matchedBy, lexiconKey };
}

/**
 * Lexicon key a service stands for, from its name, else its aliases. "Skin
 * Fade" and "Fade" both mean fade; "Haircut and beard" means cut_and_beard.
 */
function serviceKeyOf(service: MatchableService): { key: ServiceKey; generic: boolean } | null {
  const fromName = matchServiceTerm(service.name);
  if (fromName && fromName.confidence >= 0.8) {
    // "Generic" = the name is just the canonical label ("Fade", "Haircut").
    const generic = normalizeServiceText(service.name) === normalizeServiceText(serviceLabel(fromName.key));
    return { key: fromName.key, generic };
  }
  for (const alias of service.aliases ?? []) {
    const fromAlias = matchServiceTerm(alias);
    if (fromAlias && fromAlias.confidence >= 0.8) return { key: fromAlias.key, generic: false };
  }
  return null;
}

export function resolveServiceByName<S extends MatchableService>(
  catalog: { services: S[] },
  spokenText: string,
  lang?: ServiceLang,
): ServiceMatchResult {
  // The same plural folding on both sides: "fades" = "Fade", "kids haircuts"
  // = "kids haircut", "cortes" = "corte".
  const singulars = catalogWords(catalog.services);
  const text = normalizeServiceText(spokenText, singulars);
  const lexicon = text ? matchServiceTerm(spokenText, lang) : null;
  const lexiconKey = lexicon && lexicon.confidence >= 0.8 ? lexicon.key : null;
  const none: ServiceMatchResult = { service: null, candidates: [], ambiguous: false, matchedBy: null, lexiconKey };
  if (!text) return none;
  const services = catalog.services;

  for (const source of ['name', 'alias'] as const) {
    const exact = services.filter((s) => phrases(s, source, singulars).includes(text));
    if (exact.length > 0) return result(exact, source, lexiconKey);
  }

  // Phrases inside the text. Only overlapping phrases compete on length
  // ("skin fade" beats "fade", "kids cut" beats "cut"); separate phrases each
  // name a service ("fade and beard" names two).
  // A contextual phrase ("line up", "edges") only counts when the lexicon
  // read it as a service here: "line up an appointment" is not a lineup.
  let inTextFallback: ServiceMatchResult | null = null;
  const counts = (p: string) =>
    !isContextualServiceTerm(p) || (lexiconKey !== null && lexicon!.matchedText === p);
  const hits = inTextHits(services, text, singulars, counts);
  if (hits.length > 0) {
    let named = [...new Set(hits.map((h) => h.service))];
    const keys = new Map(named.map((s) => [s, serviceKeyOf(s)?.key ?? null]));
    // "A haircut, like a low fade": the specific style wins over the generic cut.
    if (named.some((s) => STYLED.has(keys.get(s) ?? ''))) named = named.filter((s) => keys.get(s) !== 'haircut');
    const byName = hits.some((h) => named.includes(h.service) && h.source === 'name');
    if (named.length > 1) {
      // Two services the menu also sells together → the combo service.
      // Otherwise all of them, so the agent asks (or books each one).
      const combo = comboFor(services, named.map((s) => keys.get(s) ?? null));
      if (combo.length > 0) return result(combo, 'lexicon', lexiconKey);
      return result(named, byName ? 'name_in_text' : 'alias_in_text', lexiconKey);
    }
    // One service, unless the lexicon recognized a longer phrase that means a
    // different service: "kids haircut" contains the name "Haircut", but the
    // caller asked for a kids cut.
    const found = result(named, byName ? 'name_in_text' : 'alias_in_text', lexiconKey);
    const length = Math.max(...hits.filter((h) => h.service === named[0]).map((h) => h.phrase.length));
    const lexiconOverrides = lexiconKey !== null
      && lexicon!.matchedText.length > length
      && keys.get(named[0]) !== lexiconKey;
    if (!lexiconOverrides) return found;
    inTextFallback = found;
  }

  if (!lexiconKey) return inTextFallback ?? none;
  const sameKey = services
    .map((s) => ({ service: s, meaning: serviceKeyOf(s) }))
    .filter((s) => s.meaning?.key === lexiconKey);
  if (sameKey.length === 0) return inTextFallback ?? none;
  // "low fade" with "Fade" and "Skin Fade" on the menu: the plain "Fade"
  // service is the right default. Two non-generic ones stay ambiguous.
  const generic = sameKey.filter((s) => s.meaning!.generic);
  return result((generic.length > 0 ? generic : sameKey).map((s) => s.service), 'lexicon', lexiconKey);
}
