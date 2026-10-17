// Barbershop / salon service vocabulary (EN + ES).
//
// Maps the words callers actually say ("a skin fade", "shape-up", "quiero un
// degradado") to a canonical service key. It is data, used three ways:
//   - catalog aliases: the demo seed writes serviceAliases(key) into
//     scheduling_appointment_types.aliases;
//   - platform/actions/scheduling/serviceMatch.ts: matches spoken text to a
//     tenant's catalog services (name → aliases → lexicon key), which
//     scheduling.list_services uses for its `query` input;
//   - speech-recognizer keyterms (serviceKeyterms.ts).
// It is deliberately NOT wired into the ReasoningEngine keyword/slot
// matching (that path is leaving the live call). Pure data + string
// matching: no I/O, no imports.
//
// Taper vs fade: a term goes to `taper` only when it says taper ("taper",
// "low taper", "taper fade", "tapered sides"). Every other fade, including
// "low fade" and its Spanish form "degradado bajo", is `fade`. Shops sell
// them as separate services, and "low fade" is a fade height, not a taper.

export const SERVICE_KEYS = [
  'fade',
  'taper',
  'haircut',
  'lineup',
  'beard_trim',
  'cut_and_beard',
  'hot_towel_shave',
  'kids_cut',
  'blowout',
  'color',
  'highlights',
  'manicure',
  'pedicure',
  'gel_manicure',
] as const;
export type ServiceKey = (typeof SERVICE_KEYS)[number];

export type ServiceLang = 'en' | 'es';

export interface ServiceTermMatch {
  key: ServiceKey;
  /** The matched phrase, normalized (lowercase, no accents or punctuation, articles dropped). */
  matchedText: string;
  /**
   * 1 = the whole utterance is the term; 0.9 = term inside a sentence; 0.8 =
   * combined; 0.6 = weak ("for my son", or "line up" with no service context).
   */
  confidence: number;
}

/** Matches at or above this are safe to act on without asking (slot fill, intent). */
export const STRONG_MATCH_CONFIDENCE = 0.8;

interface LexiconEntry {
  label: Record<ServiceLang, string>;
  terms: Record<ServiceLang, string[]>;
  /** Context phrases that hint at the service but are not a service name. */
  weak?: Partial<Record<ServiceLang, string[]>>;
  /**
   * Everyday words that name the service only with service context: the
   * whole utterance ("line up"), or right after an article or possessive
   * ("a line up", "get a line up", "my edges"). Otherwise weak: "I'd like to
   * line up an appointment" is not a lineup. Not aliases.
   */
  contextual?: Partial<Record<ServiceLang, string[]>>;
}

