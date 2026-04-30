/**
 * Companion to billingRecommendationCheckoutStripe.spec.ts that
 * exercises the *downgrade* arm of the BillingEstimator
 * recommendation banner against a real Stripe test-mode account.
 *
 * The upgrade variant works end-to-end through `/api/billing/checkout`
 * because Stripe Checkout supports immediate plan changes for
 * upgrades / interval-changes. Strict downgrades (e.g. Enterprise →
 * Starter) cannot be expressed as a Checkout Session at all — Stripe
 * Checkout has no notion of a deferred swap at period end — so the
 * checkout route refuses them with `DOWNGRADE_REQUIRES_SCHEDULE` and
 * the BillingEstimator routes those banner clicks to
 * `/api/billing/schedule-downgrade` instead.
 *
 * This spec drives that downgrade route end-to-end:
 *   1. Seed admin-org onto a real Stripe Enterprise subscription so
 *      the banner flips to "Switch to Starter".
 *   2. Click the banner CTA and let the real `/api/billing/schedule-
 *      downgrade` request through (no interception). The route forwards
 *      the recommendation snapshot into `scheduleDowngrade`, which
 *      stamps it onto the Stripe Subscription Schedule's metadata and
 *      writes a `switch_completed` row directly (no checkout webhook is
 *      involved on the downgrade path — the schedule update IS the
 *      "switch", and there's no checkout.session.completed event for
 *      the funnel to wait on).
 *   3. Verify the Stripe SubscriptionSchedule carries the recommendation*
 *      keys, and that the matching `billing_recommendation_events` row
 *      was written with the same attribution and a metadata.source of
 *      `schedule_downgrade`.
 *
 * Skips when STRIPE_SECRET_KEY / STRIPE_PRICE_ENTERPRISE_MONTHLY /
 * STRIPE_PRICE_STARTER_MONTHLY are absent.
 * Run: npm run test:e2e:billing-recommendation-checkout-downgrade-stripe
 */
import { chromium, type Browser, type Page, type Response } from 'playwright';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import path from 'path';
import Stripe from 'stripe';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRICE_ENTERPRISE_MONTHLY = process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY;
const STRIPE_PRICE_STARTER_MONTHLY = process.env.STRIPE_PRICE_STARTER_MONTHLY;
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'billing-recommendation-checkout-downgrade-stripe';
const STRIPE_API_VERSION = '2026-02-25.clover' as const;

// Mirrors platform/db/index.ts:getPoolUrl — server reads from the same
// env var the spec must seed against.
const DB_URL = (() => {
  const env = process.env.APP_ENV ?? 'development';
  return env === 'development'
    ? (process.env.DATABASE_URL ?? '')
    : (process.env.PLATFORM_DB_POOL_URL ?? '');
})();

const ADMIN_TENANT_ID = 'admin-org';
const FIXTURE_PASSWORD = 'test-password-123';
// High enough that the trailing-N average lands solidly in the Starter
// envelope — the recommendation card needs the cheaper tier to clearly
// beat Enterprise on cost for the banner to flip into "switch" state.
const FIXTURE_AI_MINUTES_PER_MONTH = 60;
const EXPECTED_CURRENT_TIER = 'enterprise';
const EXPECTED_RECOMMENDED_TIER = 'starter';
// Stripe-managed test PaymentMethod that succeeds without 3DS — lets
// the seed subscription move to `active` immediately so the local
// guard's "real Stripe subscription" precondition is genuinely met.
const TEST_PAYMENT_METHOD = 'pm_card_visa';

interface UsageMetricSnapshot {
  periodStartIso: string;
  quantity: number;
}

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
}

interface SeedResult {
  runId: string;
  fixtureEmail: string;
  fixtureUserId: string;
  preserveUsageMetrics: UsageMetricSnapshot[];
  seededPeriodStartsIso: string[];
  subscriptionSnapshot: SubscriptionSnapshot | null;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
}

