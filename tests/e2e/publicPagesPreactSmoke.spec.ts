/**
 * Task #1165: Verify Preact compatibility for every public marketing page.
 *
 * The marketing bundle is now built with `preact/compat` standing in for
 * React 19 (see `client-app/vite.public.config.ts`). The build succeeds and
 * the routing is wired correctly, but a handful of React-only escape hatches
 * (`useId` quirks, `forwardRef` edge cases, `Suspense` semantics, hook
 * counting under `<StrictMode>`, etc.) could regress silently — the bundle
 * would still ship, every page would still load, and the only visible
 * symptom would be a runtime exception logged to the browser console.
 *
 * This standalone runner spins up a tiny Express server that serves the
 * built `client-app/dist/public/` bundle exactly the way the production
 * server does (`/public/...` for hashed assets, `index.public.html` as the
 * SPA history fallback for every other URL), then drives Playwright through
 * every public route declared in `client-app/src/PublicApp.tsx` and asserts
 * the page loads with NO uncaught exceptions, NO unhandled promise
 * rejections, and NO `console.error()` calls from application code.
 *
 * Standalone runner — no `@playwright/test` dependency. Mirrors the pattern
 * established in `publicDarkModeContrast.spec.ts` and
 * `publicHeroVisualRegression.spec.ts`:
 *
 *   npx tsx tests/e2e/publicPagesPreactSmoke.spec.ts
 *
 * Pre-requisites:
 *   - The marketing bundle must be built (or this script will build it
 *     on-demand). Build manually with:
 *       npm --prefix client-app run build:public
 *   - Playwright Chromium installed: `npx playwright install chromium`.
 *
 * Env vars (all optional):
 *   PREACT_SMOKE_PORT     pin the test server to a specific port (default: 0 = ephemeral)
 *   PREACT_SMOKE_TIMEOUT  per-page navigation timeout in ms (default 30000)
 *   PREACT_SMOKE_REBUILD  force a fresh marketing build even if dist exists
 */
import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import express from 'express';
import { type Server } from 'http';
import { chromium, type Browser, type ConsoleMessage, type Page } from 'playwright';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MARKETING_DIST_PATH = path.join(REPO_ROOT, 'client-app', 'dist', 'public');
const MARKETING_HTML_PATH = path.join(MARKETING_DIST_PATH, 'index.public.html');

const NAV_TIMEOUT_MS = Number(process.env.PREACT_SMOKE_TIMEOUT ?? '30000');
const SERVER_PORT = Number(process.env.PREACT_SMOKE_PORT ?? '0');
const FORCE_REBUILD = process.env.PREACT_SMOKE_REBUILD === '1';

/**
 * Mirrors the canonical list of marketing routes declared in
 * `client-app/src/PublicApp.tsx`. Every entry is an actual URL the user can
 * land on (params resolved to a real value where the page expects one).
 *
 * `notes` is purely for human-readable failure output.
 */
interface RouteCase {
  url: string;
  notes?: string;
}

const ROUTES: ReadonlyArray<RouteCase> = [
  { url: '/', notes: 'Landing' },
  { url: '/product', notes: 'Product' },
  { url: '/product/federated-ingest', notes: 'FederatedIngest' },
  { url: '/product/global-intelligence-network', notes: 'GlobalIntelligenceNetwork' },
  { url: '/features', notes: 'Features' },
  { url: '/ai-agents', notes: 'AgentsShowcase' },
  { url: '/pricing', notes: 'Pricing' },
  { url: '/use-cases', notes: 'UseCases' },
  { url: '/integrations', notes: 'Integrations' },
  { url: '/demo', notes: 'Demo' },
  { url: '/contact', notes: 'Contact' },
  { url: '/docs', notes: 'Docs index' },
  { url: '/docs/quickstart', notes: 'DocArticle (real slug)' },
  { url: '/docs/this-slug-does-not-exist', notes: 'DocArticle (unknown slug → redirect)' },
  { url: '/resources', notes: 'Resources index' },
  { url: '/resources/getting-started-with-qvo', notes: 'GuideDetail (real slug)' },
  { url: '/resources/this-slug-does-not-exist', notes: 'GuideDetail (unknown slug → redirect)' },
  { url: '/signup', notes: 'Signup' },
  { url: '/blog', notes: 'Blog index' },
  { url: '/blog/what-are-ai-voice-agents', notes: 'BlogArticle (real slug)' },
  { url: '/blog/this-slug-does-not-exist', notes: 'BlogArticle (unknown slug)' },
  { url: '/industries/vertical-agents', notes: 'VerticalAgents' },
  { url: '/industries/dental', notes: 'VerticalLanding (real vertical)' },
  { url: '/industries/this-vertical-does-not-exist', notes: 'VerticalLanding (unknown vertical)' },
  { url: '/case-studies', notes: 'CaseStudies index' },
  { url: '/case-studies/example-customer', notes: 'CaseStudies detail (slug)' },
  { url: '/book-demo', notes: 'BookDemo' },
  { url: '/terms', notes: 'Terms' },
  { url: '/privacy', notes: 'Privacy' },
  { url: '/security', notes: 'Security' },
  { url: '/security/posture', notes: 'SecurityPosture' },
  { url: '/subprocessors', notes: 'Subprocessors' },
  { url: '/this-route-does-not-exist', notes: 'NotFound (catch-all)' },
];

