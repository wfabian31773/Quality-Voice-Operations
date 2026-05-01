/**
 * E2E spec covering the Stripe webhook over the **real HTTP route** in
 * the dev stack. Companion to billingRecommendationCheckoutStripe.spec.ts,
 * which calls `handleStripeEvent` in-process (and therefore can't catch
 * regressions in:
 *   - Stripe signature verification (STRIPE_WEBHOOK_SECRET mismatch,
 *     header parsing)
 *   - Express raw-body middleware on the webhook route
 *   - Webhook route registration / mounting
 *
 * This spec drives the same `checkout.session.completed` scenario by
 * constructing a signed payload with `stripe.webhooks.generateTestHeaderString`
 * and POSTing it to the live admin-api webhook route at
 * `http://localhost:3002/billing/stripe-webhook`. It also runs two
 * negative scenarios (missing signature, invalid signature) and a
 * duplicate-delivery / idempotency probe so a failure points clearly
 * to which layer broke:
 *
 *   - "missing signature → expected 400" failure   ⇒ route is not
 *     mounted (404), or middleware swallowed/redirected the POST.
 *   - "invalid signature → expected 400" failure   ⇒ verification was
 *     bypassed, raw body parser is missing (so the body isn't a Buffer
 *     and verification can't even attempt), or the response shape changed.
 *   - "valid signature → expected 200 + DB row"    ⇒ signature passed,
 *     route handled, but the dispatch path / handler didn't write the
 *     billing_recommendation_events row the existing in-process spec
 *     also asserts.
 *   - "duplicate POST → expected 200 + still 1 row" ⇒ the
 *     isEventProcessed dedup short-circuit in handleStripeEvent
 *     regressed — Stripe retries the same event id on timeouts and
 *     a doubled billing_recommendation_events row would corrupt
 *     downstream attribution.
 *
 * Skips when STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET /
 * STRIPE_PRICE_ENTERPRISE_MONTHLY are absent. Run:
 *   npm run test:e2e:billing-recommendation-checkout-stripe-webhook-http
 */
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import Stripe from 'stripe';
import { createCheckoutSession } from '../../platform/billing/stripe/checkout';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_PRICE_ENTERPRISE_MONTHLY = process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY;
const SPEC_NAME = 'billing-recommendation-checkout-stripe-webhook-http';
const STRIPE_API_VERSION = '2026-02-25.clover' as const;

const ADMIN_API_PORT = process.env.ADMIN_API_PORT ?? '3002';
const ADMIN_API_BASE_URL =
  process.env.ADMIN_API_BASE_URL ?? `http://localhost:${ADMIN_API_PORT}`;
const WEBHOOK_URL = `${ADMIN_API_BASE_URL}/billing/stripe-webhook`;

// Mirrors platform/db/index.ts:getPoolUrl — webhook handler reads from
// the same env var the spec must seed against.
const DB_URL = (() => {
  const env = process.env.APP_ENV ?? 'development';
  return env === 'development'
    ? (process.env.DATABASE_URL ?? '')
    : (process.env.PLATFORM_DB_POOL_URL ?? '');
})();

