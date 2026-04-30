import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// @ts-expect-error: pure-JS Node script with no type declarations.
import {
  extractPublicRoutePaths,
  isDynamicPath,
  findSitemapDrift,
  APP_FILES,
} from '../../scripts/check-sitemap-coverage.mjs';

// @ts-expect-error: pure-JS Node script with no type declarations.
import { STATIC_ROUTES } from '../../scripts/generate-sitemap.mjs';

/**
 * The sitemap generator's STATIC_ROUTES list is hand-mirrored from the
 * `<Route element={<PublicLayout />}>` block in `client-app/src/App.tsx` (and
 * `PublicApp.tsx`). If a contributor adds a public route to App.tsx and
 * forgets to add it to STATIC_ROUTES, the sitemap silently drops it and
 * crawlers never discover the page. These tests exercise the parser + drift
 * detector that catches that mistake in CI.
 */

function writePublicFile(repoRoot: string, rel: string, body: string): void {
  const abs = path.join(repoRoot, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, 'utf8');
}

const PUBLIC_ROUTE_BLOCK_FIXTURE = `
import { Routes, Route } from 'react-router-dom';
const PublicLayout = () => null;

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route element={<PublicLayout />}>
        <Route path="/" element={<Landing />} />
        <Route path="/pricing" element={<Pricing />} />
        <Route path="/docs" element={<Docs />} />
        <Route path="/docs/:slug" element={<DocArticle />} />
        <Route path="/industries/:vertical" element={<VerticalLanding />} />
      </Route>
      <Route path="/dashboard" element={<Dashboard />} />
    </Routes>
  );
}
`;

