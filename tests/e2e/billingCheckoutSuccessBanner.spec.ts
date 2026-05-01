/**
 * Task #1401 — End-to-end regression for the generic post-checkout
 * "Your new plan is active" success banner (Task #1382) and for the
 * tier-upgrade banner's stacked-discount chip block.
 *
 * Task #1382 introduced a fallback confirmation banner that fires on
 * any `/billing?checkout=success` redirect (not just monthly→annual
 * switches), driven by a `billing-checkout-success-pending`
 * sessionStorage marker. It deliberately suppresses itself when the
 * more specific annual-switch or tier-upgrade banners are also
 * rendering for the same checkout, so the tenant only ever sees one
 * confirmation surface per Stripe Checkout completion. The same change
 * also added per-discount chips to the tier-upgrade banner.
 *
 * The relevant React code (Billing.tsx) had no e2e coverage prior to
 * this spec — the existing billing-discount specs cover the
 * Subscription card and the invoice rows, the annual-switch success
 * banner spec covers its own chips, and the tier-upgrade banner spec
 * exercises the marker → banner → dismiss → no-re-fire lifecycle but
 * never seeds discounts (the DB-backed setSubscriptionPlan helper
 * doesn't reach Stripe to populate `sub.discounts`). A regression in
 * the generic banner's gating, copy, mutual exclusion, dismiss, or in
 * the tier-upgrade chip mapping would slip past every existing test.
 *
 * Stub strategy mirrors the sister spec
 * `billingAnnualSwitchSuccessStackedDiscounts.spec.ts`:
 *   - We never visit checkout.stripe.com.
 *   - `/api/billing/subscription` is fulfilled per-route per-case so
 *     each case can swap the `discounts` array, billing_interval, and
 *     plan independently without touching the DB.
 *   - The relevant sessionStorage marker(s) are seeded with
 *     `addInitScript` per-case so the success-redirect effect on
 *     /billing hydrates them on first paint.
 *   - We only seed a fixture tenant_owner under admin-org so the
 *     login + page-shell can render — everything banner-related is
 *     driven through stubbed JSON.
 *
 * Run:  npm run test:e2e:billing-checkout-success-banner
 *
 * Pre-requisites:
 *   - Platform Dev workflow is running (admin API on :3002, vite on :5000).
 *   - Playwright browsers installed: `npx playwright install chromium`.
 *
 * Env vars (all optional):
 *   E2E_BASE_URL        default http://localhost:5000
 *   E2E_ARTIFACT_DIR    default .ci-logs/screenshots
 *   DATABASE_URL / PLATFORM_DB_POOL_URL — must point at the same DB as
 *                       the running Platform Dev workflow.
 */
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import path from 'path';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'billing-checkout-success-banner';

const ADMIN_TENANT_ID = 'admin-org';
const FIXTURE_PASSWORD = 'test-password-123';

// Mirrors platform/db/index.ts:getPoolUrl — the spec must seed
// against the same DB the dev workflow is talking to.
const DB_URL = (() => {
  const env = process.env.APP_ENV ?? 'development';
  return env === 'development'
    ? (process.env.DATABASE_URL ?? process.env.PLATFORM_DB_POOL_URL ?? '')
    : (process.env.PLATFORM_DB_POOL_URL ?? process.env.DATABASE_URL ?? '');
})();

// Marker keys mirrored from client-app/src/pages/Billing.tsx — kept as
// brittle equality re-declarations (rather than imports) so a rename on
// either side surfaces here as a hard failure instead of a silent
// no-op (sessionStorage write under the wrong key would just leave the
// marker unread by the React code).
const CHECKOUT_SUCCESS_MARKER_KEY = 'billing-checkout-success-pending';
const ANNUAL_SWITCH_MARKER_KEY = 'billing-annual-switch-pending';
const TIER_UPGRADE_MARKER_KEY = 'billing-tier-upgrade-pending';

// Plural tooltip mirrored from Billing.tsx — used by both the tier
// upgrade and generic checkout success banners when discountList > 1.
const MULTI_DISCOUNT_TOOLTIP =
  '2 discounts are stacked on your new subscription. Each is shown on Stripe Checkout and on every invoice it applies to.';

// Selectors under test.
const GENERIC_BANNER = '[data-testid="billing-checkout-success-banner"]';
const GENERIC_DISMISS = '[data-testid="billing-checkout-success-dismiss"]';
const GENERIC_CHIP = '[data-testid="billing-checkout-success-discount-badge"]';
const ANNUAL_BANNER = '[data-testid="billing-annual-switch-success-banner"]';
const TIER_BANNER = '[data-testid="billing-tier-upgrade-success-banner"]';
const TIER_CHIP = '[data-testid="billing-tier-upgrade-success-discount-badge"]';

