import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import enCommon from '../locales/en/common.json';
import enDocs from '../locales/en/docs.json';
import enMarketing from '../locales/en/marketing.json';
import enTenant from '../locales/en/tenant.json';
import enAdmin from '../locales/en/admin.json';
import esCommon from '../locales/es/common.json';
import esDocs from '../locales/es/docs.json';
import esMarketing from '../locales/es/marketing.json';
import esTenant from '../locales/es/tenant.json';
import esAdmin from '../locales/es/admin.json';
import ptBRCommon from '../locales/pt-BR/common.json';
import ptBRDocs from '../locales/pt-BR/docs.json';
import ptBRMarketing from '../locales/pt-BR/marketing.json';
import ptBRTenant from '../locales/pt-BR/tenant.json';
import ptBRAdmin from '../locales/pt-BR/admin.json';
import frCommon from '../locales/fr/common.json';
import frDocs from '../locales/fr/docs.json';
import frMarketing from '../locales/fr/marketing.json';
import frTenant from '../locales/fr/tenant.json';
import frAdmin from '../locales/fr/admin.json';
import deCommon from '../locales/de/common.json';
import deDocs from '../locales/de/docs.json';
import deMarketing from '../locales/de/marketing.json';
import deTenant from '../locales/de/tenant.json';
import deAdmin from '../locales/de/admin.json';

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

const resources = {
  en: { common: enCommon, docs: enDocs, marketing: enMarketing, tenant: enTenant, admin: enAdmin },
  es: { common: esCommon, docs: esDocs, marketing: esMarketing, tenant: esTenant, admin: esAdmin },
  'pt-BR': { common: ptBRCommon, docs: ptBRDocs, marketing: ptBRMarketing, tenant: ptBRTenant, admin: ptBRAdmin },
  fr: { common: frCommon, docs: frDocs, marketing: frMarketing, tenant: frTenant, admin: frAdmin },
  de: { common: deCommon, docs: deDocs, marketing: deMarketing, tenant: deTenant, admin: deAdmin },
} as const;

const SUPPORTED_CODES = SUPPORTED_LANGUAGES.map((l) => l.code) as readonly SupportedLanguageCode[];

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

if (!i18n.isInitialized) {
  i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources,
      fallbackLng: DEFAULT_LANGUAGE,
      supportedLngs: SUPPORTED_CODES as unknown as string[],
      defaultNS: 'common',
      ns: ['common', 'docs', 'marketing', 'tenant', 'admin'],
      interpolation: { escapeValue: false },
      detection: {
        order: ['localStorage', 'navigator', 'htmlTag'],
        lookupLocalStorage: I18N_STORAGE_KEY,
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
