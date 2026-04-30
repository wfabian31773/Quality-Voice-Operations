/**
 * Browser-level smoke test for high-traffic Operations Console pages.
 *
 * Sibling of `tests/e2e/tenantPagesSmoke.spec.ts` and
 * `tests/e2e/adminPagesSmoke.spec.ts`. Until task #1153 the Ops surface
 * was only being smoke-checked through the single Reliability route that
 * the tenant spec piggy-backed on. The remaining Ops Console pages
 * (Live Monitor, Debugger, Integration Diagnostics, Cost, Digital Twin,
 * Backfill calls) only got caught by manual clicking when a backend
 * route changed shape. This spec walks every link in
 * `client-app/src/components/OpsLayout.tsx`'s `opsLinks` so that a
 * regression in any of them fails CI before merge.
 *
 * For each page it asserts (hard fails):
 *
 *   1. The page navigates without redirecting back to /login (auth still
 *      works for the seeded admin-org tenant owner) and without bouncing
 *      out of the Ops Console (OpsGuard regression).
 *   2. The expected `<h1>` (or test-id sentinel) renders within the
 *      timeout — i.e. the route resolved, the lazy chunk loaded, and the
 *      top-level component rendered without throwing into the
 *      ErrorBoundary.
 *   3. The ErrorBoundary fallback ("An unexpected error occurred", from
 *      `client-app/src/pages/ServerError.tsx`) is NOT visible.
 *   4. The OpsGuard / RoleGuard AccessDenied panel is NOT visible (would
 *      mean the seeded role on admin-org somehow regressed).
 *   5. No uncaught page errors fired during navigation.
 *
 * It also surfaces (soft warnings, no fail) any 5xx responses from /api/*
 * during the page load. We don't fail on those because individual cards
 * on a page are expected to handle their own empty/error states
 * gracefully — if a 5xx took down the whole page, assertions 2-4 will
 * catch it. The warnings still land in the spec log for triagers.
 *
 * Runs against a real Chromium browser via the `playwright` runtime API
 * (no @playwright/test dependency required). Standalone — no test runner.
 *
 *   npx tsx tests/e2e/opsPagesSmoke.spec.ts
 *
 * Pre-requisites (same as the sibling smoke specs):
 *   - Platform Dev workflow is running (admin API on :3002, vite on :5000).
 *   - `ADMIN_PASSWORD=<known-password> npx tsx scripts/seed-admin.ts` has
 *     been run, so the platform-admin login below succeeds. The seed
 *     script also gives that user a `tenant_owner` role on admin-org,
 *     which clears OpsGuard (platform_admin OR tenant_owner OR
 *     operations_manager) for every Ops Console route.
 *   - Playwright browsers installed: `npx playwright install chromium`.
 *
 * Env vars (all optional):
 *   E2E_BASE_URL           default http://localhost:5000   (vite dev preview)
 *   E2E_ADMIN_EMAIL        default admin@voiceaihub.dev
 *   E2E_ADMIN_PASSWORD     default test-password-123
 *   E2E_ARTIFACT_DIR       default .ci-logs/screenshots    (failure shots)
 */
import { chromium, type Browser, type Page, type Response } from 'playwright';
import { mkdir } from 'fs/promises';
import path from 'path';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@voiceaihub.dev';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'test-password-123';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';

const SPEC_NAME = 'ops-pages-smoke';

interface PageCheck {
  /** Path under BASE_URL — e.g. `/ops/monitor`. */
  path: string;
  /** Human-friendly slug used for screenshot filenames. */
  slug: string;
  /**
   * One of:
   *   - { kind: 'heading'; text: string }   waits for an <h1>/<h2> with the
   *       given text content.
   *   - { kind: 'testid'; testid: string }  waits for [data-testid="..."].
   * The first matching shape wins; if both are provided, both must appear.
   */
  expect: { kind: 'heading'; text: string } | { kind: 'testid'; testid: string };
}

