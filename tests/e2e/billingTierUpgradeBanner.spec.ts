/**
 * Task #1386 — End-to-end regression for the post-checkout
 * tier-upgrade success banner and the scheduled-downgrade completion
 * banner on /billing.
 *
 * Task #1366 added a one-time confirmation banner that fires on
 * /billing after a tenant completes Stripe Checkout for a strict tier
 * upgrade (e.g. starter → pro). The webhook + acknowledge endpoint are
 * covered by unit tests, and the banner JSX itself is a near-clone of
 * the existing annual-switch banner — but the full
 *   sessionStorage marker → checkout redirect → polling → banner render
 *   → dismiss → no-re-fire-on-reload
 * flow had no e2e coverage. A regression in any of those handoffs
 * (marker stamped on the wrong checkout, marker not cleared on
 * dismiss, polling not resolving when the webhook lags, etc.) would
 * silently degrade the post-upgrade experience without breaking any
 * unit tests.
 *
 * The downgrade-completion banner is the symmetric flow: the marker
 * lives on the server (subscriptions.downgrade_completed_at /
 * downgrade_completed_to_plan), set by handleSubscriptionUpdated when
 * the deferred Subscription Schedule swap actually applies the lower
 * tier. The banner renders on the next visit and dismiss POSTs
 * /billing/acknowledge-downgrade-completion to null the columns so it
 * doesn't re-fire on reload. This spec does NOT replay an actual
 * Stripe webhook for the downgrade case — it seeds the same end-state
 * the webhook would have produced (the two columns above) and then
 * exercises the client-side render → dismiss → reload lifecycle.
 * Webhook delivery itself is covered by the Stripe webhook unit
 * tests; here we are guarding only the banner UX that reads those
 * columns.
 *
 * Stub strategy:
 *   The Stripe Checkout redirect is stubbed in full — we never visit
 *   checkout.stripe.com. Instead we:
 *     1. Seed the local subscription to the pre-upgrade state.
 *     2. Stamp the same sessionStorage marker `handleUpgrade` would
 *        write before redirecting.
 *     3. Flip the local subscription row to the post-upgrade state
 *        (the same end-state the Stripe webhook
 *        `handleCheckoutCompleted` would produce).
 *     4. Drive a navigation to /billing?checkout=success — the same
 *        URL Stripe redirects back to on a successful checkout.
 *   This isolates the spec from Stripe test-mode dependencies and
 *   webhook-delivery flakiness, while still exercising every branch
 *   of the marker-driven banner lifecycle in the React code under
 *   test (Billing.tsx). The sister specs
 *   `billingRecommendationCheckoutStripe.spec.ts` /
 *   `billingRecommendationCheckoutDowngradeStripe.spec.ts` already
 *   cover the request-side end-to-end against real Stripe.
 *
 * Run: npm run test:e2e:billing-tier-upgrade-banner
 */
import { chromium, type Browser, type Page } from 'playwright';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import path from 'path';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'billing-tier-upgrade-banner';

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

// Mirrors TIER_UPGRADE_MARKER_KEY in client-app/src/pages/Billing.tsx.
// Drift here would silently no-op the entire tier-upgrade banner spec
// (the marker would be written under the wrong key and Billing.tsx's
// reader would never find it), so it's intentionally redeclared here
// as a brittle equality check rather than imported.
const TIER_UPGRADE_MARKER_KEY = 'billing-tier-upgrade-pending';

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

async function setSubscriptionPlan(
  pool: pg.Pool,
  args: { plan: 'starter' | 'pro' | 'enterprise'; downgradeCompletedToPlan?: 'starter' | 'pro' | null },
): Promise<void> {
  // Plan limits intentionally widened to the largest of the three
  // tiers — the banner code under test reads `sub.plan` and
  // `sub.downgrade_completed_*` only; the limits don't matter for the
  // assertions and using fixed maxima sidesteps a circular import on
  // PLAN_LIMITS just for a fixture row.
  await pool.query(
    `INSERT INTO subscriptions (tenant_id, plan, status, billing_interval,
                                stripe_customer_id, stripe_subscription_id,
                                monthly_call_limit, monthly_sms_limit, monthly_ai_minute_limit,
                                overage_enabled,
                                downgrade_completed_at, downgrade_completed_to_plan)
     VALUES ($1, $2, 'active'::subscription_status, 'monthly'::billing_interval,
             NULL, NULL,
             999999, 999999, 999999, true,
             $3, $4)
     ON CONFLICT (tenant_id) DO UPDATE SET
       plan = EXCLUDED.plan,
       status = 'active',
       billing_interval = 'monthly',
       stripe_customer_id = NULL,
       stripe_subscription_id = NULL,
       stripe_price_id = NULL,
       monthly_call_limit = 999999,
       monthly_sms_limit = 999999,
       monthly_ai_minute_limit = 999999,
       overage_enabled = true,
       downgrade_completed_at = EXCLUDED.downgrade_completed_at,
       downgrade_completed_to_plan = EXCLUDED.downgrade_completed_to_plan,
       updated_at = NOW()`,
    [
      ADMIN_TENANT_ID,
      args.plan,
      args.downgradeCompletedToPlan === undefined
        ? null
        : args.downgradeCompletedToPlan === null
          ? null
          : new Date().toISOString(),
      args.downgradeCompletedToPlan ?? null,
    ],
  );
}