interface CapturedIssue {
  kind: 'pageerror' | 'console' | 'unhandledrejection' | 'navigation';
  message: string;
  location?: string;
}

interface RouteResult {
  route: RouteCase;
  passed: boolean;
  issues: CapturedIssue[];
}

/**
 * Stubbed JSON responses for the `/api/**` calls a handful of marketing
 * pages make on mount. Returning a sane shape (rather than 404) keeps the
 * pages out of their error branches, which would otherwise dump network
 * failures into the browser console and mask real Preact-compat regressions.
 *
 * Anything not listed here returns `{}` with status 200 — pages that catch
 * unknown shapes (and they all do) will simply skip the data.
 */
function mountApiStubs(app: express.Express): void {
  app.get('/api/public/case-studies', (_req, res) => res.json([]));
  app.get('/api/public/case-studies/:slug', (_req, res) => res.status(404).json({ error: 'not_found' }));
  app.get('/api/public/gin/benchmarks', (_req, res) => res.json({ status: 'preview', rows: [] }));
  app.get('/api/public/posture', (_req, res) =>
    // Shape mirrors the `Posture` interface in `pages/public/SecurityPosture.tsx`.
    // Returning the right shape (rather than a stub that lands in the page's
    // error branch) keeps this smoke test focused on Preact-compat regressions
    // instead of mock-data shape drift.
    res.json({
      version: 1,
      generated_at: new Date().toISOString(),
      organization: {
        name: 'QVO',
        contact_security: 'security@example.com',
        contact_privacy: 'privacy@example.com',
      },
      frameworks: [],
      baa: { available: false, plans: [], contact: 'legal@example.com', notes: '' },
      data_residency: { primary_region: 'us-east', description: '' },
      subprocessors: [],
      documents: [],
    }),
  );
  app.get('/api/public/subprocessors', (_req, res) => res.json({ subprocessors: [] }));
  app.get('/api/book-demo/config', (_req, res) =>
    res.json({ provider: 'inline', embedUrl: '' }),
  );
  app.get('/api/platform/maintenance', (_req, res) =>
    res.json({ enabled: false, message: null, scheduled_for: null }),
  );
  app.use('/api', (_req, res) => res.status(200).json({}));
}

function ensureMarketingBuild(): void {
  if (!FORCE_REBUILD && fs.existsSync(MARKETING_HTML_PATH)) {
    return;
  }
  // eslint-disable-next-line no-console
  console.log(
    FORCE_REBUILD
      ? '→ PREACT_SMOKE_REBUILD=1 set; rebuilding marketing bundle…'
      : `→ marketing bundle missing at ${MARKETING_HTML_PATH}; running build:public…`,
  );
  const result = spawnSync('npm', ['--prefix', 'client-app', 'run', 'build:public'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`marketing build failed (exit ${result.status})`);
  }
  if (!fs.existsSync(MARKETING_HTML_PATH)) {
    throw new Error(`marketing build did not emit ${MARKETING_HTML_PATH}`);
  }
}

async function startServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();

  // The marketing build is `base: '/public/'`, so its hashed asset URLs
  // resolve under `/public/assets/...`. Mount the dist directory at that
  // prefix so they actually serve.
  app.use('/public', express.static(MARKETING_DIST_PATH, { index: false }));
  // The repo also serves a few static files from `client-app/public/` (sitemap,
  // robots.txt, og-default.png, hero images, doc screenshots) that the build
  // copies into `dist/public/` itself; serve them at the root so any
  // `<img src="/industry-hero/...">` references resolve.
  app.use(express.static(MARKETING_DIST_PATH, { index: false }));

  mountApiStubs(app);

  // SPA history fallback — every non-asset HTML navigation gets the marketing
  // index, exactly like the production server does for marketing pathnames.
  app.get('/', (_req, res) => res.sendFile(MARKETING_HTML_PATH));
  app.get('/*splat', (_req, res) => res.sendFile(MARKETING_HTML_PATH));

  return await new Promise((resolve, reject) => {
    let server: Server | null = null;
    server = app.listen(SERVER_PORT, '127.0.0.1', () => {
      const addr = server!.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('failed to determine server address'));
        return;
      }
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({
        baseUrl,
        close: () =>
          new Promise<void>((res) => {
            server!.close(() => res());
          }),
      });
    });
    server.on('error', reject);
  });
}

/**
 * Some console messages are environmental noise rather than Preact-compat
 * regressions:
 *   - "Failed to load resource" from a missing image / font / opt-in network
 *     request that the test server doesn't host. Real regressions come from
 *     application code calling `console.error(...)` directly, which always
 *     has a JS stack frame in `location.url` pointing at one of our bundles.
 *   - React DevTools download nag: a printf from React/Preact that fires
 *     on every page in development mode. Harmless, never user-visible.
 *
 * Everything else (including any `console.error()` invocation from app code)
 * counts as a failure.
 */
