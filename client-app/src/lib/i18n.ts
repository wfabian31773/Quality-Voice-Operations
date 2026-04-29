import i18n, { type ReadCallback } from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import enCommon from '../locales/en/common.json';

export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English', nativeLabel: 'English' },
  { code: 'es', label: 'Spanish', nativeLabel: 'Español' },
  { code: 'pt-BR', label: 'Portuguese (Brazil)', nativeLabel: 'Português (Brasil)' },
  { code: 'fr', label: 'French', nativeLabel: 'Français' },
  { code: 'de', label: 'German', nativeLabel: 'Deutsch' },
] as const;

export type SupportedLanguageCode = (typeof SUPPORTED_LANGUAGES)[number]['code'];

export const DEFAULT_LANGUAGE: SupportedLanguageCode = 'en';

export const I18N_STORAGE_KEY = 'qvo_lang';

const SUPPORTED_CODES = SUPPORTED_LANGUAGES.map((l) => l.code) as readonly SupportedLanguageCode[];

const NAMESPACES = ['common', 'docs', 'marketing', 'tenant', 'admin'] as const;
type Namespace = (typeof NAMESPACES)[number];

/**
 * Eager bundle: only English `common` ships with the entry chunk. Every other
 * (language, namespace) pair is fetched on demand by the dynamic-import backend
 * below so the public marketing landing, sign-in, and shell pages don't pay for
 * tenant/admin/docs/marketing translations they never render.
 */
const eagerResources = {
  en: { common: enCommon },
} as const;

/**
 * Lazy loaders for every (language, namespace) pair NOT in `eagerResources`.
 * Each `import(...)` becomes its own async chunk so a visitor browsing the
 * Spanish marketing site never downloads German tenant translations.
 */
const localeLoaders: Record<SupportedLanguageCode, Partial<Record<Namespace, () => Promise<{ default: Record<string, unknown> }>>>> = {
  en: {
    docs: () => import('../locales/en/docs.json'),
    marketing: () => import('../locales/en/marketing.json'),
    tenant: () => import('../locales/en/tenant.json'),
    admin: () => import('../locales/en/admin.json'),
  },
  es: {
    common: () => import('../locales/es/common.json'),
    docs: () => import('../locales/es/docs.json'),
    marketing: () => import('../locales/es/marketing.json'),
    tenant: () => import('../locales/es/tenant.json'),
    admin: () => import('../locales/es/admin.json'),
  },
  'pt-BR': {
    common: () => import('../locales/pt-BR/common.json'),
    docs: () => import('../locales/pt-BR/docs.json'),
    marketing: () => import('../locales/pt-BR/marketing.json'),
    tenant: () => import('../locales/pt-BR/tenant.json'),
    admin: () => import('../locales/pt-BR/admin.json'),
  },
  fr: {
    common: () => import('../locales/fr/common.json'),
    docs: () => import('../locales/fr/docs.json'),
    marketing: () => import('../locales/fr/marketing.json'),
    tenant: () => import('../locales/fr/tenant.json'),
    admin: () => import('../locales/fr/admin.json'),
  },
  de: {
    common: () => import('../locales/de/common.json'),
    docs: () => import('../locales/de/docs.json'),
    marketing: () => import('../locales/de/marketing.json'),
    tenant: () => import('../locales/de/tenant.json'),
    admin: () => import('../locales/de/admin.json'),
  },
};

const dynamicImportBackend = {
  type: 'backend' as const,
  init() {},
  read(language: string, namespace: string, callback: ReadCallback) {
    const loader = localeLoaders[language as SupportedLanguageCode]?.[namespace as Namespace];
    if (!loader) {
      callback(null, {});
      return;
    }
    loader()
      .then((mod) => callback(null, (mod as { default?: unknown }).default ?? mod))
      .catch((err: Error) => callback(err, null));
  },
};

/**
 * Map a raw BCP-47 tag (e.g. from `navigator.language` or `localStorage`) to one of
 * our SUPPORTED_LANGUAGES. Used as `detection.convertDetectedLanguage` so a visitor
 * with `pt-PT`, `fr-CA`, `de-AT`, `en-US`, etc. lands on the closest supported locale
 * on first visit instead of falling through to English.
 *
 * Order:
 *   1. Exact match (e.g. `pt-BR` → `pt-BR`)
 *   2. Any Portuguese variant (`pt`, `pt-PT`, `pt-AO`, …) → `pt-BR`
 *      (only Portuguese locale we ship today)
 *   3. Match by primary subtag (`fr-CA` → `fr`, `de-AT` → `de`, `es-MX` → `es`,
 *      `en-GB` → `en`)
 *   4. Fallback to DEFAULT_LANGUAGE (`en`)
 *
 * NOTE: We intentionally do *not* enable i18next's `nonExplicitSupportedLngs` —
 * a previous attempt to use it broke resource resolution for `pt-BR` because
 * i18next would strip the region and look up a non-existent `pt` resource.
 * Doing the mapping here keeps i18next's resolved language as one of the exact
 * supported codes, so resource lookup is unambiguous.
 */
