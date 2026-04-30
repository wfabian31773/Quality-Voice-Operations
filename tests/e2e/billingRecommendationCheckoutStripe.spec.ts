/**
 * E2E spec covering the BillingEstimator recommendation banner against
 * a real Stripe test-mode account. Drives the click, asserts Stripe
 * session metadata carries the banner-attributed currentTier /
 * recommendedTier / monthlySavingsCents / trailingWindowMonths, then
 * replays a checkout.session.completed event through `handleStripeEvent`
 * and verifies the resulting billing_recommendation_events row.
 *
 * Skips when STRIPE_SECRET_KEY / STRIPE_PRICE_ENTERPRISE_MONTHLY are
 * absent. Run: npm run test:e2e:billing-recommendation-checkout-stripe
 */
import { chromium, type Browser, type Page, type Route } from 'playwright';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import path from 'path';
import Stripe from 'stripe';
import { handleStripeEvent } from '../../platform/billing/stripe/webhook';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRICE_ENTERPRISE_MONTHLY = process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY;
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'billing-recommendation-checkout-stripe';
const STRIPE_API_VERSION = '2026-02-25.clover' as const;

// Mirrors platform/db/index.ts:getPoolUrl — webhook handler reads
// from the same env var the spec must seed against.
const DB_URL = (() => {
  const env = process.env.APP_ENV ?? 'development';
  return env === 'development'
    ? (process.env.DATABASE_URL ?? '')
    : (process.env.PLATFORM_DB_POOL_URL ?? '');
})();

const ADMIN_TENANT_ID = 'admin-org';
const FIXTURE_PASSWORD = 'test-password-123';
const FIXTURE_AI_MINUTES_PER_MONTH = 8_000;
const EXPECTED_CURRENT_TIER = 'starter';
const EXPECTED_RECOMMENDED_TIER = 'enterprise';

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
  stripeEventId: string;
}

