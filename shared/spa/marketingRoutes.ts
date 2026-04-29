/**
 * URL classification used to decide which front-end bundle to ship for a given
 * request. The marketing surface (PublicLayout pages) is built into a separate
 * Preact-based bundle (`client-app/dist/public/`); every other URL is served by
 * the React-based in-app bundle (`client-app/dist/`).
 *
 * This module is intentionally dependency-free so it can be imported from both
 * the client-app entry configs and the production Express server.
 */

/**
 * Locale prefixes the router treats as a basename (see `client-app/src/lib/i18n.ts`).
 * `en` is an explicit alias for the default un-prefixed URLs (e.g. `/en/pricing`
 * resolves to the same marketing route as `/pricing`); the other prefixes map
 * to their respective translations. Kept in lower-case for case-insensitive
 * comparison.
 */
const LOCALE_PREFIXES = ['en', 'es', 'pt-br', 'fr', 'de'];

/**
 * Exact paths that map to a marketing page rendered inside `<PublicLayout>` in
 * `client-app/src/App.tsx`. Localized variants like `/pt-BR/pricing` are handled
 * by stripping the locale prefix before comparison.
 */
const MARKETING_EXACT_PATHS: ReadonlySet<string> = new Set([
  '/',
  '/product',
  '/product/federated-ingest',
  '/product/global-intelligence-network',
  '/features',
  '/ai-agents',
  '/pricing',
  '/use-cases',
  '/integrations',
  '/demo',
  '/contact',
  '/signup',
  '/terms',
  '/privacy',
  '/security',
  '/security/posture',
  '/subprocessors',
  '/book-demo',
]);

/**
 * Path *prefixes* (`prefix` itself, plus everything under `prefix/...`) that
 * map to marketing routes. These cover the dynamic params declared in
 * `client-app/src/App.tsx` (`:slug`, `:vertical`, etc.).
 */
const MARKETING_PREFIXES: readonly string[] = [
  '/docs',
  '/resources',
  '/blog',
  '/industries',
  '/case-studies',
];

/** Strip a leading `/<locale>` segment (case-insensitive) from `pathname`. */
export function stripLocaleFromPathname(pathname: string): string {
  if (!pathname || pathname[0] !== '/') return pathname;
  const slash = pathname.indexOf('/', 1);
  const head = slash === -1 ? pathname.slice(1) : pathname.slice(1, slash);
  if (LOCALE_PREFIXES.includes(head.toLowerCase())) {
    const rest = slash === -1 ? '' : pathname.slice(slash);
    return rest === '' ? '/' : rest;
  }
  return pathname;
}

/**
 * Normalize a pathname so the marketing classifier treats `/pricing` and
 * `/pricing/` (and `//pricing`) as the same route. Returns `/` for an empty
 * input so the caller doesn't have to special-case the landing page.
 */
function normalizePathname(pathname: string): string {
  if (!pathname) return '/';
  // Collapse repeated leading slashes to one.
  let path = pathname.replace(/^\/+/, '/');
  // Strip a single trailing slash, but keep `/` itself untouched.
  if (path.length > 1 && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  return path;
}

/**
 * Returns true when the request's pathname maps to a marketing page that should
 * be served by the Preact-based bundle. Returns false for in-app, auth,
 * onboarding, agent-builder, ops, admin, etc. routes — those keep using the
 * full React bundle.
 *
 * The function only inspects the URL path; query strings are ignored. Pass the
 * `pathname` portion (e.g. `req.path` or `URL.pathname`). Trailing slashes,
 * repeated leading slashes, and the `en` locale alias are all normalized so
 * `/pricing/`, `//pricing`, and `/en/pricing` all classify the same as
 * `/pricing`.
 */
export function isMarketingPathname(pathname: string): boolean {
  if (!pathname) return false;
  const path = normalizePathname(stripLocaleFromPathname(normalizePathname(pathname)));
  if (MARKETING_EXACT_PATHS.has(path)) return true;
  return MARKETING_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`),
  );
}
