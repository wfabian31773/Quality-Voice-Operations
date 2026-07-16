import { describe, it, expect } from 'vitest';

import {
  isMarketingPathname,
  stripLocaleFromPathname,
} from '../../shared/spa/marketingRoutes';

describe('shared/spa/marketingRoutes', () => {
  describe('stripLocaleFromPathname', () => {
    it('returns the input unchanged when it has no locale prefix', () => {
      expect(stripLocaleFromPathname('/pricing')).toBe('/pricing');
      expect(stripLocaleFromPathname('/')).toBe('/');
      expect(stripLocaleFromPathname('/dashboard/foo')).toBe('/dashboard/foo');
    });

    it('strips the en alias as well as the other locale prefixes', () => {
      expect(stripLocaleFromPathname('/en/pricing')).toBe('/pricing');
      expect(stripLocaleFromPathname('/es/pricing')).toBe('/pricing');
      expect(stripLocaleFromPathname('/fr/pricing')).toBe('/pricing');
      expect(stripLocaleFromPathname('/de/pricing')).toBe('/pricing');
      expect(stripLocaleFromPathname('/pt-BR/pricing')).toBe('/pricing');
    });

    it('matches locale prefixes case-insensitively', () => {
      expect(stripLocaleFromPathname('/EN/pricing')).toBe('/pricing');
      expect(stripLocaleFromPathname('/Es/pricing')).toBe('/pricing');
      expect(stripLocaleFromPathname('/PT-br/pricing')).toBe('/pricing');
    });

    it('returns / when the path is just a locale', () => {
      expect(stripLocaleFromPathname('/en')).toBe('/');
      expect(stripLocaleFromPathname('/es')).toBe('/');
      expect(stripLocaleFromPathname('/pt-BR')).toBe('/');
    });

    it('does not strip non-locale path segments that look like words', () => {
      expect(stripLocaleFromPathname('/dashboard')).toBe('/dashboard');
      expect(stripLocaleFromPathname('/admin/users')).toBe('/admin/users');
      expect(stripLocaleFromPathname('/de-facto')).toBe('/de-facto');
    });
  });

  describe('isMarketingPathname', () => {
    it('classifies the canonical marketing paths as marketing', () => {
      const marketing = [
        '/',
        '/pricing',
        '/demo',
        '/contact',
        '/industries/healthcare',
        '/industries/dental',
        '/case-studies',
        '/terms',
        '/privacy',
        '/security',
        '/security/posture',
        '/subprocessors',
        '/book-demo',
      ];
      for (const path of marketing) {
        expect(isMarketingPathname(path), path).toBe(true);
      }
    });

    it('classifies dynamic-prefix marketing paths as marketing', () => {
      expect(isMarketingPathname('/industries/healthcare')).toBe(true);
      expect(isMarketingPathname('/industries/dental')).toBe(true);
      expect(isMarketingPathname('/case-studies/acme')).toBe(true);
    });

    it('does not classify hidden generic platform pages as marketing', () => {
      const hidden = [
        '/product',
        '/product/federated-ingest',
        '/product/global-intelligence-network',
        '/features',
        '/ai-agents',
        '/use-cases',
        '/integrations',
        '/docs',
        '/docs/getting-started',
        '/signup',
        '/industries/vertical-agents',
        '/industries/legal',
        '/industries/real-estate',
        '/industries/home-services',
        '/blog',
        '/blog/some-post-slug',
        '/resources',
        '/resources/guide-name',
      ];
      for (const path of hidden) {
        expect(isMarketingPathname(path), path).toBe(false);
      }
    });

    it('classifies in-app, auth, ops, and admin paths as non-marketing', () => {
      const inApp = [
        '/dashboard',
        '/admin/users',
        '/admin/sales-inbox/edit/123',
        '/auth/login',
        '/onboarding',
        '/agent-builder',
        '/agent-builder/foo',
        '/settings/account',
        '/ops/dispatch',
      ];
      for (const path of inApp) {
        expect(isMarketingPathname(path), path).toBe(false);
      }
    });

    it('treats /en/* as marketing (alias for the default locale)', () => {
      expect(isMarketingPathname('/en')).toBe(true);
      expect(isMarketingPathname('/en/')).toBe(true);
      expect(isMarketingPathname('/en/pricing')).toBe(true);
      expect(isMarketingPathname('/en/blog/post-name')).toBe(false);
    });

    it('treats other localized prefixes as marketing for marketing routes', () => {
      expect(isMarketingPathname('/es/pricing')).toBe(true);
      expect(isMarketingPathname('/pt-BR/industries/dental')).toBe(true);
      expect(isMarketingPathname('/fr/blog/post')).toBe(false);
      expect(isMarketingPathname('/de/industries/healthcare')).toBe(true);
    });

    it('does not promote in-app routes to marketing just because of a locale prefix', () => {
      expect(isMarketingPathname('/es/dashboard')).toBe(false);
      expect(isMarketingPathname('/en/admin/users')).toBe(false);
      expect(isMarketingPathname('/pt-BR/agent-builder')).toBe(false);
    });

    it('normalizes trailing slashes and repeated leading slashes', () => {
      expect(isMarketingPathname('/pricing/')).toBe(true);
      expect(isMarketingPathname('/blog/')).toBe(false);
      expect(isMarketingPathname('/blog/some-post/')).toBe(false);
      expect(isMarketingPathname('//pricing')).toBe(true);
      expect(isMarketingPathname('//')).toBe(true);
      expect(isMarketingPathname('/dashboard/')).toBe(false);
    });

    it('returns false for empty input', () => {
      expect(isMarketingPathname('')).toBe(false);
    });

    it('does not match on path-segment substrings', () => {
      // `/blog-archive` shares a prefix with `/blog` but should NOT be a
      // marketing route because the prefix match must respect segment
      // boundaries (`/blog/...`).
      expect(isMarketingPathname('/blog-archive')).toBe(false);
      expect(isMarketingPathname('/docsite')).toBe(false);
      expect(isMarketingPathname('/industries-overview')).toBe(false);
    });
  });
});
