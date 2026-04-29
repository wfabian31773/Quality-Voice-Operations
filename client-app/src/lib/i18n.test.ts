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
  resolveSupportedLanguage,
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