interface CheckoutRequestBody {
  plan?: string;
  interval?: string;
  recommendation?: {
    currentTier?: string;
    recommendedTier?: string;
    monthlySavingsCents?: number;
    trailingWindowMonths?: number;
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

async function snapshotAndForceStarter(pool: pg.Pool): Promise<SubscriptionSnapshot | null> {
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

  // Wipe Stripe customer/sub ids — createCheckoutSession would otherwise
  // try to attach to a fixture customer that does not exist in test mode.
  await pool.query(
    `INSERT INTO subscriptions (tenant_id, plan, status, billing_interval,
                                stripe_customer_id, stripe_subscription_id,
                                monthly_call_limit, monthly_sms_limit, monthly_ai_minute_limit,
                                overage_enabled)
     VALUES ($1, 'starter', 'active'::subscription_status, 'monthly'::billing_interval,
             NULL, NULL,
             500, 1000, 250, false)
     ON CONFLICT (tenant_id) DO UPDATE SET
       plan = 'starter',
       status = 'active',
       billing_interval = 'monthly',
       stripe_customer_id = NULL,
       stripe_subscription_id = NULL,
       stripe_price_id = NULL,
       monthly_call_limit = 500,
       monthly_sms_limit = 1000,
       monthly_ai_minute_limit = 250,
       overage_enabled = false,
       updated_at = NOW()`,
    [ADMIN_TENANT_ID],
  );

  return snapshot;
}

async function seed(pool: pg.Pool): Promise<SeedResult> {
  const runId = randomUUID().slice(0, 8);
  const fixtureEmail = `billing-rec-stripe-e2e-${runId}@voiceaihub.dev`;
  const stripeEventId = `evt_e2e_stripe_${runId}`;
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

  const subscriptionSnapshot = await snapshotAndForceStarter(pool);

  return {
    runId,
    fixtureEmail,
    fixtureUserId,
    preserveUsageMetrics,
    seededPeriodStartsIso,
    subscriptionSnapshot,
    stripeEventId,
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
  stripe: Stripe | null,
  stripeSessionId: string | null,
): Promise<void> {
  if (stripe && stripeSessionId) {
    await stripe.checkout.sessions
      .expire(stripeSessionId)
      .catch((err) =>
        console.warn(`[e2e] cleanup: stripe session expire failed (${stripeSessionId}):`, (err as Error).message),
      );
  }

  if (stripeSessionId) {
    await pool
      .query(
        `DELETE FROM website_conversion_events WHERE visitor_id = $1`,
        [`stripe_${stripeSessionId}`],
      )
      .catch((err) => console.warn('[e2e] cleanup conversion event failed:', err));
  }

  // Scope deletes to rows uniquely tied to this run's Stripe session /
  // event id so concurrent test data on admin-org is not affected.
  const cleanupClient = await pool.connect();
  try {
    await cleanupClient.query('BEGIN');
    await cleanupClient.query('SET LOCAL row_security = off');
    if (stripeSessionId) {
      await cleanupClient.query(
        `DELETE FROM billing_recommendation_events
          WHERE tenant_id = $1
            AND metadata->>'stripeSessionId' = $2`,
        [ADMIN_TENANT_ID, stripeSessionId],
      );
    }
    await cleanupClient.query(
      `DELETE FROM billing_events
        WHERE tenant_id = $1 AND stripe_event_id = $2`,
      [ADMIN_TENANT_ID, seedData.stripeEventId],
    );
    await cleanupClient.query('COMMIT');
  } catch (err) {
    await cleanupClient.query('ROLLBACK').catch(() => {});
    console.warn('[e2e] cleanup events failed:', err);
  } finally {
    cleanupClient.release();
  }

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
  stripeSessionId: string,
): Promise<{
  current_tier: string;
  recommended_tier: string;
  monthly_savings_cents: number | null;
  trailing_window_months: number | null;
  metadata: Record<string, unknown>;
} | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL row_security = off');
    const { rows } = await client.query(
      `SELECT current_tier::text, recommended_tier::text,
              monthly_savings_cents, trailing_window_months, metadata
         FROM billing_recommendation_events
        WHERE tenant_id = $1
          AND event_type = 'switch_completed'
          AND metadata->>'stripeSessionId' = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      [tenantId, stripeSessionId],
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
  if (!STRIPE_SECRET_KEY || !STRIPE_PRICE_ENTERPRISE_MONTHLY) {
    console.log(
      `[e2e] SKIP: ${SPEC_NAME} requires STRIPE_SECRET_KEY and STRIPE_PRICE_ENTERPRISE_MONTHLY.`,
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
  let createdSessionId: string | null = null;

  try {
    seedData = await seed(pool);
    console.log(`[e2e] seeded fixture user=${seedData.fixtureEmail} runId=${seedData.runId}`);

    browser = await chromium.launch({ headless: true });
    const tenantCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    tenantPage = await tenantCtx.newPage();

    // Block the post-checkout redirect to checkout.stripe.com so the
    // browser stays on /billing while the spec inspects the session.
    await tenantCtx.route('**://checkout.stripe.com/**', (route) => route.abort());

    // Capture both request body and response body for /api/billing/checkout.
    // The request body carries the banner attribution (used as the source
    // of truth for downstream assertions). route.fetch() reads the response
    // before the page's window.location.href redirect destroys it.
    type Captured = {
      status: number;
      body: { sessionId?: string; url?: string } | null;
      raw: string;
      requestBody: CheckoutRequestBody | null;
    };
    const captureState: { value: Captured | null } = { value: null };
    let captureResolve: (() => void) | null = null;
    const captured$ = new Promise<void>((resolve) => {
      captureResolve = resolve;
    });
    await tenantPage.route('**/api/billing/checkout', async (route: Route) => {
      let requestBody: CheckoutRequestBody | null = null;
      try {
        const postData = route.request().postData();
        if (postData) requestBody = JSON.parse(postData) as CheckoutRequestBody;
      } catch {
        requestBody = null;
      }
      try {
        const apiResponse = await route.fetch();
        const status = apiResponse.status();
        const raw = await apiResponse.text();
        let parsed: { sessionId?: string; url?: string } | null = null;
        try {
          parsed = JSON.parse(raw) as { sessionId?: string; url?: string };
        } catch {
          parsed = null;
        }
        captureState.value = { status, body: parsed, raw, requestBody };
        captureResolve?.();
        await route.fulfill({ status, headers: apiResponse.headers(), body: raw });
      } catch (err) {
        captureState.value = {
          status: 0,
          body: null,
          raw: `route.fetch threw: ${(err as Error).message}`,
          requestBody,
        };
        captureResolve?.();
        await route.abort();
      }
    });

    await login(tenantPage, seedData.fixtureEmail, FIXTURE_PASSWORD);
    await tenantPage.goto(`${BASE_URL}/billing`, { waitUntil: 'networkidle' });
    await tenantPage.waitForSelector(
      `[data-testid="billing-estimator-recommendation"][data-recommendation-state="switch"][data-recommended-tier="${EXPECTED_RECOMMENDED_TIER}"]`,
      { timeout: 20_000 },
    );

    await tenantPage.click('[data-testid="billing-estimator-recommendation-cta"]');
    await Promise.race([
      captured$,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Timed out waiting for /api/billing/checkout response')), 30_000),
      ),
    ]);
    const capture = captureState.value;
    assert(capture, 'expected /api/billing/checkout response capture to populate');
    assert(
      capture.status === 200,
      `POST /api/billing/checkout returned ${capture.status} (expected 200) — body: ${capture.raw}`,
    );

    // Banner attribution from the request body — source of truth for
    // downstream metadata / DB assertions (decouples test from catalog
    // math and tenant-specific Stripe rate overrides).
    const rec = capture.requestBody?.recommendation;
    assert(
      rec != null,
      `request body should include recommendation attribution, got ${JSON.stringify(capture.requestBody)}`,
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
      `attributed monthlySavingsCents should be > 0, got ${rec.monthlySavingsCents}`,
    );
    const attributedWindow = Number(rec.trailingWindowMonths);
    assert(
      attributedWindow === 3 || attributedWindow === 6 || attributedWindow === 12,
      `attributed trailingWindowMonths should be 3/6/12, got ${rec.trailingWindowMonths}`,
    );

    const body = capture.body ?? {};
    assert(
      typeof body.sessionId === 'string' && body.sessionId.startsWith('cs_'),
      `response should include a Stripe sessionId, got ${JSON.stringify(body)}`,
    );
    const sessionId: string = body.sessionId;
    createdSessionId = sessionId;
    console.log(`[e2e] created Stripe session ${sessionId}`);

    // Server-of-record check: Stripe holds the metadata stamped by
    // createCheckoutSession.
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    assert(
      session.livemode === false,
      `refusing to proceed: retrieved session is livemode=true (id=${sessionId})`,
    );
    const metadata = (session.metadata ?? {}) as Record<string, string>;

    assert(
      metadata.tenantId === ADMIN_TENANT_ID,
      `metadata.tenantId should be '${ADMIN_TENANT_ID}', got ${metadata.tenantId}`,
    );
    assert(
      metadata.plan === EXPECTED_RECOMMENDED_TIER,
      `metadata.plan should be '${EXPECTED_RECOMMENDED_TIER}', got ${metadata.plan}`,
    );
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

    // Replay a checkout.session.completed event through the webhook
    // dispatcher (handleStripeEvent), the same path Stripe would invoke
    // in production for this session.
    const completedEvent = {
      id: seedData.stripeEventId,
      object: 'event',
      api_version: STRIPE_API_VERSION,
      created: Math.floor(Date.now() / 1000),
      type: 'checkout.session.completed',
      livemode: false,
      pending_webhooks: 0,
      request: { id: null, idempotency_key: null },
      data: { object: session },
    } as unknown as Stripe.Event;
    await handleStripeEvent(completedEvent);

    const switchRow = await readSwitchCompletedRow(pool, ADMIN_TENANT_ID, sessionId);
    assert(switchRow, `no switch_completed row written for sessionId=${sessionId}`);
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
    const meta = switchRow.metadata as { source?: string; stripeSessionId?: string; stripeEventId?: string };
    assert(
      meta.source === 'stripe_webhook',
      `switch_completed metadata.source should be 'stripe_webhook', got ${JSON.stringify(switchRow.metadata)}`,
    );
    assert(
      meta.stripeSessionId === sessionId,
      `switch_completed metadata.stripeSessionId should be '${sessionId}', got ${meta.stripeSessionId}`,
    );
    assert(
      meta.stripeEventId === seedData.stripeEventId,
      `switch_completed metadata.stripeEventId should be '${seedData.stripeEventId}', got ${meta.stripeEventId}`,
    );

    console.log('[e2e] PASS');
  } catch (err) {
    await captureFailureScreenshot(tenantPage, 'tenant');
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (seedData) {
      await cleanup(pool, seedData, stripe, createdSessionId).catch((err) =>
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