const ADMIN_TENANT_ID = 'admin-org';
const FIXTURE_PASSWORD = 'test-password-123';
const EXPECTED_CURRENT_TIER = 'starter';
const EXPECTED_RECOMMENDED_TIER = 'enterprise';
// Synthetic recommendation snapshot stamped into the Stripe session
// metadata. Numbers are arbitrary but match the shape the BillingEstimator
// banner would attribute.
const FIXTURE_MONTHLY_SAVINGS_CENTS = 12_345;
const FIXTURE_TRAILING_WINDOW_MONTHS = 3 as const;
const FIXTURE_PITCH = 'tier-switch' as const;

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
  subscriptionSnapshot: SubscriptionSnapshot | null;
  stripeEventId: string;
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
  const fixtureEmail = `billing-rec-stripe-webhook-http-e2e-${runId}@voiceaihub.dev`;
  const stripeEventId = `evt_e2e_stripe_webhook_http_${runId}`;
  const passwordHash = await bcrypt.hash(FIXTURE_PASSWORD, 12);

  const fixtureUserId = await upsertFixtureUser(pool, {
    tenantId: ADMIN_TENANT_ID,
    email: fixtureEmail,
    passwordHash,
    role: 'tenant_owner',
  });

  const subscriptionSnapshot = await snapshotAndForceStarter(pool);

  return {
    runId,
    fixtureEmail,
    fixtureUserId,
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

/**
 * Count of switch_completed rows for a (tenant, stripeSessionId) pair.
 * Used by the duplicate-delivery assertion below to prove that a second
 * POST of the same signed event id does NOT cause a second
 * billing_recommendation_events INSERT.
 *
 * The webhook handler relies on `isEventProcessed` (a SELECT against
 * `billing_events` keyed on `stripe_event_id`) to short-circuit the
 * second pass before it ever reaches handleCheckoutCompleted. If that
 * check is moved/removed/bypassed, or the unique constraint that backs
 * `billing_events.stripe_event_id` is dropped, this count will jump
 * from 1 to 2 and fail the spec.
 */
async function countSwitchCompletedRows(
  pool: pg.Pool,
  tenantId: string,
  stripeSessionId: string,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL row_security = off');
    const { rows } = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM billing_recommendation_events
        WHERE tenant_id = $1
          AND event_type = 'switch_completed'
          AND metadata->>'stripeSessionId' = $2`,
      [tenantId, stripeSessionId],
    );
    await client.query('COMMIT');
    return Number(rows[0]?.count ?? 0);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

interface PostResponse {
  status: number;
  body: string;
  parsed: Record<string, unknown> | null;
}

async function postWebhook(args: {
  body: string;
  signature: string | null;
}): Promise<PostResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (args.signature !== null) headers['Stripe-Signature'] = args.signature;

  let res: Response;
  try {
    res = await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers,
      body: args.body,
    });
  } catch (err) {
    throw new Error(
      `POST ${WEBHOOK_URL} failed at the network layer: ${(err as Error).message}. ` +
        `Is the admin-api up on ${ADMIN_API_BASE_URL}?`,
    );
  }
  const text = await res.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, body: text, parsed };
}

async function run(): Promise<void> {
  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET || !STRIPE_PRICE_ENTERPRISE_MONTHLY) {
    console.log(
      `[e2e] SKIP: ${SPEC_NAME} requires STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and STRIPE_PRICE_ENTERPRISE_MONTHLY.`,
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
  let seedData: SeedResult | undefined;
  let createdSessionId: string | null = null;

  try {
    seedData = await seed(pool);
    console.log(`[e2e] seeded fixture user=${seedData.fixtureEmail} runId=${seedData.runId}`);

    // ─────────────────────────────────────────────────────────────────
    // Negative #1: missing stripe-signature header → 400.
    // Pre-flight check that exercises ROUTE MOUNTING + the
    // missing-header guard. A 404 here means the webhook route is no
    // longer mounted at /billing/stripe-webhook (or the path moved); a
    // 200 means the route lost its signature guard entirely.
    // ─────────────────────────────────────────────────────────────────
    const probeBody = JSON.stringify({ id: 'evt_probe', type: 'checkout.session.completed' });
    const missing = await postWebhook({ body: probeBody, signature: null });
    assert(
      missing.status === 400,
      `WEBHOOK ROUTE MOUNTING REGRESSION: POST ${WEBHOOK_URL} (no signature) returned ${missing.status}, expected 400. ` +
        `Body: ${missing.body}. ` +
        `If 404, the route is unmounted or the path changed. ` +
        `If 200, the missing-header guard at server/admin-api/routes/billing.ts was removed.`,
    );
    assert(
      missing.parsed?.error === 'Missing stripe-signature header',
      `WEBHOOK ROUTE RESPONSE SHAPE REGRESSION: expected { error: 'Missing stripe-signature header' }, got ${missing.body}`,
    );
    console.log('[e2e] PASS missing-signature guard returns 400');

    // ─────────────────────────────────────────────────────────────────
    // Negative #2: bogus signature → 400. Exercises SIGNATURE
    // VERIFICATION (and, indirectly, the express.raw() middleware: if
    // the body arrives as a parsed object instead of a Buffer,
    // constructEvent throws a different error path).
    // ─────────────────────────────────────────────────────────────────
    const bogus = await postWebhook({
      body: probeBody,
      signature: 't=1,v1=this-is-not-a-valid-signature',
    });
    assert(
      bogus.status === 400,
      `STRIPE SIGNATURE VERIFICATION REGRESSION: POST with bogus signature returned ${bogus.status}, expected 400. ` +
        `Body: ${bogus.body}. ` +
        `If 200, signature verification was bypassed. ` +
        `If 500, the raw-body middleware may be missing on the webhook route (constructEvent expected a Buffer).`,
    );
    assert(
      bogus.parsed?.error === 'Invalid webhook signature',
      `WEBHOOK ROUTE RESPONSE SHAPE REGRESSION: expected { error: 'Invalid webhook signature' }, got ${bogus.body}`,
    );
    console.log('[e2e] PASS bogus-signature guard returns 400');

    // ─────────────────────────────────────────────────────────────────
    // Positive: valid signature → 200 + the same billing_recommendation_events
    // row the in-process spec asserts.
    //
    // Reuses the production createCheckoutSession() helper so the Stripe
    // session this spec POSTs back through the webhook carries the same
    // metadata shape a real banner-attributed checkout would, including
    // recommendationCurrentTier / recommendationRecommendedTier /
    // recommendationMonthlySavingsCents / recommendationTrailingWindowMonths.
    // ─────────────────────────────────────────────────────────────────
    const created = await createCheckoutSession({
      tenantId: ADMIN_TENANT_ID,
      plan: EXPECTED_RECOMMENDED_TIER,
      interval: 'monthly',
      successUrl: 'http://localhost:5000/billing?checkout=success',
      cancelUrl: 'http://localhost:5000/billing?checkout=cancel',
      customerEmail: seedData.fixtureEmail,
      recommendation: {
        currentTier: EXPECTED_CURRENT_TIER,
        recommendedTier: EXPECTED_RECOMMENDED_TIER,
        monthlySavingsCents: FIXTURE_MONTHLY_SAVINGS_CENTS,
        trailingWindowMonths: FIXTURE_TRAILING_WINDOW_MONTHS,
        pitch: FIXTURE_PITCH,
      },
    });
    createdSessionId = created.sessionId;
    console.log(`[e2e] created Stripe session ${createdSessionId}`);

    const session = await stripe.checkout.sessions.retrieve(createdSessionId);
    assert(
      session.livemode === false,
      `refusing to proceed: retrieved session is livemode=true (id=${createdSessionId})`,
    );

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
    };
    const eventBody = JSON.stringify(completedEvent);

    // generateTestHeaderString re-derives the v1 HMAC the same way
    // Stripe's own delivery layer would, so the constructEvent call
    // inside the webhook route gets a header it accepts.
    const signature = stripe.webhooks.generateTestHeaderString({
      payload: eventBody,
      secret: STRIPE_WEBHOOK_SECRET,
    });

    const ok = await postWebhook({ body: eventBody, signature });
    assert(
      ok.status === 200,
      `STRIPE WEBHOOK HANDLER REGRESSION: POST with valid signature returned ${ok.status}, expected 200. ` +
        `Body: ${ok.body}. ` +
        `If 400, signature verification rejected a payload the SDK just signed — most likely STRIPE_WEBHOOK_SECRET in the dev stack does not match the secret the spec used. ` +
        `If 500, handleStripeEvent threw after passing verification — check admin-api logs for 'Stripe webhook handler failed'.`,
    );
    assert(
      ok.parsed?.received === true,
      `WEBHOOK ROUTE RESPONSE SHAPE REGRESSION: expected { received: true }, got ${ok.body}`,
    );

    // The route returned 200, so signature + dispatch passed. Now
    // assert the same row-shape the in-process spec asserts so a
    // regression in handleCheckoutCompleted's billing_recommendation_events
    // INSERT still fails the spec.
    //
    // The handler reads from the DB on its own connection inside a tx
    // (withTenant) and the route only responds AFTER that tx commits,
    // so a SELECT here against the same DB sees the row immediately.
    const switchRow = await readSwitchCompletedRow(pool, ADMIN_TENANT_ID, createdSessionId);
    assert(
      switchRow,
      `WEBHOOK DISPATCH REGRESSION: route returned 200 but no switch_completed row was written for sessionId=${createdSessionId}. ` +
        `handleStripeEvent / handleCheckoutCompleted ran without error but did not INSERT into billing_recommendation_events. ` +
        `Check admin-api logs around stripeEventId=${seedData.stripeEventId} for 'Failed to record recommendation switch_completed event'.`,
    );
    assert(
      switchRow.current_tier === EXPECTED_CURRENT_TIER &&
        switchRow.recommended_tier === EXPECTED_RECOMMENDED_TIER,
      `WEBHOOK DB-WRITE REGRESSION: switch_completed tier mismatch: ${JSON.stringify(switchRow)}`,
    );
    assert(
      Number(switchRow.monthly_savings_cents) === FIXTURE_MONTHLY_SAVINGS_CENTS,
      `WEBHOOK DB-WRITE REGRESSION: switch_completed monthly_savings_cents should equal ${FIXTURE_MONTHLY_SAVINGS_CENTS}, got ${switchRow.monthly_savings_cents}`,
    );
    assert(
      switchRow.trailing_window_months === FIXTURE_TRAILING_WINDOW_MONTHS,
      `WEBHOOK DB-WRITE REGRESSION: switch_completed trailing_window_months should equal ${FIXTURE_TRAILING_WINDOW_MONTHS}, got ${switchRow.trailing_window_months}`,
    );
    const meta = switchRow.metadata as { source?: string; stripeSessionId?: string; stripeEventId?: string };
    assert(
      meta.source === 'stripe_webhook',
      `WEBHOOK DB-WRITE REGRESSION: switch_completed metadata.source should be 'stripe_webhook', got ${JSON.stringify(switchRow.metadata)}`,
    );
    assert(
      meta.stripeSessionId === createdSessionId,
      `WEBHOOK DB-WRITE REGRESSION: switch_completed metadata.stripeSessionId should be '${createdSessionId}', got ${meta.stripeSessionId}`,
    );
    assert(
      meta.stripeEventId === seedData.stripeEventId,
      `WEBHOOK DB-WRITE REGRESSION: switch_completed metadata.stripeEventId should be '${seedData.stripeEventId}', got ${meta.stripeEventId}`,
    );

    console.log('[e2e] PASS valid-signature webhook wrote billing_recommendation_events row');

    // ─────────────────────────────────────────────────────────────────
    // Duplicate-delivery / idempotency probe.
    //
    // Stripe legitimately retries the same event id when its first
    // delivery times out (or when the webhook endpoint returns a non-2xx
    // for any reason). Our handler relies on `isEventProcessed` — a
    // SELECT against `billing_events` keyed on `stripe_event_id` — to
    // short-circuit the second pass BEFORE it reaches
    // handleCheckoutCompleted, so the second delivery must:
    //   1. Still return 200 + { received: true } (so Stripe stops
    //      retrying), and
    //   2. NOT write a second `billing_recommendation_events` row.
    //
    // The base spec above only POSTs once, so it cannot catch a
    // dedup regression — e.g. someone moving the `isEventProcessed`
    // check to AFTER the INSERT, dropping the unique constraint that
    // backs `billing_events.stripe_event_id`, or short-circuiting on
    // the wrong key. Re-POSTing the same signed payload here exercises
    // the retry path end-to-end (signature verification + dedup +
    // dispatch + DB) and asserts the row count stays at exactly 1 for
    // this stripeSessionId.
    //
    // The signature stays valid on the second POST because Stripe's v1
    // signature is over (timestamp + body), not over (event id +
    // delivery attempt) — so the SDK's verify path can't tell the two
    // POSTs apart. Dedup MUST come from our application layer, which
    // is what this assertion guards.
    // ─────────────────────────────────────────────────────────────────
    const okDup = await postWebhook({ body: eventBody, signature });
    assert(
      okDup.status === 200,
      `STRIPE WEBHOOK DUPLICATE-DELIVERY REGRESSION: second POST of the same event id (${seedData.stripeEventId}) returned ${okDup.status}, expected 200. ` +
        `Body: ${okDup.body}. ` +
        `Stripe retries the same event id on timeouts/non-2xx — a non-200 here would put us into a retry storm. ` +
        `If 400, signature verification rejected the replay (it shouldn't — same body, same secret). ` +
        `If 500, handleStripeEvent threw on the dedup path — check admin-api logs around stripeEventId=${seedData.stripeEventId}.`,
    );
    assert(
      okDup.parsed?.received === true,
      `WEBHOOK ROUTE RESPONSE SHAPE REGRESSION on duplicate delivery: expected { received: true }, got ${okDup.body}`,
    );

    const switchRowCount = await countSwitchCompletedRows(
      pool,
      ADMIN_TENANT_ID,
      createdSessionId,
    );
    assert(
      switchRowCount === 1,
      `STRIPE WEBHOOK IDEMPOTENCY REGRESSION: expected exactly 1 switch_completed row for stripeSessionId=${createdSessionId} after the duplicate POST, got ${switchRowCount}. ` +
        `This means handleCheckoutCompleted ran twice for the same Stripe event id (${seedData.stripeEventId}). ` +
        `Check that:\n` +
        `  1. handleStripeEvent still calls isEventProcessed BEFORE dispatching to handleCheckoutCompleted (platform/billing/stripe/webhook.ts).\n` +
        `  2. isEventProcessed reads from billing_events keyed on stripe_event_id (not a stale column).\n` +
        `  3. billing_events.stripe_event_id still has its UNIQUE constraint (a missing constraint lets appendBillingEvent insert a second row, after which isEventProcessed on the next retry would still see only the first — so the regression manifests as a doubled billing_recommendation_events row, exactly what this asserts).`,
    );
    console.log(
      `[e2e] PASS duplicate-delivery dedup: second POST returned 200 and switch_completed row count stayed at ${switchRowCount}`,
    );

    console.log('[e2e] PASS');
  } finally {
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
