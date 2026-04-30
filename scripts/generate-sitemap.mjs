#!/usr/bin/env node
/**
 * Build-time sitemap generator.
 *
 * Walks the public-facing route table (mirrored below from
 * `client-app/src/App.tsx`) and the slug data files
 * (`client-app/src/data/{docs,blogArticles,guides}.ts` plus the `verticals`
 * map in `client-app/src/pages/public/VerticalLanding.tsx`), then writes a
 * sitemap to `client-app/public/sitemap.xml` that lists every public route
 * once per supported locale.
 *
 * Each `<url>` entry includes `<xhtml:link rel="alternate" hreflang="…">`
 * siblings for every supported locale plus `x-default`, which is what tells
 * Google/Bing about the localized variants. Per Google's spec the full set
 * of sibling links must appear on EVERY url entry — including the default —
 * so the same alternates block is rendered for each locale's variant of a
 * given path.
 *
 * The locale list and `withLocalePrefix` rules are kept in sync with
 * `client-app/src/lib/i18n.ts`:
 *   - Default locale (`en`) is served from un-prefixed URLs (`/pricing`).
 *   - Non-default locales are prefixed (`/pt-BR/pricing`, `/fr/pricing`, …).
 *
 * The script is also invoked as a `prebuild` hook in `client-app/package.json`
 * so production builds always ship a fresh sitemap.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULT_BASE_URL = 'https://qvo.ai';
export const BASE_URL = (process.env.SITEMAP_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');

// Mirrors `SUPPORTED_LANGUAGES` in `client-app/src/lib/i18n.ts`.
export const SUPPORTED_LOCALES = ['en', 'es', 'pt-BR', 'fr', 'de'];
export const DEFAULT_LOCALE = 'en';

/** Mirrors `withLocalePrefix` in `client-app/src/lib/i18n.ts`. */
export function withLocalePrefix(locale, p) {
  const normalized = p.startsWith('/') ? p : `/${p}`;
  if (locale === DEFAULT_LOCALE) return normalized;
  if (normalized === '/') return `/${locale}`;
  return `/${locale}${normalized}`;
}

/**
 * Static public marketing routes. Mirrors the `<Route element={<PublicLayout/>}>`
 * block in `client-app/src/App.tsx`. Dynamic segments (`:slug`, `:vertical`)
 * are resolved separately below.
 *
 * Authenticated/in-app routes (dashboard, agents, admin/*, ops/*, settings,
 * etc.) are intentionally omitted — `client-app/public/robots.txt` already
 * `Disallow`s them, so listing them in the sitemap would just send crawlers
 * into a redirect loop.
 */
export const STATIC_ROUTES = [
  { path: '/',                                           changefreq: 'weekly',  priority: '1.0' },
  { path: '/product',                                    changefreq: 'weekly',  priority: '0.8' },
  { path: '/product/federated-ingest',                   changefreq: 'monthly', priority: '0.7' },
  { path: '/product/global-intelligence-network',        changefreq: 'monthly', priority: '0.7' },
  { path: '/features',                                   changefreq: 'weekly',  priority: '0.8' },
  { path: '/ai-agents',                                  changefreq: 'weekly',  priority: '0.8' },
  { path: '/pricing',                                    changefreq: 'weekly',  priority: '0.8' },
  { path: '/use-cases',                                  changefreq: 'weekly',  priority: '0.8' },
  { path: '/integrations',                               changefreq: 'weekly',  priority: '0.8' },
  { path: '/demo',                                       changefreq: 'weekly',  priority: '0.8' },
  { path: '/contact',                                    changefreq: 'weekly',  priority: '0.7' },
  { path: '/docs',                                       changefreq: 'weekly',  priority: '0.8' },
  { path: '/resources',                                  changefreq: 'weekly',  priority: '0.7' },
  { path: '/signup',                                     changefreq: 'monthly', priority: '0.6' },
  { path: '/blog',                                       changefreq: 'weekly',  priority: '0.7' },
  { path: '/industries/vertical-agents',                 changefreq: 'monthly', priority: '0.7' },
  { path: '/case-studies',                               changefreq: 'monthly', priority: '0.7' },
  { path: '/book-demo',                                  changefreq: 'weekly',  priority: '0.8' },
  { path: '/terms',                                      changefreq: 'yearly',  priority: '0.4' },
  { path: '/privacy',                                    changefreq: 'yearly',  priority: '0.4' },
  { path: '/security',                                   changefreq: 'monthly', priority: '0.5' },
  { path: '/security/posture',                           changefreq: 'monthly', priority: '0.5' },
  { path: '/subprocessors',                              changefreq: 'monthly', priority: '0.4' },
];

