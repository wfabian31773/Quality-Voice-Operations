/**
 * Task #1304 — In-browser regression for the public pricing page's
 * "Live Stripe rate" badge in the calculator's annual mode.
 *
 * Two scenarios are exercised against `/pricing` with a mocked
 * `/api/billing/effective-rate`:
 *   1. `annualBasePriceSource: 'stripe'` → the pill is visible on the
 *      tenant's tier after flipping to Annual.
 *   2. `annualBasePriceSource: 'catalog'` (with `monthlyBasePriceSource:
 *      'stripe'` so the override engages in Monthly first) → the pill is
 *      absent after flipping to Annual. The Monthly-mode pre-check is a
 *      sanity guard so the negative case can't pass by simply never
 *      engaging the override.
 *
 * Auth: a fake JWT is planted in localStorage so `useAuth().user.tenantId`
 * is populated and the Pricing page issues its effective-rate fetch. The
 * token is decoded purely client-side (no signature check) and the only
 * authed call it triggers is intercepted by `page.route` before it leaves
 * the browser — keeping the spec hermetic (no DB or real login).
 *
 * Run:  npm run test:e2e:pricing-live-rate-badge
 * Pre-reqs: Platform Dev workflow on :5000 + Playwright chromium installed.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'pricing-live-rate-badge';

// Payload shape matches `decodeToken` in client-app/src/lib/auth.ts.
// `exp` is set far enough out (year 2286) that the spec won't bit-rot
// from the clock check.
function buildFakeAuthToken(): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64');
  const payload = Buffer.from(
    JSON.stringify({
      sub: 't1304-fake-user',
      tenantId: 't1304-fake-tenant',
      email: 't1304-fake@voiceaihub.test',
      role: 'tenant_owner',
      exp: 9_999_999_999,
    }),
  ).toString('base64');
  return `${header}.${payload}.signature-not-verified-by-client`;
}

interface EffectiveRatePayload {
  plan: 'starter' | 'pro' | 'enterprise';
  basePriceCents: number;
  overageRatePerMinute: number;
  basePriceSource: 'stripe' | 'catalog';
  overagePriceSource: 'stripe' | 'catalog';
  monthlyBasePriceCents?: number;
  monthlyBasePriceSource?: 'stripe' | 'catalog';
  annualBasePriceCents?: number;
  annualBasePriceSource?: 'stripe' | 'catalog';
  currency?: string;
  source?: string;
}

// Stripe-sourced annual quote — the happy path the badge exists to surface.
const STRIPE_ANNUAL_PAYLOAD: EffectiveRatePayload = {
  plan: 'pro',
  basePriceCents: 28900,
  overageRatePerMinute: 0.07,
  basePriceSource: 'stripe',
  overagePriceSource: 'stripe',
  monthlyBasePriceCents: 34900,
  monthlyBasePriceSource: 'stripe',
  annualBasePriceCents: 28900,
  annualBasePriceSource: 'stripe',
  currency: 'usd',
  source: 'stripe',
};

// Stripe-sourced monthly, catalog-only annual — override engages in
// Monthly (badge visible) but flipping to Annual must drop the badge.
const CATALOG_ANNUAL_PAYLOAD: EffectiveRatePayload = {
  plan: 'pro',
  basePriceCents: 34900,
  overageRatePerMinute: 0.07,
  basePriceSource: 'stripe',
  overagePriceSource: 'stripe',
  monthlyBasePriceCents: 34900,
  monthlyBasePriceSource: 'stripe',
  // `annualBasePriceCents` deliberately omitted — mirrors a sub with
  // no annual Stripe price object.
  annualBasePriceSource: 'catalog',
  currency: 'usd',
  source: 'stripe',
};

const CALC_BADGE_TIERS = ['starter', 'pro', 'enterprise'] as const;
const BADGE_PILL_TEXT = 'Live Stripe rate';

async function plantAuthToken(ctx: BrowserContext): Promise<void> {
  const token = buildFakeAuthToken();
  // Run BEFORE every page script so `getToken()` (which reads
  // localStorage at module-evaluation time, top of api.ts) sees the
  // planted value before `useAuth`'s `initUserFromStorage` runs.
  await ctx.addInitScript((t) => {
    try {
      window.localStorage.setItem('auth_token', t);
    } catch {
      // ephemeral context, no quota concerns
    }
  }, token);
}

async function mockEffectiveRate(
  page: Page,
  payload: EffectiveRatePayload,
): Promise<{ getCallCount: () => number }> {
  let calls = 0;
  await page.route('**/api/billing/effective-rate*', async (route) => {
    if (route.request().method() !== 'GET') {
      await route.fallback();
      return;
    }
    calls += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });
  return { getCallCount: () => calls };
}

async function waitForCalculator(page: Page): Promise<void> {
  await page.locator('[data-testid="calc-billing-annual"]').waitFor({
    state: 'visible',
    timeout: 20_000,
  });
}

async function flipToAnnual(page: Page): Promise<void> {
  const annualBtn = page.locator('[data-testid="calc-billing-annual"]');
  await annualBtn.click();
  // Wait on aria-pressed flipping rather than racing the React
  // state update that re-renders the tier cards.
  await page.waitForFunction(
    () => {
      const btn = document.querySelector(
        '[data-testid="calc-billing-annual"]',
      );
      return btn?.getAttribute('aria-pressed') === 'true';
    },
    null,
    { timeout: 5_000 },
  );
}