interface SeedResult {
  runId: string;
  fixtureEmail: string;
  fixtureUserId: string;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function captureFailureScreenshot(page: Page | undefined, suffix = ''): Promise<void> {
  if (!page) return;
  const shotPath = path.join(
    ARTIFACT_DIR,
    `${SPEC_NAME}${suffix ? `-${suffix}` : ''}-failure.png`,
  );
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
  const fixtureEmail = `billing-checkout-success-banner-e2e-${runId}@voiceaihub.dev`;
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
  // this the login response role can fall back to viewer and the
  // Billing route guard rejects the navigation.
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

type CaseSubscriptionOpts = {
  plan: 'starter' | 'pro' | 'enterprise';
  billingInterval: 'monthly' | 'annual';
  withStackedDiscounts: boolean;
};

// Build a fully-active subscription response so the success banner's
// `status === 'active' || 'trialing'` gate opens on first paint and
// we don't have to drive the polling loop.
function buildSubscriptionResponse(opts: CaseSubscriptionOpts): unknown {
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString();

  // Two stacked discounts: one customer-level percent-off promo, one
  // subscription-level one-off amount-off coupon (no promo code, so
  // the chip falls through to the coupon name). Mirrors the shape
  // used by the annual-switch sibling spec for parity.
  const stackedDiscounts = [
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
  ];

  return {
    subscription: {
      plan: opts.plan,
      status: 'active',
      billing_interval: opts.billingInterval,
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
      // Legacy single-discount field intentionally null when stacked
      // discounts are present — the renderer prefers `discounts` over
      // `discount`, and a non-null value here would mask a regression
      // that incorrectly fell back to the legacy field.
      discount: null,
      discounts: opts.withStackedDiscounts ? stackedDiscounts : [],
    },
  };
}

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

// Per-case context: a fresh BrowserContext lets us reset routes,
// sessionStorage, and cookies between cases without the previous
// case's stubs / markers leaking into the next.
async function buildContextWithLogin(
  browser: Browser,
  seedData: SeedResult,
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await login(page, seedData.fixtureEmail, FIXTURE_PASSWORD);
  return { ctx, page };
}

// Stamp one or more sessionStorage markers BEFORE the page hydrates,
// using the exact shapes the production writers in Billing.tsx
// produce. addInitScript runs on every new document in the context,
// which means it fires before the first /billing render.
async function seedSessionMarkers(
  ctx: BrowserContext,
  markers: { checkoutSuccess?: boolean; annualSwitch?: boolean; tierUpgrade?: 'pro' | 'enterprise' },
): Promise<void> {
  await ctx.addInitScript(
    ({ keys, flags }) => {
      try {
        if (flags.checkoutSuccess) {
          window.sessionStorage.setItem(
            keys.checkout,
            JSON.stringify({ initiatedAt: Date.now() }),
          );
        }
        if (flags.annualSwitch) {
          window.sessionStorage.setItem(
            keys.annual,
            JSON.stringify({ previousInterval: 'monthly', initiatedAt: Date.now() }),
          );
        }
        if (flags.tierUpgrade) {
          window.sessionStorage.setItem(
            keys.tier,
            JSON.stringify({
              previousPlan: 'starter',
              targetPlan: flags.tierUpgrade,
              initiatedAt: Date.now(),
            }),
          );
        }
      } catch {
        /* private mode / quota — spec fails downstream with a clearer error */
      }
    },
    {
      keys: {
        checkout: CHECKOUT_SUCCESS_MARKER_KEY,
        annual: ANNUAL_SWITCH_MARKER_KEY,
        tier: TIER_UPGRADE_MARKER_KEY,
      },
      flags: {
        checkoutSuccess: !!markers.checkoutSuccess,
        annualSwitch: !!markers.annualSwitch,
        tierUpgrade: markers.tierUpgrade ?? null,
      },
    },
  );
}

async function stubBillingRoutes(
  ctx: BrowserContext,
  subscriptionResp: unknown,
): Promise<void> {
  await ctx.route('**/api/billing/subscription', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(subscriptionResp),
    });
  });
  await ctx.route('**/api/billing/invoices', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ invoices: [] }),
    });
  });
  await ctx.route('**/api/billing/effective-rate', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildEffectiveRateResponse()),
    });
  });
}

/**
 * Case A — generic checkout-success banner renders with one chip per
 * stacked discount, then dismiss hides the banner and strips
 * ?checkout=success from the URL.
 *
 * Conditions chosen so neither the annual-switch nor the
 * tier-upgrade banner can fire:
 *   - billing_interval='monthly' suppresses the annual banner.
 *   - no tier-upgrade marker stamped suppresses the tier banner.
 * That isolates the generic banner's render path.
 */
