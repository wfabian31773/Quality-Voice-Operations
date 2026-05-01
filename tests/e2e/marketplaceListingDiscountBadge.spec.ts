/**
 * Task #1380 — End-to-end regression for the in-app marketplace
 * listing-card customer-discount preview chip.
 *
 * Background: Task #1372 made `createMarketplacePurchase` forward the
 * buyer's customer-level Stripe discount onto the Checkout session via
 * `loadActiveCustomerDiscount`, so the hosted Checkout page already
 * shows the discounted total. Task #1380 mirrors that preview into the
 * in-app marketplace listing UI BEFORE the Stripe redirect — the buyer
 * should see the discounted price (and a "X% off applied at checkout"
 * chip) on the Marketplace browse cards too, not just on the hosted
 * Checkout page. This avoids the "I see $49 in-app but $36.75 at
 * checkout" trust gap the original task called out.
 *
 * Unit coverage:
 *   - tests/marketplace/marketplaceCustomerDiscountHelpers.test.ts
 *     pins `applyDiscountToCents`, `discountReducesPrice`,
 *     `formatDiscountChipLabel`, `buildDiscountChipTooltip`.
 *
 * What this spec adds: a UI-level guard that the React renderer in
 * `client-app/src/pages/Marketplace.tsx` actually renders the
 * strikethrough + emerald "X% off" chip on every TemplateCard when
 * `GET /marketplace/customer-discount` returns a discount. A regression
 * to the renderer (e.g. dropping the `customerDiscount` prop, or
 * forgetting to thread it into the second TemplateCard grid) would
 * slip past unit tests because the helpers themselves still work —
 * only the wiring would silently revert to the undiscounted price.
 *
 * The spec drives a real browser, fulfils
 * `/api/marketplace/customer-discount` with a 25%-off coupon, fulfils
 * `/api/marketplace/templates` with a single $49 paid template, and
 * asserts:
 *   1. The listing card shows the discounted price ($36.75) — not the
 *      original $49.
 *   2. The original $49 is rendered with a strikethrough.
 *   3. A `[data-testid="marketplace-card-discount-chip"]` mounts with
 *      the "25% off" label.
 *   4. The chip's `aria-label` (== tooltip) carries the full coupon
 *      attribution ("PROMO25 applied at checkout") so a buyer hovering
 *      the chip understands which coupon is being applied.
 *
 * Run:  npm run test:e2e:marketplace-listing-discount-badge
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
import { chromium, type Browser, type Page, type Route } from 'playwright';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import path from 'path';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'marketplace-listing-discount-badge';

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
  const fixtureEmail = `mkt-listing-discount-e2e-${runId}@voiceaihub.dev`;
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

// One $49 paid one-off template — enough to assert the discount math
// (49.00 * 0.75 = 36.75) renders on the listing card. The rest of the
// MarketplaceTemplate fields are minimal stubs that satisfy the
// renderer (PriceBadge, PlanBadge, ChannelBadges, StarRating).
function buildTemplatesResponse(): unknown {
  return {
    templates: [
      {
        id: 'tmpl_dispatch_addon',
        name: 'tmpl_dispatch_addon',
        displayName: 'Dispatch Add-on',
        description: 'A premium dispatch agent add-on',
        shortDescription: 'A premium dispatch agent add-on',
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
        installCount: 12,
        avgRating: 4.5,
        reviewCount: 8,
        featured: false,
        developerName: 'VoiceAI Hub',
        categories: [],
      },
    ],
    pagination: { total: 1 },
  };
}

function buildCustomerDiscountResponse(): unknown {
  return {
    discount: {
      couponId: 'coupon_promo25',
      name: 'Spring Promo',
      promotionCode: 'PROMO25',
      percentOff: 25,
      amountOffCents: null,
      currency: null,
    },
  };
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

    // Intercept BEFORE navigating so the cached query never sees a
    // real (potentially empty) response. Stub only the two endpoints
    // this spec asserts on; let everything else (installations,
    // featured, categories, purchases) hit the real API so the page
    // mounts as it would in production.
    await context.route('**/api/marketplace/customer-discount', async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildCustomerDiscountResponse()),
      });
    });
    await context.route('**/api/marketplace/templates?**', async (route: Route) => {
      const url = route.request().url();
      // Don't stomp on the featured query — let it return whatever the
      // real backend has (the test is focused on the All Packages grid).
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

    await login(page, seedData.fixtureEmail, FIXTURE_PASSWORD);
    await page.goto(`${BASE_URL}/marketplace`, { waitUntil: 'networkidle' });

    // Discount chip is the canonical "discount preview rendered" signal.
    const chip = page.locator('[data-testid="marketplace-card-discount-chip"]').first();
    await chip.waitFor({ state: 'visible', timeout: 15_000 });

    const chipText = (await chip.innerText()).trim();
    assert(
      /25% off/i.test(chipText),
      `chip should show '25% off', got: ${JSON.stringify(chipText)}`,
    );

    const tooltip = (await chip.getAttribute('aria-label')) ?? '';
    assert(
      /PROMO25/i.test(tooltip),
      `chip tooltip should include promo code 'PROMO25', got: ${JSON.stringify(tooltip)}`,
    );
    assert(
      /applied at checkout/i.test(tooltip),
      `chip tooltip should include 'applied at checkout', got: ${JSON.stringify(tooltip)}`,
    );

    // Strikethrough original price ($49.00) — proves the discounted
    // price is what's being rendered as the prominent figure.
    const original = page.locator('[data-testid="marketplace-card-original-price"]').first();
    await original.waitFor({ state: 'visible', timeout: 5_000 });
    const originalText = (await original.innerText()).trim();
    assert(
      /\$49\.00/.test(originalText),
      `original strikethrough should show '$49.00', got: ${JSON.stringify(originalText)}`,
    );

    // The discounted figure ($36.75 = 4900 * 0.75) MUST appear somewhere
    // on the card — that's the contract the in-app preview matches the
    // hosted Stripe Checkout total against.
    const cardBody = await page.locator('button:has([data-testid="marketplace-card-discount-chip"])').first().innerText();
    assert(
      /\$36\.75/.test(cardBody),
      `card body should include discounted price '$36.75', got: ${JSON.stringify(cardBody)}`,
    );

    console.log(`[e2e] ${SPEC_NAME}: PASS`);
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
