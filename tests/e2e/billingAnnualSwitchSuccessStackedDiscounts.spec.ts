/**
 * Task #1383 — Browser-level regression for the post-checkout
 * `billing-annual-switch-success-banner` chip block when
 * `subscription.discounts[]` carries multiple stacked entries.
 *
 * Sibling specs cover the Subscription card chips
 * (`billingSubscriptionStackedDiscounts.spec.ts`) and the single-
 * discount Subscription/invoice paths (`billingDiscountBadge.spec.ts`),
 * but none drive the success-banner gating (sessionStorage marker +
 * `?checkout=success` URL + `billing_interval === 'annual'` guard)
 * that controls whether the chips mount on the post-checkout banner.
 *
 * Note: this is a client-side replay against stubbed API responses,
 * not a real Stripe webhook replay — webhook ingestion is covered
 * separately by the server-side unit/contract tests.
 *
 * Run:  npm run test:e2e:billing-annual-switch-success-stacked-discounts
 *
 * Env vars (all optional): E2E_BASE_URL (default http://localhost:5000),
 * E2E_ARTIFACT_DIR (default .ci-logs/screenshots), DATABASE_URL /
 * PLATFORM_DB_POOL_URL (must match the running Platform Dev DB).
 */
import { chromium, type Browser, type Page, type Route } from 'playwright';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import path from 'path';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'billing-annual-switch-success-stacked-discounts';

const ADMIN_TENANT_ID = 'admin-org';
const FIXTURE_PASSWORD = 'test-password-123';

// Mirrors platform/db/index.ts:getPoolUrl — dev prefers DATABASE_URL.
const DB_URL = (() => {
  const env = process.env.APP_ENV ?? 'development';
  return env === 'development'
    ? (process.env.DATABASE_URL ?? process.env.PLATFORM_DB_POOL_URL ?? '')
    : (process.env.PLATFORM_DB_POOL_URL ?? process.env.DATABASE_URL ?? '');
})();

// Plural tooltip + sessionStorage key mirrored from Billing.tsx —
// keep in sync if either moves.
const MULTI_DISCOUNT_TOOLTIP =
  '2 discounts are stacked on your new subscription. Each is shown on Stripe Checkout and on every invoice it applies to.';
const ANNUAL_SWITCH_MARKER_KEY = 'billing-annual-switch-pending';

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
  const fixtureEmail = `billing-annual-switch-success-e2e-${runId}@voiceaihub.dev`;
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

  // /auth/login JOINs user_roles for the JWT's role claim — without
  // this row the login response role can fall back to viewer.
  await pool.query(
    `INSERT INTO user_roles (user_id, tenant_id, role)
     VALUES ($1, $2, 'tenant_owner')
     ON CONFLICT (user_id, tenant_id, role) DO NOTHING`,
    [fixtureUserId, ADMIN_TENANT_ID],
  );

  return { runId, fixtureEmail, fixtureUserId };
}

