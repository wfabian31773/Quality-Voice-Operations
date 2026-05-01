/**
 * Task #1405 — End-to-end regression for the auto-refresh of the
 * marketplace listing-card customer-discount preview when buyers
 * redeem a coupon mid-session.
 *
 * Background: Task #1380 added a 60s React Query `staleTime` on the
 * `/marketplace/customer-discount` query so listing cards don't
 * re-fetch on every navigation. The trade-off was that a buyer who
 * applies a fresh coupon (via Stripe Customer Portal launched from
 * /billing, or via an inline promo code on a Checkout flow) would
 * keep seeing the OLD preview for up to 60s after returning to
 * /marketplace. Task #1405 closes that window by:
 *   1. Extending the existing `?purchase=success` invalidation in
 *      `Marketplace.tsx` (TemplateDetailView) to also invalidate
 *      `marketplace-customer-discount` alongside the existing
 *      `marketplace-purchase-access` invalidation.
 *   2. Adding a cleanup `useEffect` in `Billing.tsx` that invalidates
 *      `marketplace-customer-discount` whenever Billing unmounts —
 *      so any SPA navigation back from /billing refetches the
 *      preview before the next listing render.
 *
 * Sibling spec to `marketplaceListingDiscountBadge.spec.ts`, which
 * asserts the *baseline* render of the chip. This spec asserts the
 * *refresh* behavior on round-trip through /billing: the chip must
 * reflect the NEW discount returned by `/customer-discount` after
 * the user navigates back from /billing, not the cached OLD one.
 *
 * What this spec asserts:
 *   1. Marketplace cards initially render the "25% off" chip from
 *      the first stubbed `/customer-discount` response.
 *   2. After flipping the stub to a new discount (50% off / PROMO50)
 *      and round-tripping the user through /billing, the cards
 *      render the NEW "50% off" chip — proving the staleTime cache
 *      was dropped on Billing unmount and the query refetched on
 *      Marketplace remount.
 *   3. The `/customer-discount` request count incremented (i.e. the
 *      query actually hit the network again, not just re-rendered
 *      from cache).
 *   4. After flipping the stub a second time (75% off / PROMO75)
 *      and navigating to `/marketplace/{templateId}?purchase=success`
 *      — the same redirect Stripe Checkout uses on a successful
 *      purchase — the TemplateDetailView's success-redirect
 *      `useEffect` invalidates `marketplace-customer-discount` and
 *      the chip on the detail card refreshes to the NEW value, with
 *      the request counter incrementing again. This pins the
 *      Checkout-success branch of the invalidation, which is
 *      separate from the Billing round-trip branch covered above.
 *
 * Run:  npm run test:e2e:marketplace-listing-discount-refresh
 *
 * Pre-requisites:
 *   - Platform Dev workflow is running (admin API on :3002, vite on :5000).
 *   - Playwright browsers installed: `npx playwright install chromium`.
 *
 * Env vars (all optional):
 *   E2E_BASE_URL        default http://localhost:5000
 *   E2E_ARTIFACT_DIR    default .ci-logs/screenshots
 *   DATABASE_URL / PLATFORM_DB_POOL_URL — must point at the same DB
 *                       as the running Platform Dev workflow.
 */
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import path from 'path';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'marketplace-listing-discount-refresh';

const ADMIN_TENANT_ID = 'admin-org';
const FIXTURE_PASSWORD = 'test-password-123';

const DB_URL = (() => {
  const env = process.env.APP_ENV ?? 'development';
  return env === 'development'
    ? (process.env.DATABASE_URL ?? process.env.PLATFORM_DB_POOL_URL ?? '')
    : (process.env.PLATFORM_DB_POOL_URL ?? process.env.DATABASE_URL ?? '');
})();