async function runGenericBannerCase(browser: Browser, seedData: SeedResult): Promise<void> {
  const { ctx, page } = await buildContextWithLogin(browser, seedData);
  try {
    await seedSessionMarkers(ctx, { checkoutSuccess: true });
    await stubBillingRoutes(
      ctx,
      buildSubscriptionResponse({
        plan: 'pro',
        billingInterval: 'monthly',
        withStackedDiscounts: true,
      }),
    );

    await page.goto(`${BASE_URL}/billing?checkout=success`, { waitUntil: 'networkidle' });

    const banner = page.locator(GENERIC_BANNER);
    await banner.waitFor({ state: 'visible', timeout: 20_000 });

    // Headline copy is part of the public contract — a refactor that
    // changes it should require an explicit test update.
    const bannerText = (await banner.innerText()).trim();
    assert(
      /Your new plan is active/i.test(bannerText),
      `generic banner should include 'Your new plan is active', got: ${JSON.stringify(bannerText)}`,
    );
    assert(
      /Pro plan is set up/i.test(bannerText),
      `generic banner body should reference the active plan label, got: ${JSON.stringify(bannerText)}`,
    );

    // Chip mapping — one chip per discount.
    const chips = banner.locator(GENERIC_CHIP);
    await chips.first().waitFor({ state: 'visible', timeout: 5_000 });
    const chipCount = await chips.count();
    assert(
      chipCount === 2,
      `expected exactly two generic-banner discount chips, got ${chipCount}`,
    );
    for (let i = 0; i < chipCount; i += 1) {
      const titleAttr = await chips.nth(i).getAttribute('title');
      assert(
        titleAttr === MULTI_DISCOUNT_TOOLTIP,
        `generic-banner chip #${i} should carry the multi-discount tooltip, got: ${JSON.stringify(titleAttr)}`,
      );
    }
    const firstChipText = (await chips.nth(0).innerText()).trim();
    assert(
      /Active discount:/i.test(firstChipText) && /25% off/i.test(firstChipText) && /WELCOME25/i.test(firstChipText),
      `first chip should reflect 'Active discount: 25% off — WELCOME25', got: ${JSON.stringify(firstChipText)}`,
    );
    const secondChipText = (await chips.nth(1).innerText()).trim();
    assert(
      /\$5\.00 off/i.test(secondChipText) && /Loyalty Bonus/i.test(secondChipText),
      `second chip should reflect '$5.00 off — Loyalty Bonus', got: ${JSON.stringify(secondChipText)}`,
    );

    // Mutual exclusion sanity — neither sibling banner should be in
    // the DOM at the same time.
    assert(
      (await page.locator(ANNUAL_BANNER).count()) === 0,
      'annual-switch banner must not render alongside the generic banner',
    );
    assert(
      (await page.locator(TIER_BANNER).count()) === 0,
      'tier-upgrade banner must not render alongside the generic banner',
    );

    // Dismiss — banner hides, sessionStorage marker clears, and the
    // ?checkout=success query param is stripped (so a reload doesn't
    // re-fire the success-side effects).
    await page.click(GENERIC_DISMISS);
    await page.waitForSelector(GENERIC_BANNER, { state: 'detached', timeout: 5_000 });

    const markerAfterDismiss = await page.evaluate(
      (key) => window.sessionStorage.getItem(key),
      CHECKOUT_SUCCESS_MARKER_KEY,
    );
    assert(
      markerAfterDismiss === null,
      `checkout-success marker should be cleared on dismiss, got ${JSON.stringify(markerAfterDismiss)}`,
    );

    const urlAfterDismiss = new URL(page.url());
    assert(
      !urlAfterDismiss.searchParams.has('checkout'),
      `?checkout=success should be stripped from URL on dismiss, got: ${page.url()}`,
    );

    console.log('[e2e]   PASS — generic banner render + dismiss');
  } catch (err) {
    await captureFailureScreenshot(page, 'generic-banner');
    throw err;
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

/**
 * Case B — generic banner is suppressed when the annual-switch banner
 * is also rendering for the same checkout. Both markers are stamped;
 * only the more specific banner should mount.
 */
async function runAnnualMutualExclusionCase(browser: Browser, seedData: SeedResult): Promise<void> {
  const { ctx, page } = await buildContextWithLogin(browser, seedData);
  try {
    await seedSessionMarkers(ctx, { checkoutSuccess: true, annualSwitch: true });
    await stubBillingRoutes(
      ctx,
      buildSubscriptionResponse({
        plan: 'pro',
        billingInterval: 'annual',
        withStackedDiscounts: true,
      }),
    );

    await page.goto(`${BASE_URL}/billing?checkout=success`, { waitUntil: 'networkidle' });

    await page.waitForSelector(ANNUAL_BANNER, { timeout: 20_000 });
    // Give any late-render of the generic banner one paint to surface
    // before asserting it's absent.
    await page.waitForTimeout(500);
    const genericCount = await page.locator(GENERIC_BANNER).count();
    assert(
      genericCount === 0,
      `generic banner must NOT render when annual-switch banner is showing (count=${genericCount})`,
    );

    console.log('[e2e]   PASS — generic banner suppressed by annual-switch banner');
  } catch (err) {
    await captureFailureScreenshot(page, 'mutual-exclusion-annual');
    throw err;
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

/**
 * Case C — generic banner is suppressed when the tier-upgrade banner
 * is rendering, AND the tier-upgrade banner shows one
 * `billing-tier-upgrade-success-discount-badge` chip per discount.
 *
 * This is the only e2e coverage of the tier-upgrade discount chips —
 * the existing `billingTierUpgradeBanner.spec.ts` drives the
 * marker → render → dismiss → no-re-fire lifecycle but never seeds
 * `sub.discounts`, so the chip mapping was previously untested.
 */
async function runTierMutualExclusionCase(browser: Browser, seedData: SeedResult): Promise<void> {
  const { ctx, page } = await buildContextWithLogin(browser, seedData);
  try {
    await seedSessionMarkers(ctx, { checkoutSuccess: true, tierUpgrade: 'pro' });
    await stubBillingRoutes(
      ctx,
      buildSubscriptionResponse({
        plan: 'pro',
        billingInterval: 'monthly',
        withStackedDiscounts: true,
      }),
    );

    await page.goto(`${BASE_URL}/billing?checkout=success`, { waitUntil: 'networkidle' });

    const tierBanner = page.locator(TIER_BANNER);
    await tierBanner.waitFor({ state: 'visible', timeout: 20_000 });

    // Chip mapping on the tier-upgrade banner.
    const tierChips = tierBanner.locator(TIER_CHIP);
    await tierChips.first().waitFor({ state: 'visible', timeout: 5_000 });
    const tierChipCount = await tierChips.count();
    assert(
      tierChipCount === 2,
      `expected exactly two tier-upgrade-success discount chips, got ${tierChipCount}`,
    );
    for (let i = 0; i < tierChipCount; i += 1) {
      const titleAttr = await tierChips.nth(i).getAttribute('title');
      assert(
        titleAttr === MULTI_DISCOUNT_TOOLTIP,
        `tier-upgrade chip #${i} should carry the multi-discount tooltip, got: ${JSON.stringify(titleAttr)}`,
      );
    }
    const tierFirst = (await tierChips.nth(0).innerText()).trim();
    assert(
      /Active discount:/i.test(tierFirst) && /25% off/i.test(tierFirst) && /WELCOME25/i.test(tierFirst),
      `first tier-upgrade chip should reflect 'Active discount: 25% off — WELCOME25', got: ${JSON.stringify(tierFirst)}`,
    );
    const tierSecond = (await tierChips.nth(1).innerText()).trim();
    assert(
      /\$5\.00 off/i.test(tierSecond) && /Loyalty Bonus/i.test(tierSecond),
      `second tier-upgrade chip should reflect '$5.00 off — Loyalty Bonus', got: ${JSON.stringify(tierSecond)}`,
    );

    // Generic banner must stay hidden.
    await page.waitForTimeout(500);
    const genericCount = await page.locator(GENERIC_BANNER).count();
    assert(
      genericCount === 0,
      `generic banner must NOT render when tier-upgrade banner is showing (count=${genericCount})`,
    );

    console.log('[e2e]   PASS — tier-upgrade chips + generic banner suppressed');
  } catch (err) {
    await captureFailureScreenshot(page, 'mutual-exclusion-tier');
    throw err;
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

async function run(): Promise<void> {
  if (!DB_URL) {
    console.error('[e2e] DATABASE_URL (dev) or PLATFORM_DB_POOL_URL (prod) must be set');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: DB_URL, max: 4 });
  let browser: Browser | undefined;
  let seedData: SeedResult | undefined;

  try {
    seedData = await seed(pool);
    console.log(`[e2e] seeded fixture user=${seedData.fixtureEmail} runId=${seedData.runId}`);

    browser = await chromium.launch({ headless: true });

    await runGenericBannerCase(browser, seedData);
    await runAnnualMutualExclusionCase(browser, seedData);
    await runTierMutualExclusionCase(browser, seedData);

    console.log(`[e2e] ${SPEC_NAME}: PASS`);
  } catch (err) {
    console.error(`[e2e] ${SPEC_NAME}: FAIL — ${(err as Error).message}`);
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
