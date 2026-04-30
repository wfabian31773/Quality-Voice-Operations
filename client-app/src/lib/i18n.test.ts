// @vitest-environment happy-dom
/**
 * Regression suite for the first-visit language-detection logic in `i18n.ts`.
 *
 * What this guards against:
 *   1. `resolveSupportedLanguage` returning the wrong code for any supported
 *      locale, a regional variant of a supported locale, or an unsupported
 *      locale (which must fall back to `en`).
 *   2. The pt-BR resource-resolution regression: a previous attempt to use
 *      i18next's `nonExplicitSupportedLngs` silently broke pt-BR translation
 *      lookup because i18next stripped the region and tried to load a
 *      non-existent `pt` resource bundle. This file boots a fresh i18next
 *      instance with mocked `navigator.language` / `localStorage` and asserts
 *      that translated strings actually come back, not just that the resolved
 *      language code is right.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import i18next, { type i18n as I18nInstance } from 'i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import {
  DEFAULT_LANGUAGE,
  I18N_STORAGE_KEY,
  SUPPORTED_LANGUAGES,
  getLocaleFromPath,
  resolveSupportedLanguage,
  stripLocalePrefix,
  withLocalePrefix,
  type SupportedLanguageCode,
} from './i18n';

import enCommon from '../locales/en/common.json';
import esCommon from '../locales/es/common.json';
import ptBrCommon from '../locales/pt-BR/common.json';
import frCommon from '../locales/fr/common.json';
import deCommon from '../locales/de/common.json';

const SUPPORTED_CODES = SUPPORTED_LANGUAGES.map((l) => l.code) as readonly SupportedLanguageCode[];

describe('resolveSupportedLanguage', () => {
  // 1. Every supported locale must resolve to itself exactly.
  it.each(SUPPORTED_CODES.map((code) => [code]))(
    'resolves the supported code %s to itself',
    (code) => {
      expect(resolveSupportedLanguage(code)).toBe(code);
    },
  );

  // 2. At least one regional variant per supported locale must resolve to the
  //    base supported code (so visitors with `en-US`, `es-MX`, `fr-CA`, `de-AT`,
  //    `pt-PT` land somewhere sensible instead of falling through to English).
  const regionalVariants: Array<[string, SupportedLanguageCode]> = [
    ['en-US', 'en'],
    ['en-GB', 'en'],
    ['es-MX', 'es'],
    ['es-AR', 'es'],
    ['es-419', 'es'],
    ['fr-CA', 'fr'],
    ['fr-FR', 'fr'],
    ['de-AT', 'de'],
    ['de-CH', 'de'],
    // Portuguese is the special case: only pt-BR ships, but every Portuguese
    // variant (pt, pt-PT, pt-AO, …) must still resolve to it.
    ['pt', 'pt-BR'],
    ['pt-PT', 'pt-BR'],
    ['pt-AO', 'pt-BR'],
    ['PT-br', 'pt-BR'],
  ];
  it.each(regionalVariants)(
    'resolves regional variant %s to %s',
    (input, expected) => {
      expect(resolveSupportedLanguage(input)).toBe(expected);
    },
  );

  // 3. Unsupported locales fall back to the default (`en`).
  const unsupported: Array<string | undefined | null> = [
    'ja',
    'ja-JP',
    'zh',
    'zh-CN',
    'ru',
    'ar',
    'tlh', // Klingon — definitely not in the matrix
    '',
    undefined,
    null,
  ];
  it.each(unsupported.map((v) => [v]))(
    'falls back to the default language for unsupported input %s',
    (input) => {
      expect(resolveSupportedLanguage(input)).toBe(DEFAULT_LANGUAGE);
    },
  );
});

/**
 * Boot a fresh i18next instance that mirrors the production detection chain
 * (LanguageDetector + the same `convertDetectedLanguage`, `order`, and
 * `lookupLocalStorage` settings as `i18n.ts`) but with eager `resources` for
 * every locale so we can assert on translated strings without a backend.
 */
function bootInstance({
  navigatorLang,
  stored,
}: {
  navigatorLang?: string;
  stored?: string;
}): Promise<I18nInstance> {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.clear();
    if (stored) window.localStorage.setItem(I18N_STORAGE_KEY, stored);
  }
  if (typeof window !== 'undefined' && window.navigator) {
    Object.defineProperty(window.navigator, 'language', {
      configurable: true,
      get: () => navigatorLang ?? '',
    });
    Object.defineProperty(window.navigator, 'languages', {
      configurable: true,
      get: () => (navigatorLang ? [navigatorLang] : []),
    });
  }

  const instance = i18next.createInstance();
  return instance
    .use(LanguageDetector)
    .init({
      resources: {
        en: { common: enCommon },
        es: { common: esCommon },
        'pt-BR': { common: ptBrCommon },
        fr: { common: frCommon },
        de: { common: deCommon },
      },
      fallbackLng: DEFAULT_LANGUAGE,
      supportedLngs: SUPPORTED_CODES as unknown as string[],
      defaultNS: 'common',
      ns: ['common'],
      load: 'currentOnly',
      interpolation: { escapeValue: false },
      detection: {
        order: ['localStorage', 'navigator', 'htmlTag'],
        lookupLocalStorage: I18N_STORAGE_KEY,
        caches: [],
        convertDetectedLanguage: resolveSupportedLanguage,
      },
      returnNull: false,
    })
    .then(() => instance);
}

