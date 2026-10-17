// Spoken service text → one of the tenant's catalog services.
//
// Order of evidence, strongest first:
//   1. exact name        "Skin Fade" said as "skin fade"
//   2. exact alias       "bald fade" listed in the service's aliases
//   3. name or alias     "can I get a bald fade on Saturday" (longest
//      inside text       phrase wins across names and aliases)
//   4. lexicon key       "degradado" → fade → the service whose name or
//                        aliases mean fade (shared/scheduling/serviceLexicon)
// The first tier with any candidate decides. Inside a tier, the longest
// phrase wins; candidates that tie are returned as ambiguous (service: null)
// so the agent asks which one instead of guessing. Pure: no I/O.

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

function phrases(service: MatchableService, source: 'name' | 'alias'): string[] {
  const list = source === 'name' ? [service.name] : service.aliases ?? [];
  return list.map(normalizeServiceText).filter((p) => p.length > 0);
}

function containsPhrase(text: string, phrase: string): boolean {
  return ` ${text} `.includes(` ${phrase} `);
}

/** Services whose best phrase is longest; all of them when tied. */
function longest<S>(scored: { service: S; length: number }[]): { services: S[]; length: number } {
  const length = Math.max(0, ...scored.map((s) => s.length));
  return { services: length === 0 ? [] : scored.filter((s) => s.length === length).map((s) => s.service), length };
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
  const text = normalizeServiceText(spokenText);
  const lexicon = text ? matchServiceTerm(spokenText, lang) : null;
  const lexiconKey = lexicon && lexicon.confidence >= 0.8 ? lexicon.key : null;
  const none: ServiceMatchResult = { service: null, candidates: [], ambiguous: false, matchedBy: null, lexiconKey };
  if (!text) return none;
  const services = catalog.services;

  for (const source of ['name', 'alias'] as const) {
    const exact = services.filter((s) => phrases(s, source).includes(text));
    if (exact.length > 0) return result(exact, source, lexiconKey);
  }

  // A phrase inside the text decides, unless the lexicon recognized a longer
  // phrase that means a different service: "kids haircut" contains the name
  // "Haircut", but the caller asked for a kids cut.
  // Names and aliases compete on phrase length; a name wins a tie.
  // A contextual phrase ("line up", "edges") only counts when the lexicon
  // read it as a service here: "line up an appointment" is not a lineup.
  let inTextFallback: ServiceMatchResult | null = null;
  const counts = (p: string) =>
    containsPhrase(text, p) && (!isContextualServiceTerm(p) || (lexiconKey !== null && lexicon!.matchedText === p));
  const inTextLength = (s: S, source: 'name' | 'alias') =>
    Math.max(0, ...phrases(s, source).filter(counts).map((p) => p.length));
  const inText = longest(services.map((s) => ({ service: s, length: Math.max(inTextLength(s, 'name'), inTextLength(s, 'alias')) })));
  if (inText.services.length > 0) {
    const byName = inText.services.some((s) => inTextLength(s, 'name') === inText.length);
    const found = result(inText.services, byName ? 'name_in_text' : 'alias_in_text', lexiconKey);
    const lexiconOverrides = lexiconKey !== null
      && lexicon!.matchedText.length > inText.length
      && inText.services.every((s) => serviceKeyOf(s)?.key !== lexiconKey);
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
