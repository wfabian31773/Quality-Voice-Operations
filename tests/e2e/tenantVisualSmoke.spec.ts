/**
 * Tenant Portal visual smoke — light + dark mode.
 *
 * Loads Dashboard, Calls, Campaigns, Settings, and Billing in both
 * themes, asserts the heading renders, and writes a full-page
 * screenshot per page+mode for visual diffing.
 *
 *   npx tsx tests/e2e/tenantVisualSmoke.spec.ts
 */
import { chromium, type Browser, type Page } from 'playwright';
import { mkdir } from 'fs/promises';
import path from 'path';
import { loginViaUi } from './helpers/login';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@voiceaihub.dev';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'test-password-123';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';

const SPEC_NAME = 'tenant-visual-smoke';
const PAGE_TIMEOUT_MS = 20_000;

interface VisualCheck {
  path: string;
  slug: string;
  heading: string;
}

const PAGES: VisualCheck[] = [
  { path: '/dashboard', slug: 'dashboard', heading: 'Dashboard' },
  { path: '/calls', slug: 'calls', heading: 'Conversations' },
  { path: '/campaigns', slug: 'campaigns', heading: 'Automation' },
  { path: '/settings', slug: 'settings', heading: 'Settings' },
  { path: '/billing', slug: 'billing', heading: 'Billing' },
];

interface VisualFailure {
  page: VisualCheck;
  mode: 'light' | 'dark';
  reason: string;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function login(page: Page): Promise<void> {
  await loginViaUi(page, ADMIN_EMAIL, ADMIN_PASSWORD, { waitUntil: 'networkidle' });
}

async function setTheme(page: Page, mode: 'light' | 'dark'): Promise<void> {
  await page.evaluate((m) => {
    window.localStorage.setItem('theme', m);
    document.documentElement.classList.toggle('dark', m === 'dark');
  }, mode);
}

async function captureMode(
  page: Page,
  check: VisualCheck,
  mode: 'light' | 'dark',
): Promise<VisualFailure | null> {
  await setTheme(page, mode);
  await page.goto(`${BASE_URL}${check.path}`, {
    waitUntil: 'domcontentloaded',
    timeout: PAGE_TIMEOUT_MS,
  });

  if (/\/login(\?|$)/.test(page.url())) {
    return { page: check, mode, reason: `redirected to /login — landed at ${page.url()}` };
  }

  const heading = page.getByRole('heading', { name: check.heading }).first();
  try {
    await heading.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
  } catch (err) {
    return { page: check, mode, reason: `heading "${check.heading}" never appeared (${(err as Error).message})` };
  }

  await page.waitForTimeout(400);

  const themeProbe = await page.evaluate(() => {
    const html = document.documentElement;
    const body = document.body;
    return {
      htmlHasDarkClass: html.classList.contains('dark'),
      bodyBg: window.getComputedStyle(body).backgroundColor,
      bodyText: window.getComputedStyle(body).color,
    };
  });

  if (mode === 'dark' && !themeProbe.htmlHasDarkClass) {
    return { page: check, mode, reason: '<html> is missing the `dark` class — theme failed to apply' };
  }
  if (mode === 'light' && themeProbe.htmlHasDarkClass) {
    return { page: check, mode, reason: '<html> still has the `dark` class in light mode' };
  }

  const shotPath = path.join(ARTIFACT_DIR, `${SPEC_NAME}-${check.slug}-${mode}.png`);
  await page.screenshot({ path: shotPath, fullPage: true });
  console.log(
    `[e2e]    OK ${mode}  body=${themeProbe.bodyBg} text=${themeProbe.bodyText} -> ${shotPath}`,
  );
  return null;
}

async function run(): Promise<void> {
  await mkdir(ARTIFACT_DIR, { recursive: true });

  let browser: Browser | undefined;
  const failures: VisualFailure[] = [];
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    await login(page);
    console.log(`[e2e] logged in as ${ADMIN_EMAIL}`);

    for (const check of PAGES) {
      console.log(`[e2e] -> ${check.path}`);
      for (const mode of ['light', 'dark'] as const) {
        const failure = await captureMode(page, check, mode);
        if (failure) {
          console.error(`[e2e] FAIL ${check.path} (${mode}): ${failure.reason}`);
          failures.push(failure);
        }
      }
      await setTheme(page, 'light');
    }
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }

  if (failures.length > 0) {
    console.error(`[e2e] ${failures.length} visual smoke check(s) failed:`);
    for (const f of failures) {
      console.error(`[e2e]   - ${f.page.path} (${f.mode}): ${f.reason}`);
    }
    assert(false, `${failures.length} tenant visual smoke check(s) failed`);
  }

  console.log(`[e2e] PASS — captured ${PAGES.length * 2} screenshots`);
}

run().catch((err) => {
  console.error('[e2e] FAIL', err);
  process.exitCode = 1;
});