describe('i18next first-visit detection (end-to-end)', () => {
  beforeEach(() => {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.clear();
    }
  });

  afterEach(() => {
    if (typeof window !== 'undefined' && window.localStorage) {
      window.localStorage.clear();
    }
  });

  it('detects an exact pt-BR navigator and serves Portuguese strings (pt-BR resource regression guard)', async () => {
    const i = await bootInstance({ navigatorLang: 'pt-BR' });
    expect(i.language).toBe('pt-BR');
    expect(i.t('actions.sign_in')).toBe('Entrar');
  });

  it('detects pt-PT and still serves Portuguese strings via pt-BR', async () => {
    const i = await bootInstance({ navigatorLang: 'pt-PT' });
    expect(i.language).toBe('pt-BR');
    expect(i.t('actions.sign_in')).toBe('Entrar');
  });

  it('detects fr-CA and serves French strings', async () => {
    const i = await bootInstance({ navigatorLang: 'fr-CA' });
    expect(i.language).toBe('fr');
    expect(i.t('actions.sign_in')).toBe(frCommon.actions.sign_in);
  });

  it('detects de-AT and serves German strings', async () => {
    const i = await bootInstance({ navigatorLang: 'de-AT' });
    expect(i.language).toBe('de');
    expect(i.t('actions.sign_in')).toBe(deCommon.actions.sign_in);
  });

  it('detects es-MX and serves Spanish strings', async () => {
    const i = await bootInstance({ navigatorLang: 'es-MX' });
    expect(i.language).toBe('es');
    expect(i.t('actions.sign_in')).toBe(esCommon.actions.sign_in);
  });

  it('detects en-US and serves English strings', async () => {
    const i = await bootInstance({ navigatorLang: 'en-US' });
    expect(i.language).toBe('en');
    expect(i.t('actions.sign_in')).toBe(enCommon.actions.sign_in);
  });

  it('falls back to English when the navigator advertises an unsupported language', async () => {
    const i = await bootInstance({ navigatorLang: 'ja' });
    expect(i.language).toBe('en');
    expect(i.t('actions.sign_in')).toBe(enCommon.actions.sign_in);
  });

  it('honors a manual choice in localStorage over the navigator language', async () => {
    // Navigator says French, but the user previously picked Spanish — the
    // localStorage choice must win because it is first in the detector chain.
    const i = await bootInstance({ navigatorLang: 'fr-FR', stored: 'es' });
    expect(i.language).toBe('es');
    expect(i.t('actions.sign_in')).toBe(esCommon.actions.sign_in);
  });

  it('honors a manual pt-BR choice in localStorage over an English navigator', async () => {
    const i = await bootInstance({ navigatorLang: 'en-US', stored: 'pt-BR' });
    expect(i.language).toBe('pt-BR');
    expect(i.t('actions.sign_in')).toBe('Entrar');
  });
});

/**
 * URL-prefix locale routing
 * --------------------------
 * `getLocaleFromPath`, `stripLocalePrefix`, and `withLocalePrefix` underpin the
 * router's `/<locale>/...` URLs. These tests guard the contract that:
 *   - Every supported locale (and its mixed-case variants) is recognized as a
 *     prefix.
 *   - The default locale (`en`) is served from un-prefixed URLs but `/en/...`
 *     is still accepted as an alias.
 *   - `withLocalePrefix` is idempotent: re-prefixing an already-prefixed path
 *     produces a single, correct prefix instead of stacking them.
 *   - Bare `/` and prefix-only paths round-trip cleanly.
 *
 * Without these tests, a regression here would silently break shareable
 * marketing links and SEO without any QA signal.
 */