interface ScheduleDowngradeRequestBody {
  plan?: string;
  interval?: string;
  recommendation?: {
    currentTier?: string;
    recommendedTier?: string;
    monthlySavingsCents?: number;
    trailingWindowMonths?: number;
    pitch?: string;
  };
}

interface ScheduleDowngradeResponseBody {
  scheduled?: {
    scheduleId?: string;
    scheduledFor?: string;
    targetPlan?: string;
    targetInterval?: string;
  };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

function monthStart(now: Date, monthsAgo: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1, 0, 0, 0, 0));
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

/**
 * Provision a real Stripe test-mode customer + active subscription on
 * the Enterprise monthly price, then point admin-org's local
 * subscriptions row at it. This is the critical setup that
 * differentiates this spec from the upgrade variant: the downgrade
 * route refuses unless the tenant is on a paid plan with a live Stripe
 * subscription, and `scheduleDowngrade` reads the subscription id back
 * out of the local row when materializing the schedule.
 */
async function snapshotAndSeedEnterprise(
  pool: pg.Pool,
  stripe: Stripe,
  runId: string,
): Promise<{
  snapshot: SubscriptionSnapshot | null;
  customerId: string;
  subscriptionId: string;
}> {
  const { rows } = await pool.query<SubscriptionSnapshot & {
    current_period_start: Date | null;
    current_period_end: Date | null;
  }>(
    `SELECT plan, status::text AS status, billing_interval::text AS billing_interval,
            stripe_customer_id, stripe_subscription_id, stripe_price_id,
            monthly_call_limit, monthly_sms_limit, monthly_ai_minute_limit,
            overage_enabled, current_period_start, current_period_end
       FROM subscriptions WHERE tenant_id = $1`,
    [ADMIN_TENANT_ID],
  );
  const raw = rows[0];
  const snapshot: SubscriptionSnapshot | null = raw
    ? {
        ...raw,
        current_period_start: raw.current_period_start ? new Date(raw.current_period_start).toISOString() : null,
        current_period_end: raw.current_period_end ? new Date(raw.current_period_end).toISOString() : null,
      }
    : null;

  const customer = await stripe.customers.create({
    email: `billing-rec-down-stripe-e2e-${runId}@voiceaihub.dev`,
    payment_method: TEST_PAYMENT_METHOD,
    invoice_settings: { default_payment_method: TEST_PAYMENT_METHOD },
    metadata: { tenantId: ADMIN_TENANT_ID, e2eRunId: runId, e2eSpec: SPEC_NAME },
  });

  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: STRIPE_PRICE_ENTERPRISE_MONTHLY! }],
    default_payment_method: TEST_PAYMENT_METHOD,
    metadata: { tenantId: ADMIN_TENANT_ID, e2eRunId: runId, e2eSpec: SPEC_NAME },
  });

  // Mirror the price/interval onto the local row so downstream UI
  // queries (effective rate, downgrade preview) read consistent
  // enterprise values while the spec runs.
  const subRaw = subscription as unknown as Record<string, unknown>;
  const periodStartUnix = subRaw.current_period_start as number | undefined;
  const periodEndUnix = subRaw.current_period_end as number | undefined;
  const periodStartIso = periodStartUnix ? new Date(periodStartUnix * 1000).toISOString() : null;
  const periodEndIso = periodEndUnix ? new Date(periodEndUnix * 1000).toISOString() : null;

  await pool.query(
    `INSERT INTO subscriptions (tenant_id, plan, status, billing_interval,
       stripe_customer_id, stripe_subscription_id, stripe_price_id,
       monthly_call_limit, monthly_sms_limit, monthly_ai_minute_limit,
       overage_enabled, current_period_start, current_period_end)
     VALUES ($1, 'enterprise', 'active'::subscription_status, 'monthly'::billing_interval,
             $2, $3, $4,
             999999, 999999, 999999, true,
             $5, $6)
     ON CONFLICT (tenant_id) DO UPDATE SET
       plan = 'enterprise',
       status = 'active',
       billing_interval = 'monthly',
       stripe_customer_id = EXCLUDED.stripe_customer_id,
       stripe_subscription_id = EXCLUDED.stripe_subscription_id,
       stripe_price_id = EXCLUDED.stripe_price_id,
       monthly_call_limit = 999999,
       monthly_sms_limit = 999999,
       monthly_ai_minute_limit = 999999,
       overage_enabled = true,
       current_period_start = EXCLUDED.current_period_start,
       current_period_end = EXCLUDED.current_period_end,
       updated_at = NOW()`,
    [ADMIN_TENANT_ID, customer.id, subscription.id, STRIPE_PRICE_ENTERPRISE_MONTHLY, periodStartIso, periodEndIso],
  );

  return { snapshot, customerId: customer.id, subscriptionId: subscription.id };
}

