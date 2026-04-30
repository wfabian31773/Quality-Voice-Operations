/**
 * Task #1252: drives the BillingEstimator recommendation banner CTA on
 * the live Billing page through to POST /billing/checkout, and asserts
 * a read-only role does not see the CTA on the same page.
 *
 * The component-level coverage in
 * `tests/billing/billingEstimatorRecommendation.test.tsx` exercises the
 * banner in isolation; this spec exists to lock down how
 * `client-app/src/pages/Billing.tsx` wires `isAdmin`, `handleUpgrade`,
 * and the monthly interval into the checkout request.
 *
 * Standalone runner:
 *   npx tsx tests/e2e/billingRecommendationCheckout.spec.ts
 *
 * Pre-requisites:
 *   - Platform Dev workflow running (admin API on :3002, vite on :5000).
 *   - DATABASE_URL set so the spec can seed the tenant + users + usage.
 *   - Playwright browsers installed: `npx playwright install chromium`.
 *
 * Seeds are idempotent upserts; we don't delete because `audit_logs` is
 * immutable and login writes audit rows referencing the seeded users
 * (same pattern as the sibling onboarding specs).
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { mkdir } from 'fs/promises';
import path from 'path';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'billing-recommendation-checkout';

const TENANT_ID =
  process.env.E2E_BILLING_REC_TENANT_ID ?? 't1252-billing-rec-tenant';
const TENANT_SLUG =
  process.env.E2E_BILLING_REC_TENANT_SLUG ?? 't1252-billing-rec-tenant';

const ADMIN_USER_EMAIL =
  process.env.E2E_BILLING_REC_ADMIN_EMAIL ?? 't1252-billing-rec-admin@voiceaihub.test';
const ADMIN_USER_PASSWORD =
  process.env.E2E_BILLING_REC_ADMIN_PASSWORD ?? 'BillingRecAdmin!2026';

const VIEWER_USER_EMAIL =
  process.env.E2E_BILLING_REC_VIEWER_EMAIL ?? 't1252-billing-rec-viewer@voiceaihub.test';
const VIEWER_USER_PASSWORD =
  process.env.E2E_BILLING_REC_VIEWER_PASSWORD ?? 'BillingRecViewer!2026';

// 4 000 trailing min/mo on Starter ($99 + 3 500 × $0.15 = $624) makes
// Pro ($399 + 1 500 × $0.12 = $579) the cheaper plan, so the banner
// recommends Pro and renders an upgrade CTA — the path that goes
// through `/billing/checkout` (downgrades go through
// `/billing/schedule-downgrade`).
const TRAILING_AI_MINUTES_PER_MONTH = 4_000;
const TRAILING_MONTHS_TO_SEED = 3;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

interface SeededIds {
  adminUserId: string;
  viewerUserId: string;
}

async function seedTenantAndUsers(pool: pg.Pool): Promise<SeededIds> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL row_security = off`);

    // Backdated 7 days so TenantLayout's onboarding gate (no phone
    // numbers + tenant < 24h old) doesn't bounce either user.
    await client.query(
      `INSERT INTO tenants (id, name, slug, status, plan, settings, feature_flags, created_at)
       VALUES ($1, 'Billing Recommendation e2e Tenant', $2, 'active', 'starter',
               '{"timezone": "America/New_York"}'::jsonb,
               '{}'::jsonb,
               NOW() - INTERVAL '7 days')
       ON CONFLICT (id) DO UPDATE SET
         status = 'active',
         plan = 'starter',
         created_at = LEAST(tenants.created_at, EXCLUDED.created_at),
         updated_at = NOW()`,
      [TENANT_ID, TENANT_SLUG],
    );

    // Make sure the tenant's subscription row (if any leaked over from
    // a prior run / manual fiddling) is reset to Starter so the Billing
    // page renders `currentPlan = "starter"` — the recommendation
    // selectors below assume that starting tier.
    await client.query(
      `DELETE FROM subscriptions WHERE tenant_id = $1`,
      [TENANT_ID],
    );

    const adminPasswordHash = await bcrypt.hash(ADMIN_USER_PASSWORD, 12);
    const adminResult = await client.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, first_name, password_hash,
                          role, is_active, is_platform_admin, email_verified,
                          preferences)
       VALUES ($1, $2, 'Billing Rec Admin', $3, 'admin', TRUE, FALSE, TRUE,
               '{}'::jsonb)
       ON CONFLICT (email) DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         password_hash = EXCLUDED.password_hash,
         role = EXCLUDED.role,
         is_active = TRUE,
         is_platform_admin = FALSE,
         email_verified = TRUE,
         preferences = '{}'::jsonb,
         updated_at = NOW()
       RETURNING id`,
      [TENANT_ID, ADMIN_USER_EMAIL, adminPasswordHash],
    );
    const adminUserId = adminResult.rows[0]?.id;
    if (!adminUserId) throw new Error('failed to seed tenant admin user');

    const viewerPasswordHash = await bcrypt.hash(VIEWER_USER_PASSWORD, 12);
    const viewerResult = await client.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, first_name, password_hash,
                          role, is_active, is_platform_admin, email_verified,
                          preferences)
       VALUES ($1, $2, 'Billing Rec Viewer', $3, 'viewer', TRUE, FALSE, TRUE,
               '{}'::jsonb)
       ON CONFLICT (email) DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         password_hash = EXCLUDED.password_hash,
         role = EXCLUDED.role,
         is_active = TRUE,
         is_platform_admin = FALSE,
         email_verified = TRUE,
         preferences = '{}'::jsonb,
         updated_at = NOW()
       RETURNING id`,
      [TENANT_ID, VIEWER_USER_EMAIL, viewerPasswordHash],
    );
    const viewerUserId = viewerResult.rows[0]?.id;
    if (!viewerUserId) throw new Error('failed to seed tenant viewer user');

    // The JWT `role` claim comes from `user_roles.role`, which is what
    // `hasMinRole(user.role, 'manager')` evaluates in Billing.tsx.
    // `tenant_owner` → owner (admin); `support_reviewer` → viewer.
    await client.query(
      `INSERT INTO user_roles (user_id, tenant_id, role)
       VALUES ($1, $2, 'tenant_owner')
       ON CONFLICT (user_id, tenant_id, role) DO NOTHING`,
      [adminUserId, TENANT_ID],
    );
    await client.query(
      `INSERT INTO user_roles (user_id, tenant_id, role)
       VALUES ($1, $2, 'support_reviewer')
       ON CONFLICT (user_id, tenant_id, role) DO NOTHING`,
      [viewerUserId, TENANT_ID],
    );

    // The trailing-usage SQL window is the last 3 complete months
    // (excluding the current month). Seed those three slots so the
    // Pro recommendation has signal to render.
    for (let monthsAgo = 1; monthsAgo <= TRAILING_MONTHS_TO_SEED; monthsAgo++) {
      await client.query(
        `INSERT INTO usage_metrics (tenant_id, metric_type, period_start, period_end, quantity)
         VALUES ($1, 'ai_minutes',
                 date_trunc('month', NOW()) - ($2::int * INTERVAL '1 month'),
                 date_trunc('month', NOW()) - (($2::int - 1) * INTERVAL '1 month') - INTERVAL '1 second',
                 $3)
         ON CONFLICT (tenant_id, metric_type, period_start) DO UPDATE SET
           quantity = EXCLUDED.quantity,
           period_end = EXCLUDED.period_end,
           updated_at = NOW()`,
        [TENANT_ID, monthsAgo, TRAILING_AI_MINUTES_PER_MONTH],
      );
    }

    await client.query('COMMIT');
    return { adminUserId, viewerUserId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function tenantUiLogin(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15_000 }),
    page.click('button[type="submit"]'),
  ]);
}

async function captureFailureScreenshot(page: Page | undefined, suffix: string): Promise<void> {
  if (!page) return;
  const shotPath = path.join(ARTIFACT_DIR, `${SPEC_NAME}-${suffix}.png`);
  try {
    await mkdir(path.dirname(shotPath), { recursive: true });
    await page.screenshot({ path: shotPath, fullPage: true });
    console.error(`[e2e]   screenshot: ${shotPath}`);
  } catch (err) {
    console.warn(`[e2e] failed to write screenshot to ${shotPath}: ${(err as Error).message}`);
  }
}

const STUB_REDIRECT_URL = `${BASE_URL}/billing?checkout=stub`;

/**
 * Stub POST /api/billing/checkout so the click never reaches Stripe and
 * the mutation's `window.location.href = data.url` redirect lands on a
 * known same-origin URL we can wait on.
 */