function shouldIgnoreConsoleMessage(msg: ConsoleMessage): boolean {
  const text = msg.text();
  if (/Failed to load resource/i.test(text)) return true;
  if (/Download the React DevTools/i.test(text)) return true;
  // Browser-emitted CORS / mixed-content / favicon warnings during navigation.
  if (/favicon\.ico/.test(text)) return true;
  return false;
}

async function checkRoute(browser: Browser, baseUrl: string, route: RouteCase): Promise<RouteResult> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Track unhandled promise rejections from inside the page. Playwright's
  // `page.on('pageerror')` already covers synchronous uncaught exceptions
  // (which is what most Preact-compat regressions surface as), but a
  // promise rejected with no `.catch()` handler — e.g. a useEffect that
  // awaits an API call and crashes inside the awaited callback — only
  // shows up as an `unhandledrejection` event on `window`.
  await ctx.addInitScript(() => {
    (window as unknown as { __preactSmokeRejections: string[] }).__preactSmokeRejections = [];
    window.addEventListener('unhandledrejection', (event) => {
      const reason = event.reason;
      const text =
        reason && typeof reason === 'object' && 'message' in reason
          ? String((reason as { message: unknown }).message)
          : String(reason);
      (window as unknown as { __preactSmokeRejections: string[] }).__preactSmokeRejections.push(text);
    });
  });

  const issues: CapturedIssue[] = [];
  const page: Page = await ctx.newPage();

  page.on('pageerror', (err) => {
    issues.push({ kind: 'pageerror', message: err.message, location: err.stack ?? undefined });
  });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    if (shouldIgnoreConsoleMessage(msg)) return;
    const loc = msg.location();
    issues.push({
      kind: 'console',
      message: msg.text(),
      location: loc.url ? `${loc.url}:${loc.lineNumber}:${loc.columnNumber}` : undefined,
    });
  });

  try {
    const response = await page.goto(`${baseUrl}${route.url}`, {
      waitUntil: 'networkidle',
      timeout: NAV_TIMEOUT_MS,
    });
    if (!response) {
      issues.push({ kind: 'navigation', message: 'no HTTP response received' });
    } else if (response.status() >= 400) {
      issues.push({ kind: 'navigation', message: `HTTP ${response.status()} from server` });
    }

    // Settle for any post-mount async work (lazy chunks, in-flight API calls,
    // RAF-driven animations) so a deferred render error has a chance to fire.
    await page.waitForTimeout(500);

    // Sanity check: the SPA root mounted something. The Preact-compat root
    // creator on a broken page would no-op silently, leaving `<div id="root">`
    // empty even though no exception fired during the initial render.
    const rootMounted = await page.evaluate(() => {
      const root = document.getElementById('root');
      return !!(root && root.children.length > 0);
    });
    if (!rootMounted) {
      issues.push({
        kind: 'navigation',
        message: '<div id="root"> rendered no children — bundle did not mount',
      });
    }

    const rejections = await page.evaluate(
      () => (window as unknown as { __preactSmokeRejections: string[] }).__preactSmokeRejections ?? [],
    );
    for (const r of rejections) {
      issues.push({ kind: 'unhandledrejection', message: r });
    }
  } catch (err) {
    issues.push({ kind: 'navigation', message: (err as Error).message });
  } finally {
    await ctx.close();
  }

  return { route, passed: issues.length === 0, issues };
}

function formatIssue(issue: CapturedIssue): string {
  const head = `      [${issue.kind}] ${issue.message}`;
  return issue.location ? `${head}\n        @ ${issue.location}` : head;
}

async function run(): Promise<void> {
  ensureMarketingBuild();

  const server = await startServer();
  // eslint-disable-next-line no-console
  console.log(`→ serving ${MARKETING_DIST_PATH} at ${server.baseUrl}`);

  const browser: Browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const results: RouteResult[] = [];
  try {
    for (const route of ROUTES) {
      // eslint-disable-next-line no-console
      process.stdout.write(`  · ${route.url.padEnd(48)} ... `);
      const result = await checkRoute(browser, server.baseUrl, route);
      results.push(result);
      // eslint-disable-next-line no-console
      console.log(result.passed ? 'OK' : `FAIL (${result.issues.length} issue${result.issues.length === 1 ? '' : 's'})`);
    }
  } finally {
    await browser.close();
    await server.close();
  }

  let failed = 0;
  for (const r of results) {
    if (r.passed) continue;
    failed += 1;
    // eslint-disable-next-line no-console
    console.error(`\n[FAIL] ${r.route.url}${r.route.notes ? ` — ${r.route.notes}` : ''}`);
    for (const issue of r.issues.slice(0, 10)) {
      // eslint-disable-next-line no-console
      console.error(formatIssue(issue));
    }
    if (r.issues.length > 10) {
      // eslint-disable-next-line no-console
      console.error(`      … and ${r.issues.length - 10} more`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `\n${results.length - failed}/${results.length} marketing routes rendered cleanly under preact/compat.`,
  );
  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('e2e test failed:', err);
  process.exit(1);
});
