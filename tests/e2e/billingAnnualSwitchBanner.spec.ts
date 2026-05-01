/**
 * Task #1396 — End-to-end regression for the post-checkout
 * monthly→annual switch confirmation banner on /billing.
 *
 * Background:
 *   The annual-switch banner (`billing-annual-switch-success-banner`)
 *   is the older sibling of the tier-upgrade banner covered by
 *   `billingTierUpgradeBanner.spec.ts` (Task #1386). Both ride the
 *   same lifecycle — sessionStorage marker stamped before the Stripe
 *   redirect, hydrated only on `?checkout=success`, render gate that
 *   waits for the local subscription row to catch up, dismiss that
 *   clears the marker and strips the query param, no re-fire on
 *   reload — and the same regressions threatened the annual-switch
 *   banner (marker stamped on the wrong checkout, polling never
 *   resolving when the webhook lags, banner re-firing on reload after
 *   dismiss). The annual-switch banner had only unit-test coverage,
 *   so this spec walks the full browser flow against the real
 *   Billing.tsx render code.
 *
 * Stub strategy:
 *   We never visit checkout.stripe.com. Instead we:
 *     1. Seed the local subscription to the pre-switch state
 *        (plan=pro, billing_interval=monthly).
 *     2. Stamp the same sessionStorage marker `handleUpgrade` would
 *        have written for a monthly→annual switch before redirecting
 *        (see `writeAnnualSwitchMarker` in Billing.tsx).
 *     3. Flip the local subscription row to billing_interval=annual
 *        (the same end-state the Stripe webhook
 *        `handleCheckoutCompleted` / `handleSubscriptionUpdated` would
 *        produce after the switch).
 *     4. Drive a navigation to /billing?checkout=success — the same
 *        URL Stripe redirects back to on a successful checkout.
 *   This isolates the spec from Stripe test-mode dependencies and
 *   webhook-delivery flakiness, while still exercising every branch
 *   of the marker-driven banner lifecycle in Billing.tsx. The
 *   request-side end-to-end against real Stripe is already covered
 *   by `billingRecommendationCheckoutStripe.spec.ts`.
 *
 * Run: npm run test:e2e:billing-annual-switch-banner
 */
import { chromium, type Browser, type Page } from 'playwright';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import path from 'path';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'billing-annual-switch-banner';

// Mirrors platform/db/index.ts:getPoolUrl — the spec must seed
// against the same DB the dev workflow reads from.
const DB_URL = (() => {
  const env = process.env.APP_ENV ?? 'development';
  return env === 'development'
    ? (process.env.DATABASE_URL ?? process.env.PLATFORM_DB_POOL_URL ?? '')
    : (process.env.PLATFORM_DB_POOL_URL ?? process.env.DATABASE_URL ?? '');
})();

const ADMIN_TENANT_ID = 'admin-org';
const FIXTURE_PASSWORD = 'test-password-123';

// Mirrors ANNUAL_SWITCH_MARKER_KEY in client-app/src/pages/Billing.tsx.
// Drift here would silently no-op the entire spec (the marker would
// be written under the wrong key and Billing.tsx's reader would never
// find it), so it's intentionally redeclared here as a brittle
// equality check rather than imported.
const ANNUAL_SWITCH_MARKER_KEY = 'billing-annual-switch-pending';

type BillingInterval = 'monthly' | 'annual';

interface SubscriptionSnapshot {
  plan: string;
  status: string;
  billing_interval: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  stripe_price_id: string | null;
  monthly_call_limit: number | null;
  monthly_sms_limit: number | null;
  monthly_ai_minute_limit: number | null;
  overage_enabled: boolean;
  current_period_start: string | null;
  current_period_end: string | null;
  downgrade_completed_at: string | null;
  downgrade_completed_to_plan: string | null;
}