async function installCheckoutStub(page: Page): Promise<void> {
  await page.route('**/api/billing/checkout', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ url: STUB_REDIRECT_URL }),
    });
  });
}

async function runAdminCheckoutPhase(page: Page): Promise<void> {
  await installCheckoutStub(page);

  await tenantUiLogin(page, ADMIN_USER_EMAIL, ADMIN_USER_PASSWORD);
  await page.goto(`${BASE_URL}/billing`, { waitUntil: 'domcontentloaded' });

  // Match on the recommended-tier attribute so a regression that swapped
  // the tier (e.g. Enterprise) would fail even though the testid alone
  // would still match.
  const cta = page.locator(
    '[data-testid="billing-estimator-recommendation-cta"][data-recommendation-cta-tier="pro"]',
  );
  await cta.waitFor({ state: 'visible', timeout: 20_000 });

  const ctaText = (await cta.textContent())?.trim() ?? '';
  assert(/Switch to Pro/i.test(ctaText), `expected CTA "Switch to Pro", got "${ctaText}"`);
  assert(!/Downgrade/i.test(ctaText), `CTA must not read "Downgrade …" for an upgrade, got "${ctaText}"`);

  // Hook before the click — handleUpgrade fires the POST and then
  // redirects via window.location.href, so the network event would race
  // a click-then-wait sequence.
  const checkoutRequestPromise = page.waitForRequest(
    (req) => req.method() === 'POST' && /\/api\/billing\/checkout(\?|$)/.test(req.url()),
    { timeout: 10_000 },
  );

  await cta.click();

  const checkoutRequest = await checkoutRequestPromise;
  const rawBody = checkoutRequest.postData() ?? '{}';
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawBody) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`/billing/checkout body was not JSON: ${rawBody} (${(err as Error).message})`);
  }

  assert(parsed.plan === 'pro', `body.plan must be "pro", got ${JSON.stringify(parsed.plan)}`);
  assert(
    parsed.interval === 'monthly',
    `body.interval must be "monthly" (banner default), got ${JSON.stringify(parsed.interval)}`,
  );

  const recommendation = parsed.recommendation as Record<string, unknown> | undefined;
  assert(
    recommendation && typeof recommendation === 'object',
    `body.recommendation must be an object, got ${JSON.stringify(parsed.recommendation)}`,
  );
  assert(
    recommendation.currentTier === 'starter',
    `recommendation.currentTier must be "starter", got ${JSON.stringify(recommendation.currentTier)}`,
  );
  assert(
    recommendation.recommendedTier === 'pro',
    `recommendation.recommendedTier must be "pro", got ${JSON.stringify(recommendation.recommendedTier)}`,
  );

  // Verify the redirect handoff completes — confirms the mutation's
  // onSuccess actually navigated to the URL the stub returned.
  await page.waitForURL((u) => u.search.includes('checkout=stub'), { timeout: 10_000 });

  console.log(
    `[e2e] admin: CTA → POST /billing/checkout {plan: ${parsed.plan}, interval: ${parsed.interval}, recommendedTier: ${recommendation.recommendedTier}}`,
  );
}