interface SeedResult {
  runId: string;
  fixtureEmail: string;
  fixtureUserId: string;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function captureFailureScreenshot(page: Page | undefined): Promise<void> {
  if (!page) return;
  const shotPath = path.join(ARTIFACT_DIR, `${SPEC_NAME}-failure.png`);
  try {
    await mkdir(path.dirname(shotPath), { recursive: true });
    await page.screenshot({ path: shotPath, fullPage: true });
    console.error(`[e2e]   screenshot: ${shotPath}`);
  } catch (err) {
    console.warn(`[e2e] failed to write screenshot to ${shotPath}: ${(err as Error).message}`);
  }
}

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await Promise.all([
    page.waitForURL((u) => !u.toString().endsWith('/login'), { timeout: 15_000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function seed(pool: pg.Pool): Promise<SeedResult> {
  const runId = randomUUID().slice(0, 8);
  const fixtureEmail = `mkt-listing-discount-refresh-e2e-${runId}@voiceaihub.dev`;
  const passwordHash = await bcrypt.hash(FIXTURE_PASSWORD, 12);

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (tenant_id, email, password_hash, role, is_platform_admin, is_active, email_verified)
     VALUES ($1, $2, $3, 'tenant_owner', false, true, true)
     ON CONFLICT (email) DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id,
       password_hash = EXCLUDED.password_hash,
       role = EXCLUDED.role,
       is_platform_admin = false,
       is_active = true,
       email_verified = true,
       updated_at = NOW()
     RETURNING id`,
    [ADMIN_TENANT_ID, fixtureEmail, passwordHash],
  );
  const fixtureUserId = rows[0]?.id;
  assert(fixtureUserId, `Failed to upsert fixture user ${fixtureEmail}`);

  await pool.query(
    `INSERT INTO user_roles (user_id, tenant_id, role)
     VALUES ($1, $2, 'tenant_owner')
     ON CONFLICT (user_id, tenant_id, role) DO NOTHING`,
    [fixtureUserId, ADMIN_TENANT_ID],
  );

  return { runId, fixtureEmail, fixtureUserId };
}

async function cleanup(pool: pg.Pool, seedData: SeedResult): Promise<void> {
  await pool
    .query(
      `UPDATE users
          SET is_active = false,
              email = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [seedData.fixtureUserId, `${seedData.fixtureEmail}.deleted-${Date.now()}`],
    )
    .catch((err) => console.warn(`[e2e] cleanup user soft-delete failed:`, err));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL row_security = off');
    await client.query(`DELETE FROM user_roles WHERE user_id = $1`, [seedData.fixtureUserId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.warn(`[e2e] cleanup user_roles failed:`, err);
  } finally {
    client.release();
  }
}

// Single $49 paid template — same shape as the sibling badge spec
// (`marketplaceListingDiscountBadge.spec.ts`) so the assertions can
// pivot on the chip + price math (49.00 * 0.75 = 36.75 for the
// initial 25% off; 49.00 * 0.50 = 24.50 for the post-refresh 50%).
const FIXTURE_TEMPLATE_ID = 'tmpl_dispatch_addon';

function buildTemplateRow(): Record<string, unknown> {
  return {
    id: FIXTURE_TEMPLATE_ID,
    slug: FIXTURE_TEMPLATE_ID,
    name: FIXTURE_TEMPLATE_ID,
    displayName: 'Dispatch Add-on',
    description: 'A premium dispatch agent add-on',
    shortDescription: 'A premium dispatch agent add-on',
    iconUrl: null,
    status: 'published',
    agentType: 'dispatch',
    currentVersion: '1.0.0',
    defaultVoice: 'rachel',
    defaultLanguage: 'en',
    priceModel: 'one_time',
    priceCents: 4900,
    currency: 'usd',
    minPlan: 'starter',
    marketplaceCategory: 'productivity',
    supportedChannels: ['voice'],
    requiredTools: [],
    optionalTools: [],
    tags: [],
    sortOrder: 0,
    installCount: 12,
    categories: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    avgRating: 4.5,
    reviewCount: 8,
    featured: false,
    developerName: 'VoiceAI Hub',
  };
}

function buildTemplatesResponse(): unknown {
  return {
    templates: [buildTemplateRow()],
    pagination: { total: 1 },
  };
}

// Minimal TemplateDetail extension of TemplateRow — Phase 4 navigates
// to the detail view, which fetches `/marketplace/templates/{id}` and
// gates the rest of the page on a successful response. Without this
// stub the detail view stays in its loading spinner and the
// customer-discount `useEffect` that we're trying to assert on
// never gets a chance to render the chip alongside the page.
function buildTemplateDetailResponse(): unknown {
  return {
    ...buildTemplateRow(),
    configSchema: {},
    metadata: {},
    versions: [],
    changelogs: [],
    entitlements: [],
  };
}

interface DiscountState {
  // Mutable holder for the discount payload. The route handler
  // captures this object by reference so flipping `state.current`
  // mid-test causes the next request to return the new payload —
  // simulating the buyer redeeming a fresh coupon while sitting
  // on /billing.
  current: unknown;
  // Counts how many times the route handler served a response.
  // Used to assert the post-redirect refetch actually hit the
  // network (i.e. cache was invalidated, not just re-rendered).
  hits: number;
}

function discountWith(opts: { code: string; percent: number; name: string }): unknown {
  return {
    discount: {
      couponId: `coupon_${opts.code.toLowerCase()}`,
      name: opts.name,
      promotionCode: opts.code,
      percentOff: opts.percent,
      amountOffCents: null,
      currency: null,
    },
  };
}

async function setupRoutes(context: BrowserContext, state: DiscountState): Promise<void> {
  await context.route('**/api/marketplace/customer-discount', async (route: Route) => {
    state.hits += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(state.current),
    });
  });
  await context.route('**/api/marketplace/templates?**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('featured=true')) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildTemplatesResponse()),
    });
  });
  // Detail-view fan-out (Phase 4). The TemplateDetailView fires a
  // handful of sibling queries on mount; stub the bare minimum so the
  // page lifts past its loading spinner and the success-redirect
  // `useEffect` (the load-bearing path under test) actually runs and
  // re-renders the chip. The non-essential queries (compatibility,
  // prompt-library, starter-knowledge, demo-flows, reviews,
  // purchase-access) are stubbed with empty responses so they don't
  // hit the real backend mid-test.
  await context.route(`**/api/marketplace/templates/${FIXTURE_TEMPLATE_ID}`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildTemplateDetailResponse()),
    });
  });
  await context.route(`**/api/marketplace/templates/${FIXTURE_TEMPLATE_ID}/compatibility`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ compatible: true, errors: [], warnings: [] }),
    });
  });
  await context.route(`**/api/marketplace/templates/${FIXTURE_TEMPLATE_ID}/prompt-library`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ promptLibrary: [], categories: [] }),
    });
  });
  await context.route(`**/api/marketplace/templates/${FIXTURE_TEMPLATE_ID}/starter-knowledge`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ articles: [], categoryTypes: [] }),
    });
  });
  await context.route(`**/api/marketplace/templates/${FIXTURE_TEMPLATE_ID}/demo-flows`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ demoFlows: [] }),
    });
  });
  await context.route(`**/api/marketplace/templates/${FIXTURE_TEMPLATE_ID}/reviews`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ reviews: [], summary: { avgRating: 0, reviewCount: 0, distribution: {} } }),
    });
  });
  await context.route(`**/api/marketplace/templates/${FIXTURE_TEMPLATE_ID}/purchase-access`, async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ hasAccess: false }),
    });
  });
}

