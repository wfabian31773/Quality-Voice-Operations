/**
 * Task #1312 — End-to-end regression for the Billing page discount badges.
 *
 * Unit tests already cover `loadActiveCustomerDiscount` and the
 * Checkout-session forwarding path, but a regression where the
 * `/billing/subscription` or `/billing/invoices` JSON shape changes
 * (`discount` field renamed, dropped, or reshaped) would slip past those
 * tests because the React renderer silently no-ops on the missing field.
 *
 * This spec drives the live Billing page in a real browser, fulfils the
 * two relevant admin-API endpoints with discounted shapes, and asserts
 * both badge testids actually mount in the DOM with the expected copy.
 *
 * Fixture user: a dedicated `tenant_owner` under admin-org is seeded
 * (mirroring `billingRecommendationCheckout.spec.ts`) so the invoice
 * sub-tree — gated on `isAdmin = hasMinRole(user?.role, 'manager')` in
 * `client-app/src/pages/Billing.tsx` — is guaranteed to render
 * regardless of how the seeded `admin@…` user's roles drift.
 *
 * Run:  npm run test:e2e:billing-discount-badge
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
const SPEC_NAME = 'billing-discount-badge';

const ADMIN_TENANT_ID = 'admin-org';
const FIXTURE_PASSWORD = 'test-password-123';

// Mirrors platform/db/index.ts:getPoolUrl — dev prefers DATABASE_URL,
// the rest of the world prefers PLATFORM_DB_POOL_URL. The spec must
// seed against the same DB the dev workflow is talking to.
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
  const fixtureEmail = `billing-discount-e2e-${runId}@voiceaihub.dev`;
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
  // this row, the role returned to the client falls back to the
  // (potentially `viewer`) default and the invoice sub-tree's
  // `hasMinRole(user?.role, 'manager')` gate fails closed.
  await pool.query(
    `INSERT INTO user_roles (user_id, tenant_id, role)
     VALUES ($1, $2, 'tenant_owner')
     ON CONFLICT (user_id, tenant_id, role) DO NOTHING`,
    [fixtureUserId, ADMIN_TENANT_ID],
  );

  return { runId, fixtureEmail, fixtureUserId };
}

async function cleanup(pool: pg.Pool, seedData: SeedResult): Promise<void> {
  // Hard-DELETE blows up the SET NULL FK cascade because audit_logs is
  // append-only (prevent_audit_log_mutation trigger). Soft-delete + drop
  // user_roles instead, mirroring billingRecommendationCheckout.spec.ts.
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

// Discounted subscription payload — mirrors the shape returned by
// `GET /api/billing/subscription` when a Stripe customer has an active
// percent_off coupon attached. The `discount` block is the contract
// `BillingDiscountSummary` in client-app/src/pages/Billing.tsx.
function buildSubscriptionResponse(): unknown {
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
        couponId: 'coupon_promo20',
        name: 'Spring Promo',
        percentOff: 20,
        amountOffCents: null,
        currency: null,
        promotionCode: 'SPRING20',
      },
    },
  };
}

// Two-invoice payload — one with a discount applied, one without — so
// the spec proves the per-row badge is gated on the field rather than
// rendered for every row.
function buildInvoicesResponse(): unknown {
  const now = Math.floor(Date.now() / 1000);
  return {
    invoices: [
      {
        id: 'in_discounted_001',
        date: new Date(now * 1000).toISOString(),
        amount_cents: 8_000,
        currency: 'usd',
        status: 'paid',
        invoice_pdf: 'https://example.invalid/in_discounted_001.pdf',
        number: 'INV-DISC-001',
        description: 'Pro plan — March',
        discount: {
          couponId: 'coupon_promo20',
          name: 'Spring Promo',
          percentOff: 20,
          amountOffCents: null,
          currency: 'usd',
          promotionCode: 'SPRING20',
        },
      },
      {
        id: 'in_undiscounted_002',
        date: new Date((now - 30 * 86_400) * 1000).toISOString(),
        amount_cents: 10_000,
        currency: 'usd',
        status: 'paid',
        invoice_pdf: null,
        number: 'INV-PLAIN-002',
        description: 'Pro plan — February',
        discount: null,
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
    // real (potentially undiscounted) response. Routes match both
    // `/api/billing/subscription` and `/api/billing/invoices`
    // regardless of the leading host.
    await context.route('**/api/billing/subscription', async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildSubscriptionResponse()),
      });
    });
    await context.route('**/api/billing/invoices', async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildInvoicesResponse()),
      });
    });

    await login(page, seedData.fixtureEmail, FIXTURE_PASSWORD);
    await page.goto(`${BASE_URL}/billing`, { waitUntil: 'networkidle' });

    // Subscription card discount badge.
    const subBadge = page.locator('[data-testid="billing-subscription-discount-badge"]');
    await subBadge.first().waitFor({ state: 'visible', timeout: 15_000 });
    const subBadgeText = (await subBadge.first().innerText()).trim();
    assert(
      /Active discount:/i.test(subBadgeText),
      `subscription discount badge should include 'Active discount:', got: ${JSON.stringify(subBadgeText)}`,
    );
    assert(
      /20% off/i.test(subBadgeText),
      `subscription discount badge should reflect '20% off', got: ${JSON.stringify(subBadgeText)}`,
    );
    assert(
      /SPRING20/i.test(subBadgeText),
      `subscription discount badge should include the promotion code 'SPRING20', got: ${JSON.stringify(subBadgeText)}`,
    );

    // Invoice row discount badge — exactly one row must render the
    // badge (one of the two invoices was discounted) so a regression
    // that paints the badge on every row is also caught.
    const invoiceBadges = page.locator('[data-testid="billing-invoice-discount-badge"]');
    await invoiceBadges.first().waitFor({ state: 'visible', timeout: 15_000 });
    const invoiceBadgeCount = await invoiceBadges.count();
    assert(
      invoiceBadgeCount === 1,
      `expected exactly one invoice discount badge (one of two invoices was discounted), got ${invoiceBadgeCount}`,
    );
    const invoiceBadgeText = (await invoiceBadges.first().innerText()).trim();
    assert(
      /20% off/i.test(invoiceBadgeText),
      `invoice discount badge should reflect '20% off', got: ${JSON.stringify(invoiceBadgeText)}`,
    );
    assert(
      /SPRING20/i.test(invoiceBadgeText),
      `invoice discount badge should include the promotion code 'SPRING20', got: ${JSON.stringify(invoiceBadgeText)}`,
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