/**
 * Extract slugs from a TS source file by matching `slug: 'value',` literals.
 * `startMarker`, when provided, restricts matching to lines after the marker
 * appears (used to skip `docCategories` slugs in `docs.ts`, which are taxonomy
 * keys not URL paths — only `docArticles` slugs become `/docs/<slug>` URLs).
 */
export function extractSlugs(source, { startMarker } = {}) {
  let body = source;
  if (startMarker) {
    const idx = source.indexOf(startMarker);
    if (idx === -1) {
      throw new Error(`extractSlugs: startMarker ${JSON.stringify(startMarker)} not found in source`);
    }
    body = source.slice(idx);
  }
  const slugs = [];
  const re = /\bslug:\s*'([a-z0-9][a-z0-9-]*)'/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    slugs.push(match[1]);
  }
  return Array.from(new Set(slugs));
}

/**
 * Extract the keys of the `verticals` Record in VerticalLanding.tsx — these
 * are the slugs the `/industries/:vertical` route accepts. We walk the source
 * with a brace-depth counter and harvest identifiers / quoted strings that
 * appear immediately before `: {` at depth 1 (the top level of the verticals
 * object literal).
 */
export function extractVerticalSlugs(source) {
  const start = source.indexOf('const verticals: Record<string, VerticalConfig> = {');
  if (start === -1) {
    throw new Error('extractVerticalSlugs: verticals map not found in VerticalLanding.tsx');
  }
  const openIdx = source.indexOf('{', start);
  if (openIdx === -1) {
    throw new Error('extractVerticalSlugs: opening brace not found');
  }

  const slugs = [];
  let depth = 1; // we begin INSIDE the verticals object
  let i = openIdx + 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === '{') {
      // The chars immediately preceding this `{` (skipping whitespace and `:`)
      // are the key for the inner object. Only harvest at depth 1.
      if (depth === 1) {
        // Walk back to grab the key.
        let j = i - 1;
        while (j >= openIdx && /\s/.test(source[j])) j--;
        if (source[j] === ':') {
          j--;
          while (j >= openIdx && /\s/.test(source[j])) j--;
          // Quoted key: `'home-services':` — capture everything between the quotes.
          if (source[j] === "'" || source[j] === '"') {
            const quote = source[j];
            const closeQuote = j;
            j--;
            const start = source.lastIndexOf(quote, j);
            if (start !== -1) {
              slugs.push(source.slice(start + 1, closeQuote));
            }
          } else {
            // Bare identifier key: `healthcare:` — walk back through valid chars.
            let end = j + 1;
            while (j >= openIdx && /[A-Za-z0-9_$-]/.test(source[j])) j--;
            slugs.push(source.slice(j + 1, end));
          }
        }
      }
      depth++;
    } else if (ch === '}') {
      depth--;
    }
    i++;
  }
  return Array.from(new Set(slugs.filter(Boolean)));
}

function readClientFile(rel) {
  return readFileSync(path.join(REPO_ROOT, 'client-app', 'src', rel), 'utf8');
}

/**
 * Resolve every dynamic-segment route by reading the data files. Returns
 * full path strings (`/docs/quickstart`, `/blog/whatever`, …) without locale
 * prefixes — the prefix is applied later, once per supported locale.
 */
