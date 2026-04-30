// @vitest-environment happy-dom
/**
 * Regression suite for `searchDocsLocalized` — the locale-aware doc search
 * used by the public docs index and the in-app help widget.
 *
 * What this guards against:
 *   1. Searching for a translated phrase (e.g. "primer agente" in Spanish)
 *      must return the matching article. Before this fix the search only
 *      indexed the English source so non-English users could see translated
 *      titles but could not find them by typing in their own language.
 *   2. The English source must remain searchable in English mode (the
 *      regression guard called out in the task — translated search must not
 *      break the existing English experience).
 *   3. Results must come back pre-translated (title, description, and body)
 *      so callers can render them directly without re-translating.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import i18next, { type i18n as I18nInstance } from 'i18next';

import enDocs from '../locales/en/docs.json';
import esDocs from '../locales/es/docs.json';
import frDocs from '../locales/fr/docs.json';
import deDocs from '../locales/de/docs.json';
import ptBrDocs from '../locales/pt-BR/docs.json';

import { searchDocsLocalized } from './translateDoc';

let instance: I18nInstance;

beforeAll(async () => {
  instance = i18next.createInstance();
  await instance.init({
    lng: 'en',
    fallbackLng: 'en',
    supportedLngs: ['en', 'es', 'fr', 'de', 'pt-BR'],
    defaultNS: 'docs',
    ns: ['docs'],
    resources: {
      en: { docs: enDocs },
      es: { docs: esDocs },
      fr: { docs: frDocs },
      de: { docs: deDocs },
      'pt-BR': { docs: ptBrDocs },
    },
    interpolation: { escapeValue: false },
    returnNull: false,
  });
});

function withLanguage<T>(lng: string, fn: () => T): T {
  // i18next.changeLanguage is async; for our test instance we can flip the
  // language synchronously via the public setter and rely on the resources
  // we eagerly loaded above.
  const previous = instance.language;
  instance.changeLanguage(lng);
  try {
    return fn();
  } finally {
    instance.changeLanguage(previous);
  }
}

function search(query: string) {
  return searchDocsLocalized(query, instance, (key) => instance.t(key, { ns: 'docs' }) as string);
}

describe('searchDocsLocalized — Spanish (translated phrases must match)', () => {
  it('returns the "building-your-first-agent" article when searching the Spanish title', () => {
    withLanguage('es', () => {
      const results = search('primer agente');
      const slugs = results.map((r) => r.slug);
      expect(slugs).toContain('building-your-first-agent');
    });
  });

  it('returns the "quickstart" article when searching the Spanish title', () => {
    withLanguage('es', () => {
      const results = search('guía rápida');
      const slugs = results.map((r) => r.slug);
      expect(slugs).toContain('quickstart');
    });
  });

  it('returns the "core-concepts" article when searching its Spanish title', () => {
    withLanguage('es', () => {
      const results = search('conceptos básicos');
      const slugs = results.map((r) => r.slug);
      expect(slugs).toContain('core-concepts');
    });
  });

  it('returns articles whose translated body (not just title) mentions the query', () => {
    // "inquilino" appears in the translated body of core-concepts and other
    // articles but never in the English source — proves we index translated
    // body text, not just titles.
    withLanguage('es', () => {
      const results = search('inquilino');
      const slugs = results.map((r) => r.slug);
      expect(slugs).toContain('core-concepts');
    });
  });

  it('returns results pre-translated (title and description in Spanish)', () => {
    withLanguage('es', () => {
      const results = search('primer agente');
      const article = results.find((r) => r.slug === 'building-your-first-agent');
      expect(article?.title).toBe('Construyendo tu primer agente');
      expect(article?.description).toMatch(/voz/i);
    });
  });
});

describe('searchDocsLocalized — English regression guard', () => {
  it('returns the quickstart article for an English query (regression-safe)', () => {
    withLanguage('en', () => {
      const results = search('quickstart');
      const slugs = results.map((r) => r.slug);
      expect(slugs).toContain('quickstart');
    });
  });

  it('still matches body text in English mode', () => {
    withLanguage('en', () => {
      const results = search('tenant');
      const slugs = results.map((r) => r.slug);
      expect(slugs).toContain('core-concepts');
    });
  });

  it('returns English titles in English mode', () => {
    withLanguage('en', () => {
      const results = search('quickstart');
      const article = results.find((r) => r.slug === 'quickstart');
      expect(article?.title.toLowerCase()).toContain('quickstart');
    });
  });

  it('returns an empty array for blank queries', () => {
    withLanguage('en', () => {
      expect(search('')).toEqual([]);
      expect(search('   ')).toEqual([]);
    });
  });

  it('does not return Spanish-only matches when the active locale is English', () => {
    // "inquilino" is Spanish for "tenant" and never appears in the English
    // source. Searching for it in English mode must return zero results.
    withLanguage('en', () => {
      const results = search('inquilino');
      expect(results).toEqual([]);
    });
  });
});

describe('searchDocsLocalized — other locales', () => {
  it('matches a French query against translated French content', () => {
    withLanguage('fr', () => {
      // Sanity check: confirm the locale's docs.json actually contains the
      // article title key — if the bundle ever changes shape this assertion
      // tells us before the search assertion fires a misleading miss.
      expect(instance.exists('articles.quickstart.title', { ns: 'docs' })).toBe(true);
      const translatedTitle = (instance.t('articles.quickstart.title', { ns: 'docs' }) as string).toLowerCase();
      // Search using the first significant word of the translated title.
      const probe = translatedTitle.split(/\s+/).find((w) => w.length > 4) ?? translatedTitle;
      const results = search(probe);
      expect(results.map((r) => r.slug)).toContain('quickstart');
    });
  });

  it('matches a German query against translated German content', () => {
    withLanguage('de', () => {
      expect(instance.exists('articles.quickstart.title', { ns: 'docs' })).toBe(true);
      const translatedTitle = (instance.t('articles.quickstart.title', { ns: 'docs' }) as string).toLowerCase();
      const probe = translatedTitle.split(/\s+/).find((w) => w.length > 4) ?? translatedTitle;
      const results = search(probe);
      expect(results.map((r) => r.slug)).toContain('quickstart');
    });
  });

  it('matches a Brazilian Portuguese query against translated content', () => {
    withLanguage('pt-BR', () => {
      expect(instance.exists('articles.quickstart.title', { ns: 'docs' })).toBe(true);
      const translatedTitle = (instance.t('articles.quickstart.title', { ns: 'docs' }) as string).toLowerCase();
      const probe = translatedTitle.split(/\s+/).find((w) => w.length > 4) ?? translatedTitle;
      const results = search(probe);
      expect(results.map((r) => r.slug)).toContain('quickstart');
    });
  });
});
