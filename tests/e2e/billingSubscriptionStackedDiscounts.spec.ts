/**
 * Task #1377 — Browser-level regression for the Billing Subscription
 * card chip block when `subscription.discounts[]` carries multiple
 * stacked entries. The sibling `billingDiscountBadge.spec.ts` only
 * covers the single-discount (legacy `discount`) path; a regression
 * that drops the `discounts` mapping in Billing.tsx would still
 * render one chip from the legacy fallback and slip past it.
 *
 * Run:  npm run test:e2e:billing-subscription-stacked-discounts
 */
import { chromium, type Browser, type Page, type Route } from 'playwright';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import path from 'path';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'billing-subscription-stacked-discounts';

const ADMIN_TENANT_ID = 'admin-org';
const FIXTURE_PASSWORD = 'test-password-123';

// Mirrors platform/db/index.ts:getPoolUrl — dev prefers DATABASE_URL.
const DB_URL = (() => {
  const env = process.env.APP_ENV ?? 'development';
  return env === 'development'
    ? (process.env.DATABASE_URL ?? process.env.PLATFORM_DB_POOL_URL ?? '')
    : (process.env.PLATFORM_DB_POOL_URL ?? process.env.DATABASE_URL ?? '');
})();

// Plural tooltip emitted by Billing.tsx when `list.length > 1`.
const MULTI_DISCOUNT_TOOLTIP =
  '2 discounts are stacked on your subscription. Each is shown on Stripe Checkout and on every invoice it applies to.';

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
  const fixtureEmail = `billing-sub-stacked-e2e-${runId}@voiceaihub.dev`;
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

// Two stacked discounts in `discounts[]` plus a deliberately
// mismatched legacy `discount` payload (LEGACY10) so a regression
// that prefers `discount` over `discounts` (or merges the two)
// surfaces 'LEGACY10' and trips the negative assertion below.
function buildStackedDiscountSubscriptionResponse(): unknown {
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString();
  return {
    subscription: {
      plan: 'pro',
      status: 'active',
      billing_interval: 'monthly',
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

    // Stub before navigating so the cached query never sees a real
    // (potentially undiscounted) response.
    await context.route('**/api/billing/subscription', async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildStackedDiscountSubscriptionResponse()),
      });
    });
    await context.route('**/api/billing/invoices', async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ invoices: [] }),
      });
    });

    await login(page, seedData.fixtureEmail, FIXTURE_PASSWORD);
    await page.goto(`${BASE_URL}/billing`, { waitUntil: 'networkidle' });

    const subBadges = page.locator('[data-testid="billing-subscription-discount-badge"]');
    await subBadges.first().waitFor({ state: 'visible', timeout: 15_000 });
    const subBadgeCount = await subBadges.count();
    assert(
      subBadgeCount === 2,
      `expected exactly two subscription discount badges, got ${subBadgeCount}`,
    );

    for (let i = 0; i < subBadgeCount; i += 1) {
      const titleAttr = await subBadges.nth(i).getAttribute('title');
      assert(
        titleAttr === MULTI_DISCOUNT_TOOLTIP,
        `subscription discount badge #${i} should carry the multi-discount tooltip, got: ${JSON.stringify(titleAttr)}`,
      );
    }

    const firstBadgeText = (await subBadges.nth(0).innerText()).trim();
    assert(
      /Active discount:/i.test(firstBadgeText),
      `first badge should include 'Active discount:', got: ${JSON.stringify(firstBadgeText)}`,
    );
    assert(
      /25% off/i.test(firstBadgeText),
      `first badge should reflect '25% off', got: ${JSON.stringify(firstBadgeText)}`,
    );
    assert(
      /WELCOME25/i.test(firstBadgeText),
      `first badge should include 'WELCOME25', got: ${JSON.stringify(firstBadgeText)}`,
    );

    const secondBadgeText = (await subBadges.nth(1).innerText()).trim();
    // formatDiscountLabel renders 500 cents USD as "$5.00 off" and
    // appends the coupon name when no promotion_code is present.
    assert(
      /\$5\.00 off/i.test(secondBadgeText),
      `second badge should reflect '$5.00 off', got: ${JSON.stringify(secondBadgeText)}`,
    );
    assert(
      /Loyalty Bonus/i.test(secondBadgeText),
      `second badge should include 'Loyalty Bonus', got: ${JSON.stringify(secondBadgeText)}`,
    );

    for (let i = 0; i < subBadgeCount; i += 1) {
      const text = (await subBadges.nth(i).innerText()).trim();
      assert(
        !/LEGACY10/i.test(text),
        `badge #${i} must not surface the legacy 'discount' payload, got: ${JSON.stringify(text)}`,
      );
    }

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