export function collectDynamicPaths() {
  const paths = [];

  const docsSrc = readClientFile('data/docs.ts');
  for (const slug of extractSlugs(docsSrc, { startMarker: 'docArticles' })) {
    paths.push({ path: `/docs/${slug}`, changefreq: 'monthly', priority: '0.6' });
  }

  const blogSrc = readClientFile('data/blogArticles.ts');
  for (const slug of extractSlugs(blogSrc, { startMarker: 'blogArticles' })) {
    paths.push({ path: `/blog/${slug}`, changefreq: 'monthly', priority: '0.6' });
  }

  const guidesSrc = readClientFile('data/guides.ts');
  for (const slug of extractSlugs(guidesSrc, { startMarker: 'guides:' })) {
    // `startMarker` above will not match — guides.ts uses `export const guides`.
    paths.push({ path: `/resources/${slug}`, changefreq: 'monthly', priority: '0.6' });
  }
  // Re-run without marker if the marker-based pass found nothing (the file
  // shape is simple — `slug: 'foo'` literals only appear inside the guides
  // array — so a global sweep is safe and matches the docs.ts/blogArticles.ts
  // intent of "every slug literal is a URL slug").
  if (!paths.some((p) => p.path.startsWith('/resources/'))) {
    for (const slug of extractSlugs(guidesSrc)) {
      paths.push({ path: `/resources/${slug}`, changefreq: 'monthly', priority: '0.6' });
    }
  }

  const verticalSrc = readClientFile('pages/public/VerticalLanding.tsx');
  for (const slug of extractVerticalSlugs(verticalSrc)) {
    // /industries/vertical-agents is already in STATIC_ROUTES; skip if a
    // future PR ever adds a same-named entry to the verticals map.
    if (slug === 'vertical-agents') continue;
    paths.push({ path: `/industries/${slug}`, changefreq: 'monthly', priority: '0.7' });
  }

  return paths;
}

/**
 * Slug validator shared across case-study helpers. Accepts the URL-safe segment
 * chars actually produced by platform/analytics/CaseStudyService.generateCaseStudy
 * — lowercase ASCII alphanumerics, hyphens, and underscores (e.g.
 * `cs-1abc-call_volume-500`). Must start with an alphanumeric. Anything else is
 * dropped silently so a stray malformed row can never poison the sitemap.
 */
function isValidSlug(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(value);
}

/**
 * Pull every valid `publicSlug` out of a parsed `/api/public/case-studies`
 * response. Accepts both `publicSlug` (API) and `public_slug` (raw DB row
 * snapshot). Drops nulls, invalid slugs, and dedupes.
 */
export function extractCaseStudySlugsFromPayload(body) {
  if (!Array.isArray(body)) return [];
  const slugs = [];
  for (const item of body) {
    if (!item || typeof item !== 'object') continue;
    const candidate =
      typeof item.publicSlug === 'string'
        ? item.publicSlug
        : typeof item.public_slug === 'string'
          ? item.public_slug
          : null;
    if (isValidSlug(candidate)) slugs.push(candidate);
  }
  return Array.from(new Set(slugs));
}

/**
 * Load published case-study slugs from a remote `url` (preferred) or local
 * `file` snapshot. Returns `[]` on any failure so a flaky API can never block
 * a release build.
 */
