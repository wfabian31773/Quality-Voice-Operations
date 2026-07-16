// @vitest-environment happy-dom
/**
 * Regression suite for `searchMarketingPagesLocalized` — the locale-aware
 * marketing-page search used by the in-app Help widget and the public
 * Resources page.
 *
 * What this guards against:
 *   1. Searching for a translated marketing-page phrase (e.g. "precios" in
 *      Spanish) must return the matching page. Before this fix the search
 *      only indexed the English source so non-English users could see
 *      translated marketing pages in the catalog but could not find them by
 *      typing in their own language.
 *   2. The English source must remain searchable in English mode (the
 *      regression guard called out in the task — translated search must not
 *      break the existing English experience).
 *   3. Results must come back pre-translated (title, description, and
 *      categoryLabel) so callers can render them directly without
 *      re-translating.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import i18next, { type i18n as I18nInstance } from 'i18next';

import enMarketing from '../locales/en/marketing.json';
import esMarketing from '../locales/es/marketing.json';
import frMarketing from '../locales/fr/marketing.json';
import deMarketing from '../locales/de/marketing.json';
import ptBrMarketing from '../locales/pt-BR/marketing.json';

import { searchMarketingPagesLocalized } from './translateMarketingPage';

let instance: I18nInstance;

beforeAll(async () => {
  instance = i18next.createInstance();
  await instance.init({
    lng: 'en',
    fallbackLng: 'en',
    supportedLngs: ['en', 'es', 'fr', 'de', 'pt-BR'],
    defaultNS: 'marketing',
    ns: ['marketing'],
    resources: {
      en: { marketing: enMarketing },
      es: { marketing: esMarketing },
      fr: { marketing: frMarketing },
      de: { marketing: deMarketing },
      'pt-BR': { marketing: ptBrMarketing },
    },
    interpolation: { escapeValue: false },
    returnNull: false,
  });
});

function withLanguage<T>(lng: string, fn: () => T): T {
  const previous = instance.language;
  instance.changeLanguage(lng);
  try {
    return fn();
  } finally {
    instance.changeLanguage(previous);
  }
}

function search(query: string) {
  return searchMarketingPagesLocalized(
    query,
    instance,
    (key) => instance.t(key, { ns: 'marketing' }) as string,
  );
}

describe('searchMarketingPagesLocalized — Spanish (translated phrases must match)', () => {
  it('returns the pricing page when searching the Spanish title "precios"', () => {
    withLanguage('es', () => {
      const slugs = search('precios').map((r) => r.slug);
      expect(slugs).toContain('pricing');
    });
  });

  it('does not return the hidden features page when searching the Spanish title "características"', () => {
    withLanguage('es', () => {
      const slugs = search('características').map((r) => r.slug);
      expect(slugs).not.toContain('features');
    });
  });

  it('does not return the hidden integrations page when searching "integraciones"', () => {
    withLanguage('es', () => {
      const slugs = search('integraciones').map((r) => r.slug);
      expect(slugs).not.toContain('integrations');
    });
  });

  it('returns the healthcare page when searching the Spanish title "salud"', () => {
    withLanguage('es', () => {
      const slugs = search('salud').map((r) => r.slug);
      expect(slugs).toContain('healthcare');
    });
  });

  it('matches translated descriptions, not just titles', () => {
    // "consultorio" appears in the Spanish dental description but never in
    // the English source — proves we index translated description text.
    withLanguage('es', () => {
      const slugs = search('consultorio').map((r) => r.slug);
      expect(slugs).toContain('dental');
    });
  });

  it('returns results pre-translated (title, description, categoryLabel)', () => {
    withLanguage('es', () => {
      const page = search('precios').find((r) => r.slug === 'pricing');
      expect(page?.title).toBe('Precios');
      expect(page?.description).toMatch(/planes/i);
      expect(page?.categoryLabel).toBe('Producto');
    });
  });
});

describe('searchMarketingPagesLocalized — English regression guard', () => {
  it('returns the pricing page for an English query', () => {
    withLanguage('en', () => {
      const slugs = search('pricing').map((r) => r.slug);
      expect(slugs).toContain('pricing');
    });
  });

  it('does not match hidden integration description text in English mode', () => {
    withLanguage('en', () => {
      const slugs = search('hubspot').map((r) => r.slug);
      expect(slugs).not.toContain('integrations');
    });
  });

  it('returns English titles and English categoryLabel in English mode', () => {
    withLanguage('en', () => {
      const page = search('pricing').find((r) => r.slug === 'pricing');
      expect(page?.title).toBe('Pricing');
      expect(page?.categoryLabel).toBe('Product');
    });
  });

  it('returns an empty array for blank queries', () => {
    withLanguage('en', () => {
      expect(search('')).toEqual([]);
      expect(search('   ')).toEqual([]);
    });
  });

  it('does not return Spanish-only matches when the active locale is English', () => {
    // "precios" and "consultorio" are Spanish and never appear in the English
    // source. Searching for them in English mode must return zero results.
    withLanguage('en', () => {
      expect(search('precios')).toEqual([]);
      expect(search('consultorio')).toEqual([]);
    });
  });

  it('keeps English keywords searchable so English users typing English terms still hit', () => {
    // The dental page lists "dentist" as a keyword. In any locale, an
    // English keyword search should still match because we keep the English
    // keyword list in the haystack alongside the translated one.
    withLanguage('en', () => {
      const slugs = search('dentist').map((r) => r.slug);
      expect(slugs).toContain('dental');
    });
  });
});

describe('searchMarketingPagesLocalized — other locales', () => {
  it('matches a French query against the translated French title ("tarifs")', () => {
    withLanguage('fr', () => {
      const slugs = search('tarifs').map((r) => r.slug);
      expect(slugs).toContain('pricing');
    });
  });

  it('matches a German query against the translated German title ("preise")', () => {
    withLanguage('de', () => {
      const slugs = search('preise').map((r) => r.slug);
      expect(slugs).toContain('pricing');
    });
  });

  it('matches a Brazilian Portuguese query against the translated title ("preços")', () => {
    withLanguage('pt-BR', () => {
      const slugs = search('preços').map((r) => r.slug);
      expect(slugs).toContain('pricing');
    });
  });
});
