/**
 * QVO/4 · Brand prominence smoke test.
 *
 * Sibling of the data-hydration specs (tenantPagesSmoke, adminPagesSmoke,
 * opsPagesSmoke, publicPagesPreactSmoke). Those catch "the shell rendered
 * but the cards under it are stuck on skeletons." This one catches the
 * regression class Wayne actually flagged in the QVO rebrand:
 *
 *   - Logo disappears from a layout (PublicLayout / TenantLayout / ConsoleShell
 *     all render an `<img src="/brand/logo-*.png">` and the brand-kit directive
 *     says "the logo must be prominent across the app and website").
 *   - Page console.errors silently (a fetch crashes, a missing translation
 *     key triggers an i18n warning, a deprecated React API logs). Existing
 *     tenant/admin/ops smoke specs capture console errors but don't fail
 *     on them — this one does.
 *   - The QVO theme tokens never get applied (e.g. a layout drops the
 *     [data-accent] attribute, or _theme.css fails to load). Checked via
 *     a computed-style probe on the brand color custom property.
 *
 * Runs across ONE representative page per surface:
 *   - Public marketing root (/)
 *   - Public vertical landing (/industries/dental) — exercises
 *     [data-accent="teal-forward"]
 *   - Tenant dashboard (/dashboard)
 *   - Admin dashboard (/admin/dashboard)
 *   - Ops console live monitor (/ops/monitor)
 *
 * The data-hydration specs already walk every individual page; this spec
 * deliberately stays narrow so it runs in <60s in CI and pinpoints brand
 * regressions without re-checking what the other specs cover.
 *
 * Runs against a real Chromium browser via the `playwright` runtime API
 * (no @playwright/test dependency). Standalone — no test runner.
 *
 *   npx tsx tests/e2e/brandProminenceSmoke.spec.ts
 *
 * Pre-requisites:
 *   - Platform Dev workflow running (admin API on :3002, vite on :5000).
 *   - `ADMIN_PASSWORD=<known-password> npx tsx scripts/seed-admin.ts` has
 *     been run, so the platform-admin login below succeeds (also gives the
 *     user tenant_owner on admin-org for the tenant route).
 *   - Playwright Chromium installed: `npx playwright install chromium`.
 *
 * Env vars (all optional):
 *   E2E_BASE_URL           default http://localhost:5000
 *   E2E_ADMIN_EMAIL        default admin@voiceaihub.dev
 *   E2E_ADMIN_PASSWORD     default test-password-123
 *   BRAND_SMOKE_TIMEOUT    per-page nav timeout in ms, default 20000
 *   BRAND_SMOKE_PUBLIC_ONLY  set to "1" to skip authed pages — useful when
 *                          running against a stripped vite-only dev server
 *                          (no admin API booted, no seeded admin user).
 */
import { chromium, type Browser, type ConsoleMessage, type Page } from 'playwright';
import { loginViaUi } from './helpers/login';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@voiceaihub.dev';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'test-password-123';
const PAGE_TIMEOUT_MS = Number(process.env.BRAND_SMOKE_TIMEOUT ?? '20000');
const PUBLIC_ONLY = process.env.BRAND_SMOKE_PUBLIC_ONLY === '1';

interface PageCheck {
  /** URL path under BASE_URL. */
  path: string;
  /** Human-friendly slug for log output. */
  slug: string;
  /** Whether the page is behind auth (needs login before nav). */
  requiresAuth: boolean;
  /**
   * Optional accent value the layout is expected to apply via [data-accent].
   * VerticalLanding flips to 'teal-forward' for the medical wedge; the
   * default marketing surface and all consoles leave it unset/undefined.
   */
  expectedAccent?: string;
}

