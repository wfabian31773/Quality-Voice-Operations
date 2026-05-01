/**
 * Task #1337 — End-to-end regression for the green "switch to annual"
 * CTA on the BillingEstimator's optimal/already-on-tier banner.
 *
 * Background:
 *   The recommendation banner has a second checkout path that the
 *   sister `billingRecommendationCheckout.spec.ts` does not exercise.
 *   When the tenant is already on the cheapest tier for their volume
 *   AND still on monthly billing, BillingEstimator surfaces a green
 *   "Switch to annual billing" pitch CTA
 *   (`billing-estimator-recommendation-annual-pitch-cta`). That CTA
 *   hardcodes `data-recommendation-cta-interval="annual"` and calls
 *   `onSwitchPlan(recommended.tier, 'annual', attribution)` directly —
 *   no toggle in between. A regression that dropped `interval` from
 *   `handleUpgrade` (or that flipped the hardcoded literal to
 *   'monthly') would silently send these tenants to a monthly Stripe
 *   subscription, with no other test catching it.
 *
 * Stub strategy:
 *   We never visit checkout.stripe.com. Instead we:
 *     1. Seed admin-org's subscription to the recommended tier
 *        (starter) on monthly billing — the prerequisite for the
 *        optimal-branch annual pitch to render.
 *     2. Seed three trailing months of low ai_minutes (~100/mo) so the
 *        recommendation engine confirms starter is still the cheapest
 *        tier at this volume; this lights up the "you're already on
 *        the cheapest plan" optimal banner.
 *     3. Stub `/api/billing/checkout` so we can capture the outgoing
 *        request body (the wiring guard the task asks for) without
 *        needing a real Stripe round-trip.
 *   The pre-test admin-org subscription row and the overwritten
 *   usage_metrics rows are snapshotted and restored on cleanup so the
 *   shared dev fixture doesn't drift between runs.
 *
 * Run: npm run test:e2e:billing-recommendation-annual-pitch
 */
import { chromium, type Browser, type Page, type Request, type Route } from 'playwright';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import path from 'path';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'billing-recommendation-annual-pitch';

// Mirrors platform/db/index.ts:getPoolUrl — the spec must seed against
// the same DB the dev workflow reads from. Same precedence as the
// sister billing recommendation specs.
const DB_URL = (() => {
  const env = process.env.APP_ENV ?? 'development';
  return env === 'development'
    ? (process.env.DATABASE_URL ?? process.env.PLATFORM_DB_POOL_URL ?? '')
    : (process.env.PLATFORM_DB_POOL_URL ?? process.env.DATABASE_URL ?? '');
})();

const ADMIN_TENANT_ID = 'admin-org';
const FIXTURE_PASSWORD = 'test-password-123';
// Far below starter's 500 included minutes — keeps starter the
// cheapest tier (so the optimal branch renders) and keeps the
// monthly-savings projection deterministic for the sessionStorage
// dedup key below.
const FIXTURE_AI_MINUTES_PER_MONTH = 100;

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
  downgrade_completed_at: string | null;
  downgrade_completed_to_plan: string | null;
}

interface SeedResult {
  runId: string;
  fixtureEmail: string;
  fixtureUserId: string;
  /** UTC ISO timestamp; rows in billing_recommendation_events with
   *  created_at >= cutoff are deletable as test rows. */
  eventsCutoffIso: string;
  preserveUsageMetrics: UsageMetricSnapshot[];
  seededPeriodStartsIso: string[];
  /** Pre-test snapshot of admin-org's subscriptions row, restored on
   *  cleanup. The seed UPSERTs to starter+monthly to drive the optimal
   *  branch and we don't want that to leak into other specs. */
  subscriptionSnapshot: SubscriptionSnapshot | null;
}

