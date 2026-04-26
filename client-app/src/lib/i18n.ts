import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import enCommon from '../locales/en/common.json';
import enDocs from '../locales/en/docs.json';
import esCommon from '../locales/es/common.json';
import esDocs from '../locales/es/docs.json';
import ptBRCommon from '../locales/pt-BR/common.json';
import ptBRDocs from '../locales/pt-BR/docs.json';
import frCommon from '../locales/fr/common.json';
import frDocs from '../locales/fr/docs.json';
import deCommon from '../locales/de/common.json';
import deDocs from '../locales/de/docs.json';

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
  en: { common: enCommon, docs: enDocs },
  es: { common: esCommon, docs: esDocs },
  'pt-BR': { common: ptBRCommon, docs: ptBRDocs },
  fr: { common: frCommon, docs: frDocs },
  de: { common: deCommon, docs: deDocs },
} as const;

if (!i18n.isInitialized) {
  i18n
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources,
      fallbackLng: DEFAULT_LANGUAGE,
      supportedLngs: SUPPORTED_LANGUAGES.map((l) => l.code),
      defaultNS: 'common',
      ns: ['common', 'docs'],
      interpolation: { escapeValue: false },
      detection: {
        order: ['localStorage', 'navigator', 'htmlTag'],
        lookupLocalStorage: I18N_STORAGE_KEY,
        caches: ['localStorage'],
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