const PAGES: PageCheck[] = [
  // Marketing surface — all public pages we've brand-restored. Every one
  // got the radial-gradient hero treatment + defensive text-white +
  // brand-token color audit pass. Walking the full set in CI means any
  // future regression (e.g. someone reintroduces a raw Tailwind color or
  // forgets the explicit text-white on a new dark-band heading) breaks
  // the build instead of shipping silently.
  { path: '/', slug: 'public-landing', requiresAuth: false, expectedAccent: 'teal-forward' },
  { path: '/pricing', slug: 'public-pricing', requiresAuth: false, expectedAccent: 'teal-forward' },
  { path: '/features', slug: 'public-features', requiresAuth: false, expectedAccent: 'teal-forward' },
  { path: '/use-cases', slug: 'public-use-cases', requiresAuth: false, expectedAccent: 'teal-forward' },
  { path: '/product', slug: 'public-product', requiresAuth: false, expectedAccent: 'teal-forward' },
  { path: '/ai-agents', slug: 'public-agents-showcase', requiresAuth: false, expectedAccent: 'teal-forward' },
  { path: '/demo', slug: 'public-demo', requiresAuth: false, expectedAccent: 'teal-forward' },
  { path: '/contact', slug: 'public-contact', requiresAuth: false, expectedAccent: 'teal-forward' },
  { path: '/book-demo', slug: 'public-book-demo', requiresAuth: false, expectedAccent: 'teal-forward' },
  { path: '/integrations', slug: 'public-integrations', requiresAuth: false, expectedAccent: 'teal-forward' },
  { path: '/resources', slug: 'public-resources', requiresAuth: false, expectedAccent: 'teal-forward' },
  { path: '/blog', slug: 'public-blog', requiresAuth: false, expectedAccent: 'teal-forward' },
  { path: '/security', slug: 'public-security', requiresAuth: false, expectedAccent: 'teal-forward' },
  { path: '/security/posture', slug: 'public-security-posture', requiresAuth: false, expectedAccent: 'teal-forward' },
  { path: '/subprocessors', slug: 'public-subprocessors', requiresAuth: false, expectedAccent: 'teal-forward' },
  { path: '/signup', slug: 'public-signup', requiresAuth: false, expectedAccent: 'teal-forward' },
  { path: '/terms', slug: 'public-terms', requiresAuth: false, expectedAccent: 'teal-forward' },
  { path: '/privacy', slug: 'public-privacy', requiresAuth: false, expectedAccent: 'teal-forward' },
  { path: '/docs', slug: 'public-docs', requiresAuth: false, expectedAccent: 'teal-forward' },
  { path: '/industries/dental', slug: 'public-vertical-dental', requiresAuth: false, expectedAccent: 'teal-forward' },
  { path: '/industries/vertical-agents', slug: 'public-vertical-agents', requiresAuth: false, expectedAccent: 'teal-forward' },
  { path: '/product/federated-ingest', slug: 'public-federated-ingest', requiresAuth: false, expectedAccent: 'teal-forward' },
  { path: '/product/global-intelligence-network', slug: 'public-gin', requiresAuth: false, expectedAccent: 'teal-forward' },
  // Console surface — sticky brand-prominence checks on the three
  // logged-in shells. requiresAuth=true triggers the login flow.
  { path: '/dashboard', slug: 'tenant-dashboard', requiresAuth: true },
  { path: '/admin/dashboard', slug: 'admin-dashboard', requiresAuth: true },
  // `/ops/calls` was the prior probe path, but no such route exists in
  // App.tsx — the SPA fallback rendered a chrome-less view without the
  // QVO logo and the brand check rightly failed. The Ops console's
  // canonical landing route is `/ops/monitor` (live monitoring), which
  // is what OpsLayout's first nav group points at. Probing the shell
  // through a real route gives a true brand-prominence check.
  { path: '/ops/monitor', slug: 'ops-monitor', requiresAuth: true },
];

interface CapturedIssue {
  kind: 'pageerror' | 'console' | 'logo' | 'theme' | 'navigation';
  message: string;
  location?: string;
}

interface PageResult {
  page: PageCheck;
  passed: boolean;
  issues: CapturedIssue[];
}