interface CapturedCheckout {
  body?: {
    plan?: string;
    interval?: string;
    successUrl?: string;
    cancelUrl?: string;
    recommendation?: {
      currentTier?: string;
      recommendedTier?: string;
      monthlySavingsCents?: number;
      trailingWindowMonths?: number;
      pitch?: string;
    };
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

async function setSubscriptionStarterMonthly(pool: pg.Pool): Promise<void> {
  // stripe_customer_id / stripe_subscription_id / stripe_price_id are
  // intentionally NULLed so /billing/effective-rate falls back to the
  // catalog rate and `recommended.sourcedFromStripe` stays false —
  // the optimal-branch annual pitch is suppressed when the recommended
  // tier was sourced from a Stripe override (we can't reprice
  // negotiated rates). Plan limits widened to the largest of the three
  // tiers; the banner only reads `sub.plan`, `sub.billing_interval`,
  // and `sub.status`.
  await pool.query(
    `INSERT INTO subscriptions (tenant_id, plan, status, billing_interval,
                                stripe_customer_id, stripe_subscription_id, stripe_price_id,
                                monthly_call_limit, monthly_sms_limit, monthly_ai_minute_limit,
                                overage_enabled,
                                downgrade_completed_at, downgrade_completed_to_plan)
     VALUES ($1, 'starter', 'active'::subscription_status, 'monthly'::billing_interval,
             NULL, NULL, NULL,
             999999, 999999, 999999, true,
             NULL, NULL)
     ON CONFLICT (tenant_id) DO UPDATE SET
       plan = 'starter',
       status = 'active',
       billing_interval = 'monthly',
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
    [ADMIN_TENANT_ID],
  );
}

async function restoreSubscriptionSnapshot(
  pool: pg.Pool,
  s: SubscriptionSnapshot,
): Promise<void> {
  await pool.query(
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
  );
}

async function seed(pool: pg.Pool): Promise<SeedResult> {
  const runId = randomUUID().slice(0, 8);
  const fixtureEmail = `billing-rec-annual-pitch-e2e-${runId}@voiceaihub.dev`;
  const eventsCutoffIso = new Date().toISOString();

  const passwordHash = await bcrypt.hash(FIXTURE_PASSWORD, 12);

  // The seeded admin user has users.role='admin' which is not in the
  // role hierarchy and fails hasMinRole('manager') — the same reason
  // billingRecommendationCheckout.spec.ts uses a tenant_owner under
  // admin-org. Reusing admin-org keeps the subscription snapshot/
  // restore cheap (one row) and matches the sister specs.
  const fixtureUserId = await upsertFixtureUser(pool, {
    tenantId: ADMIN_TENANT_ID,
    email: fixtureEmail,
    passwordHash,
    role: 'tenant_owner',
  });

  // Seed three trailing months of low ai_minutes — at this volume the
  // recommendation engine picks starter as the cheapest tier (well
  // below its 500-minute included quota), so when we also pin the
  // subscription to starter+monthly below, the recommendation card
  // renders in its `optimal` state with `data-annual-pitch="true"`.
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

  // Snapshot before we overwrite — admin-org is the shared seeded
  // fixture and ships on Enterprise; flipping it to starter for this
  // spec must not bleed into the next test run.
  const subscriptionSnapshot = await snapshotSubscription(pool);
  await setSubscriptionStarterMonthly(pool);

  return {
    runId,
    fixtureEmail,
    fixtureUserId,
    eventsCutoffIso,
    preserveUsageMetrics,
    seededPeriodStartsIso,
    subscriptionSnapshot,
  };
}

async function softDeleteUser(pool: pg.Pool, userId: string, originalEmail: string): Promise<void> {
  // Hard-DELETE blows up the SET NULL FK cascade because audit_logs is
  // append-only (prevent_audit_log_mutation trigger). Soft-delete +
  // drop user_roles instead, mirroring the sister specs.
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
  // Delete the test-attributable billing_recommendation_events rows.
  // RLS-bypass tx (privileged read) — same shape as the sister specs.
  const cleanupClient = await pool.connect();
  try {
    await cleanupClient.query('BEGIN');
    await cleanupClient.query('SET LOCAL row_security = off');
    await cleanupClient.query(
      `DELETE FROM billing_recommendation_events
        WHERE tenant_id = $1 AND created_at >= $2`,
      [ADMIN_TENANT_ID, seedData.eventsCutoffIso],
    );
    await cleanupClient.query('COMMIT');
  } catch (err) {
    await cleanupClient.query('ROLLBACK').catch(() => {});
    console.warn('[e2e] cleanup events failed:', err);
  } finally {
    cleanupClient.release();
  }

  // Restore admin-org's pre-test subscriptions row. If no row existed
  // before (unusual for the dev fixture, but be defensive) delete the
  // row we inserted so the table matches the pre-spec state exactly.
  if (seedData.subscriptionSnapshot) {
    await restoreSubscriptionSnapshot(pool, seedData.subscriptionSnapshot).catch((err) =>
      console.warn('[e2e] cleanup subscription restore failed:', err),
    );
  } else {
    await pool
      .query(`DELETE FROM subscriptions WHERE tenant_id = $1`, [ADMIN_TENANT_ID])
      .catch((err) => console.warn('[e2e] cleanup subscription delete failed:', err));
  }

  // Restore the pre-existing usage_metrics rows we overwrote.
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

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await Promise.all([
    page.waitForURL((u) => !u.toString().endsWith('/login'), { timeout: 15_000 }),
    page.click('button[type="submit"]'),
  ]);
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

    // Capture every recommendation-event POST so we can assert the
    // pitch CTA fired the right `annual-only` click — the same pitch
    // the impression on this branch uses, so it's also the dedup
    // segment Postgres lands the row under.
    const recEventBodies: Array<{
      eventType?: string;
      currentTier?: string;
      recommendedTier?: string;
      pitch?: string;
      monthlySavingsCents?: number;
      trailingWindowMonths?: number;
    }> = [];
    page.on('request', (req: Request) => {
      if (
        req.method() === 'POST' &&
        /\/api\/billing\/recommendation-event(\?|$)/.test(req.url())
      ) {
        try {
          const raw = req.postData();
          if (raw) recEventBodies.push(JSON.parse(raw));
        } catch {
          /* ignore */
        }
      }
    });

    // Stub /api/billing/checkout so we never round-trip to Stripe but
    // can still capture the request body — the wiring guard the task
    // asks for. The handler returns the same {url, sessionId} shape
    // checkoutMutation expects so the navigation goes through.
    const captured: CapturedCheckout = {};
    await page.route('**/api/billing/checkout', async (route: Route) => {
      try {
        const raw = route.request().postData();
        if (raw) captured.body = JSON.parse(raw);
      } catch {
        /* ignore */
      }
      const successUrl = captured.body?.successUrl ?? `${BASE_URL}/billing?checkout=success`;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ url: successUrl, sessionId: `cs_e2e_annual_pitch_${seedData!.runId}` }),
      });
    });

    await login(page, seedData.fixtureEmail, FIXTURE_PASSWORD);
    console.log('[e2e] logged in as fixture user');

    await page.goto(`${BASE_URL}/billing`, { waitUntil: 'networkidle' });

    // Wait for the optimal-branch banner with the annual pitch
    // attached. `data-annual-pitch="true"` is the canonical flag for
    // showAnnualPitch — gated on isAlreadyOptimal && currentBillingInterval=='monthly'
    // && !sourcedFromStripe && annualOption.monthlySavings>0. If the
    // selector doesn't resolve, one of those preconditions broke
    // (most likely the subscription seed didn't take or the Stripe
    // override unexpectedly fired).
    await page.waitForSelector(
      '[data-testid="billing-estimator-recommendation"][data-recommendation-state="optimal"][data-annual-pitch="true"]',
      { timeout: 20_000 },
    );

    // Pitch CTA must declare its hardcoded interval contract via the
    // data attribute. This is the regression guard: a fix that
    // accidentally flipped the literal to "monthly" or that dropped
    // the attribute would fail here BEFORE the click, making the
    // failure mode obvious instead of silent-monthly-checkout.
    const pitchCta = page.locator('[data-testid="billing-estimator-recommendation-annual-pitch-cta"]');
    await pitchCta.waitFor({ state: 'visible', timeout: 10_000 });
    const pitchCtaInterval = await pitchCta.getAttribute('data-recommendation-cta-interval');
    assert(
      pitchCtaInterval === 'annual',
      `pitch CTA must declare data-recommendation-cta-interval="annual", got ${JSON.stringify(pitchCtaInterval)}`,
    );
    const pitchCtaTier = await pitchCta.getAttribute('data-recommendation-cta-tier');
    assert(
      pitchCtaTier === 'starter',
      `pitch CTA must declare data-recommendation-cta-tier="starter" (recommended === current === starter), got ${JSON.stringify(pitchCtaTier)}`,
    );

    // Click the pitch CTA — both the recommendation-event click POST
    // and the /billing/checkout POST should fire. Wait on both before
    // navigation so we never read a partial captured.body.
    const clickFired = page.waitForRequest(
      (r) => {
        if (r.method() !== 'POST') return false;
        if (!/\/api\/billing\/recommendation-event(\?|$)/.test(r.url())) return false;
        try {
          const body = JSON.parse(r.postData() ?? '{}');
          return body.eventType === 'click' && body.pitch === 'annual-only';
        } catch {
          return false;
        }
      },
      { timeout: 15_000 },
    );
    const checkoutFired = page.waitForRequest(
      (r) => r.method() === 'POST' && /\/api\/billing\/checkout(\?|$)/.test(r.url()),
      { timeout: 15_000 },
    );
    const navigated = page.waitForURL(
      (u) => u.toString().includes('/billing') && u.toString().includes('checkout=success'),
      { timeout: 20_000 },
    );

    await pitchCta.click();
    await clickFired;
    await checkoutFired;
    await navigated;
    console.log(`[e2e] annual pitch CTA clicked, redirected to ${page.url()}`);

    // The wiring guard the task asks for: the checkout body must
    // forward `interval: "annual"` and `plan: "starter"`. A regression
    // that dropped `interval` from `handleUpgrade` or that flipped the
    // hardcoded literal to 'monthly' lands here.
    assert(captured.body, 'Expected to capture pitch checkout request body');
    assert(
      captured.body.plan === 'starter',
      `pitch checkout plan should be 'starter' (current === recommended), got ${captured.body.plan}`,
    );
    assert(
      captured.body.interval === 'annual',
      `pitch checkout body must carry interval="annual", got ${JSON.stringify(captured.body.interval)}`,
    );
    assert(
      captured.body.recommendation?.currentTier === 'starter',
      `recommendation.currentTier should be 'starter', got ${captured.body.recommendation?.currentTier}`,
    );
    assert(
      captured.body.recommendation?.recommendedTier === 'starter',
      `recommendation.recommendedTier should be 'starter', got ${captured.body.recommendation?.recommendedTier}`,
    );
    assert(
      captured.body.recommendation?.pitch === 'annual-only',
      `recommendation.pitch should be 'annual-only' (the optimal-branch CTA, not 'tier-switch'), got ${JSON.stringify(captured.body.recommendation?.pitch)}`,
    );
    console.log('[e2e] checkout body forwarded interval="annual" with annual-only attribution');

    // The matching click recommendation-event must have fired with
    // pitch='annual-only' so the platform admin attribution tile can
    // separate annual-pitch conversions from tier-switch ones.
    const clickPayload = recEventBodies.find(
      (b) => b.eventType === 'click' && b.pitch === 'annual-only',
    );
    assert(
      clickPayload &&
        clickPayload.currentTier === 'starter' &&
        clickPayload.recommendedTier === 'starter',
      `Click payload missing or malformed: ${JSON.stringify(clickPayload)}`,
    );

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