const LEXICON: Record<ServiceKey, LexiconEntry> = {
  fade: {
    label: { en: 'Fade', es: 'Degradado' },
    terms: {
      en: [
        'fade', 'fade cut', 'fade haircut', 'skin fade', 'bald fade', 'zero fade',
        'low fade', 'mid fade', 'medium fade', 'high fade', 'drop fade', 'burst fade',
        'temple fade', 'temp fade',
      ],
      es: [
        'degradado', 'desvanecido', 'corte degradado', 'degradado bajo', 'degradado medio',
        'degradado alto', 'corte fade',
      ],
    },
  },
  taper: {
    label: { en: 'Taper', es: 'Taper' },
    terms: {
      en: [
        'taper', 'taper fade', 'low taper', 'low taper fade', 'mid taper', 'high taper',
        'tapered sides', 'taper on the sides', 'tapered cut', 'tapered haircut',
      ],
      es: ['corte taper', 'degradado taper'],
    },
  },
  haircut: {
    label: { en: 'Haircut', es: 'Corte de pelo' },
    terms: {
      en: [
        'haircut', 'hair cut', 'cut', 'trim', 'hair trim', 'regular cut', 'regular haircut',
        "men's cut", "men's haircut", 'mens cut', 'scissor cut', 'clipper cut', 'buzz cut',
        'buzzcut', 'crew cut', 'cut my hair', 'get my hair cut',
      ],
      es: [
        'corte', 'corte de pelo', 'corte de cabello', 'recorte', 'corte regular',
        'corte de caballero', 'corte con tijera', 'corte con máquina', 'cortarme el pelo',
        'cortarme el cabello',
      ],
    },
    weak: { en: ['buzz'] },
  },
  lineup: {
    label: { en: 'Lineup', es: 'Perfilado' },
    terms: {
      en: ['lineup', 'shape-up', 'shape up', 'shapeup', 'edge-up', 'edge up', 'edgeup'],
      es: ['perfilado', 'arreglo de contorno', 'perfilar', 'contorno'],
    },
    contextual: { en: ['line-up', 'line up', 'edges', 'hairline'] },
  },
  beard_trim: {
    label: { en: 'Beard trim', es: 'Arreglo de barba' },
    terms: {
      en: [
        'beard trim', 'beard', 'beard line-up', 'beard line up', 'beard lineup',
        'beard shape-up', 'beard shape up', 'beard edge up', 'trim my beard', 'beard trimmed',
        'mustache trim', 'moustache trim', 'mustache', 'goatee',
      ],
      es: [
        'arreglo de barba', 'recorte de barba', 'perfilado de barba', 'barba',
        'arreglar la barba', 'arreglarme la barba', 'bigote',
      ],
    },
  },
  cut_and_beard: {
    label: { en: 'Haircut and beard', es: 'Corte y barba' },
    terms: {
      en: [
        'cut and beard', 'haircut and beard', 'cut + beard', 'haircut + beard',
        'cut and beard trim', 'haircut and beard trim', 'haircut with beard trim',
        'cut plus beard', 'the works',
      ],
      es: ['corte y barba', 'corte de pelo y barba', 'corte y arreglo de barba', 'corte con barba'],
    },
  },
  hot_towel_shave: {
    label: { en: 'Hot towel shave', es: 'Afeitado con toalla caliente' },
    terms: {
      en: [
        'hot towel shave', 'straight razor shave', 'razor shave', 'shave', 'head shave',
        'shave my head', 'clean shave', 'hot towel',
      ],
      es: [
        'afeitado', 'afeitado con toalla caliente', 'afeitada', 'rasurado', 'rasurar',
        'toalla caliente', 'afeitado de cabeza',
      ],
    },
  },
  kids_cut: {
    label: { en: 'Kids cut', es: 'Corte para niños' },
    terms: {
      en: [
        'kids cut', "kid's cut", "kid's haircut", 'kids haircut', 'kid haircut',
        "children's cut", "children's haircut", 'child haircut', 'boys cut', "boy's haircut",
        'boys haircut', 'girls haircut', 'toddler haircut', 'haircut for my son',
        'cut for my son', 'haircut for my daughter', 'cut for my daughter', 'haircut for my kid',
      ],
      es: [
        'corte para niños', 'corte infantil', 'corte de niño', 'corte para mi hijo',
        'corte para mi hija',
      ],
    },
    weak: {
      en: ['for my son', 'for my daughter', 'for my kid', 'for my boy'],
      es: ['para mi hijo', 'para mi hija', 'para mi niño'],
    },
  },
  blowout: {
    label: { en: 'Blowout', es: 'Secado' },
    terms: {
      en: ['blowout', 'blow out', 'blow-dry', 'blow dry', 'blowdry'],
      es: ['secado', 'brushing', 'secado con cepillo'],
    },
  },
  color: {
    label: { en: 'Color', es: 'Color' },
    terms: {
      en: ['color', 'colour', 'hair color', 'dye my hair', 'root touch-up', 'root touch up'],
      es: ['tinte', 'coloración', 'teñir', 'teñirme el pelo', 'retoque de raíces'],
    },
  },
  highlights: {
    label: { en: 'Highlights', es: 'Mechas' },
    terms: {
      en: ['highlights', 'balayage', 'foils', 'lowlights'],
      es: ['mechas', 'rayitos', 'reflejos'],
    },
  },
  manicure: {
    label: { en: 'Manicure', es: 'Manicura' },
    terms: {
      en: ['manicure', 'mani'],
      es: ['manicura'],
    },
  },
  pedicure: {
    label: { en: 'Pedicure', es: 'Pedicura' },
    terms: {
      en: ['pedicure', 'pedi'],
      es: ['pedicura'],
    },
  },
  gel_manicure: {
    label: { en: 'Gel manicure', es: 'Manicura de gel' },
    terms: {
      en: ['gel', 'gel manicure', 'gel nails', 'gel polish', 'shellac'],
      es: ['uñas de gel', 'manicura de gel', 'esmalte de gel'],
    },
  },
};

const DROPPED_WORDS = new Set(['a', 'an', 'un', 'una']);
const CONJUNCTIONS: Record<string, string> = { y: 'and', plus: 'and' };
/** Words that make a contextual term a service: "a line up", "my edges". */
const CONTEXT_WORDS = new Set(['a', 'an', 'the', 'my', 'his', 'her', 'un', 'una', 'el', 'mi', 'su']);