async function captureFailureScreenshot(
  page: Page | undefined,
  suffix: string,
): Promise<void> {
  if (!page) return;
  const shotPath = path.join(ARTIFACT_DIR, `${SPEC_NAME}-${suffix}.png`);
  try {
    await mkdir(path.dirname(shotPath), { recursive: true });
    await page.screenshot({ path: shotPath, fullPage: true });
    console.error(`[e2e]   screenshot: ${shotPath}`);
  } catch (err) {
    console.warn(
      `[e2e] failed to write screenshot to ${shotPath}: ${(err as Error).message}`,
    );
  }
}

async function assertNoBadgeOnAnyTier(page: Page): Promise<void> {
  for (const tier of CALC_BADGE_TIERS) {
    const count = await page
      .locator(`[data-testid="calc-source-${tier}"]`)
      .count();
    assert.equal(
      count,
      0,
      `expected NO "${BADGE_PILL_TEXT}" pill on tier "${tier}", found ${count}`,
    );
  }
}

async function runStripeAnnualScenario(browser: Browser): Promise<void> {
  console.log('[e2e] scenario A: annualBasePriceSource=stripe → badge visible in Annual');
  let ctx: BrowserContext | undefined;
  let page: Page | undefined;
  try {
    ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await plantAuthToken(ctx);
    page = await ctx.newPage();
    const { getCallCount } = await mockEffectiveRate(page, STRIPE_ANNUAL_PAYLOAD);

    // Hook the response BEFORE navigating to avoid racing the
    // Pricing useEffect's fetch.
    const ratePromise = page.waitForResponse(
      (res) => res.url().includes('/api/billing/effective-rate') && res.status() === 200,
      { timeout: 20_000 },
    );

    await page.goto(`${BASE_URL}/pricing`, { waitUntil: 'domcontentloaded' });
    await ratePromise;
    await waitForCalculator(page);

    await flipToAnnual(page);

    const annualBadge = page.locator('[data-testid="calc-source-pro"]');
    await annualBadge.waitFor({ state: 'visible', timeout: 5_000 });

    // Pill is rendered with a `uppercase` Tailwind utility — compare
    // case-insensitively so we pin the wording, not the CSS casing.
    const text = (await annualBadge.innerText()).trim();
    assert.equal(
      text.toLowerCase(),
      BADGE_PILL_TEXT.toLowerCase(),
      `expected pill text "${BADGE_PILL_TEXT}" (case-insensitive), got "${text}"`,
    );

    // Pill must only render on the tenant's tier — Stripe can't quote
    // unsubscribed plans.
    for (const tier of CALC_BADGE_TIERS) {
      if (tier === 'pro') continue;
      const otherCount = await page
        .locator(`[data-testid="calc-source-${tier}"]`)
        .count();
      assert.equal(
        otherCount,
        0,
        `pill must only render on the tenant's current tier (pro); found pill on "${tier}"`,
      );
    }

    assert.ok(
      getCallCount() >= 1,
      `expected at least one /billing/effective-rate fetch, observed ${getCallCount()}`,
    );

    console.log('[e2e]   scenario A PASS');
  } catch (err) {
    await captureFailureScreenshot(page, 'stripe-annual-failure');
    throw err;
  } finally {
    if (ctx) await ctx.close().catch(() => undefined);
  }
}

async function runCatalogAnnualScenario(browser: Browser): Promise<void> {
  console.log('[e2e] scenario B: annualBasePriceSource=catalog → badge ABSENT in Annual');
  let ctx: BrowserContext | undefined;
  let page: Page | undefined;
  try {
    ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await plantAuthToken(ctx);
    page = await ctx.newPage();
    const { getCallCount } = await mockEffectiveRate(page, CATALOG_ANNUAL_PAYLOAD);

    const ratePromise = page.waitForResponse(
      (res) => res.url().includes('/api/billing/effective-rate') && res.status() === 200,
      { timeout: 20_000 },
    );

    await page.goto(`${BASE_URL}/pricing`, { waitUntil: 'domcontentloaded' });
    await ratePromise;
    await waitForCalculator(page);

    // Sanity: badge must be visible in Monthly first — without this
    // guard the negative assertion below could pass simply because
    // no override engaged at all (e.g. fetch never fired).
    const monthlyBadge = page.locator('[data-testid="calc-source-pro"]');
    await monthlyBadge.waitFor({ state: 'visible', timeout: 5_000 });
    const monthlyText = (await monthlyBadge.innerText()).trim();
    assert.equal(
      monthlyText.toLowerCase(),
      BADGE_PILL_TEXT.toLowerCase(),
      `monthly-mode pill text should be "${BADGE_PILL_TEXT}" (case-insensitive), got "${monthlyText}"`,
    );

    await flipToAnnual(page);

    // Wait for the annual-mode re-render to commit before asserting
    // absence — the price re-renders, so a finite $-prefixed string
    // is a reliable signal we're not sampling mid-update.
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="calc-monthly-pro"]');
        return !!el && /\$[0-9]/.test(el.textContent ?? '');
      },
      null,
      { timeout: 5_000 },
    );

    await assertNoBadgeOnAnyTier(page);

    assert.ok(
      getCallCount() >= 1,
      `expected at least one /billing/effective-rate fetch, observed ${getCallCount()}`,
    );

    console.log('[e2e]   scenario B PASS');
  } catch (err) {
    await captureFailureScreenshot(page, 'catalog-annual-failure');
    throw err;
  } finally {
    if (ctx) await ctx.close().catch(() => undefined);
  }
}

async function run(): Promise<void> {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    await runStripeAnnualScenario(browser);
    await runCatalogAnnualScenario(browser);

    console.log('[e2e] PASS');
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }
}

run().catch((err) => {
  console.error('[e2e] FAIL', err);
  process.exitCode = 1;
});