describe('getLocaleFromPath', () => {
  // Every supported locale must be detected at the start of the path.
  it.each(SUPPORTED_CODES.map((code) => [code]))(
    'detects the supported locale prefix %s',
    (code) => {
      expect(getLocaleFromPath(`/${code}/pricing`)).toBe(code);
      expect(getLocaleFromPath(`/${code}`)).toBe(code);
    },
  );

  // Mixed-case variants must resolve to the canonical SUPPORTED_LANGUAGES code.
  const mixedCase: Array<[string, SupportedLanguageCode]> = [
    ['/EN/pricing', 'en'],
    ['/En/pricing', 'en'],
    ['/ES/pricing', 'es'],
    ['/Es/pricing', 'es'],
    ['/FR/pricing', 'fr'],
    ['/Fr/pricing', 'fr'],
    ['/DE/pricing', 'de'],
    ['/De/pricing', 'de'],
    ['/pt-br/pricing', 'pt-BR'],
    ['/PT-BR/pricing', 'pt-BR'],
    ['/PT-br/pricing', 'pt-BR'],
    ['/Pt-Br/pricing', 'pt-BR'],
    ['/pt-BR/pricing', 'pt-BR'],
  ];
  it.each(mixedCase)(
    'normalizes mixed-case prefix %s to canonical %s',
    (input, expected) => {
      expect(getLocaleFromPath(input)).toBe(expected);
    },
  );

  // Paths without a locale prefix (or with a non-locale first segment) must
  // return null so the caller knows there is no prefix to strip.
  const noPrefix: string[] = [
    '/',
    '',
    '/pricing',
    '/pricing/team',
    '/about',
    '/blog/announcement',
    '/docs/getting-started',
    // These look locale-shaped but aren't supported — must return null, not
    // accidentally match the regex and lie.
    '/ja/pricing',
    '/zh-CN/pricing',
    '/ru/pricing',
    '/xx/pricing',
    // Numeric / path traversal / weird inputs.
    '/123/pricing',
    '/pricing/en',
    '/pricing/pt-BR/team',
  ];
  it.each(noPrefix.map((p) => [p]))(
    'returns null for path without a supported locale prefix: %s',
    (input) => {
      expect(getLocaleFromPath(input)).toBeNull();
    },
  );

  it('returns null for the bare root path', () => {
    expect(getLocaleFromPath('/')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(getLocaleFromPath('')).toBeNull();
  });
});

describe('stripLocalePrefix', () => {
  // Each supported locale prefix must be stripped from the front of the path.
  it.each(SUPPORTED_CODES.map((code) => [code]))(
    'strips the supported locale prefix %s',
    (code) => {
      expect(stripLocalePrefix(`/${code}/pricing`)).toBe('/pricing');
      expect(stripLocalePrefix(`/${code}/pricing/team`)).toBe('/pricing/team');
    },
  );

  // A path that is *only* the prefix (e.g. `/pt-BR`) must collapse to `/`.
  it.each(SUPPORTED_CODES.map((code) => [code]))(
    'returns / when the path is only the locale prefix %s',
    (code) => {
      expect(stripLocalePrefix(`/${code}`)).toBe('/');
    },
  );

  // Mixed-case prefixes must be stripped by length, not by string
  // concatenation with the canonical code, so `/pt-br/...` strips correctly.
  const mixedCaseStrip: Array<[string, string]> = [
    ['/pt-br/pricing', '/pricing'],
    ['/PT-BR/pricing', '/pricing'],
    ['/PT-br/pricing', '/pricing'],
    ['/EN/pricing', '/pricing'],
    ['/Es/pricing', '/pricing'],
    ['/Fr/about/team', '/about/team'],
    ['/pt-br', '/'],
    ['/PT-BR', '/'],
  ];
  it.each(mixedCaseStrip)(
    'strips mixed-case prefix from %s -> %s',
    (input, expected) => {
      expect(stripLocalePrefix(input)).toBe(expected);
    },
  );

  // Paths without a prefix are returned untouched — except the empty string,
  // which must be normalized to `/` so callers always get a usable path.
  it('leaves a path without a locale prefix untouched', () => {
    expect(stripLocalePrefix('/pricing')).toBe('/pricing');
    expect(stripLocalePrefix('/pricing/team')).toBe('/pricing/team');
    expect(stripLocalePrefix('/about')).toBe('/about');
  });

  it('returns / for the bare root path', () => {
    expect(stripLocalePrefix('/')).toBe('/');
  });

  it('returns / for an empty string', () => {
    expect(stripLocalePrefix('')).toBe('/');
  });

  // Paths whose first segment looks locale-shaped but isn't supported (e.g.
  // `/ja/pricing`) must be left alone — stripping a non-supported prefix would
  // silently corrupt the URL.
  it('leaves an unsupported locale-shaped first segment untouched', () => {
    expect(stripLocalePrefix('/ja/pricing')).toBe('/ja/pricing');
    expect(stripLocalePrefix('/zh-CN/pricing')).toBe('/zh-CN/pricing');
    expect(stripLocalePrefix('/xx/pricing')).toBe('/xx/pricing');
  });
});

describe('withLocalePrefix', () => {
  // Default locale (`en`) is served from un-prefixed URLs.
  it('returns un-prefixed paths for the default locale', () => {
    expect(withLocalePrefix('en', '/pricing')).toBe('/pricing');
    expect(withLocalePrefix('en', '/pricing/team')).toBe('/pricing/team');
    expect(withLocalePrefix('en', '/')).toBe('/');
  });

  // Non-default locales get prefixed.
  const nonDefault: Array<[SupportedLanguageCode, string, string]> = [
    ['es', '/pricing', '/es/pricing'],
    ['es', '/pricing/team', '/es/pricing/team'],
    ['fr', '/about', '/fr/about'],
    ['de', '/docs/getting-started', '/de/docs/getting-started'],
    ['pt-BR', '/pricing', '/pt-BR/pricing'],
    ['pt-BR', '/blog/announcement', '/pt-BR/blog/announcement'],
  ];
  it.each(nonDefault)(
    'prefixes %s onto %s -> %s',
    (locale, input, expected) => {
      expect(withLocalePrefix(locale, input)).toBe(expected);
    },
  );

  // The bare root maps to `/` for the default locale and `/<locale>` for
  // others — *not* `/<locale>/`, which would create a dangling trailing slash.
  it('maps the root path to / for the default locale', () => {
    expect(withLocalePrefix('en', '/')).toBe('/');
  });

  it.each(SUPPORTED_CODES.filter((c) => c !== DEFAULT_LANGUAGE).map((c) => [c]))(
    'maps the root path to /%s for non-default locale (no trailing slash)',
    (locale) => {
      expect(withLocalePrefix(locale, '/')).toBe(`/${locale}`);
    },
  );

  // Inputs that don't start with `/` get one added — callers shouldn't have to
  // care about leading slashes.
  it('prepends a leading slash to inputs that lack one', () => {
    expect(withLocalePrefix('en', 'pricing')).toBe('/pricing');
    expect(withLocalePrefix('es', 'pricing')).toBe('/es/pricing');
    expect(withLocalePrefix('pt-BR', 'about/team')).toBe('/pt-BR/about/team');
  });

  // Idempotency: re-prefixing an already-prefixed path must produce a single,
  // correct prefix instead of stacking them. This is what makes language
  // switching from inside a localized page work — the switcher hands the
  // current pathname (which already has a prefix) back to `withLocalePrefix`.
  describe('idempotency', () => {
    it('does not stack the same prefix when re-applied', () => {
      expect(withLocalePrefix('es', '/es/pricing')).toBe('/es/pricing');
      expect(withLocalePrefix('fr', '/fr/about')).toBe('/fr/about');
      expect(withLocalePrefix('de', '/de/docs/getting-started')).toBe(
        '/de/docs/getting-started',
      );
      expect(withLocalePrefix('pt-BR', '/pt-BR/pricing')).toBe('/pt-BR/pricing');
    });

    it('replaces a different existing locale prefix instead of nesting', () => {
      expect(withLocalePrefix('fr', '/es/pricing')).toBe('/fr/pricing');
      expect(withLocalePrefix('de', '/fr/about')).toBe('/de/about');
      expect(withLocalePrefix('pt-BR', '/es/pricing/team')).toBe(
        '/pt-BR/pricing/team',
      );
      expect(withLocalePrefix('es', '/pt-BR/pricing')).toBe('/es/pricing');
    });

    it('strips a non-default prefix when switching to the default locale', () => {
      expect(withLocalePrefix('en', '/es/pricing')).toBe('/pricing');
      expect(withLocalePrefix('en', '/pt-BR/pricing/team')).toBe(
        '/pricing/team',
      );
      expect(withLocalePrefix('en', '/fr/about')).toBe('/about');
      // `/en/pricing` is the un-prefixed alias case: re-applying `en` strips
      // the explicit `en/` and returns the canonical un-prefixed form.
      expect(withLocalePrefix('en', '/en/pricing')).toBe('/pricing');
    });

    it('handles mixed-case existing prefixes when switching locales', () => {
      expect(withLocalePrefix('fr', '/PT-BR/pricing')).toBe('/fr/pricing');
      expect(withLocalePrefix('en', '/pt-br/pricing')).toBe('/pricing');
      expect(withLocalePrefix('pt-BR', '/ES/pricing')).toBe('/pt-BR/pricing');
    });

    it('collapses a path that is only a (different) locale prefix to the new bare prefix', () => {
      expect(withLocalePrefix('fr', '/es')).toBe('/fr');
      expect(withLocalePrefix('en', '/es')).toBe('/');
      expect(withLocalePrefix('pt-BR', '/fr')).toBe('/pt-BR');
    });

    it('leaves an unsupported locale-shaped first segment in place', () => {
      // `/ja/...` isn't a supported prefix, so it must be treated as part of
      // the path and the new prefix simply prepended.
      expect(withLocalePrefix('es', '/ja/pricing')).toBe('/es/ja/pricing');
      expect(withLocalePrefix('en', '/ja/pricing')).toBe('/ja/pricing');
    });
  });
});