// One entry per link in OpsLayout.tsx's `opsLinks`. Heading text below
// must match the literal `<h1>` / PageHeader title rendered by the route's
// page component — keep this list in sync when a heading is renamed.
const PAGES: PageCheck[] = [
  // Live Monitor — Operations.tsx PageHeader title="Operations". This
  // page also subscribes to the live agent feed on mount, so a regression
  // in /api/operations/* routes typically blows up the top-level render
  // before the heading paints.
  { path: '/ops/monitor', slug: 'ops-monitor', expect: { kind: 'heading', text: 'Operations' } },

  // Reliability — ToolHealth.tsx PageHeader title="Platform Reliability".
  // Previously covered by tenantPagesSmoke; relocated here so the Ops
  // surface owns its own coverage.
  { path: '/ops/reliability', slug: 'ops-reliability', expect: { kind: 'heading', text: 'Platform Reliability' } },

  // Backfill calls — admin/BackfillCalls.tsx <h1> "Backfill calls". Form
  // page that also hydrates the tenant context on mount.
  { path: '/ops/backfill-calls', slug: 'ops-backfill-calls', expect: { kind: 'heading', text: 'Backfill calls' } },

  // Debugger — CallDebug.tsx PageHeader title="Call Debugging". Heaviest
  // lazy chunk in the Ops Console (search + replay + live tabs).
  { path: '/ops/call-debug', slug: 'ops-call-debug', expect: { kind: 'heading', text: 'Call Debugging' } },

  // Integration Diagnostics — IntegrationDiagnostics.tsx <h1>
  // "Integration Diagnostics". Pulls webhook/outbox status on mount, so
  // /api/integration-diagnostics regressions surface here first.
  { path: '/ops/integration-diagnostics', slug: 'ops-integration-diagnostics', expect: { kind: 'heading', text: 'Integration Diagnostics' } },

  // Cost — CostOptimization.tsx PageHeader title="Cost Optimization".
  { path: '/ops/cost', slug: 'ops-cost', expect: { kind: 'heading', text: 'Cost Optimization' } },

  // Digital Twin — DigitalTwin.tsx PageHeader title contains "Digital
  // Twin" wrapped in a span with a tour launcher; getByRole('heading')
  // matches on accessible name, which still resolves to "Digital Twin".
  { path: '/ops/digital-twin', slug: 'ops-digital-twin', expect: { kind: 'heading', text: 'Digital Twin' } },
];

const ERROR_BOUNDARY_TEXT = 'An unexpected error occurred';
const ACCESS_DENIED_TEXT = 'Access denied';

/** Navigation/render budget per page — must stay well below the 25-min CI cap. */
const PAGE_TIMEOUT_MS = 20_000;

