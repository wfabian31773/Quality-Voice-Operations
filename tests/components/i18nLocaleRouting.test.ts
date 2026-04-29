import { describe, it, expect } from 'vitest';
import {
  getLocaleFromPath,
  stripLocalePrefix,
  withLocalePrefix,
  resolveSupportedLanguage,
} from '../../client-app/src/lib/i18n';

describe('getLocaleFromPath', () => {
  it('returns the supported locale for a prefixed path', () => {
    expect(getLocaleFromPath('/pt-BR/pricing')).toBe('pt-BR');
    expect(getLocaleFromPath('/fr')).toBe('fr');
    expect(getLocaleFromPath('/de/docs/intro')).toBe('de');
    expect(getLocaleFromPath('/es')).toBe('es');
    expect(getLocaleFromPath('/en/about')).toBe('en');
  });

  it('matches case-insensitively (urls are commonly lowercased)', () => {
    expect(getLocaleFromPath('/pt-br/pricing')).toBe('pt-BR');
    expect(getLocaleFromPath('/PT-BR')).toBe('pt-BR');
  });

  it('returns null when the first segment is not a supported locale', () => {
    expect(getLocaleFromPath('/pricing')).toBeNull();
    expect(getLocaleFromPath('/zh/pricing')).toBeNull();
    expect(getLocaleFromPath('/')).toBeNull();
    expect(getLocaleFromPath('')).toBeNull();
  });
});

describe('stripLocalePrefix', () => {
  it('removes the locale prefix and preserves the rest of the path', () => {
    expect(stripLocalePrefix('/pt-BR/pricing')).toBe('/pricing');
    expect(stripLocalePrefix('/fr/docs/intro')).toBe('/docs/intro');
    expect(stripLocalePrefix('/en/about')).toBe('/about');
  });

  it('returns "/" when only the prefix is present', () => {
    expect(stripLocalePrefix('/pt-BR')).toBe('/');
    expect(stripLocalePrefix('/de/')).toBe('/');
  });

  it('passes through paths without a locale prefix unchanged', () => {
    expect(stripLocalePrefix('/pricing')).toBe('/pricing');
    expect(stripLocalePrefix('/')).toBe('/');
  });
});

describe('withLocalePrefix', () => {
  it('prefixes non-default locales', () => {
    expect(withLocalePrefix('pt-BR', '/pricing')).toBe('/pt-BR/pricing');
    expect(withLocalePrefix('fr', '/docs/intro')).toBe('/fr/docs/intro');
    expect(withLocalePrefix('de', '/')).toBe('/de');
  });

  it('returns un-prefixed paths for the default locale', () => {
    expect(withLocalePrefix('en', '/pricing')).toBe('/pricing');
    expect(withLocalePrefix('en', '/')).toBe('/');
  });

  it('is idempotent — re-prefixing strips the existing prefix first', () => {
    expect(withLocalePrefix('fr', '/pt-BR/pricing')).toBe('/fr/pricing');
    expect(withLocalePrefix('en', '/pt-BR/pricing')).toBe('/pricing');
    expect(withLocalePrefix('pt-BR', '/pt-BR/pricing')).toBe('/pt-BR/pricing');
  });

  it('normalizes paths missing a leading slash', () => {
    expect(withLocalePrefix('fr', 'pricing')).toBe('/fr/pricing');
  });
});

describe('resolveSupportedLanguage', () => {
  it('still maps regional and unknown variants to a supported code', () => {
    expect(resolveSupportedLanguage('pt-PT')).toBe('pt-BR');
    expect(resolveSupportedLanguage('fr-CA')).toBe('fr');
    expect(resolveSupportedLanguage('en-GB')).toBe('en');
    expect(resolveSupportedLanguage('zh')).toBe('en');
    expect(resolveSupportedLanguage(undefined)).toBe('en');
  });
});