async function seed(pool: pg.Pool, stripe: Stripe): Promise<SeedResult> {
  const runId = randomUUID().slice(0, 8);
  const fixtureEmail = `billing-rec-down-stripe-e2e-${runId}@voiceaihub.dev`;
  const passwordHash = await bcrypt.hash(FIXTURE_PASSWORD, 12);

  const fixtureUserId = await upsertFixtureUser(pool, {
    tenantId: ADMIN_TENANT_ID,
    email: fixtureEmail,
    passwordHash,
    role: 'tenant_owner',
  });

  const now = new Date();
  const seededPeriodStarts = [monthStart(now, 1), monthStart(now, 2), monthStart(now, 3)];
  const seededPeriodStartsIso = seededPeriodStarts.map((d) => d.toISOString());

  const preserveResult = await pool.query<{ period_start: Date; quantity: number }>(
    `SELECT period_start, quantity
       FROM usage_metrics
      WHERE tenant_id = $1
        AND metric_type = 'ai_minutes'
        AND period_start = ANY($2::timestamp[])`,
    [ADMIN_TENANT_ID, seededPeriodStartsIso],
  );
  const preserveUsageMetrics: UsageMetricSnapshot[] = preserveResult.rows.map((r) => ({
    periodStartIso: new Date(r.period_start).toISOString(),
    quantity: Number(r.quantity),
  }));

  // Three trailing months of low ai_minutes — flips the estimator
  // recommendation enterprise → starter.
  for (const ps of seededPeriodStarts) {
    const periodEnd = new Date(Date.UTC(ps.getUTCFullYear(), ps.getUTCMonth() + 1, 1, 0, 0, 0, 0));
    await pool.query(
      `INSERT INTO usage_metrics (tenant_id, metric_type, period_start, period_end, quantity)
       VALUES ($1, 'ai_minutes', $2, $3, $4)
       ON CONFLICT (tenant_id, metric_type, period_start) DO UPDATE SET
         quantity = EXCLUDED.quantity,
         period_end = EXCLUDED.period_end,
         updated_at = NOW()`,
      [ADMIN_TENANT_ID, ps.toISOString(), periodEnd.toISOString(), FIXTURE_AI_MINUTES_PER_MONTH],
    );
  }

  const { snapshot, customerId, subscriptionId } = await snapshotAndSeedEnterprise(pool, stripe, runId);

  return {
    runId,
    fixtureEmail,
    fixtureUserId,
    preserveUsageMetrics,
    seededPeriodStartsIso,
    subscriptionSnapshot: snapshot,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
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

async function cleanup(
  pool: pg.Pool,
  seedData: SeedResult,
  stripe: Stripe,
  stripeScheduleId: string | null,
): Promise<void> {
  // Cancel (release) the schedule first so cancelling the subscription
  // doesn't trip on the bound schedule.
  if (stripe && stripeScheduleId) {
    await stripe.subscriptionSchedules
      .release(stripeScheduleId)
      .catch((err) =>
        console.warn(
          `[e2e] cleanup: stripe schedule release failed (${stripeScheduleId}):`,
          (err as Error).message,
        ),
      );
  }
  // Cancel the seeded Stripe subscription so a delete on the customer
  // doesn't fail on an attached active subscription.
  if (stripe && seedData.stripeSubscriptionId) {
    await stripe.subscriptions
      .cancel(seedData.stripeSubscriptionId)
      .catch((err) =>
        console.warn(
          `[e2e] cleanup: stripe subscription cancel failed (${seedData.stripeSubscriptionId}):`,
          (err as Error).message,
        ),
      );
  }
  if (stripe && seedData.stripeCustomerId) {
    await stripe.customers
      .del(seedData.stripeCustomerId)
      .catch((err) =>
        console.warn(
          `[e2e] cleanup: stripe customer delete failed (${seedData.stripeCustomerId}):`,
          (err as Error).message,
        ),
      );
  }

  // Scope deletes to rows uniquely tied to this run so concurrent
  // admin-org test data is unaffected. The downgrade arm writes the
  // switch_completed row with metadata.stripeScheduleId (no checkout
  // session is involved), so the cleanup match key changes accordingly.
  const cleanupClient = await pool.connect();
  try {
    await cleanupClient.query('BEGIN');
    await cleanupClient.query('SET LOCAL row_security = off');
    if (stripeScheduleId) {
      await cleanupClient.query(
        `DELETE FROM billing_recommendation_events
          WHERE tenant_id = $1
            AND metadata->>'stripeScheduleId' = $2`,
        [ADMIN_TENANT_ID, stripeScheduleId],
      );
    }
    await cleanupClient.query('COMMIT');
  } catch (err) {
    await cleanupClient.query('ROLLBACK').catch(() => {});
    console.warn('[e2e] cleanup events failed:', err);
  } finally {
    cleanupClient.release();
  }

  // Restore admin-org's pre-test subscriptions row. The downgrade path
  // doesn't itself overwrite the local subscriptions row (the row
  // updates when Stripe later fires the schedule's price-change
  // webhook), but the seed pinned admin-org to the disposable Stripe
  // customer/subscription that just got cleaned up — without restore
  // the row would be left pointing at deleted Stripe ids.
  if (seedData.subscriptionSnapshot) {
    const s = seedData.subscriptionSnapshot;
    await pool
      .query(
        `INSERT INTO subscriptions (tenant_id, plan, status, billing_interval,
           stripe_customer_id, stripe_subscription_id, stripe_price_id,
           monthly_call_limit, monthly_sms_limit, monthly_ai_minute_limit,
           overage_enabled, current_period_start, current_period_end)
         VALUES ($1, $2, $3::subscription_status, $4::billing_interval,
                 $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
           updated_at = NOW()`,
        [
          ADMIN_TENANT_ID, s.plan, s.status, s.billing_interval,
          s.stripe_customer_id, s.stripe_subscription_id, s.stripe_price_id,
          s.monthly_call_limit, s.monthly_sms_limit, s.monthly_ai_minute_limit,
          s.overage_enabled, s.current_period_start, s.current_period_end,
        ],
      )
      .catch((err) => console.warn('[e2e] cleanup subscription restore failed:', err));
  }

  const preservedSet = new Set(seedData.preserveUsageMetrics.map((r) => r.periodStartIso));
  const toDelete = seedData.seededPeriodStartsIso.filter((iso) => !preservedSet.has(iso));
  if (toDelete.length > 0) {
    await pool
      .query(
        `DELETE FROM usage_metrics
          WHERE tenant_id = $1
            AND metric_type = 'ai_minutes'
            AND period_start = ANY($2::timestamp[])`,
        [ADMIN_TENANT_ID, toDelete],
      )
      .catch((err) => console.warn('[e2e] cleanup usage_metrics delete failed:', err));
  }
  for (const orig of seedData.preserveUsageMetrics) {
    const ps = new Date(orig.periodStartIso);
    const pe = new Date(Date.UTC(ps.getUTCFullYear(), ps.getUTCMonth() + 1, 1, 0, 0, 0, 0));
    await pool
      .query(
        `INSERT INTO usage_metrics (tenant_id, metric_type, period_start, period_end, quantity)
         VALUES ($1, 'ai_minutes', $2, $3, $4)
         ON CONFLICT (tenant_id, metric_type, period_start) DO UPDATE SET
           quantity = EXCLUDED.quantity,
           updated_at = NOW()`,
        [ADMIN_TENANT_ID, orig.periodStartIso, pe.toISOString(), orig.quantity],
      )
      .catch((err) => console.warn('[e2e] cleanup usage_metrics restore failed:', err));
  }

  await softDeleteUser(pool, seedData.fixtureUserId, seedData.fixtureEmail);
}

async function readSwitchCompletedRow(
  pool: pg.Pool,
  tenantId: string,
  stripeScheduleId: string,
): Promise<{
  current_tier: string;
  recommended_tier: string;
  monthly_savings_cents: number | null;
  trailing_window_months: number | null;
  pitch: string | null;
  metadata: Record<string, unknown>;
} | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL row_security = off');
    const { rows } = await client.query(
      `SELECT current_tier::text, recommended_tier::text,
              monthly_savings_cents, trailing_window_months,
              pitch::text AS pitch, metadata
         FROM billing_recommendation_events
        WHERE tenant_id = $1
          AND event_type = 'switch_completed'
          AND metadata->>'stripeScheduleId' = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [tenantId, stripeScheduleId],
    );
    await client.query('COMMIT');
    return rows[0] ?? null;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
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

async function run(): Promise<void> {
  if (!STRIPE_SECRET_KEY || !STRIPE_PRICE_ENTERPRISE_MONTHLY || !STRIPE_PRICE_STARTER_MONTHLY) {
    console.log(
      `[e2e] SKIP: ${SPEC_NAME} requires STRIPE_SECRET_KEY, STRIPE_PRICE_ENTERPRISE_MONTHLY, and STRIPE_PRICE_STARTER_MONTHLY.`,
    );
    return;
  }
  if (!DB_URL) {
    console.error('[e2e] DATABASE_URL (dev) or PLATFORM_DB_POOL_URL (prod) must be set');
    process.exit(1);
  }

  assert(
    STRIPE_SECRET_KEY.startsWith('sk_test_'),
    'STRIPE_SECRET_KEY must be a test-mode key (sk_test_…); refusing to run against live Stripe',
  );

  const pool = new pg.Pool({ connectionString: DB_URL, max: 4 });
  const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
  let browser: Browser | undefined;
  let tenantPage: Page | undefined;
  let seedData: SeedResult | undefined;
  let createdScheduleId: string | null = null;

  try {
    seedData = await seed(pool, stripe);
    console.log(
      `[e2e] seeded fixture user=${seedData.fixtureEmail} runId=${seedData.runId} ` +
        `stripeCustomer=${seedData.stripeCustomerId} stripeSub=${seedData.stripeSubscriptionId}`,
    );

    browser = await chromium.launch({ headless: true });
    const tenantCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    tenantPage = await tenantCtx.newPage();

    await login(tenantPage, seedData.fixtureEmail, FIXTURE_PASSWORD);
    await tenantPage.goto(`${BASE_URL}/billing`, { waitUntil: 'networkidle' });
    await tenantPage.waitForSelector(
      `[data-testid="billing-estimator-recommendation"][data-recommendation-state="switch"]` +
        `[data-recommended-tier="${EXPECTED_RECOMMENDED_TIER}"]`,
      { timeout: 20_000 },
    );

    // Drive the real route end-to-end: click the banner CTA and wait
    // for the matching /api/billing/schedule-downgrade response. No
    // interception — the route fix under test is what makes this
    // request go to schedule-downgrade in the first place (previously
    // the BillingEstimator always POSTed to /api/billing/checkout,
    // which would 400 with DOWNGRADE_REQUIRES_SCHEDULE).
    const responsePromise: Promise<Response> = tenantPage.waitForResponse(
      (resp) => /\/api\/billing\/schedule-downgrade$/.test(resp.url()) && resp.request().method() === 'POST',
      { timeout: 30_000 },
    );

    // The banner-attributed CTA must NOT trigger window.confirm — the
    // banner click itself is the consent. Fail the test if a confirm
    // dialog ever pops, since that would mean the BillingEstimator
    // path is falling through to the legacy "scheduled downgrade card"
    // confirm flow instead of the banner-attributed path.
    tenantPage.on('dialog', async (dialog) => {
      const message = `unexpected ${dialog.type()} dialog from banner CTA: ${dialog.message()}`;
      console.error(`[e2e] ${message}`);
      await dialog.dismiss().catch(() => undefined);
      throw new Error(message);
    });

    await tenantPage.click('[data-testid="billing-estimator-recommendation-cta"]');

    const response = await responsePromise;
    assert(response.status() === 200, `schedule-downgrade should return 200, got ${response.status()}`);

    let requestBody: ScheduleDowngradeRequestBody | null = null;
    try {
      const postData = response.request().postData();
      if (postData) requestBody = JSON.parse(postData) as ScheduleDowngradeRequestBody;
    } catch {
      requestBody = null;
    }
    assert(requestBody, 'expected to capture schedule-downgrade request body');

    const responseBody = (await response.json()) as ScheduleDowngradeResponseBody;
    const scheduled = responseBody.scheduled;
    assert(scheduled, `schedule-downgrade response missing 'scheduled': ${JSON.stringify(responseBody)}`);
    assert(
      typeof scheduled.scheduleId === 'string' && scheduled.scheduleId.startsWith('sub_sched_'),
      `schedule-downgrade should return a Stripe scheduleId, got ${JSON.stringify(scheduled)}`,
    );
    assert(
      scheduled.targetPlan === EXPECTED_RECOMMENDED_TIER,
      `scheduled.targetPlan should be '${EXPECTED_RECOMMENDED_TIER}', got ${scheduled.targetPlan}`,
    );
    const scheduleId = scheduled.scheduleId;
    createdScheduleId = scheduleId;
    console.log(`[e2e] created Stripe subscription schedule ${scheduleId}`);

    // Banner attribution from the request body — source of truth for
    // downstream metadata / DB assertions (decouples the test from
    // tenant-specific catalog math and rate overrides).
    const rec = requestBody.recommendation;
    assert(
      rec != null,
      `request body should include recommendation attribution, got ${JSON.stringify(requestBody)}`,
    );
    assert(
      rec.currentTier === EXPECTED_CURRENT_TIER,
      `attributed currentTier should be '${EXPECTED_CURRENT_TIER}', got ${rec.currentTier}`,
    );
    assert(
      rec.recommendedTier === EXPECTED_RECOMMENDED_TIER,
      `attributed recommendedTier should be '${EXPECTED_RECOMMENDED_TIER}', got ${rec.recommendedTier}`,
    );
    const attributedSavings = Number(rec.monthlySavingsCents);
    assert(
      Number.isFinite(attributedSavings) && attributedSavings > 0,
      `attributed monthlySavingsCents should be > 0 (downgrade savings), got ${rec.monthlySavingsCents}`,
    );
    const attributedWindow = Number(rec.trailingWindowMonths);
    assert(
      attributedWindow === 3 || attributedWindow === 6 || attributedWindow === 12,
      `attributed trailingWindowMonths should be 3/6/12, got ${rec.trailingWindowMonths}`,
    );
    assert(
      requestBody.plan === EXPECTED_RECOMMENDED_TIER,
      `request body plan should be '${EXPECTED_RECOMMENDED_TIER}', got ${requestBody.plan}`,
    );

    // Server-of-record check: Stripe holds the metadata stamped by
    // scheduleDowngrade. Mirrors the upgrade arm's session.metadata
    // assertions but reads from the Subscription Schedule instead.
    const stripeSchedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
    assert(
      stripeSchedule.livemode === false,
      `refusing to proceed: retrieved schedule is livemode=true (id=${scheduleId})`,
    );
    const metadata = (stripeSchedule.metadata ?? {}) as Record<string, string>;

    assert(
      metadata.recommendationSource === 'billing_estimator_recommendation',
      `metadata.recommendationSource mismatch, got ${metadata.recommendationSource}`,
    );
    assert(
      metadata.recommendationCurrentTier === EXPECTED_CURRENT_TIER,
      `metadata.recommendationCurrentTier mismatch, got ${metadata.recommendationCurrentTier}`,
    );
    assert(
      metadata.recommendationRecommendedTier === EXPECTED_RECOMMENDED_TIER,
      `metadata.recommendationRecommendedTier mismatch, got ${metadata.recommendationRecommendedTier}`,
    );
    assert(
      Number(metadata.recommendationMonthlySavingsCents) === attributedSavings,
      `metadata.recommendationMonthlySavingsCents should equal attributed ${attributedSavings}, got ${metadata.recommendationMonthlySavingsCents}`,
    );
    assert(
      Number(metadata.recommendationTrailingWindowMonths) === attributedWindow,
      `metadata.recommendationTrailingWindowMonths should equal attributed ${attributedWindow}, got ${metadata.recommendationTrailingWindowMonths}`,
    );
    assert(
      metadata.recommendationPitch === 'tier-switch',
      `metadata.recommendationPitch should be 'tier-switch', got ${metadata.recommendationPitch}`,
    );

    // Funnel attribution: scheduleDowngrade writes the
    // switch_completed row directly (the upgrade arm writes it from
    // the checkout webhook, but downgrades have no
    // checkout.session.completed event to wait on — the schedule
    // update IS the "switch" from the funnel's POV). The route
    // returns synchronously after the row is written, so polling
    // isn't necessary.
    const switchRow = await readSwitchCompletedRow(pool, ADMIN_TENANT_ID, scheduleId);
    assert(switchRow, `no switch_completed row written for scheduleId=${scheduleId}`);
    assert(
      switchRow.current_tier === EXPECTED_CURRENT_TIER &&
        switchRow.recommended_tier === EXPECTED_RECOMMENDED_TIER,
      `switch_completed tier mismatch: ${JSON.stringify(switchRow)}`,
    );
    assert(
      Number(switchRow.monthly_savings_cents) === attributedSavings,
      `switch_completed monthly_savings_cents should equal ${attributedSavings}, got ${switchRow.monthly_savings_cents}`,
    );
    assert(
      switchRow.trailing_window_months === attributedWindow,
      `switch_completed trailing_window_months should equal ${attributedWindow}, got ${switchRow.trailing_window_months}`,
    );
    assert(
      switchRow.pitch === 'tier-switch',
      `switch_completed pitch should be 'tier-switch', got ${switchRow.pitch}`,
    );
    const meta = switchRow.metadata as {
      source?: string;
      stripeScheduleId?: string;
      stripeSubscriptionId?: string;
      targetInterval?: string;
    };
    assert(
      meta.source === 'schedule_downgrade',
      `switch_completed metadata.source should be 'schedule_downgrade', got ${JSON.stringify(switchRow.metadata)}`,
    );
    assert(
      meta.stripeScheduleId === scheduleId,
      `switch_completed metadata.stripeScheduleId should be '${scheduleId}', got ${meta.stripeScheduleId}`,
    );
    assert(
      meta.stripeSubscriptionId === seedData.stripeSubscriptionId,
      `switch_completed metadata.stripeSubscriptionId should be '${seedData.stripeSubscriptionId}', got ${meta.stripeSubscriptionId}`,
    );
    assert(
      meta.targetInterval === 'monthly',
      `switch_completed metadata.targetInterval should be 'monthly', got ${meta.targetInterval}`,
    );

    console.log('[e2e] PASS');
  } catch (err) {
    await captureFailureScreenshot(tenantPage, 'tenant');
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (seedData) {
      await cleanup(pool, seedData, stripe, createdScheduleId).catch((err) =>
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
