/**
 * Task #1373 — End-to-end regression for the in-app marketplace
 * Purchase History view's coupon-aware "Discount applied" badge.
 *
 * Task #1351 added the badge to the Stripe-rendered receipt PDF via
 * `handleInvoiceFinalized`. Task #1373 mirrors that badge into the
 * marketplace_purchases row so the in-app purchase history view can
 * surface the same coupon attribution without a per-row Stripe
 * round-trip.
 *
 * Unit coverage:
 *   - tests/billing/stripeWebhookInvoiceFinalized.test.ts pins the
 *     mirror call (`applyInvoiceDiscountToPurchase`) for both one-off
 *     (metadata.purchaseId) and subscription (stripe_subscription_id
 *     join) marketplace invoices.
 *
 * What this spec adds: a UI-level guard that the React renderer in
 * `client-app/src/pages/Marketplace.tsx` PurchasesView actually shows
 * the badge with the right label + tooltip when the API returns a
 * purchase row carrying discount metadata. A regression to the chip
 * rendering (e.g. dropping the `discount && (…)` branch, or breaking
 * `formatPurchaseDiscountLabel`) would slip past unit tests because
 * the API mapping itself is unchanged — only the renderer would
 * silently skip the chip.
 *
 * The spec drives a real browser, fulfils `/api/marketplace/purchases`
 * with a payload containing one one-off purchase + one subscription
 * purchase (each with a different discount shape — percent_off vs
 * amount_off), and asserts:
 *   1. Two `[data-testid="marketplace-purchase-discount-badge"]`
 *      elements mount (one per discounted purchase).
 *   2. The first chip surfaces the promotion code label.
 *   3. The second chip surfaces the coupon name + amount-off label.
 *   4. The chip's `aria-label` (== tooltip) includes the full coupon
 *      attribution (name + percent / amount off), not just the short
 *      label visible on the chip — that's the "hover/expand reveals
 *      coupon name + percent/amount off" requirement from the task.
 *
 * Run:  npm run test:e2e:marketplace-purchase-discount-badge
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
const SPEC_NAME = 'marketplace-purchase-discount-badge';

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
  const fixtureEmail = `mkt-purchase-discount-e2e-${runId}@voiceaihub.dev`;
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

// Two-purchase payload: one one-off purchase carrying a percent-off
// promotion code, one subscription purchase carrying an amount-off
// coupon (no promo code). The renderer must surface a chip per
// purchase, with promotion code labels preferred over coupon names.
function buildPurchasesResponse(): unknown {
  const now = new Date().toISOString();
  return {
    purchases: [
      {
        id: 'mkt_purchase_oneoff_001',
        templateId: 'tmpl_dispatch_addon',
        templateName: 'Dispatch Add-on',
        status: 'completed',
        purchasedAt: now,
        completedAt: now,
        amountCents: 4_900,
        currency: 'usd',
        recurring: false,
        subscriptionStatus: null,
        stripeSubscriptionId: null,
        discount: {
          couponId: 'coupon_market10',
          name: 'Marketplace Promo',
          percentOff: 10,
          amountOffCents: null,
          currency: null,
          promotionCode: 'MARKET10',
        },
      },
      {
        id: 'mkt_purchase_sub_001',
        templateId: 'tmpl_loyalty_pack',
        templateName: 'Loyalty Pack',
        status: 'completed',
        purchasedAt: now,
        completedAt: now,
        amountCents: 9_900,
        currency: 'usd',
        recurring: true,
        subscriptionStatus: 'active',
        stripeSubscriptionId: 'sub_marketplace_xyz',
        discount: {
          couponId: 'coupon_loyal_flat',
          name: 'Loyalty Flat $5',
          percentOff: null,
          amountOffCents: 500,
          currency: 'usd',
          promotionCode: null,
        },
      },
    ],
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
    // real (potentially empty) response. The Marketplace page also
    // hits other /api/marketplace/* endpoints (templates, installed,
    // updates) — leave those un-intercepted so the page mounts as it
    // would in production. Only the purchase-history fetch is stubbed.
    await context.route('**/api/marketplace/purchases', async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildPurchasesResponse()),
      });
    });

    await login(page, seedData.fixtureEmail, FIXTURE_PASSWORD);
    await page.goto(`${BASE_URL}/marketplace/purchases`, { waitUntil: 'networkidle' });

    const badges = page.locator('[data-testid="marketplace-purchase-discount-badge"]');
    await badges.first().waitFor({ state: 'visible', timeout: 15_000 });
    const badgeCount = await badges.count();
    assert(
      badgeCount === 2,
      `expected exactly two marketplace purchase discount badges, got ${badgeCount}`,
    );

    // Chip 1 (one-off): promotion code label preferred over coupon name.
    const firstBadgeText = (await badges.nth(0).innerText()).trim();
    assert(
      /MARKET10/i.test(firstBadgeText),
      `first badge should show promo code 'MARKET10', got: ${JSON.stringify(firstBadgeText)}`,
    );
    const firstBadgeTooltip = (await badges.nth(0).getAttribute('aria-label')) ?? '';
    // Tooltip is the "hover/expand reveals coupon name + percent off"
    // contract from Task #1373. Must include both the human coupon
    // name and the percent-off amount, not just the short label.
    assert(
      /Marketplace Promo/i.test(firstBadgeTooltip),
      `first badge tooltip should include coupon name 'Marketplace Promo', got: ${JSON.stringify(firstBadgeTooltip)}`,
    );
    assert(
      /10% off/i.test(firstBadgeTooltip),
      `first badge tooltip should include '10% off', got: ${JSON.stringify(firstBadgeTooltip)}`,
    );

    // Chip 2 (subscription): no promo code → coupon name on chip,
    // tooltip carries the amount-off attribution.
    const secondBadgeText = (await badges.nth(1).innerText()).trim();
    assert(
      /Loyalty Flat \$5/i.test(secondBadgeText),
      `second badge should show coupon name 'Loyalty Flat $5', got: ${JSON.stringify(secondBadgeText)}`,
    );
    const secondBadgeTooltip = (await badges.nth(1).getAttribute('aria-label')) ?? '';
    // 500 cents in USD renders as "$5.00 off" via formatCentsHelper.
    assert(
      /\$5\.00 off/i.test(secondBadgeTooltip),
      `second badge tooltip should include '$5.00 off', got: ${JSON.stringify(secondBadgeTooltip)}`,
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