interface Word {
  text: string;
  /** Position in the token list before articles were dropped. */
  rawIndex: number;
}

function rawTokens(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[+&]/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w);
}

/** Every word used in a lexicon term ("fade", "haircut", "edges", "corte"). */
const TERM_WORDS = new Set(
  Object.values(LEXICON).flatMap((entry) =>
    [entry.terms, entry.contextual ?? {}, entry.weak ?? {}].flatMap((lists) =>
      [...(lists.en ?? []), ...(lists.es ?? [])].flatMap((term) =>
        rawTokens(term).filter((w) => !DROPPED_WORDS.has(w)).map((w) => CONJUNCTIONS[w] ?? w)))),
);

/**
 * A plural folded onto its singular, only when the singular is a known word
 * (a lexicon word, or one of `singulars`): "fades" → "fade", "cortes" →
 * "corte". A word that is itself a lexicon word stays ("highlights", "edges").
 */
function singular(word: string, singulars?: ReadonlySet<string>): string {
  if (TERM_WORDS.has(word)) return word;
  const known = (w: string) => w.length >= 2 && (TERM_WORDS.has(w) || singulars?.has(w) === true);
  if (word.endsWith('s') && known(word.slice(0, -1))) return word.slice(0, -1);
  if (word.endsWith('es') && known(word.slice(0, -2))) return word.slice(0, -2);
  return word;
}

function tokenize(text: string, singulars?: ReadonlySet<string>): { raw: string[]; words: Word[] } {
  const raw = rawTokens(text);
  const words: Word[] = [];
  raw.forEach((w, rawIndex) => {
    if (!DROPPED_WORDS.has(w)) words.push({ text: singular(CONJUNCTIONS[w] ?? w, singulars), rawIndex });
  });
  return { raw, words };
}

/**
 * Lowercase, strip accents and apostrophes, turn "+"/"&"/"y"/"plus" into
 * "and", drop articles (a, an, un, una), fold plurals onto a known singular,
 * and collapse everything else to single spaces. "Kid's line-up" → "kids line
 * up"; "Niño" → "nino"; "fades" → "fade". `singulars` adds words a plural may
 * fold onto besides the lexicon's (e.g. the tenant's catalog words).
 */
export function normalizeServiceText(text: string, singulars?: ReadonlySet<string>): string {
  return tokenize(text, singulars).words.map((w) => w.text).join(' ');
}

type TermKind = 'strong' | 'contextual' | 'weak';

interface IndexedTerm {
  key: ServiceKey;
  tokens: string[];
  text: string;
  lang: ServiceLang;
  kind: TermKind;
}

const INDEX: IndexedTerm[] = (() => {
  const seen = new Map<string, ServiceKey>();
  const out: IndexedTerm[] = [];
  for (const key of SERVICE_KEYS) {
    const entry = LEXICON[key];
    const lists: Record<TermKind, Partial<Record<ServiceLang, string[]>>> = {
      strong: entry.terms,
      contextual: entry.contextual ?? {},
      weak: entry.weak ?? {},
    };
    for (const kind of ['strong', 'contextual', 'weak'] as const) {
      for (const lang of ['en', 'es'] as const) {
        for (const term of lists[kind][lang] ?? []) {
          const text = normalizeServiceText(term);
          const owner = seen.get(text);
          if (owner && owner !== key) {
            throw new Error(`serviceLexicon: "${term}" maps to both ${owner} and ${key}`);
          }
          if (owner) continue;
          seen.set(text, key);
          out.push({ key, tokens: text.split(' '), text, lang, kind });
        }
      }
    }
  }
  // Longest first: more words, then more characters.
  return out.sort((a, b) => b.tokens.length - a.tokens.length || b.text.length - a.text.length);
})();

const CONTEXTUAL_TEXTS = new Set(INDEX.filter((t) => t.kind === 'contextual').map((t) => t.text));

/**
 * True for an everyday phrase that names a service only with service context
 * ("line up", "edges", "hairline"). Callers that look for a phrase inside a
 * sentence must not treat it as a service on its own.
 */
export function isContextualServiceTerm(phrase: string): boolean {
  return CONTEXTUAL_TEXTS.has(normalizeServiceText(phrase));
}

interface Hit {
  term: IndexedTerm;
  start: number;
  end: number;
  weak: boolean;
}