/**
 * Same filter the publicPagesPreactSmoke spec uses — keeps environmental
 * noise (missing favicons, React DevTools nag, resource-load failures from
 * external CDNs) out of the failure list. Anything else from app code
 * counts as a failure.
 */
function shouldIgnoreConsoleMessage(msg: ConsoleMessage): boolean {
  const text = msg.text();
  if (/Failed to load resource/i.test(text)) return true;
  if (/Download the React DevTools/i.test(text)) return true;
  if (/favicon\.ico/.test(text)) return true;
  // Vite HMR / dev-only warnings during navigation; not user-visible in prod.
  if (/\[vite\]/i.test(text)) return true;
  // i18n missingKey is a known long-tail; the dedicated check:i18n-keys script
  // owns that surface, this spec doesn't double-report.
  if (/i18next::translator: missingKey/i.test(text)) return true;
  return false;
}

async function login(page: Page): Promise<void> {
  await loginViaUi(page, ADMIN_EMAIL, ADMIN_PASSWORD, { waitUntil: 'networkidle' });
}

async function checkPage(page: Page, check: PageCheck): Promise<PageResult> {
  const issues: CapturedIssue[] = [];

  const onConsole = (msg: ConsoleMessage) => {
    if (msg.type() !== 'error') return;
    if (shouldIgnoreConsoleMessage(msg)) return;
    const loc = msg.location();
    issues.push({
      kind: 'console',
      message: msg.text(),
      location: loc.url ? `${loc.url}:${loc.lineNumber}:${loc.columnNumber}` : undefined,
    });
  };
  const onPageError = (err: Error) => {
    issues.push({ kind: 'pageerror', message: err.message, location: err.stack ?? undefined });
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);

  try {
    await page.goto(`${BASE_URL}${check.path}`, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_TIMEOUT_MS,
    });
    // Settle: layouts mount lazy chunks (sidebar, FABs), and the [data-accent]
    // is applied in a useEffect on PublicLayout — give the next macrotask a
    // chance before we probe the DOM.
    await page.waitForLoadState('networkidle', { timeout: PAGE_TIMEOUT_MS }).catch(() => {
      // networkidle can be flaky on pages with long-poll SSE (Operations);
      // fall through to the explicit settle below and let the per-check
      // assertions speak for themselves.
    });
    await page.waitForTimeout(500);

    // ----- Logo prominence -------------------------------------------------
    // PublicLayout, TenantLayout, and ConsoleShell each render an
    // `<img src="/brand/logo-...">`. At least one must exist AND be visible
    // (non-zero bounding box). A layout that silently drops the logo
    // (regression class: someone replaces it with a text mark) will fail
    // here.
    const logoState = await page.evaluate(() => {
      const imgs = Array.from(
        document.querySelectorAll<HTMLImageElement>('img[src*="/brand/logo-"]'),
      );
      if (imgs.length === 0) return { count: 0, visibleCount: 0, srcs: [] as string[] };
      const visible = imgs.filter((img) => {
        const r = img.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      return {
        count: imgs.length,
        visibleCount: visible.length,
        srcs: imgs.map((i) => i.getAttribute('src') ?? ''),
      };
    });
    if (logoState.count === 0) {
      issues.push({
        kind: 'logo',
        message: 'no <img src*="/brand/logo-"> in DOM — layout dropped the QVO logo',
      });
    } else if (logoState.visibleCount === 0) {
      issues.push({
        kind: 'logo',
        message: `found ${logoState.count} logo image(s) but none visible (zero bounding box). srcs: ${logoState.srcs.join(', ')}`,
      });
    }

    // ----- QVO theme tokens applied ---------------------------------------
    // _theme.css defines --color-primary as an alias of --qvo-brand. If the
    // bridge fails to load (e.g. someone deletes the import from tokens.css),
    // the computed value resolves to the empty string instead of an rgb().
    // Also probe --qvo-brand directly to distinguish "Tailwind v4 baked"
    // (which leaves --color-primary defined) from "QVO tokens loaded"
    // (which is the source of truth).
    const themeState = await page.evaluate(() => {
      const styles = getComputedStyle(document.documentElement);
      const colorPrimary = styles.getPropertyValue('--color-primary').trim();
      const qvoBrand = styles.getPropertyValue('--qvo-brand').trim();
      const dataAccent = document.documentElement.getAttribute('data-accent')
        ?? document.body.getAttribute('data-accent')
        ?? document.querySelector('[data-accent]')?.getAttribute('data-accent')
        ?? null;
      return { colorPrimary, qvoBrand, dataAccent };
    });
    if (!themeState.qvoBrand) {
      issues.push({
        kind: 'theme',
        message: '--qvo-brand custom property is empty on <html> — qvo-global.css not loaded',
      });
    }
    if (!themeState.colorPrimary) {
      issues.push({
        kind: 'theme',
        message: '--color-primary custom property is empty on <html> — _theme.css bridge not loaded',
      });
    }
    if (check.expectedAccent && themeState.dataAccent !== check.expectedAccent) {
      issues.push({
        kind: 'theme',
        message: `expected [data-accent="${check.expectedAccent}"] on this layout, found ${themeState.dataAccent === null ? '<unset>' : `"${themeState.dataAccent}"`}`,
      });
    }
  } catch (err) {
    issues.push({ kind: 'navigation', message: (err as Error).message });
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
  }

  return { page: check, passed: issues.length === 0, issues };
}

function formatIssue(issue: CapturedIssue): string {
  const head = `      [${issue.kind}] ${issue.message}`;
  return issue.location ? `${head}\n        @ ${issue.location}` : head;
}

async function run(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`→ brand prominence smoke against ${BASE_URL}`);

  const browser: Browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  // One context for auth pages (shares login cookie across them), one for
  // unauth so the public pages prove they render without a session.
  const authCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const publicCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });

  const activePages = PUBLIC_ONLY ? PAGES.filter((p) => !p.requiresAuth) : PAGES;
  if (PUBLIC_ONLY) {
    // eslint-disable-next-line no-console
    console.log(`→ BRAND_SMOKE_PUBLIC_ONLY=1 — skipping ${PAGES.length - activePages.length} authed page(s)`);
  }
  const results: PageResult[] = [];
  const needsAuth = activePages.some((p) => p.requiresAuth);
  try {
    // Log in once on the auth context if any authed page is on the list —
    // every authed page reuses the cookie. Skip if PAGES is public-only so
    // the spec stays runnable against a stripped-down dev environment
    // (e.g. marketing-only Replit deploy where the admin API isn't booted).
    if (needsAuth) {
      const loginPage = await authCtx.newPage();
      try {
        await login(loginPage);
      } finally {
        await loginPage.close();
      }
    }

    for (const check of activePages) {
      // eslint-disable-next-line no-console
      process.stdout.write(`  · ${check.slug.padEnd(28)} ${check.path.padEnd(28)} ... `);
      const ctx = check.requiresAuth ? authCtx : publicCtx;
      const page = await ctx.newPage();
      let result: PageResult;
      try {
        result = await checkPage(page, check);
      } finally {
        await page.close();
      }
      results.push(result);
      // eslint-disable-next-line no-console
      console.log(result.passed ? 'OK' : `FAIL (${result.issues.length} issue${result.issues.length === 1 ? '' : 's'})`);
    }
  } finally {
    await authCtx.close();
    await publicCtx.close();
    await browser.close();
  }

  let failed = 0;
  for (const r of results) {
    if (r.passed) continue;
    failed += 1;
    // eslint-disable-next-line no-console
    console.error(`\n[FAIL] ${r.page.slug} — ${r.page.path}`);
    for (const issue of r.issues) {
      // eslint-disable-next-line no-console
      console.error(formatIssue(issue));
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `\n${results.length - failed}/${results.length} surfaces passed brand prominence smoke.`,
  );
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('brand prominence smoke crashed:', err);
  process.exit(1);
});