interface SeedResult {
  runId: string;
  fixtureEmail: string;
  fixtureUserId: string;
  subscriptionSnapshot: SubscriptionSnapshot | null;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function upsertFixtureUser(
  pool: pg.Pool,
  args: { tenantId: string; email: string; passwordHash: string; role: 'tenant_owner' },
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (tenant_id, email, password_hash, role, is_platform_admin, is_active, email_verified)
     VALUES ($1, $2, $3, $4, false, true, true)
     ON CONFLICT (email) DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id,
       password_hash = EXCLUDED.password_hash,
       role = EXCLUDED.role,
       is_platform_admin = false,
       is_active = true,
       email_verified = true,
       updated_at = NOW()
     RETURNING id`,
    [args.tenantId, args.email, args.passwordHash, args.role],
  );
  const id = rows[0]?.id;
  assert(id, `Failed to upsert fixture user ${args.email}`);
  await pool.query(
    `INSERT INTO user_roles (user_id, tenant_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, tenant_id, role) DO NOTHING`,
    [id, args.tenantId, args.role],
  );
  return id;
}

async function snapshotSubscription(pool: pg.Pool): Promise<SubscriptionSnapshot | null> {
  const { rows } = await pool.query<SubscriptionSnapshot & {
    current_period_start: Date | null;
    current_period_end: Date | null;
    downgrade_completed_at: Date | null;
  }>(
    `SELECT plan, status::text AS status, billing_interval::text AS billing_interval,
            stripe_customer_id, stripe_subscription_id, stripe_price_id,
            monthly_call_limit, monthly_sms_limit, monthly_ai_minute_limit,
            overage_enabled, current_period_start, current_period_end,
            downgrade_completed_at, downgrade_completed_to_plan
       FROM subscriptions WHERE tenant_id = $1`,
    [ADMIN_TENANT_ID],
  );
  const raw = rows[0];
  if (!raw) return null;
  return {
    ...raw,
    current_period_start: raw.current_period_start ? new Date(raw.current_period_start).toISOString() : null,
    current_period_end: raw.current_period_end ? new Date(raw.current_period_end).toISOString() : null,
    downgrade_completed_at: raw.downgrade_completed_at
      ? new Date(raw.downgrade_completed_at).toISOString()
      : null,
  };
}

async function setSubscription(
  pool: pg.Pool,
  args: { plan: 'starter' | 'pro' | 'enterprise'; billingInterval: BillingInterval },
): Promise<void> {
  // Plan limits intentionally widened to the largest of the three
  // tiers — the banner code under test reads `sub.plan`,
  // `sub.billing_interval`, and `sub.status` only; the limits don't
  // matter for the assertions and using fixed maxima sidesteps a
  // circular import on PLAN_LIMITS just for a fixture row.
  await pool.query(
    `INSERT INTO subscriptions (tenant_id, plan, status, billing_interval,
                                stripe_customer_id, stripe_subscription_id,
                                monthly_call_limit, monthly_sms_limit, monthly_ai_minute_limit,
                                overage_enabled,
                                downgrade_completed_at, downgrade_completed_to_plan)
     VALUES ($1, $2, 'active'::subscription_status, $3::billing_interval,
             NULL, NULL,
             999999, 999999, 999999, true,
             NULL, NULL)
     ON CONFLICT (tenant_id) DO UPDATE SET
       plan = EXCLUDED.plan,
       status = 'active',
       billing_interval = EXCLUDED.billing_interval,
       stripe_customer_id = NULL,
       stripe_subscription_id = NULL,
       stripe_price_id = NULL,
       monthly_call_limit = 999999,
       monthly_sms_limit = 999999,
       monthly_ai_minute_limit = 999999,
       overage_enabled = true,
       downgrade_completed_at = NULL,
       downgrade_completed_to_plan = NULL,
       updated_at = NOW()`,
    [ADMIN_TENANT_ID, args.plan, args.billingInterval],
  );
}

async function seed(pool: pg.Pool): Promise<SeedResult> {
  const runId = randomUUID().slice(0, 8);
  const fixtureEmail = `billing-annual-switch-banner-e2e-${runId}@voiceaihub.dev`;
  const passwordHash = await bcrypt.hash(FIXTURE_PASSWORD, 12);

  const fixtureUserId = await upsertFixtureUser(pool, {
    tenantId: ADMIN_TENANT_ID,
    email: fixtureEmail,
    passwordHash,
    role: 'tenant_owner',
  });

  const subscriptionSnapshot = await snapshotSubscription(pool);
  // Start from a clean monthly pro row so the switch case runs against
  // the same pre-switch state every time, regardless of what the
  // tenant happened to be on between runs. Pro is representative of
  // any tier — the annual-switch banner gate keys on
  // billing_interval, not on plan.
  await setSubscription(pool, { plan: 'pro', billingInterval: 'monthly' });

  return {
    runId,
    fixtureEmail,
    fixtureUserId,
    subscriptionSnapshot,
  };
}

async function softDeleteUser(pool: pg.Pool, userId: string, originalEmail: string): Promise<void> {
  await pool
    .query(
      `UPDATE users SET is_active = false, email = $2, updated_at = NOW() WHERE id = $1`,
      [userId, `${originalEmail}.deleted-${Date.now()}`],
    )
    .catch((err) => console.warn(`[e2e] cleanup user soft-delete failed (${userId}):`, err));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL row_security = off');
    await client.query(`DELETE FROM user_roles WHERE user_id = $1`, [userId]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.warn(`[e2e] cleanup user_roles failed (${userId}):`, err);
  } finally {
    client.release();
  }
}

async function cleanup(pool: pg.Pool, seedData: SeedResult): Promise<void> {
  if (seedData.subscriptionSnapshot) {
    const s = seedData.subscriptionSnapshot;
    await pool
      .query(
        `INSERT INTO subscriptions (tenant_id, plan, status, billing_interval,
           stripe_customer_id, stripe_subscription_id, stripe_price_id,
           monthly_call_limit, monthly_sms_limit, monthly_ai_minute_limit,
           overage_enabled, current_period_start, current_period_end,
           downgrade_completed_at, downgrade_completed_to_plan)
         VALUES ($1, $2, $3::subscription_status, $4::billing_interval,
                 $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (tenant_id) DO UPDATE SET
           plan = EXCLUDED.plan,
           status = EXCLUDED.status,
           billing_interval = EXCLUDED.billing_interval,
           stripe_customer_id = EXCLUDED.stripe_customer_id,
           stripe_subscription_id = EXCLUDED.stripe_subscription_id,
           stripe_price_id = EXCLUDED.stripe_price_id,
           monthly_call_limit = EXCLUDED.monthly_call_limit,
           monthly_sms_limit = EXCLUDED.monthly_sms_limit,
           monthly_ai_minute_limit = EXCLUDED.monthly_ai_minute_limit,
           overage_enabled = EXCLUDED.overage_enabled,
           current_period_start = EXCLUDED.current_period_start,
           current_period_end = EXCLUDED.current_period_end,
           downgrade_completed_at = EXCLUDED.downgrade_completed_at,
           downgrade_completed_to_plan = EXCLUDED.downgrade_completed_to_plan,
           updated_at = NOW()`,
        [
          ADMIN_TENANT_ID, s.plan, s.status, s.billing_interval,
          s.stripe_customer_id, s.stripe_subscription_id, s.stripe_price_id,
          s.monthly_call_limit, s.monthly_sms_limit, s.monthly_ai_minute_limit,
          s.overage_enabled, s.current_period_start, s.current_period_end,
          s.downgrade_completed_at, s.downgrade_completed_to_plan,
        ],
      )
      .catch((err) => console.warn('[e2e] cleanup subscription restore failed:', err));
  } else {
    // No prior subscription existed for admin-org before the spec
    // ran, which means the row currently in the table is the one our
    // seed inserted. Restore absence by deleting it so future visits
    // to /billing for admin-org match the pre-spec state exactly.
    await pool
      .query(`DELETE FROM subscriptions WHERE tenant_id = $1`, [ADMIN_TENANT_ID])
      .catch((err) => console.warn('[e2e] cleanup subscription delete failed:', err));
  }

  await softDeleteUser(pool, seedData.fixtureUserId, seedData.fixtureEmail);
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

async function captureFailureScreenshot(page: Page | undefined, suffix = ''): Promise<void> {
  if (!page) return;
  const shotPath = path.join(ARTIFACT_DIR, `${SPEC_NAME}${suffix ? `-${suffix}` : ''}-failure.png`);
  try {
    await mkdir(path.dirname(shotPath), { recursive: true });
    await page.screenshot({ path: shotPath, fullPage: true });
    console.error(`[e2e]   screenshot: ${shotPath}`);
  } catch (err) {
    console.warn(`[e2e] failed to write screenshot to ${shotPath}: ${(err as Error).message}`);
  }
}

/**
 * Walks the marker → success-redirect → polling → render → dismiss
 * → no-re-fire-on-reload flow for the annual-switch banner:
 *
 *   1. Stamp the same sessionStorage marker `handleUpgrade` would
 *      have written for a monthly→annual switch before redirecting.
 *   2. Flip the local subscription to billing_interval='annual' (the
 *      post-webhook end state).
 *   3. Navigate to /billing?checkout=success — the same URL Stripe
 *      redirects back to. The Billing page's success-path effect
 *      hydrates the marker and the next /billing/subscription fetch
 *      flips sub.billing_interval to 'annual', so the banner's
 *      render gate (sub.billing_interval === 'annual') opens.
 *   4. Click dismiss — the banner disappears, sessionStorage is
 *      cleared, and ?checkout=success is stripped from the URL.
 *   5. Reload — assert the banner does NOT re-fire (the marker has
 *      been cleared and there's no checkout=success param to
 *      re-hydrate it from).
 */
async function runAnnualSwitchBannerCase(
  page: Page,
  pool: pg.Pool,
): Promise<void> {
  const bannerSelector = '[data-testid="billing-annual-switch-success-banner"]';
  const dismissSelector = '[data-testid="billing-annual-switch-success-dismiss"]';

  // Land on /billing first to get a same-origin context for
  // sessionStorage. The sub still says monthly at this point so the
  // banner won't fire — gives us a clean baseline to assert against
  // later.
  await page.goto(`${BASE_URL}/billing`, { waitUntil: 'networkidle' });
  const baselineBannerCount = await page.locator(bannerSelector).count();
  assert(
    baselineBannerCount === 0,
    `annual-switch banner should NOT be present before marker is stamped (count=${baselineBannerCount})`,
  );

  // Stamp the marker the same shape `writeAnnualSwitchMarker`
  // produces in Billing.tsx.
  await page.evaluate(
    ({ key, marker }) => {
      window.sessionStorage.setItem(key, JSON.stringify(marker));
    },
    {
      key: ANNUAL_SWITCH_MARKER_KEY,
      marker: {
        previousInterval: 'monthly' as const,
        initiatedAt: Date.now(),
      },
    },
  );

  // Flip the DB to the post-switch state BEFORE driving the
  // success-redirect navigation — the page's success effect
  // invalidates the billing-subscription query, and the refetch needs
  // to return the new interval for the render gate to open.
  await setSubscription(pool, { plan: 'pro', billingInterval: 'annual' });

  // Drive the post-Stripe redirect.
  await page.goto(`${BASE_URL}/billing?checkout=success`, { waitUntil: 'networkidle' });

  // Banner should render once the refetch lands and the gate opens.
  // The polling loop's tick is the worst case; 20s budget mirrors
  // the sister billingTierUpgradeBanner spec.
  await page.waitForSelector(bannerSelector, { timeout: 20_000 });

  // Dismiss the banner — clears sessionStorage marker, strips
  // ?checkout param, and hides the banner without waiting on a server
  // round-trip (the annual-switch dismiss is purely client-side; no
  // acknowledge endpoint exists for this banner).
  await page.click(dismissSelector);
  await page.waitForSelector(bannerSelector, { state: 'detached', timeout: 5_000 });

  // The dismiss handler above stripped ?checkout=success; the
  // sessionStorage marker should also be gone.
  const markerAfterDismiss = await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    ANNUAL_SWITCH_MARKER_KEY,
  );
  assert(
    markerAfterDismiss === null,
    `annual-switch marker should have been cleared on dismiss, got ${markerAfterDismiss}`,
  );

  // Reload to confirm the banner does NOT re-fire. With the marker
  // cleared and ?checkout=success stripped, the success-path effect
  // shouldn't re-hydrate a marker, so the banner stays hidden.
  await page.reload({ waitUntil: 'networkidle' });
  // Give any late-arriving render a chance to fire so we're not
  // catching a one-frame race window.
  await page.waitForTimeout(500);
  const reloadedBannerCount = await page.locator(bannerSelector).count();
  assert(
    reloadedBannerCount === 0,
    `annual-switch banner should NOT re-fire on reload after dismiss (count=${reloadedBannerCount})`,
  );

  console.log('[e2e]   PASS — annual-switch banner');
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
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await ctx.newPage();

    await login(page, seedData.fixtureEmail, FIXTURE_PASSWORD);

    await runAnnualSwitchBannerCase(page, pool);

    console.log('[e2e] PASS');
  } catch (err) {
    await captureFailureScreenshot(page);
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (seedData) {
      await cleanup(pool, seedData).catch((err) =>
        console.warn(`[e2e] cleanup failed for runId=${seedData?.runId}:`, err),
      );
    }
    await pool.end().catch(() => undefined);
  }
}

run().catch((err) => {
  console.error('[e2e] FAIL', err);
  process.exitCode = 1;
});