export function resolveSupportedLanguage(detected: string | undefined | null): SupportedLanguageCode {
  if (!detected) return DEFAULT_LANGUAGE;

  if ((SUPPORTED_CODES as readonly string[]).includes(detected)) {
    return detected as SupportedLanguageCode;
  }

  const primary = detected.split('-')[0].toLowerCase();
  if (!primary) return DEFAULT_LANGUAGE;

  if (primary === 'pt') return 'pt-BR';

  const byPrimary = SUPPORTED_CODES.find(
    (code) => code.split('-')[0].toLowerCase() === primary,
  );
  if (byPrimary) return byPrimary;

  return DEFAULT_LANGUAGE;
}

/**
 * URL-prefix locale routing
 * --------------------------
 * The router treats `/<locale>/...` as a localized variant of the same route.
 * `getLocaleFromPath` returns the locale code when the first path segment is a
 * supported language (case-insensitive so `/pt-br/...` resolves the same as
 * `/pt-BR/...`); otherwise `null`.
 *
 * The default locale (`en`) is intentionally served from un-prefixed URLs so
 * existing inbound links and SEO continue to work — `/en/pricing` is still
 * accepted as an alias and resolves to the English bundle.
 */
export function getLocaleFromPath(pathname: string): SupportedLanguageCode | null {
  if (!pathname) return null;
  const match = pathname.match(/^\/([A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?)(?=\/|$)/);
  if (!match) return null;
  const candidate = match[1];
  const exact = (SUPPORTED_CODES as readonly string[]).find((c) => c === candidate);
  if (exact) return exact as SupportedLanguageCode;
  const ci = SUPPORTED_CODES.find((c) => c.toLowerCase() === candidate.toLowerCase());
  return ci ?? null;
}

/** Strip a leading `/<locale>` prefix from the path. Returns `/` if only the prefix was present. */
export function stripLocalePrefix(pathname: string): string {
  const locale = getLocaleFromPath(pathname);
  if (!locale) return pathname || '/';
  // The matched segment in the URL may differ in casing from the canonical
  // SUPPORTED_LANGUAGES entry (e.g. `/pt-br/...`), so strip by length, not by
  // string concat with the canonical code.
  const m = pathname.match(/^\/[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?/);
  const stripped = m ? pathname.slice(m[0].length) : pathname;
  return stripped || '/';
}

/**
 * Build a path string with the appropriate locale prefix.
 *  - `en` (default): returned un-prefixed, e.g. `/pricing`.
 *  - other locales: prefixed, e.g. `/pt-BR/pricing`.
 *
 * Always returns a leading-slash absolute path. The input may or may not start
 * with `/` and may already include a different locale prefix, which is stripped
 * first so this function is idempotent.
 */
export function withLocalePrefix(locale: SupportedLanguageCode, path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const withoutPrefix = stripLocalePrefix(normalized);
  if (locale === DEFAULT_LANGUAGE) return withoutPrefix;
  if (withoutPrefix === '/') return `/${locale}`;
  return `/${locale}${withoutPrefix}`;
}

if (!i18n.isInitialized) {
  // Custom detectors so the URL prefix and ?lang= query string take priority
  // over localStorage. This is what makes `/pt-BR/pricing` and `/?lang=fr`
  // shareable: a recipient lands in the sender's language regardless of their
  // own browser/localStorage preference.
  const detector = new LanguageDetector();
  detector.addDetector({
    name: 'urlPath',
    lookup() {
      if (typeof window === 'undefined') return undefined;
      return getLocaleFromPath(window.location.pathname) ?? undefined;
    },
    cacheUserLanguage() {},
  });

  i18n
    .use(dynamicImportBackend)
    .use(detector)
    .use(initReactI18next)
    .init({
      resources: eagerResources,
      partialBundledLanguages: true,
      fallbackLng: DEFAULT_LANGUAGE,
      supportedLngs: SUPPORTED_CODES as unknown as string[],
      defaultNS: 'common',
      ns: NAMESPACES as unknown as string[],
      load: 'currentOnly',
      interpolation: { escapeValue: false },
      detection: {
        // Order matters: URL prefix wins, then ?lang=, then prior manual
        // choice, then browser language, then the <html lang> attribute.
        order: ['urlPath', 'querystring', 'localStorage', 'navigator', 'htmlTag'],
        lookupQuerystring: 'lang',
        lookupLocalStorage: I18N_STORAGE_KEY,
        // localStorage is cached so manual picks survive across visits, but
        // urlPath / querystring intentionally aren't — they reflect the URL,
        // not the user's preference, so they shouldn't persist if removed.
        caches: ['localStorage'],
        convertDetectedLanguage: resolveSupportedLanguage,
      },
      returnNull: false,
    });
}

function syncHtmlLang(lng: string) {
  if (typeof document !== 'undefined') {
    const supportedCodes = SUPPORTED_LANGUAGES.map((l) => l.code) as readonly string[];
    const exact = supportedCodes.includes(lng) ? lng : null;
    const matched =
      exact ||
      supportedCodes.find((code) => code.split('-')[0] === (lng || '').split('-')[0]) ||
      DEFAULT_LANGUAGE;
    document.documentElement.lang = matched;
  }
}

syncHtmlLang(i18n.language || DEFAULT_LANGUAGE);
i18n.on('languageChanged', syncHtmlLang);

export default i18n;
