/**
 * BL-012: end-to-end regression test for the open-redirect guard on
 * `/login?redirectTo=…`.
 *
 * Verifies that:
 *   1. A cross-origin `redirectTo` (https://attacker.com/...) is dropped:
 *      after a successful login the user lands on their role-aware default
 *      (`/admin/dashboard` for our seeded platform admin), NOT on the
 *      attacker's URL.
 *   2. A protocol-relative `redirectTo` (`//attacker.com/...`) is dropped
 *      the same way.
 *   3. A legitimate same-origin path (`/widget`) IS honoured — the guard
 *      should not break the intended UX.
 *
 * Standalone runner — no `@playwright/test` dependency. Mirrors the pattern
 * established in `tests/e2e/salesInboxFilters.spec.ts`:
 *
 *   npx tsx tests/e2e/loginRedirectGuard.spec.ts
 *
 * Pre-requisites:
 *   - Platform Dev workflow running (admin API on :3002, vite on :5000).
 *   - `ADMIN_PASSWORD=<known-password> npx tsx scripts/seed-admin.ts` has
 *     been run.
 *   - Playwright browsers installed: `npx playwright install chromium`.
 *
 * Env vars (all optional):
 *   E2E_BASE_URL         default http://localhost:5000
 *   E2E_ADMIN_EMAIL      default admin@voiceaihub.dev
 *   E2E_ADMIN_PASSWORD   default test-password-123
 */
import { chromium, type Browser, type Page, type Request } from 'playwright';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@voiceaihub.dev';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'test-password-123';

interface TestResult {
  name: string;
  passed: boolean;
  detail?: string;
}

async function loginWithRedirect(
  page: Page,
  redirectTo: string,
): Promise<{ finalUrl: string; crossOriginAttempts: string[] }> {
  // Track every navigation request so we can assert nothing pointed off-site.
  const crossOriginAttempts: string[] = [];
  const trackRequest = (req: Request) => {
    if (req.isNavigationRequest()) {
      const url = req.url();
      try {
        const parsed = new URL(url);
        const baseHost = new URL(BASE_URL).host;
        if (parsed.host !== baseHost) {
          crossOriginAttempts.push(url);
        }
      } catch {
        crossOriginAttempts.push(url);
      }
    }
  };
  page.on('request', trackRequest);

  const url = `${BASE_URL}/login?redirectTo=${encodeURIComponent(redirectTo)}`;
  await page.goto(url, { waitUntil: 'networkidle' });

  await page.fill('input[type="email"]', ADMIN_EMAIL);
  await page.fill('input[type="password"]', ADMIN_PASSWORD);

  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15_000 }),
    page.click('button[type="submit"]'),
  ]);
  // Settle on whatever the SPA navigated to.
  await page.waitForLoadState('networkidle').catch(() => {
    /* fine — network may stay open due to long-poll endpoints */
  });

  page.off('request', trackRequest);
  return { finalUrl: page.url(), crossOriginAttempts };
}

async function logout(page: Page): Promise<void> {
  await page.context().clearCookies();
  await page.evaluate(() => {
    try {
      window.localStorage.clear();
      window.sessionStorage.clear();
    } catch {
      /* SecurityError on opaque origins — ignore */
    }
  });
}

async function run(): Promise<void> {
  const browser: Browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const results: TestResult[] = [];

  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    // ---------- Case 1: absolute cross-origin URL is scrubbed ----------
    {
      const evil = 'https://attacker.example.com/phish';
      const { finalUrl, crossOriginAttempts } = await loginWithRedirect(page, evil);

      const stayedOnSite = finalUrl.startsWith(BASE_URL);
      const noOffSiteNav = crossOriginAttempts.length === 0;
      // Admin lands on /admin/dashboard, regular tenant on /dashboard. Either
      // is acceptable — what matters is that we did NOT land on attacker.com.
      const landedOnDefault =
        finalUrl.includes('/admin/dashboard') ||
        finalUrl.includes('/dashboard') ||
        finalUrl.includes('/ops/monitor');

      results.push({
        name: 'absolute https URL is scrubbed → user lands on safe default',
        passed: stayedOnSite && noOffSiteNav && landedOnDefault,
        detail: `finalUrl=${finalUrl} | crossOriginAttempts=${JSON.stringify(crossOriginAttempts)}`,
      });
      await logout(page);
    }

    // ---------- Case 2: protocol-relative URL is scrubbed ----------
    {
      const evil = '//attacker.example.com/phish';
      const { finalUrl, crossOriginAttempts } = await loginWithRedirect(page, evil);
      const stayedOnSite = finalUrl.startsWith(BASE_URL);
      const noOffSiteNav = crossOriginAttempts.length === 0;
      results.push({
        name: 'protocol-relative URL (//attacker.com) is scrubbed',
        passed: stayedOnSite && noOffSiteNav,
        detail: `finalUrl=${finalUrl} | crossOriginAttempts=${JSON.stringify(crossOriginAttempts)}`,
      });
      await logout(page);
    }

    // ---------- Case 3: backslash bypass is scrubbed ----------
    {
      const evil = '/\\attacker.example.com/phish';
      const { finalUrl, crossOriginAttempts } = await loginWithRedirect(page, evil);
      const stayedOnSite = finalUrl.startsWith(BASE_URL);
      const noOffSiteNav = crossOriginAttempts.length === 0;
      results.push({
        name: 'backslash bypass (/\\attacker.com) is scrubbed',
        passed: stayedOnSite && noOffSiteNav,
        detail: `finalUrl=${finalUrl} | crossOriginAttempts=${JSON.stringify(crossOriginAttempts)}`,
      });
      await logout(page);
    }

    // ---------- Case 4: legitimate same-origin path IS honoured ----------
    {
      const safeTarget = '/widget';
      const { finalUrl, crossOriginAttempts } = await loginWithRedirect(page, safeTarget);
      const honored = finalUrl.startsWith(`${BASE_URL}/widget`);
      const noOffSiteNav = crossOriginAttempts.length === 0;
      results.push({
        name: 'same-origin path /widget is honoured',
        passed: honored && noOffSiteNav,
        detail: `finalUrl=${finalUrl} | crossOriginAttempts=${JSON.stringify(crossOriginAttempts)}`,
      });
      await logout(page);
    }

    await context.close();
  } finally {
    await browser.close();
  }

  let failed = 0;
  for (const r of results) {
    const flag = r.passed ? 'PASS' : 'FAIL';
    // eslint-disable-next-line no-console
    console.log(`[${flag}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    if (!r.passed) failed += 1;
  }
  // eslint-disable-next-line no-console
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('e2e test failed:', err);
  process.exit(1);
});
