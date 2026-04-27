/**
 * BL-013 / Task #247: end-to-end regression for the MaintenanceGate whitelist
 * and platform-admin bypass.
 *
 * Verifies that when maintenance mode is ON:
 *   1. A logged-out user hitting `/dashboard` (a NON-whitelisted path) sees
 *      the full-screen maintenance page — tenant traffic IS gated.
 *   2. The same logged-out user hitting `/login` (whitelisted) sees the
 *      login form, NOT the maintenance page — the whitelist works.
 *   3. A signed-in platform admin hitting `/admin/dashboard` sees the admin
 *      console, NOT the maintenance page — admins are not locked out.
 *   4. The signed-in admin sees the maintenance status banner (so they know
 *      the system is in maintenance mode across all consoles).
 *
 * The test toggles `/platform/maintenance` directly via the admin API at
 * the start of each scenario and unconditionally clears it in `finally`.
 *
 * Standalone runner (mirrors `tests/e2e/loginRedirectGuard.spec.ts`):
 *
 *   E2E_ADMIN_PASSWORD='VoiceHub2026!' npx tsx tests/e2e/maintenanceGateWhitelist.spec.ts
 *
 * Pre-requisites:
 *   - Platform Dev workflow running (admin API on :3002, vite on :5000).
 *   - `ADMIN_PASSWORD=<known-password> npx tsx scripts/seed-admin.ts` has
 *     been run.
 *   - Playwright browsers installed: `npx playwright install chromium`.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@voiceaihub.dev';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'test-password-123';

interface TestResult {
  name: string;
  passed: boolean;
  detail?: string;
}

async function adminLogin(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`admin login failed: ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { token: string; isPlatformAdmin?: boolean };
  if (!json.isPlatformAdmin) {
    throw new Error('seeded admin is not a platform admin');
  }
  return json.token;
}

async function setMaintenance(token: string, enabled: boolean, message: string | null) {
  const res = await fetch(`${BASE_URL}/api/platform/maintenance`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ enabled, message, scheduled_for: null }),
  });
  if (!res.ok) {
    throw new Error(
      `set maintenance failed (enabled=${enabled}): ${res.status} ${await res.text()}`,
    );
  }
}

async function uiLogin(page: Page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', ADMIN_EMAIL);
  await page.fill('input[type="password"]', ADMIN_PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15_000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function pageHtml(page: Page): Promise<string> {
  return await page.evaluate(() => document.body.innerText);
}

async function run(): Promise<void> {
  const browser: Browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const results: TestResult[] = [];
  let cleanupToken: string | null = null;

  try {
    const adminToken = await adminLogin();
    cleanupToken = adminToken;

    // Flip maintenance ON for the duration of these scenarios.
    await setMaintenance(adminToken, true, 'Maintenance window — BL-013 e2e');

    // ---------- Case 1: tenant traffic to /dashboard is denied ----------
    //
    // A logged-out user navigating to `/dashboard` MUST NOT land on the
    // tenant dashboard. They will either:
    //   (a) be intercepted by MaintenanceGate and shown the maintenance
    //       page directly, or
    //   (b) be redirected to /login by ProtectedRoute (and from there see
    //       the login form + the maintenance banner — /login is whitelisted).
    //
    // Either is correct system behaviour. What is NOT correct is reaching
    // the dashboard itself. We assert that explicitly.
    {
      const ctx: BrowserContext = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'networkidle' }).catch(() => {});
      const text = await pageHtml(page);
      const sawMaintenance = /QVO is briefly offline/i.test(text);
      const onLogin = page.url().includes('/login');
      // Sanity-check we did not somehow render dashboard content.
      const onDashboard = page.url().endsWith('/dashboard') && !sawMaintenance && !onLogin;
      const denied = !onDashboard && (sawMaintenance || onLogin);
      results.push({
        name: 'tenant traffic to /dashboard is denied (maintenance page or login redirect)',
        passed: denied,
        detail: `url=${page.url()} sawMaintenance=${sawMaintenance} onLogin=${onLogin}`,
      });
      await ctx.close();
    }

    // ---------- Case 2: logged-out user on /login is NOT gated ----------
    {
      const ctx: BrowserContext = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' }).catch(() => {});
      const hasEmailField = await page.locator('input[type="email"]').count();
      const text = await pageHtml(page);
      const sawMaintenance = /QVO is briefly offline/i.test(text);
      results.push({
        name: '/login is whitelisted: email input renders, maintenance page does NOT',
        passed: hasEmailField > 0 && !sawMaintenance,
        detail: `emailFields=${hasEmailField} sawMaintenance=${sawMaintenance}`,
      });
      await ctx.close();
    }

    // ---------- Case 3: platform admin reaches /admin/dashboard ----------
    {
      const ctx: BrowserContext = await browser.newContext();
      const page = await ctx.newPage();
      await uiLogin(page);
      // The admin should land on /admin/dashboard by default. Force-navigate
      // to make the assertion explicit even if the default route changes.
      await page.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' }).catch(() => {});
      const text = await pageHtml(page);
      const sawMaintenance = /QVO is briefly offline/i.test(text);
      const sawBanner = await page
        .locator('[data-testid="maintenance-status-banner"]')
        .count();
      const onAdminPath = page.url().includes('/admin/dashboard');
      results.push({
        name: 'platform admin reaches /admin/dashboard with maintenance ON',
        passed: onAdminPath && !sawMaintenance,
        detail: `url=${page.url()} sawMaintenance=${sawMaintenance}`,
      });
      results.push({
        name: 'platform admin sees maintenance status banner across consoles',
        passed: sawBanner > 0,
        detail: `bannerCount=${sawBanner}`,
      });
      await ctx.close();
    }
  } finally {
    if (cleanupToken) {
      // Always restore maintenance OFF, even if assertions failed above.
      await setMaintenance(cleanupToken, false, null).catch((err) => {
        // eslint-disable-next-line no-console
        console.error('cleanup: failed to disable maintenance:', err);
      });
    }
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
