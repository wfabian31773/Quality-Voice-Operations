// @vitest-environment happy-dom
/**
 * Regression suite for the `<html lang>` synchronization in `i18n.ts`.
 *
 * Why this exists:
 *   `syncHtmlLang` (registered as the `languageChanged` listener in `i18n.ts`)
 *   keeps `document.documentElement.lang` in sync with the active i18next
 *   language. Screen readers, browser translation prompts, and search engines
 *   all rely on this attribute being correct — a Brazilian visitor whose UI
 *   shows Portuguese strings but whose `<html lang>` says `en` will get the
 *   wrong screen-reader voice and weaker SEO signals. There is no manual QA
 *   that catches a regression here; this suite drives `changeLanguage` across
 *   the full supported-locale + regional-variant matrix and asserts the lang
 *   attribute lands on the expected supported code each time.
 */
import { afterAll, describe, expect, it } from 'vitest';

import i18n, {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  type SupportedLanguageCode,
} from './i18n';

const SUPPORTED_CODES = SUPPORTED_LANGUAGES.map((l) => l.code) as readonly SupportedLanguageCode[];

describe('syncHtmlLang (document.documentElement.lang via languageChanged)', () => {
  afterAll(async () => {
    // Leave the singleton in a known state so it doesn't bleed into other suites.
    await i18n.changeLanguage(DEFAULT_LANGUAGE);
  });

  // 1. Every supported locale must set <html lang> to itself exactly.
  it.each(SUPPORTED_CODES.map((code) => [code]))(
    'sets <html lang> to %s when changeLanguage is called with the supported code',
    async (code) => {
      await i18n.changeLanguage(code);
      expect(document.documentElement.lang).toBe(code);
    },
  );

  // 2. Regional variants must collapse to the closest supported code so that
  //    a visitor manually picking pt-PT, fr-CA, de-AT, es-MX, or en-US still
  //    gets a screen-reader-friendly lang attribute.
  const regionalVariants: Array<[string, SupportedLanguageCode]> = [
    ['pt-PT', 'pt-BR'],
    ['fr-CA', 'fr'],
    ['de-AT', 'de'],
    ['es-MX', 'es'],
    ['en-US', 'en'],
  ];
  it.each(regionalVariants)(
    'maps regional variant %s onto supported <html lang> %s',
    async (variant, expected) => {
      await i18n.changeLanguage(variant);
      expect(document.documentElement.lang).toBe(expected);
    },
  );

  // 3. Unsupported languages must fall back to the default so the lang
  //    attribute is never left advertising a locale we don't actually serve.
  it('falls back to the default language for an unsupported language (ja → en)', async () => {
    await i18n.changeLanguage('ja');
    expect(document.documentElement.lang).toBe(DEFAULT_LANGUAGE);
  });
});