async function readChipText(page: Page): Promise<string> {
  const chip = page.locator('[data-testid="marketplace-card-discount-chip"]').first();
  await chip.waitFor({ state: 'visible', timeout: 15_000 });
  return (await chip.innerText()).trim();
}

async function readChipTooltip(page: Page): Promise<string> {
  const chip = page.locator('[data-testid="marketplace-card-discount-chip"]').first();
  return (await chip.getAttribute('aria-label')) ?? '';
}

async function run(): Promise<void> {
  if (!DB_URL) {
    console.error('[e2e] DATABASE_URL (dev) or PLATFORM_DB_POOL_URL (prod) must be set');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: DB_URL, max: 4 });
  let browser: Browser | undefined;
  let page: Page | undefined;
  let seedData: SeedResult | undefined;

  try {
    seedData = await seed(pool);
    console.log(`[e2e] seeded fixture user=${seedData.fixtureEmail} runId=${seedData.runId}`);

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();

    const state: DiscountState = {
      current: discountWith({ code: 'PROMO25', percent: 25, name: 'Spring Promo' }),
      hits: 0,
    };
    await setupRoutes(context, state);

    await login(page, seedData.fixtureEmail, FIXTURE_PASSWORD);

    // ─── Phase 1: initial render shows the cached 25% off discount ───
    await page.goto(`${BASE_URL}/marketplace`, { waitUntil: 'networkidle' });
    const initialChip = await readChipText(page);
    assert(
      /25% off/i.test(initialChip),
      `phase 1: initial chip should show '25% off', got: ${JSON.stringify(initialChip)}`,
    );
    const initialTooltip = await readChipTooltip(page);
    assert(
      /PROMO25/i.test(initialTooltip),
      `phase 1: initial chip tooltip should mention PROMO25, got: ${JSON.stringify(initialTooltip)}`,
    );
    const hitsAfterPhase1 = state.hits;
    assert(
      hitsAfterPhase1 >= 1,
      `phase 1: expected at least one /customer-discount hit, got ${hitsAfterPhase1}`,
    );

    // ─── Phase 2: simulate the buyer redeeming a fresh coupon ───
    // Flip the route stub so the NEXT /customer-discount fetch
    // returns the upgraded coupon. If the staleTime cache from
    // phase 1 isn't dropped on the upcoming /billing → /marketplace
    // round-trip, the chip will keep showing the stale 25% off
    // value and the assertion below will fail.
    state.current = discountWith({ code: 'PROMO50', percent: 50, name: 'Summer Promo' });

    // Round-trip through /billing — the act that triggers the
    // unmount-cleanup invalidation added in Task #1405. We use
    // SPA navigation (clientside router) rather than a full reload
    // so a passing test actually exercises the new useEffect
    // cleanup path; a full reload would falsely pass by clearing
    // the React Query cache wholesale.
    await page.evaluate(() => {
      window.history.pushState({}, '', '/billing');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.waitForURL(/\/billing(\?|$)/, { timeout: 10_000 });
    // Wait for Billing to actually mount (its primary heading
    // anchors the page) before navigating away — the cleanup must
    // have a mounted instance to tear down.
    await page.waitForLoadState('networkidle');

    await page.evaluate(() => {
      window.history.pushState({}, '', '/marketplace');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.waitForURL(/\/marketplace(\?|$)/, { timeout: 10_000 });

    // ─── Phase 3: chip now reflects the NEW 50% off discount ───
    // Wait for the chip text to converge on the new value rather
    // than reading once — the refetch is async, so a single read
    // can race the response.
    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="marketplace-card-discount-chip"]');
        return el ? /50% off/i.test(el.textContent ?? '') : false;
      },
      undefined,
      { timeout: 10_000 },
    );

    const refreshedChip = await readChipText(page);
    assert(
      /50% off/i.test(refreshedChip),
      `phase 3: post-redirect chip should show '50% off', got: ${JSON.stringify(refreshedChip)}`,
    );
    const refreshedTooltip = await readChipTooltip(page);
    assert(
      /PROMO50/i.test(refreshedTooltip),
      `phase 3: post-redirect chip tooltip should mention PROMO50, got: ${JSON.stringify(refreshedTooltip)}`,
    );

    // The discounted figure ($24.50 = 4900 * 0.50) MUST now
    // appear on the card — proves the refetched payload is what
    // drove the re-render, not a re-mount with a stale cache.
    const cardBody = await page
      .locator('button:has([data-testid="marketplace-card-discount-chip"])')
      .first()
      .innerText();
    assert(
      /\$24\.50/.test(cardBody),
      `phase 3: card body should include refreshed discounted price '$24.50', got: ${JSON.stringify(cardBody)}`,
    );

    // The hit counter must have incremented — i.e. the round-trip
    // actually fired a network request, it didn't just re-render
    // from a still-warm staleTime cache. This is the load-bearing
    // assertion for Task #1405: without the Billing unmount
    // invalidation, `hits` would stay equal to `hitsAfterPhase1`.
    assert(
      state.hits > hitsAfterPhase1,
      `phase 3: expected /customer-discount to refetch after /billing round-trip ` +
        `(hits before=${hitsAfterPhase1}, after=${state.hits})`,
    );
    const hitsAfterPhase3 = state.hits;

    // ─── Phase 4: post-Checkout `?purchase=success` invalidation ───
    // Mirrors what the in-app marketplace flow does after Stripe
    // Checkout completes: the buyer is redirected back to
    // `/marketplace/{templateId}?purchase=success`. The
    // TemplateDetailView's `useEffect` extended in Task #1405 must
    // invalidate the `marketplace-customer-discount` query so a
    // fresh customer-level discount attached during Checkout (e.g.
    // an inline promo code) shows up immediately on the detail
    // card instead of reading from the staleTime cache. Flip the
    // stub to a third discount value so this phase can't accidentally
    // pass on a stale Phase 3 read.
    state.current = discountWith({ code: 'PROMO75', percent: 75, name: 'Black Friday' });

    await page.evaluate((id) => {
      const target = `/marketplace/${id}?purchase=success`;
      window.history.pushState({}, '', target);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, FIXTURE_TEMPLATE_ID);
    await page.waitForURL(/\/marketplace\/[^/?]+(\?|$)/, { timeout: 10_000 });

    // The success-redirect `useEffect` strips the query param after
    // invalidating, so wait for the URL to settle without it before
    // asserting on the chip — otherwise we could race the strip and
    // miss a transient state. The detail view also re-mounts the
    // customer-discount query, so the network must hit at least once
    // more than after Phase 3.
    await page.waitForFunction(
      () => !window.location.search.includes('purchase=success'),
      undefined,
      { timeout: 10_000 },
    );

    await page.waitForFunction(
      () => {
        // Detail view renders the same chip element on the PriceBadge
        // alongside the template title. Wait for the 75% off label
        // before reading state, in case the refetch races the assertion.
        const chips = document.querySelectorAll('[data-testid="marketplace-card-discount-chip"]');
        return Array.from(chips).some((el) => /75% off/i.test(el.textContent ?? ''));
      },
      undefined,
      { timeout: 10_000 },
    );

    assert(
      state.hits > hitsAfterPhase3,
      `phase 4: expected /customer-discount to refetch after ?purchase=success redirect ` +
        `(hits before=${hitsAfterPhase3}, after=${state.hits})`,
    );

    // Sanity check the tooltip on the now-visible 75% off chip carries
    // the new promotion code — pins the refetched payload as the source
    // of truth, not a residual Phase 3 render.
    const detailTooltip =
      (await page
        .locator('[data-testid="marketplace-card-discount-chip"]')
        .first()
        .getAttribute('aria-label')) ?? '';
    assert(
      /PROMO75/i.test(detailTooltip),
      `phase 4: detail-view chip tooltip should mention PROMO75, got: ${JSON.stringify(detailTooltip)}`,
    );

    console.log(`[e2e] ${SPEC_NAME}: PASS (customer-discount hits: ${state.hits})`);
  } catch (err) {
    console.error(`[e2e] ${SPEC_NAME}: FAIL — ${(err as Error).message}`);
    await captureFailureScreenshot(page);
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
    if (seedData) {
      await cleanup(pool, seedData);
    }
    await pool.end().catch(() => {});
  }
}

run().catch((err) => {
  console.error(`[e2e] ${SPEC_NAME}: unhandled — ${(err as Error).message}`);
  process.exitCode = 1;
});