async function runViewerNoCtaPhase(page: Page): Promise<void> {
  await tenantUiLogin(page, VIEWER_USER_EMAIL, VIEWER_USER_PASSWORD);
  await page.goto(`${BASE_URL}/billing`, { waitUntil: 'domcontentloaded' });

  // Wait for the banner first so we don't false-pass by asserting the
  // CTA is missing before the banner has even rendered.
  const banner = page.locator('[data-testid="billing-estimator-recommendation"]');
  await banner.waitFor({ state: 'visible', timeout: 20_000 });
  const recommendationState = await banner.getAttribute('data-recommendation-state');
  assert(
    recommendationState === 'switch',
    `banner must be in "switch" state for the viewer (same usage as admin), got ${JSON.stringify(recommendationState)}`,
  );

  // Wait for the recommended-tier label so the React tree is settled
  // before we assert "no CTA".
  await banner
    .locator('[data-testid="billing-estimator-recommendation-tier"]')
    .waitFor({ state: 'visible', timeout: 5_000 });

  const ctaCount = await page
    .locator('[data-testid="billing-estimator-recommendation-cta"]')
    .count();
  assert(ctaCount === 0, `viewer must not see the CTA — found ${ctaCount}`);

  // The interval toggle lives in the same `onSwitchPlan && (...)`
  // branch, so its absence locks down the whole sub-tree.
  const intervalToggleCount = await page
    .locator('[data-testid="billing-estimator-recommendation-interval-toggle"]')
    .count();
  assert(intervalToggleCount === 0, `viewer must not see the interval toggle — found ${intervalToggleCount}`);

  console.log('[e2e] viewer: banner rendered without a CTA');
}

async function run(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.PLATFORM_DB_POOL_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required to seed the tenant, users, and usage rows.');
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
  let browser: Browser | undefined;
  let adminCtx: BrowserContext | undefined;
  let viewerCtx: BrowserContext | undefined;
  let adminPage: Page | undefined;
  let viewerPage: Page | undefined;

  try {
    const seeded = await seedTenantAndUsers(pool);
    console.log(
      `[e2e] seeded tenant ${TENANT_ID} (admin=${seeded.adminUserId}, viewer=${seeded.viewerUserId})`,
    );

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    // One context per identity so the admin's auth cookie doesn't leak
    // into the viewer run.
    adminCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    adminPage = await adminCtx.newPage();
    await runAdminCheckoutPhase(adminPage);

    viewerCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    viewerPage = await viewerCtx.newPage();
    await runViewerNoCtaPhase(viewerPage);

    console.log('[e2e] PASS');
  } catch (err) {
    await captureFailureScreenshot(adminPage, 'admin-failure');
    await captureFailureScreenshot(viewerPage, 'viewer-failure');
    throw err;
  } finally {
    if (adminCtx) await adminCtx.close().catch(() => undefined);
    if (viewerCtx) await viewerCtx.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

run().catch((err) => {
  console.error('[e2e] FAIL', err);
  process.exitCode = 1;
});
