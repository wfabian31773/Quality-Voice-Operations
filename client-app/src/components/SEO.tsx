import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  withLocalePrefix,
  stripLocalePrefix,
  resolveSupportedLanguage,
  type SupportedLanguageCode,
} from '../lib/i18n';

interface SEOProps {
  title: string;
  description: string;
  ogImage?: string;
  ogType?: string;
  canonicalPath?: string;
  structuredData?: object;
}

const BASE_URL = typeof window !== 'undefined' ? window.location.origin : '';
const DEFAULT_OG_IMAGE = '/og-default.png';

// hreflang values use BCP-47 underscores → dashes; our codes are already
// dash-formatted (e.g. `pt-BR`). `x-default` is what crawlers look for when
// the visitor's language doesn't match any explicit alternate.
const HREFLANG_X_DEFAULT = 'x-default';

export default function SEO({
  title,
  description,
  ogImage,
  ogType = 'website',
  canonicalPath,
  structuredData,
}: SEOProps) {
  const location = useLocation();
  const { i18n } = useTranslation();
  // Normalize the canonical path: callers may pass either a fully-prefixed
  // path or one without the locale prefix; we always work with the un-prefixed
  // form internally so we can emit one alternate per supported locale. We
  // also strip in case `useLocation` returned a prefixed path (it normally
  // doesn't because BrowserRouter's basename swallows the prefix, but a
  // caller may pass `canonicalPath="/pt-BR/foo"` explicitly).
  const rawPath = canonicalPath ?? location.pathname;
  const pathWithoutLocale = stripLocalePrefix(rawPath);
  const fullTitle = title.includes('QVO') ? title : `${title} | QVO`;
  const image = ogImage
    ? ogImage.startsWith('http') ? ogImage : `${BASE_URL}${ogImage}`
    : `${BASE_URL}${DEFAULT_OG_IMAGE}`;

  // The canonical URL points at the *current* locale's variant. If the page
  // is /pricing, the canonical is /pricing (en); if /pt-BR/pricing, the
  // canonical is /pt-BR/pricing — that's how Google selects the right page
  // per language without splitting link equity. Source the locale from
  // i18next (set from URL prefix at boot) rather than the path, since
  // BrowserRouter's basename has already stripped the prefix from `location`.
  const currentLocale = resolveSupportedLanguage(
    i18n.resolvedLanguage || i18n.language,
  ) as SupportedLanguageCode;
  const canonicalUrl = `${BASE_URL}${withLocalePrefix(currentLocale, pathWithoutLocale)}`;

  useEffect(() => {
    document.title = fullTitle;

    const setMeta = (property: string, content: string, isName = false) => {
      const attr = isName ? 'name' : 'property';
      let el = document.querySelector(`meta[${attr}="${property}"]`);
      if (!el) {
        el = document.createElement('meta');
        el.setAttribute(attr, property);
        document.head.appendChild(el);
      }
      el.setAttribute('content', content);
    };

    setMeta('description', description, true);
    setMeta('og:title', fullTitle);
    setMeta('og:description', description);
    setMeta('og:image', image);
    setMeta('og:url', canonicalUrl);
    setMeta('og:type', ogType);
    setMeta('twitter:card', 'summary_large_image', true);
    setMeta('twitter:title', fullTitle, true);
    setMeta('twitter:description', description, true);
    setMeta('twitter:image', image, true);

    let canonical = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
    if (!canonical) {
      canonical = document.createElement('link');
      canonical.setAttribute('rel', 'canonical');
      document.head.appendChild(canonical);
    }
    canonical.setAttribute('href', canonicalUrl);

    // hreflang alternates: emit one <link rel="alternate" hreflang="…"> per
    // supported locale, plus an `x-default` pointing at the unprefixed
    // English URL. Sweep BOTH our previously-rendered runtime tags AND the
    // static home-page fallbacks shipped in index.html before re-emitting:
    // the static tags only describe `/` and would conflict with per-page
    // alternates on every other route. (We sweep `link[rel="alternate"]
    // [hreflang]` rather than only our data-attribute selectors so any
    // unmanaged stragglers are also cleaned up.)
    document
      .querySelectorAll('link[rel="alternate"][hreflang]')
      .forEach((el) => el.parentNode?.removeChild(el));

    const setAlternate = (hreflang: string, href: string) => {
      const link = document.createElement('link');
      link.setAttribute('rel', 'alternate');
      link.setAttribute('hreflang', hreflang);
      link.setAttribute('href', href);
      link.setAttribute('data-seo-hreflang', 'true');
      document.head.appendChild(link);
    };

    SUPPORTED_LANGUAGES.forEach(({ code }) => {
      const altPath = withLocalePrefix(code as SupportedLanguageCode, pathWithoutLocale);
      setAlternate(code, `${BASE_URL}${altPath}`);
    });
    // x-default points at the un-prefixed English URL — that's what crawlers
    // serve to visitors whose language doesn't match any of our alternates.
    setAlternate(HREFLANG_X_DEFAULT, `${BASE_URL}${withLocalePrefix(DEFAULT_LANGUAGE, pathWithoutLocale)}`);

    let ldScript = document.querySelector('script[data-seo-ld]') as HTMLScriptElement | null;
    if (structuredData) {
      if (!ldScript) {
        ldScript = document.createElement('script');
        ldScript.setAttribute('type', 'application/ld+json');
        ldScript.setAttribute('data-seo-ld', 'true');
        document.head.appendChild(ldScript);
      }
      ldScript.textContent = JSON.stringify(structuredData);
    } else if (ldScript) {
      ldScript.remove();
    }

    return () => {
      const ld = document.querySelector('script[data-seo-ld]');
      if (ld) ld.remove();
      // Leave hreflang tags in place between navigations — the next mount of
      // <SEO> will overwrite them. Removing here would briefly drop them while
      // the new page's effect runs, which crawlers can sample.
    };
  }, [fullTitle, description, image, canonicalUrl, ogType, structuredData, pathWithoutLocale]);

  return null;
}
