import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

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

export default function SEO({
  title,
  description,
  ogImage,
  ogType = 'website',
  canonicalPath,
  structuredData,
}: SEOProps) {
  const location = useLocation();
  const path = canonicalPath ?? location.pathname;
  const canonicalUrl = `${BASE_URL}${path}`;
  const fullTitle = title.includes('QVO') ? title : `${title} | QVO`;
  const image = ogImage || `${BASE_URL}${DEFAULT_OG_IMAGE}`;

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
    };
  }, [fullTitle, description, image, canonicalUrl, ogType, structuredData]);

  return null;
}