describe('check-sitemap-coverage script', () => {
  describe('extractPublicRoutePaths', () => {
    it('returns every <Route path="…"> declared inside the <PublicLayout /> block', () => {
      expect(extractPublicRoutePaths(PUBLIC_ROUTE_BLOCK_FIXTURE)).toEqual([
        '/',
        '/pricing',
        '/docs',
        '/docs/:slug',
        '/industries/:vertical',
      ]);
    });

    it('does not pick up routes outside the <PublicLayout /> group', () => {
      const paths = extractPublicRoutePaths(PUBLIC_ROUTE_BLOCK_FIXTURE) ?? [];
      expect(paths).not.toContain('/login');
      expect(paths).not.toContain('/dashboard');
    });

    it('returns null when no <PublicLayout /> block exists', () => {
      expect(extractPublicRoutePaths('export default function App() { return null; }')).toBeNull();
    });

    it('throws when the <PublicLayout /> block is unterminated', () => {
      const broken = '<Route element={<PublicLayout />}>\n<Route path="/" element={<X />} />\n';
      expect(() => extractPublicRoutePaths(broken)).toThrow(/no closing <\/Route>/);
    });
  });

  describe('isDynamicPath', () => {
    it('flags paths with React-Router params', () => {
      expect(isDynamicPath('/docs/:slug')).toBe(true);
      expect(isDynamicPath('/industries/:vertical')).toBe(true);
      expect(isDynamicPath('/track/:token')).toBe(true);
    });

    it('treats fully-static paths as non-dynamic', () => {
      expect(isDynamicPath('/')).toBe(false);
      expect(isDynamicPath('/pricing')).toBe(false);
      expect(isDynamicPath('/product/federated-ingest')).toBe(false);
    });
  });

  describe('findSitemapDrift', () => {
    function withTempRepo(setup: (repoRoot: string) => void) {
      const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'sitemap-coverage-'));
      setup(repoRoot);
      return repoRoot;
    }

    it('reports nothing when STATIC_ROUTES covers every static path', () => {
      const repoRoot = withTempRepo((root) => {
        writePublicFile(root, 'client-app/src/App.tsx', PUBLIC_ROUTE_BLOCK_FIXTURE);
        writePublicFile(root, 'client-app/src/PublicApp.tsx', PUBLIC_ROUTE_BLOCK_FIXTURE);
      });

      const result = findSitemapDrift({
        files: APP_FILES,
        repoRoot,
        staticRoutes: [
          { path: '/', changefreq: 'weekly', priority: '1.0' },
          { path: '/pricing', changefreq: 'weekly', priority: '0.8' },
          { path: '/docs', changefreq: 'weekly', priority: '0.8' },
        ],
      });
      expect(result.errors).toEqual([]);
      expect(result.missingFromSitemap).toEqual([]);
      expect(result.orphanedInSitemap).toEqual([]);
      expect(result.declaredCount).toBe(3);
    });

    it('flags static paths declared in App.tsx that are missing from STATIC_ROUTES', () => {
      const repoRoot = withTempRepo((root) => {
        writePublicFile(root, 'client-app/src/App.tsx', PUBLIC_ROUTE_BLOCK_FIXTURE);
        writePublicFile(root, 'client-app/src/PublicApp.tsx', PUBLIC_ROUTE_BLOCK_FIXTURE);
      });

      const result = findSitemapDrift({
        files: APP_FILES,
        repoRoot,
        staticRoutes: [
          { path: '/', changefreq: 'weekly', priority: '1.0' },
          { path: '/pricing', changefreq: 'weekly', priority: '0.8' },
          // `/docs` intentionally omitted to simulate drift.
        ],
      });
      expect(result.missingFromSitemap.map((m: { path: string }) => m.path)).toEqual(['/docs']);
      expect(result.missingFromSitemap[0].sources).toEqual([
        'client-app/src/App.tsx',
        'client-app/src/PublicApp.tsx',
      ]);
      expect(result.orphanedInSitemap).toEqual([]);
    });

    it('flags STATIC_ROUTES entries that no public route group declares', () => {
      const repoRoot = withTempRepo((root) => {
        writePublicFile(root, 'client-app/src/App.tsx', PUBLIC_ROUTE_BLOCK_FIXTURE);
        writePublicFile(root, 'client-app/src/PublicApp.tsx', PUBLIC_ROUTE_BLOCK_FIXTURE);
      });

      const result = findSitemapDrift({
        files: APP_FILES,
        repoRoot,
        staticRoutes: [
          { path: '/', changefreq: 'weekly', priority: '1.0' },
          { path: '/pricing', changefreq: 'weekly', priority: '0.8' },
          { path: '/docs', changefreq: 'weekly', priority: '0.8' },
          { path: '/old-page', changefreq: 'monthly', priority: '0.4' },
        ],
      });
      expect(result.missingFromSitemap).toEqual([]);
      expect(result.orphanedInSitemap).toEqual(['/old-page']);
    });

    it('skips dynamic segments — those are handled by collectDynamicPaths', () => {
      const repoRoot = withTempRepo((root) => {
        writePublicFile(root, 'client-app/src/App.tsx', PUBLIC_ROUTE_BLOCK_FIXTURE);
        writePublicFile(root, 'client-app/src/PublicApp.tsx', PUBLIC_ROUTE_BLOCK_FIXTURE);
      });

      const result = findSitemapDrift({
        files: APP_FILES,
        repoRoot,
        staticRoutes: [
          { path: '/', changefreq: 'weekly', priority: '1.0' },
          { path: '/pricing', changefreq: 'weekly', priority: '0.8' },
          { path: '/docs', changefreq: 'weekly', priority: '0.8' },
        ],
      });
      // /docs/:slug and /industries/:vertical exist in the fixture but must
      // never appear in missingFromSitemap — they're resolved per-slug by the
      // generator's collectDynamicPaths() pass.
      const missingPaths = result.missingFromSitemap.map((m: { path: string }) => m.path);
      expect(missingPaths).not.toContain('/docs/:slug');
      expect(missingPaths).not.toContain('/industries/:vertical');
    });

    it('treats a missing <PublicLayout /> block as drift, not a silent pass', () => {
      const repoRoot = withTempRepo((root) => {
        writePublicFile(root, 'client-app/src/App.tsx', '// no public layout here');
        writePublicFile(root, 'client-app/src/PublicApp.tsx', PUBLIC_ROUTE_BLOCK_FIXTURE);
      });

      const result = findSitemapDrift({
        files: APP_FILES,
        repoRoot,
        staticRoutes: [
          { path: '/', changefreq: 'weekly', priority: '1.0' },
          { path: '/pricing', changefreq: 'weekly', priority: '0.8' },
          { path: '/docs', changefreq: 'weekly', priority: '0.8' },
        ],
      });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatch(/App\.tsx.*PublicLayout/);
    });
  });

  describe('against the real codebase', () => {
    it('STATIC_ROUTES is in sync with App.tsx / PublicApp.tsx today', () => {
      // This is the live guard the CI step relies on. If it fails locally,
      // the fix is to add the new path to STATIC_ROUTES in
      // scripts/generate-sitemap.mjs (or remove the orphan).
      const result = findSitemapDrift();
      expect(result.errors).toEqual([]);
      expect(result.missingFromSitemap).toEqual([]);
      expect(result.orphanedInSitemap).toEqual([]);
      expect(result.declaredCount).toBeGreaterThan(0);
    });

    it('every STATIC_ROUTES entry is itself a static (non-dynamic) path', () => {
      // Defense in depth: STATIC_ROUTES should never accidentally contain a
      // `:param` path — those belong in collectDynamicPaths() instead.
      const dynamic = STATIC_ROUTES.filter((r: { path: string }) => isDynamicPath(r.path));
      expect(dynamic).toEqual([]);
    });
  });
});
