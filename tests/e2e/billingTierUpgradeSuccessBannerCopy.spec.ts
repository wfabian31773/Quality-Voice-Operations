/**
 * Task #1395 — Browser-level regression for the post-checkout
 * `billing-tier-upgrade-success-banner` copy on a stubbed strict
 * tier upgrade (starter → pro).
 *
 * The annual-switch sibling spec
 * (`billingAnnualSwitchSuccessStackedDiscounts.spec.ts`) covers the
 * monthly→annual marker / `?checkout=success` / banner-render flow,
 * but the tier-upgrade banner — which uses an independent
 * sessionStorage marker (`billing-tier-upgrade-pending`) and gates on
 * `sub.plan === marker.targetPlan` rather than `billing_interval` —
 * had no e2e coverage of its post-checkout copy. The companion spec
 * `billingTierUpgradeBanner.spec.ts` walks the marker → polling →
 * dismiss → no-re-fire DB-driven lifecycle but does not assert the
 * tier-specific title / body copy this spec guards.
 *
 * A regression that drifted the title/body i18n keys, the
 * `PLAN_LABELS` mapping, or the marker's `targetPlan` propagation
 * would silently surface the wrong (or no) plan label to the tenant
 * after a successful checkout — exactly the kind of UX regression the
 * sibling annual-switch spec catches for its banner.
 *
 * Note: this is a client-side replay against stubbed API responses,
 * not a real Stripe webhook replay — webhook ingestion is covered
 * separately by the server-side unit/contract tests, and the existing
 * `billingTierUpgradeBanner.spec.ts` covers the DB-seeded lifecycle.
 *
 * Run:  npm run test:e2e:billing-tier-upgrade-success-banner-copy
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
const SPEC_NAME = 'billing-tier-upgrade-success-banner-copy';

const ADMIN_TENANT_ID = 'admin-org';
const FIXTURE_PASSWORD = 'test-password-123';

// Mirrors platform/db/index.ts:getPoolUrl — dev prefers DATABASE_URL.
const DB_URL = (() => {
  const env = process.env.APP_ENV ?? 'development';
  return env === 'development'
    ? (process.env.DATABASE_URL ?? process.env.PLATFORM_DB_POOL_URL ?? '')
    : (process.env.PLATFORM_DB_POOL_URL ?? process.env.DATABASE_URL ?? '');
})();

// sessionStorage key + plan labels mirrored from Billing.tsx — keep
// in sync if either moves. Drift here would silently no-op the spec
// (the marker would be written under the wrong key, or the wrong
// `Pro` label would never surface in the asserted copy).
const TIER_UPGRADE_MARKER_KEY = 'billing-tier-upgrade-pending';
const TARGET_PLAN = 'pro';
const TARGET_PLAN_LABEL = 'Pro';
const PREVIOUS_PLAN = 'starter';

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
  const fixtureEmail = `billing-tier-upgrade-success-copy-e2e-${runId}@voiceaihub.dev`;
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

// Fully-active monthly Pro subscription so the tier-upgrade banner
// renders on first paint (sub.plan === marker.targetPlan, status
// active) without depending on webhook-lag polling. Discounts are
// intentionally omitted — this spec guards the banner *copy*, the
// sibling annual-switch stacked-discount spec covers chip rendering.
function buildProSubscriptionResponse(): unknown {
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString();
  return {
    subscription: {
      plan: TARGET_PLAN,
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
      discount: null,
      discounts: [],
    },
  };
}

function buildEffectiveRateResponse(): unknown {
  return {
    basePriceCents: 30_000,
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

    // Pre-seed the tier-upgrade sessionStorage marker on every new
    // document so the `?checkout=success` effect on /billing hydrates
    // the in-memory marker on first render. Mirrors the shape
    // `writeTierUpgradeMarker` produces in Billing.tsx (and matches
    // the validation in `readTierUpgradeMarker`: previousPlan and
    // targetPlan in TIER_UPGRADE_PLANS, distinct, with a recent
    // `initiatedAt`).
    await context.addInitScript(
      ({ key, marker }) => {
        try {
          window.sessionStorage.setItem(key, JSON.stringify(marker));
        } catch {
          /* private mode / quota — spec fails downstream with a clearer error */
        }
      },
      {
        key: TIER_UPGRADE_MARKER_KEY,
        marker: {
          previousPlan: PREVIOUS_PLAN,
          targetPlan: TARGET_PLAN,
          initiatedAt: Date.now(),
        },
      },
    );

    // Stub before navigating so the cached queries never see a real
    // (potentially starter / undiscounted) response — the render gate
    // (`sub.plan === marker.targetPlan`) needs the stubbed `pro` to
    // open the banner on first paint.
    await context.route('**/api/billing/subscription', async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildProSubscriptionResponse()),
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
    // tier-upgrade marker into in-memory state.
    await page.goto(`${BASE_URL}/billing?checkout=success`, { waitUntil: 'networkidle' });

    // Wait on the banner first so a gating regression ("banner
    // missing") surfaces with a clearer failure than a copy-mismatch
    // one. 20s budget mirrors the sister specs' polling worst case.
    const banner = page.locator('[data-testid="billing-tier-upgrade-success-banner"]');
    await banner.waitFor({ state: 'visible', timeout: 20_000 });

    // The 'tenant' i18next namespace ships in its own dynamic-import
    // chunk (see client-app/src/lib/i18n.ts), so on the very first
    // paint of /billing the banner can render with raw translation
    // keys (e.g. "billing.tier_upgrade_banner.title") before the
    // chunk lands. Wait for the resolved English copy so we assert
    // against the real rendered text rather than racing the chunk.
    // Hard-coded against the en `billing.tier_upgrade_banner.title`
    // template ("You're now on {{plan}}") so a drift in either the
    // copy or the label mapping (PLAN_LABELS / marker.targetPlan)
    // fails this spec.
    const titleLocator = banner.getByText(`You're now on ${TARGET_PLAN_LABEL}`, { exact: false });
    await titleLocator.waitFor({ state: 'visible', timeout: 15_000 });

    // Body — same template ("Welcome to {{plan}}"). The combined
    // copy gives us a redundant guard against a regression that
    // dropped only one of the two interpolations.
    const bannerText = (await banner.innerText()).trim();
    assert(
      new RegExp(`You're now on ${TARGET_PLAN_LABEL}`, 'i').test(bannerText),
      `tier-upgrade banner title should include "You're now on ${TARGET_PLAN_LABEL}", got: ${JSON.stringify(bannerText)}`,
    );
    assert(
      new RegExp(`Welcome to ${TARGET_PLAN_LABEL}`, 'i').test(bannerText),
      `tier-upgrade banner body should include "Welcome to ${TARGET_PLAN_LABEL}", got: ${JSON.stringify(bannerText)}`,
    );
    // Negative guard — the body must not surface the previous plan
    // label (e.g. "Welcome to Starter"). A regression that swapped
    // marker.previousPlan for marker.targetPlan in the banner JSX
    // would otherwise pass the positive checks above.
    assert(
      !/Starter/i.test(bannerText),
      `tier-upgrade banner must not surface the previous plan label, got: ${JSON.stringify(bannerText)}`,
    );
    // Negative guard — raw i18n key must never reach the user; if
    // the namespace failed to load this asserts loudly instead of
    // silently passing on key text.
    assert(
      !/tier_upgrade_banner/i.test(bannerText),
      `tier-upgrade banner must not surface raw i18n keys, got: ${JSON.stringify(bannerText)}`,
    );

    // Sanity — the dismiss button is wired so the banner can actually
    // be cleared by the tenant. Lifecycle (sessionStorage cleared,
    // ?checkout=success stripped, no-re-fire on reload) is covered
    // by `billingTierUpgradeBanner.spec.ts`; here we only confirm
    // the dismiss control rendered alongside the asserted copy.
    const dismiss = banner.locator('[data-testid="billing-tier-upgrade-success-dismiss"]');
    await dismiss.waitFor({ state: 'visible', timeout: 5_000 });

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
