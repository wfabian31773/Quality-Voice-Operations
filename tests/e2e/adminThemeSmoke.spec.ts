// Light + dark theme smoke for Platform Admin and Ops Console pages.
// Run: npm run test:e2e:admin-theme-smoke
import { chromium, type Browser, type Page } from 'playwright';
import { mkdir } from 'fs/promises';
import path from 'path';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@voiceaihub.dev';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'test-password-123';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';

const SPEC_NAME = 'admin-theme-smoke';
const ADMIN_TENANT_ID = 'admin-org';
const PAGE_TIMEOUT_MS = 20_000;

type Theme = 'light' | 'dark';

interface PageCheck {
  path: string;
  slug: string;
  heading: string;
}

const PAGES: PageCheck[] = [
  { path: '/admin/dashboard', slug: 'platform-admin-dashboard', heading: 'Platform Administration' },
  { path: '/admin/sales-inbox', slug: 'sales-inbox', heading: 'Sales Inbox' },
  { path: `/admin/analytics/tenants/${ADMIN_TENANT_ID}/calls`, slug: 'tenant-calls', heading: '— Calls' },
  { path: '/ops/backfill-calls', slug: 'ops-backfill-calls', heading: 'Backfill calls' },
];

const ERROR_BOUNDARY_TEXT = 'An unexpected error occurred';

interface PairFailure {
  page: PageCheck;
  theme: Theme;
  reason: string;
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

async function pinTheme(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript((t: string) => {
    try {
      window.localStorage.setItem('theme', t);
    } catch {
      /* localStorage may be unavailable in some incognito contexts */
    }
  }, theme);
}

function parseRgb(value: string): [number, number, number, number] | null {
  const m = /rgba?\(([^)]+)\)/.exec(value);
  if (!m) return null;
  const parts = m[1].split(',').map((p) => Number.parseFloat(p.trim()));
  if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) return null;
  return [parts[0], parts[1], parts[2], parts[3] ?? 1];
}

async function checkPair(page: Page, check: PageCheck, theme: Theme): Promise<PairFailure | null> {
  await pinTheme(page, theme);

  let reason: string | null = null;
  try {
    await page.goto(`${BASE_URL}${check.path}`, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_TIMEOUT_MS,
    });

    const landed = page.url();
    if (/\/login(\?|$)/.test(landed)) {
      reason = `redirected to /login (lost session?) — landed at ${landed}`;
    } else if (!landed.includes(check.path.split('?')[0])) {
      reason = `redirected away from ${check.path}, landed at ${landed}`;
    }

    if (!reason) {
      const heading = page
        .locator('h1', { hasText: check.heading })
        .first();
      try {
        await heading.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
      } catch (err) {
        reason = `expected heading containing "${check.heading}" never appeared (${(err as Error).message})`;
      }
    }

    if (!reason) {
      const htmlIsDark = await page.evaluate(
        () => document.documentElement.classList.contains('dark'),
      );
      if (theme === 'dark' && !htmlIsDark) {
        reason = `dark theme requested but <html> missing "dark" class (theme switch did not pick up)`;
      } else if (theme === 'light' && htmlIsDark) {
        reason = `light theme requested but <html> still carries "dark" class (theme reset failed)`;
      }
    }

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

    if (!reason) {
      const colorPair = await page.evaluate((headingText: string) => {
        const all = Array.from(document.querySelectorAll('h1'));
        const target = all.find((h) => (h.textContent ?? '').includes(headingText));
        if (!target) return null;
        const text = window.getComputedStyle(target).color;
        let bgEl: Element | null = target;
        while (bgEl) {
          const cs = window.getComputedStyle(bgEl);
          const bg = cs.backgroundColor;
          if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
            return { text, bg };
          }
          bgEl = bgEl.parentElement;
        }
        return { text, bg: 'rgb(255, 255, 255)' };
      }, check.heading);

      if (colorPair) {
        const text = parseRgb(colorPair.text);
        const bg = parseRgb(colorPair.bg);
        if (text && bg && text[0] === bg[0] && text[1] === bg[1] && text[2] === bg[2]) {
          reason = `heading is invisible against background — text=${colorPair.text} bg=${colorPair.bg}`;
        }
      }
    }
  } catch (err) {
    reason = `unexpected error: ${(err as Error).message}`;
  }

  if (!reason) return null;

  const shotPath = path.join(ARTIFACT_DIR, `${SPEC_NAME}-${check.slug}-${theme}.png`);
  await mkdir(path.dirname(shotPath), { recursive: true }).catch(() => undefined);
  await page.screenshot({ path: shotPath, fullPage: true }).catch((err) => {
    console.warn(`[e2e] failed to write screenshot to ${shotPath}: ${(err as Error).message}`);
  });
  console.error(`[e2e] FAIL ${check.path} [${theme}]: ${reason}`);
  console.error(`[e2e]   screenshot: ${shotPath}`);

  return { page: check, theme, reason };
}

async function run(): Promise<void> {
  let browser: Browser | undefined;
  let page: Page | undefined;
  const failures: PairFailure[] = [];

  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await ctx.newPage();

    await login(page);
    console.log(`[e2e] logged in as ${ADMIN_EMAIL}`);

    for (const theme of ['light', 'dark'] as Theme[]) {
      console.log(`[e2e] === theme: ${theme} ===`);
      for (const check of PAGES) {
        console.log(`[e2e] -> ${check.path} [${theme}]`);
        const failure = await checkPair(page, check, theme);
        if (failure) {
          failures.push(failure);
        } else {
          console.log(`[e2e]    OK`);
        }
      }
    }
  } catch (err) {
    if (page) {
      const shotPath = path.join(ARTIFACT_DIR, `${SPEC_NAME}-global-failure.png`);
      try {
        await mkdir(path.dirname(shotPath), { recursive: true });
        await page.screenshot({ path: shotPath, fullPage: true });
        console.error(`[e2e]   screenshot: ${shotPath}`);
      } catch (shotErr) {
        console.warn(`[e2e] failed to write global-failure screenshot: ${(shotErr as Error).message}`);
      }
    }
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }

  if (failures.length > 0) {
    console.error(`[e2e] ${failures.length} (page, theme) pair(s) failed:`);
    for (const f of failures) {
      console.error(`[e2e]   - ${f.page.path} [${f.theme}]: ${f.reason}`);
    }
    assert(false, `${failures.length} theme smoke check(s) failed`);
  }

  console.log(`[e2e] PASS — ${PAGES.length} pages × 2 themes rendered cleanly`);
}

run().catch((err) => {
  console.error('[e2e] FAIL', err);
  process.exitCode = 1;
});
