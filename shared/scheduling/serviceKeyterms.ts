// Speech-recognizer keyterms from a tenant's service catalog.
//
// The realtime STT takes a short list of phrases to bias toward (xAI: at
// most 100 keyterms of at most 50 characters). This builds the service part
// of that list: every service name first, then the aliases (EN/ES), taken
// round-robin so each service gets its best aliases in before any service
// gets its tenth. Services with no catalog aliases borrow the lexicon's
// aliases for the service their name means ("Fade" → "skin fade",
// "degradado", ...). Pure: no I/O. Not wired into the voice gateway here
// (VA-05 does that, adding staff and business names).

import { matchServiceTerm, normalizeServiceText, serviceAliases, STRONG_MATCH_CONFIDENCE } from './serviceLexicon';

/** Hard limits of the recognizer: never exceeded, whatever the options say. */
export const KEYTERM_MAX_COUNT = 100;
export const KEYTERM_MAX_LENGTH = 50;

export interface KeytermService {
  name: string;
  aliases?: string[];
}

export interface ServiceKeytermOptions {
  /** Most entries to return (capped at 100). */
  max?: number;
  /** Longest entry in characters (capped at 50); longer phrases are skipped, not cut. */
  maxLen?: number;
  /** Fill alias-less services from the EN/ES lexicon (default true). */
  lexiconFallback?: boolean;
}

function aliasesOf(service: KeytermService, lexiconFallback: boolean): string[] {
  if (service.aliases && service.aliases.length > 0) return service.aliases;
  if (!lexiconFallback) return [];
  const match = matchServiceTerm(service.name);
  return match && match.confidence >= STRONG_MATCH_CONFIDENCE ? serviceAliases(match.key) : [];
}

/**
 * Ranked, deduplicated keyterms for a catalog: names, then aliases
 * round-robin. Duplicates are judged on normalized text ("Line-Up" and
 * "line up" are one entry; the first spelling wins).
 */
export function buildServiceKeyterms(
  catalog: { services: KeytermService[] },
  options: ServiceKeytermOptions = {},
): string[] {
  const max = Math.max(0, Math.min(options.max ?? KEYTERM_MAX_COUNT, KEYTERM_MAX_COUNT));
  const maxLen = Math.max(0, Math.min(options.maxLen ?? KEYTERM_MAX_LENGTH, KEYTERM_MAX_LENGTH));
  const lexiconFallback = options.lexiconFallback ?? true;

  const out: string[] = [];
  const seen = new Set<string>();
  const add = (phrase: string) => {
    const term = phrase.replace(/\s+/g, ' ').trim();
    const key = normalizeServiceText(term) || term.toLowerCase();
    if (!term || term.length > maxLen || seen.has(key) || out.length >= max) return;
    seen.add(key);
    out.push(term);
  };

  for (const service of catalog.services) add(service.name);
  const lists = catalog.services.map((s) => aliasesOf(s, lexiconFallback));
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest && out.length < max; i += 1) {
    for (const list of lists) if (i < list.length) add(list[i]);
  }
  return out;
}