export async function loadCaseStudySlugs({
  url,
  file,
  timeoutMs = 5000,
  fetchImpl = typeof fetch === 'function' ? fetch : undefined,
  logger = console,
} = {}) {
  if (url) {
    if (typeof fetchImpl !== 'function') {
      logger.warn?.('loadCaseStudySlugs: no fetch implementation available, skipping case-study URLs');
      return [];
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
    try {
      const res = await fetchImpl(url, controller ? { signal: controller.signal } : undefined);
      if (!res || !res.ok) {
        const status = res ? res.status : 'no response';
        logger.warn?.(`loadCaseStudySlugs: ${url} returned ${status}, skipping case-study URLs`);
        return [];
      }
      const body = await res.json();
      return extractCaseStudySlugsFromPayload(body);
    } catch (err) {
      const message = err && typeof err === 'object' && 'message' in err ? err.message : String(err);
      logger.warn?.(`loadCaseStudySlugs: failed to fetch ${url} (${message}), skipping case-study URLs`);
      return [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  if (file) {
    try {
      if (!existsSync(file)) {
        logger.warn?.(`loadCaseStudySlugs: snapshot file ${file} not found, skipping case-study URLs`);
        return [];
      }
      const raw = readFileSync(file, 'utf8');
      const body = JSON.parse(raw);
      return extractCaseStudySlugsFromPayload(body);
    } catch (err) {
      const message = err && typeof err === 'object' && 'message' in err ? err.message : String(err);
      logger.warn?.(`loadCaseStudySlugs: failed to read ${file} (${message}), skipping case-study URLs`);
      return [];
    }
  }

  return [];
}

/**
 * Turn validated case-study slugs into sitemap route entries (monthly/0.6,
 * matching the doc/blog cadence).
 */
export function buildCaseStudyRoutes(slugs) {
  const routes = [];
  for (const slug of slugs) {
    if (!isValidSlug(slug)) continue;
    routes.push({ path: `/case-studies/${slug}`, changefreq: 'monthly', priority: '0.6' });
  }
  return routes;
}

function escapeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildSitemapXml({ routes, locales = SUPPORTED_LOCALES, baseUrl = BASE_URL, lastmod } = {}) {
  const today = lastmod || new Date().toISOString().slice(0, 10);
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push(
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
  );

  for (const route of routes) {
    // Pre-compute the full set of alternate <link>s for this path. Same set
    // is repeated under every locale variant per the spec.
    const alternates = [
      ...locales.map((locale) => ({
        hreflang: locale,
        href: `${baseUrl}${withLocalePrefix(locale, route.path)}`,
      })),
      // `x-default` points at the un-prefixed (English) URL — that's what
      // crawlers serve when no other hreflang matches the visitor.
      {
        hreflang: 'x-default',
        href: `${baseUrl}${withLocalePrefix(DEFAULT_LOCALE, route.path)}`,
      },
    ];

    for (const locale of locales) {
      const loc = `${baseUrl}${withLocalePrefix(locale, route.path)}`;
      out.push('  <url>');
      out.push(`    <loc>${escapeXml(loc)}</loc>`);
      out.push(`    <lastmod>${today}</lastmod>`);
      out.push(`    <changefreq>${route.changefreq}</changefreq>`);
      out.push(`    <priority>${route.priority}</priority>`);
      for (const alt of alternates) {
        out.push(
          `    <xhtml:link rel="alternate" hreflang="${escapeXml(alt.hreflang)}" href="${escapeXml(alt.href)}"/>`,
        );
      }
      out.push('  </url>');
    }
  }

  out.push('</urlset>');
  out.push('');
  return out.join('\n');
}

export function generateSitemap({
  baseUrl = BASE_URL,
  locales = SUPPORTED_LOCALES,
  lastmod,
  caseStudySlugs = [],
} = {}) {
  const routes = [
    ...STATIC_ROUTES,
    ...collectDynamicPaths(),
    ...buildCaseStudyRoutes(caseStudySlugs),
  ];
  return buildSitemapXml({ routes, locales, baseUrl, lastmod });
}

function isCli() {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === __filename;
}

/**
 * Resolve the case-study source the CLI should use given the current env.
 * Precedence: snapshot file > URL override (`'' | 'none'` disables) >
 * default `${baseUrl}/api/public/case-studies` API.
 */
export function resolveCaseStudySource({ env = process.env, baseUrl = BASE_URL } = {}) {
  if (env.SITEMAP_CASE_STUDIES_FILE) return { file: env.SITEMAP_CASE_STUDIES_FILE };
  if (Object.prototype.hasOwnProperty.call(env, 'SITEMAP_CASE_STUDIES_URL')) {
    const override = env.SITEMAP_CASE_STUDIES_URL;
    if (!override || override === 'none') return {};
    return { url: override };
  }
  return { url: `${baseUrl}/api/public/case-studies` };
}

if (isCli()) {
  const source = resolveCaseStudySource();
  const caseStudySlugs = await loadCaseStudySlugs(source);
  const xml = generateSitemap({ caseStudySlugs });
  const outPath = path.join(REPO_ROOT, 'client-app', 'public', 'sitemap.xml');
  writeFileSync(outPath, xml, 'utf8');
  const urlCount = (xml.match(/<url>/g) || []).length;
  // eslint-disable-next-line no-console
  console.log(
    `Wrote ${outPath} (${urlCount} <url> entries across ${SUPPORTED_LOCALES.length} locales, ${caseStudySlugs.length} case-study slug(s))`,
  );
}