async function cleanup(pool: pg.Pool, seedData: SeedResult): Promise<void> {
  // Soft-delete + drop user_roles — audit_logs has an append-only
  // trigger so a hard DELETE on users blows up the FK cascade.
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

// Fully-active annual subscription with two stacked discounts so the
// success banner renders on first paint (no webhook-lag polling).
// Legacy `discount` deliberately mismatches (LEGACY10) so a regression
// that prefers/merges it surfaces and trips the negative assertion.
function buildAnnualStackedDiscountSubscriptionResponse(): unknown {
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString();
  return {
    subscription: {
      plan: 'pro',
      status: 'active',
      billing_interval: 'annual',
      current_period_start: periodStart,
      current_period_end: periodEnd,
      trial_end: null,
      cancelled_at: null,
      monthly_call_limit: 2_000,
      monthly_sms_limit: 5_000,
      monthly_ai_minute_limit: 1_000,
      overage_enabled: false,
      created_at: periodStart,
      updated_at: periodStart,
      discount: {
        couponId: 'coupon_legacy_only',
        name: 'Legacy Only 10% Off',
        percentOff: 10,
        amountOffCents: null,
        currency: null,
        promotionCode: 'LEGACY10',
      },
      discounts: [
        {
          couponId: 'coupon_customer_promo',
          name: 'Customer 25% Off',
          percentOff: 25,
          amountOffCents: null,
          currency: null,
          promotionCode: 'WELCOME25',
        },
        {
          couponId: 'coupon_subscription_oneoff',
          name: 'Loyalty Bonus',
          percentOff: null,
          amountOffCents: 500,
          currency: 'usd',
          promotionCode: null,
        },
      ],
    },
  };
}

// monthly > annual so the banner's savings clause also renders.
function buildEffectiveRateResponse(): unknown {
  return {
    basePriceCents: 25_000,
    overageRatePerMinute: 0.05,
    basePriceSource: 'catalog',
    overagePriceSource: 'catalog',
    monthlyBasePriceCents: 30_000,
    monthlyBasePriceSource: 'catalog',
    annualBasePriceCents: 25_000,
    annualBasePriceSource: 'catalog',
    smsRatePerMessage: 0.01,
    smsPriceSource: 'catalog',
    twilioRatePerMinute: 0.02,
    twilioPriceSource: 'catalog',
    twilioPriceId: null,
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

    // Pre-seed the annual-switch sessionStorage marker on every new
    // document so the `?checkout=success` effect on /billing hydrates
    // the in-memory marker on first render.
    await context.addInitScript(
      ({ key }) => {
        try {
          window.sessionStorage.setItem(
            key,
            JSON.stringify({
              previousInterval: 'monthly',
              initiatedAt: Date.now(),
            }),
          );
        } catch {
          /* private mode / quota — spec fails downstream with a clearer error */
        }
      },
      { key: ANNUAL_SWITCH_MARKER_KEY },
    );

    // Stub before navigating so the cached queries never see a real
    // (potentially monthly / undiscounted) response.
    await context.route('**/api/billing/subscription', async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildAnnualStackedDiscountSubscriptionResponse()),
      });
    });
    await context.route('**/api/billing/invoices', async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ invoices: [] }),
      });
    });
    await context.route('**/api/billing/effective-rate', async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildEffectiveRateResponse()),
      });
    });

    await login(page, seedData.fixtureEmail, FIXTURE_PASSWORD);
    // `?checkout=success` is the only entry point that hydrates the
    // annual-switch marker into in-memory state.
    await page.goto(`${BASE_URL}/billing?checkout=success`, { waitUntil: 'networkidle' });

    // Wait on the banner first so a gating regression ("banner missing")
    // surfaces with a clearer failure than a chip-mapping one.
    const banner = page.locator('[data-testid="billing-annual-switch-success-banner"]');
    await banner.waitFor({ state: 'visible', timeout: 20_000 });

    const chips = banner.locator('[data-testid="billing-annual-switch-success-discount-badge"]');
    await chips.first().waitFor({ state: 'visible', timeout: 15_000 });
    const chipCount = await chips.count();
    assert(
      chipCount === 2,
      `expected exactly two annual-switch success-banner discount chips, got ${chipCount}`,
    );

    // Every chip must carry the plural tooltip when discountList > 1.
    for (let i = 0; i < chipCount; i += 1) {
      const titleAttr = await chips.nth(i).getAttribute('title');
      assert(
        titleAttr === MULTI_DISCOUNT_TOOLTIP,
        `success-banner chip #${i} should carry the multi-discount tooltip, got: ${JSON.stringify(titleAttr)}`,
      );
    }

    // First chip — customer-level percent-off promo (WELCOME25, 25%).
    const firstChipText = (await chips.nth(0).innerText()).trim();
    assert(
      /Active discount:/i.test(firstChipText),
      `first chip should include 'Active discount:', got: ${JSON.stringify(firstChipText)}`,
    );
    assert(
      /25% off/i.test(firstChipText),
      `first chip should reflect '25% off', got: ${JSON.stringify(firstChipText)}`,
    );
    assert(
      /WELCOME25/i.test(firstChipText),
      `first chip should include 'WELCOME25', got: ${JSON.stringify(firstChipText)}`,
    );

    // Second chip — subscription-level $5.00 off coupon (no promo code,
    // so formatDiscountLabel falls through to the coupon name).
    const secondChipText = (await chips.nth(1).innerText()).trim();
    assert(
      /\$5\.00 off/i.test(secondChipText),
      `second chip should reflect '$5.00 off', got: ${JSON.stringify(secondChipText)}`,
    );
    assert(
      /Loyalty Bonus/i.test(secondChipText),
      `second chip should include 'Loyalty Bonus', got: ${JSON.stringify(secondChipText)}`,
    );

    // Negative guard: renderer must prefer `discounts` over legacy `discount`.
    for (let i = 0; i < chipCount; i += 1) {
      const text = (await chips.nth(i).innerText()).trim();
      assert(
        !/LEGACY10/i.test(text),
        `success-banner chip #${i} must not surface the legacy 'discount' payload, got: ${JSON.stringify(text)}`,
      );
    }

    // Savings clause sanity — stubbed monthly > annual so it must render.
    const savings = banner.locator('[data-testid="billing-annual-switch-success-savings"]');
    await savings.waitFor({ state: 'visible', timeout: 5_000 });
    const savingsText = (await savings.innerText()).trim();
    assert(
      /\/yr$/i.test(savingsText),
      `savings node should end with '/yr', got: ${JSON.stringify(savingsText)}`,
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