interface PageFailure {
  page: PageCheck;
  reason: string;
  consoleErrors: string[];
  pageErrors: string[];
  serverErrors: { url: string; status: number }[];
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function login(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', ADMIN_EMAIL);
  await page.fill('input[type="password"]', ADMIN_PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.toString().endsWith('/login'), { timeout: 15_000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function checkPage(page: Page, check: PageCheck): Promise<PageFailure | null> {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const serverErrors: { url: string; status: number }[] = [];

  const onConsole = (msg: import('playwright').ConsoleMessage) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  };
  const onPageError = (err: Error) => {
    pageErrors.push(err.message);
  };
  const onResponse = (res: Response) => {
    const status = res.status();
    const url = res.url();
    if (status >= 500 && status < 600 && url.includes('/api/')) {
      serverErrors.push({ url, status });
    }
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);

  let reason: string | null = null;
  try {
    await page.goto(`${BASE_URL}${check.path}`, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_TIMEOUT_MS,
    });

    // Auth check: the global redirect bounces logged-out users to /login,
    // and OpsGuard would push us to /dashboard if the seeded role ever
    // stops including tenant_owner / platform_admin / operations_manager.
    const landed = page.url();
    if (/\/login(\?|$)/.test(landed)) {
      reason = `redirected to /login (lost session?) — landed at ${landed}`;
    } else if (!landed.includes(check.path) && !landed.includes(check.path.split('?')[0])) {
      reason = `redirected away from ${check.path}, landed at ${landed} (OpsGuard regression?)`;
    }

    if (!reason) {
      // Wait for the expected sentinel. We use locator.first().waitFor() so
      // duplicate matches (e.g. h1 + breadcrumb) don't fail the strict
      // "exactly one match" rule that page.waitForSelector imposes.
      const locator =
        check.expect.kind === 'heading'
          ? page.getByRole('heading', { name: check.expect.text }).first()
          : page.locator(`[data-testid="${check.expect.testid}"]`).first();
      try {
        await locator.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
      } catch (err) {
        reason = `expected ${
          check.expect.kind === 'heading' ? `heading "${check.expect.text}"` : `[data-testid="${check.expect.testid}"]`
        } never appeared (${(err as Error).message})`;
      }
    }

    // Even if the heading was found, the ErrorBoundary may have rendered
    // *under* it for a child component. Guard against that explicitly.
    if (!reason) {
      const errorBoundaryVisible = await page
        .getByText(ERROR_BOUNDARY_TEXT, { exact: false })
        .first()
        .isVisible()
        .catch(() => false);
      if (errorBoundaryVisible) {
        reason = `ErrorBoundary fallback rendered ("${ERROR_BOUNDARY_TEXT}")`;
      }
    }

    // OpsGuard / RoleGuard renders an AccessDenied panel inside the
    // layout instead of redirecting, so a missing role wouldn't trip the
    // URL check above.
    if (!reason) {
      const accessDeniedVisible = await page
        .getByText(ACCESS_DENIED_TEXT, { exact: false })
        .first()
        .isVisible()
        .catch(() => false);
      if (accessDeniedVisible) {
        reason = `AccessDenied rendered ("${ACCESS_DENIED_TEXT}") — seeded ops role missing?`;
      }
    }

    if (!reason && pageErrors.length > 0) {
      reason = `uncaught page error(s): ${pageErrors.slice(0, 3).join(' | ')}`;
    }
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('response', onResponse);
  }

  // Soft-warn on 5xx /api responses regardless of pass/fail. These are
  // useful triage info but don't fail the spec on their own — a card with
  // an empty/error state on a page that otherwise rendered shouldn't
  // block the PR.
  if (serverErrors.length > 0) {
    console.warn(
      `[e2e] WARN ${check.path}: ${serverErrors.length} 5xx response(s) from /api/*: ${serverErrors
        .slice(0, 5)
        .map((e) => `${e.status} ${e.url}`)
        .join(' | ')}`,
    );
  }

  if (!reason) {
    return null;
  }

  // Capture a screenshot for triage.
  const shotPath = path.join(ARTIFACT_DIR, `${SPEC_NAME}-${check.slug}.png`);
  await mkdir(path.dirname(shotPath), { recursive: true }).catch(() => undefined);
  await page.screenshot({ path: shotPath, fullPage: true }).catch((err) => {
    console.warn(`[e2e] failed to write screenshot to ${shotPath}: ${(err as Error).message}`);
  });
  console.error(`[e2e] FAIL ${check.path}: ${reason}`);
  console.error(`[e2e]   screenshot: ${shotPath}`);
  if (consoleErrors.length > 0) {
    console.error(`[e2e]   console errors (${consoleErrors.length}): ${consoleErrors.slice(0, 5).join(' | ')}`);
  }

  return { page: check, reason, consoleErrors, pageErrors, serverErrors };
}

async function captureGlobalFailureScreenshot(page: Page | undefined): Promise<void> {
  if (!page) return;
  const shotPath = path.join(ARTIFACT_DIR, `${SPEC_NAME}-global-failure.png`);
  try {
    await mkdir(path.dirname(shotPath), { recursive: true });
    await page.screenshot({ path: shotPath, fullPage: true });
    console.error(`[e2e]   screenshot: ${shotPath}`);
  } catch (err) {
    console.warn(`[e2e] failed to write global-failure screenshot to ${shotPath}: ${(err as Error).message}`);
  }
}

async function run(): Promise<void> {
  let browser: Browser | undefined;
  // Holding the page reference outside the try block lets us capture a
  // screenshot from inside the catch when login() or per-page navigation
  // throws before checkPage() has a chance to write its own.
  let page: Page | undefined;
  const failures: PageFailure[] = [];
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await ctx.newPage();

    await login(page);
    console.log(`[e2e] logged in as ${ADMIN_EMAIL}`);

    for (const check of PAGES) {
      console.log(`[e2e] -> ${check.path}`);
      const failure = await checkPage(page, check);
      if (failure) {
        failures.push(failure);
      } else {
        console.log(`[e2e]    OK`);
      }
    }
  } catch (err) {
    // Bootstrap or unexpected throw — checkPage's per-page screenshot
    // hook never ran, so capture whatever the browser is currently
    // showing as a last-ditch artifact for triage.
    await captureGlobalFailureScreenshot(page);
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }

  if (failures.length > 0) {
    console.error(`[e2e] ${failures.length} of ${PAGES.length} ops page(s) failed:`);
    for (const f of failures) {
      console.error(`[e2e]   - ${f.page.path}: ${f.reason}`);
    }
    assert(false, `${failures.length} ops page smoke check(s) failed`);
  }

  console.log(`[e2e] PASS — all ${PAGES.length} ops pages rendered cleanly`);
}

run().catch((err) => {
  console.error('[e2e] FAIL', err);
  process.exitCode = 1;
});