function findHits(raw: string[], words: Word[]): Hit[] {
  const tokens = words.map((w) => w.text);
  const hits: Hit[] = [];
  for (const term of INDEX) {
    const n = term.tokens.length;
    for (let i = 0; i + n <= tokens.length; i += 1) {
      let ok = true;
      for (let j = 0; j < n; j += 1) {
        if (tokens[i + j] !== term.tokens[j]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      let weak = term.kind === 'weak';
      if (term.kind === 'contextual') {
        const whole = i === 0 && n === tokens.length;
        weak = !whole && !CONTEXT_WORDS.has(raw[words[i].rawIndex - 1] ?? '');
      }
      hits.push({ term, start: i, end: i + n, weak });
    }
  }
  return hits;
}

/**
 * Best service term in an utterance: longest match first, accent- and
 * case-insensitive, whole words only ("cut" never matches inside "cute";
 * "hot towel shave" beats "shave"; "fades", "cortes" fold onto "fade",
 * "corte"). When the caller names several services:
 * a generic haircut next to a fade/taper/kids cut yields the specific one;
 * a haircut plus a beard trim ("a haircut and my beard trimmed") yields
 * `cut_and_beard`; anything else yields the first one mentioned.
 * `lang` only breaks ties between equally long terms; both languages are
 * always searched because callers mix them ("quiero un fade").
 */
export function matchServiceTerm(utterance: string, lang?: ServiceLang): ServiceTermMatch | null {
  const { raw, words } = tokenize(utterance);
  if (words.length === 0) return null;
  const normalized = words.map((w) => w.text).join(' ');
  const hits = findHits(raw, words);
  if (hits.length === 0) return null;

  // Strong terms beat weak context phrases; then INDEX order (longest first);
  // then the caller's language; then the earliest position.
  const ranked = hits
    .map((hit, order) => ({ hit, order: INDEX.indexOf(hit.term), seq: order }))
    .sort((a, b) =>
      Number(a.hit.weak) - Number(b.hit.weak)
      || a.order - b.order
      || Number(b.hit.term.lang === lang) - Number(a.hit.term.lang === lang)
      || a.hit.start - b.hit.start
      || a.seq - b.seq)
    .map((r) => r.hit);

  // Greedy non-overlapping selection, in ranked order.
  const chosen: Hit[] = [];
  for (const hit of ranked) {
    if (chosen.every((c) => hit.end <= c.start || hit.start >= c.end)) chosen.push(hit);
  }

  const strong = chosen.filter((c) => !c.weak).sort((a, b) => a.start - b.start);
  if (strong.length === 0) {
    return { key: chosen[0].term.key, matchedText: chosen[0].term.text, confidence: 0.6 };
  }

  const keys = new Set(strong.map((c) => c.term.key));
  const styled = keys.has('fade') || keys.has('taper') || keys.has('kids_cut');
  if (keys.has('haircut') && keys.has('beard_trim') && !styled && !keys.has('cut_and_beard')) {
    const parts = strong.filter((c) => c.term.key === 'haircut' || c.term.key === 'beard_trim');
    return { key: 'cut_and_beard', matchedText: parts.map((c) => c.term.text).join(' … '), confidence: 0.8 };
  }
  // "A haircut, like a low fade": the specific style wins over the generic
  // cut. Otherwise several services → the first one mentioned.
  const pick = strong.find((c) => !(styled && c.term.key === 'haircut')) ?? strong[0];
  const confidence = pick.term.text === normalized ? 1 : 0.9;
  return { key: pick.term.key, matchedText: pick.term.text, confidence };
}

/** Human label for a service key ("Fade", "Corte y barba"). */
export function serviceLabel(key: ServiceKey, lang: ServiceLang = 'en'): string {
  return LEXICON[key].label[lang];
}

/**
 * Spoken variants of a service, in display form ("skin fade", "degradado"),
 * deduplicated by normalized text. Weak and contextual phrases ("for my son",
 * "line up") are not aliases: a catalog alias matches anywhere in a sentence.
 * Without `lang`, English then Spanish.
 */
export function serviceAliases(key: ServiceKey, lang?: ServiceLang): string[] {
  const entry = LEXICON[key];
  const langs: ServiceLang[] = lang ? [lang] : ['en', 'es'];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of langs) {
    for (const term of entry.terms[l]) {
      const norm = normalizeServiceText(term);
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push(term);
    }
  }
  return out;
}