async function readDowngradeCompletionColumns(
  pool: pg.Pool,
): Promise<{ at: string | null; toPlan: string | null }> {
  const { rows } = await pool.query<{
    downgrade_completed_at: Date | null;
    downgrade_completed_to_plan: string | null;
  }>(
    `SELECT downgrade_completed_at, downgrade_completed_to_plan
       FROM subscriptions WHERE tenant_id = $1`,
    [ADMIN_TENANT_ID],
  );
  const row = rows[0];
  if (!row) return { at: null, toPlan: null };
  return {
    at: row.downgrade_completed_at ? new Date(row.downgrade_completed_at).toISOString() : null,
    toPlan: row.downgrade_completed_to_plan,
  };
}

async function seed(pool: pg.Pool): Promise<SeedResult> {
  const runId = randomUUID().slice(0, 8);
  const fixtureEmail = `billing-tier-upgrade-banner-e2e-${runId}@voiceaihub.dev`;
  const passwordHash = await bcrypt.hash(FIXTURE_PASSWORD, 12);

  const fixtureUserId = await upsertFixtureUser(pool, {
    tenantId: ADMIN_TENANT_ID,
    email: fixtureEmail,
    passwordHash,
    role: 'tenant_owner',
  });

  const subscriptionSnapshot = await snapshotSubscription(pool);
  // Start from a clean starter row so the upgrade-banner case runs
  // against the same pre-upgrade state every time, regardless of what
  // the tenant happened to be on between runs.
  await setSubscriptionPlan(pool, { plan: 'starter', downgradeCompletedToPlan: null });

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
    // No prior subscription existed for admin-org before the spec ran,
    // which means the row currently in the table is the one our seed
    // inserted. Restore absence by deleting it so future visits to
    // /billing for admin-org match the pre-spec state exactly (and no
    // stale downgrade-completion columns can spuriously render the
    // banner against fixture data we left behind).
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
 * Case A — post-checkout tier-upgrade banner.
 *
 * Walks the marker → polling → render → dismiss → no-re-fire flow:
 *   1. Stamp the same sessionStorage marker `handleUpgrade` would
 *      have written for a starter → pro upgrade.
 *   2. Flip the local subscription to pro (the post-webhook end state).
 *   3. Navigate to /billing?checkout=success — the same URL Stripe
 *      redirects back to. The Billing page's success-path effect
 *      hydrates the marker and the next /billing/subscription fetch
 *      flips sub.plan to pro, so the banner's render gate
 *      (sub.plan === marker.targetPlan) opens.
 *   4. Click dismiss — the banner disappears, sessionStorage is
 *      cleared, and ?checkout=success is stripped from the URL.
 *   5. Reload — assert the banner does NOT re-fire (the marker has
 *      been cleared and there's no checkout=success param to re-hydrate
 *      it from).
 */
async function runUpgradeBannerCase(page: Page, pool: pg.Pool, seedData: SeedResult): Promise<void> {
  const upgradeBannerSelector = '[data-testid="billing-tier-upgrade-success-banner"]';
  const upgradeDismissSelector = '[data-testid="billing-tier-upgrade-success-dismiss"]';

  // Land on /billing first to get a same-origin context for sessionStorage.
  // The sub still says starter at this point so the banner won't fire
  // — gives us a clean baseline to assert against later.
  await page.goto(`${BASE_URL}/billing`, { waitUntil: 'networkidle' });
  const baselineBannerCount = await page.locator(upgradeBannerSelector).count();
  assert(
    baselineBannerCount === 0,
    `tier-upgrade banner should NOT be present before marker is stamped (count=${baselineBannerCount})`,
  );

  // Stamp the marker the same shape `writeTierUpgradeMarker` produces.
  await page.evaluate(
    ({ key, marker }) => {
      window.sessionStorage.setItem(key, JSON.stringify(marker));
    },
    {
      key: TIER_UPGRADE_MARKER_KEY,
      marker: {
        previousPlan: 'starter',
        targetPlan: 'pro',
        initiatedAt: Date.now(),
      },
    },
  );

  // Flip the DB to the post-upgrade state BEFORE driving the
  // success-redirect navigation — the page's success effect
  // invalidates the billing-subscription query, and the refetch needs
  // to return the new plan for the render gate to open.
  await setSubscriptionPlan(pool, { plan: 'pro', downgradeCompletedToPlan: null });

  // Drive the post-Stripe redirect.
  await page.goto(`${BASE_URL}/billing?checkout=success`, { waitUntil: 'networkidle' });

  // Banner should render once the refetch lands and the gate opens.
  // The polling loop's 3s tick is the worst case; 20s budget mirrors
  // the sister billingRecommendationCheckout* specs.
  await page.waitForSelector(upgradeBannerSelector, { timeout: 20_000 });

  // Dismiss the banner — clears sessionStorage marker, strips ?checkout
  // param, and hides the banner without waiting on a server round-trip.
  await page.click(upgradeDismissSelector);
  await page.waitForSelector(upgradeBannerSelector, { state: 'detached', timeout: 5_000 });

  // The dismiss handler above stripped ?checkout=success; the
  // sessionStorage marker should also be gone.
  const markerAfterDismiss = await page.evaluate(
    (key) => window.sessionStorage.getItem(key),
    TIER_UPGRADE_MARKER_KEY,
  );
  assert(
    markerAfterDismiss === null,
    `tier-upgrade marker should have been cleared on dismiss, got ${markerAfterDismiss}`,
  );

  // Reload to confirm the banner does NOT re-fire. With the marker
  // cleared and ?checkout=success stripped, the success-path effect
  // shouldn't re-hydrate a marker, so the banner stays hidden.
  await page.reload({ waitUntil: 'networkidle' });
  // Give any late-arriving render a chance to fire so we're not
  // catching a one-frame race window.
  await page.waitForTimeout(500);
  const reloadedBannerCount = await page.locator(upgradeBannerSelector).count();
  assert(
    reloadedBannerCount === 0,
    `tier-upgrade banner should NOT re-fire on reload after dismiss (count=${reloadedBannerCount})`,
  );

  console.log('[e2e]   PASS — tier-upgrade banner');
}

/**
 * Case B — scheduled-downgrade completion banner.
 *
 * Marker source for this banner is server-side (subscriptions.
 * downgrade_completed_at / downgrade_completed_to_plan), set by the
 * Stripe webhook `handleSubscriptionUpdated` when a deferred
 * Subscription Schedule swap actually applies the lower tier. Dismiss
 * POSTs `/billing/acknowledge-downgrade-completion` to null the
 * columns server-side so the banner doesn't re-fire on reload.
 *
 * Sequence:
 *   1. Reset the local subscription to enterprise (the pre-downgrade
 *      tier) and stamp the columns the way the webhook would.
 *   2. Navigate to /billing — the banner renders against the marker
 *      columns returned by `/billing/subscription`.
 *   3. Click dismiss — the banner disappears locally (instant
 *      feedback) and the acknowledge endpoint nulls the columns.
 *   4. Verify the columns are nulled in the DB.
 *   5. Reload — the banner stays gone.
 */
async function runDowngradeBannerCase(page: Page, pool: pg.Pool): Promise<void> {
  const downgradeBannerSelector = '[data-testid="billing-downgrade-completion-banner"]';
  const downgradeDismissSelector = '[data-testid="billing-downgrade-completion-dismiss"]';

  // Pre-downgrade tier is enterprise; the schedule applied a swap to
  // pro (any strict-rank-decrease pair would do — pro is the
  // representative case the webhook unit tests also exercise).
  await setSubscriptionPlan(pool, { plan: 'pro', downgradeCompletedToPlan: 'pro' });

  await page.goto(`${BASE_URL}/billing`, { waitUntil: 'networkidle' });
  await page.waitForSelector(downgradeBannerSelector, { timeout: 20_000 });

  // Wait for the acknowledge POST so we can assert against it
  // deterministically — without this, the column-nulled assertion
  // below would race the fetch handler.
  const acknowledgeResponsePromise = page.waitForResponse(
    (resp) =>
      /\/api\/billing\/acknowledge-downgrade-completion$/.test(resp.url()) &&
      resp.request().method() === 'POST',
    { timeout: 10_000 },
  );
  await page.click(downgradeDismissSelector);
  await page.waitForSelector(downgradeBannerSelector, { state: 'detached', timeout: 5_000 });

  const acknowledgeResponse = await acknowledgeResponsePromise;
  assert(
    acknowledgeResponse.status() === 200,
    `acknowledge-downgrade-completion should return 200, got ${acknowledgeResponse.status()}`,
  );

  // Server side should have nulled both columns. The acknowledge
  // route updates them as a pair — partial nulling would leave the
  // banner in a wedged state on the next visit.
  const cols = await readDowngradeCompletionColumns(pool);
  assert(
    cols.at === null && cols.toPlan === null,
    `downgrade_completed columns should be NULL after acknowledge, got ${JSON.stringify(cols)}`,
  );

  // Reload — banner must stay hidden because the columns are nulled.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const reloadedBannerCount = await page.locator(downgradeBannerSelector).count();
  assert(
    reloadedBannerCount === 0,
    `downgrade-completion banner should NOT re-fire on reload after dismiss (count=${reloadedBannerCount})`,
  );

  console.log('[e2e]   PASS — downgrade-completion banner');
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

    await runUpgradeBannerCase(page, pool, seedData);
    await runDowngradeBannerCase(page, pool);

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
