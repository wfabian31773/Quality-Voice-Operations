/**
 * Task #1473 — End-to-end regression for the Billing Subscription card
 * chip block when the tenant has TWO active discounts stacked at the
 * customer + subscription level, driven by a REAL Stripe test customer
 * + subscription (no API route mocks).
 *
 * Companion to `tests/e2e/billingSubscriptionStackedDiscounts.spec.ts`,
 * which fulfils `/api/billing/subscription` from in-test fixtures.
 * That spec catches client-side regressions but, by stubbing the API
 * response, it bypasses both the customer-level and subscription-
 * level discount loaders AND the `pushIfFresh` de-dup loop that
 * merges them in `server/admin-api/routes/billing.ts`:
 *
 *   - `loadActiveCustomerDiscount` resolves the customer-level coupon.
 *   - `loadActiveSubscriptionDiscounts` resolves every entry on
 *      `subscription.discounts[]`.
 *   - The `pushIfFresh` loop concatenates them, de-duping by coupon /
 *      promotion-code id so a coupon attached to BOTH surfaces only
 *      renders once. A regression that drops the merge, dedupes
 *      differently, or fails one of the two loaders would slip past
 *      the mocked spec because the renderer is fed the expected
 *      shape directly.
 *
 * This spec drives the FULL server → API → UI badge path against a
 * dedicated Stripe test-mode customer with a customer-level coupon
 * and a real subscription carrying a second subscription-level coupon
 * so the regression surfaces here with a real failing badge count.
 *
 * Skips cleanly (matching the other Stripe-dependent specs) when
 * STRIPE_SECRET_KEY or STRIPE_PRICE_STARTER_MONTHLY are absent.
 *
 * Run:  npm run test:e2e:billing-subscription-stacked-discounts-stripe
 *
 * Pre-requisites:
 *   - Platform Dev workflow is running (admin API on :3002, vite on :5000).
 *   - Playwright browsers installed: `npx playwright install chromium`.
 *   - STRIPE_SECRET_KEY set to a test-mode key (sk_test_…).
 *   - STRIPE_PRICE_STARTER_MONTHLY set so we can mint a real subscription.
 *
 * Env vars:
 *   STRIPE_SECRET_KEY              required (must be a test-mode key)
 *   STRIPE_PRICE_STARTER_MONTHLY   required (real Stripe price id)
 *   E2E_BASE_URL                   default http://localhost:5000
 *   E2E_ARTIFACT_DIR               default .ci-logs/screenshots
 *   DATABASE_URL / PLATFORM_DB_POOL_URL — must point at the same DB
 *                                  as the running Platform Dev workflow.
 */
import { chromium, type Browser, type Page } from 'playwright';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import path from 'path';
import Stripe from 'stripe';
import {
  loadActiveCustomerDiscount,
  loadActiveSubscriptionDiscounts,
} from '../../platform/billing/stripe/effectiveRate';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'billing-subscription-stacked-discounts-stripe';
const STRIPE_API_VERSION = '2026-02-25.clover' as const;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRICE_STARTER_MONTHLY = process.env.STRIPE_PRICE_STARTER_MONTHLY;

const ADMIN_TENANT_ID = 'admin-org';
const FIXTURE_PASSWORD = 'test-password-123';
const CUSTOMER_PERCENT_OFF = 25;
const SUBSCRIPTION_AMOUNT_OFF_CENTS = 500; // $5.00 off

// Plural tooltip emitted by Billing.tsx when `list.length > 1`. Kept
// in lock-step with the source string so a copy drift fails the spec
// instead of silently passing.
const MULTI_DISCOUNT_TOOLTIP =
  '2 discounts are stacked on your subscription. Each is shown on Stripe Checkout and on every invoice it applies to.';

// Mirrors platform/db/index.ts:getPoolUrl — dev prefers DATABASE_URL,
// the rest of the world prefers PLATFORM_DB_POOL_URL. The spec must
// seed against the same DB the dev workflow is talking to.
const DB_URL = (() => {
  const env = process.env.APP_ENV ?? 'development';
  return env === 'development'
    ? (process.env.DATABASE_URL ?? process.env.PLATFORM_DB_POOL_URL ?? '')
    : (process.env.PLATFORM_DB_POOL_URL ?? process.env.DATABASE_URL ?? '');
})();

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
  customerCouponId: string;
  customerCouponName: string;
  subscriptionCouponId: string;
  subscriptionCouponName: string;
  customerId: string;
  subscriptionId: string;
  subscriptionSnapshot: SubscriptionSnapshot | null;
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

async function snapshotSubscription(pool: pg.Pool): Promise<SubscriptionSnapshot | null> {
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
  if (!raw) return null;
  return {
    ...raw,
    current_period_start: raw.current_period_start
      ? new Date(raw.current_period_start).toISOString()
      : null,
    current_period_end: raw.current_period_end
      ? new Date(raw.current_period_end).toISOString()
      : null,
  };
}

async function upsertSubscriptionRow(
  pool: pg.Pool,
  customerId: string,
  subscriptionId: string,
  priceId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO subscriptions (tenant_id, plan, status, billing_interval,
                                stripe_customer_id, stripe_subscription_id, stripe_price_id,
                                monthly_call_limit, monthly_sms_limit, monthly_ai_minute_limit,
                                overage_enabled)
     VALUES ($1, 'starter', 'active'::subscription_status, 'monthly'::billing_interval,
             $2, $3, $4,
             500, 1000, 250, false)
     ON CONFLICT (tenant_id) DO UPDATE SET
       stripe_customer_id = EXCLUDED.stripe_customer_id,
       stripe_subscription_id = EXCLUDED.stripe_subscription_id,
       stripe_price_id = EXCLUDED.stripe_price_id,
       updated_at = NOW()`,
    [ADMIN_TENANT_ID, customerId, subscriptionId, priceId],
  );
}

async function restoreSubscription(
  pool: pg.Pool,
  snapshot: SubscriptionSnapshot | null,
): Promise<void> {
  if (!snapshot) {
    await pool
      .query(`DELETE FROM subscriptions WHERE tenant_id = $1`, [ADMIN_TENANT_ID])
      .catch((err) => console.warn('[e2e] cleanup subscription delete failed:', err));
    return;
  }
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
        ADMIN_TENANT_ID,
        snapshot.plan,
        snapshot.status,
        snapshot.billing_interval,
        snapshot.stripe_customer_id,
        snapshot.stripe_subscription_id,
        snapshot.stripe_price_id,
        snapshot.monthly_call_limit,
        snapshot.monthly_sms_limit,
        snapshot.monthly_ai_minute_limit,
        snapshot.overage_enabled,
        snapshot.current_period_start,
        snapshot.current_period_end,
      ],
    )
    .catch((err) => console.warn('[e2e] cleanup subscription restore failed:', err));
}

async function seedFixtureUser(
  pool: pg.Pool,
  runId: string,
): Promise<{ email: string; userId: string }> {
  const fixtureEmail = `billing-sub-stack-stripe-e2e-${runId}@voiceaihub.dev`;
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

  await pool.query(
    `INSERT INTO user_roles (user_id, tenant_id, role)
     VALUES ($1, $2, 'tenant_owner')
     ON CONFLICT (user_id, tenant_id, role) DO NOTHING`,
    [fixtureUserId, ADMIN_TENANT_ID],
  );

  return { email: fixtureEmail, userId: fixtureUserId };
}

async function softDeleteUser(
  pool: pg.Pool,
  userId: string,
  originalEmail: string,
): Promise<void> {
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

/**
 * Tracker for partially-created Stripe resources. Populated as each
 * resource is created inside `seed()` so the surrounding cleanup can
 * tear down whatever made it across the line — even when `seed()`
 * itself throws halfway through (e.g. a Stripe-side validation error
 * on the subscription create after the coupons and customer have
 * already been created).
 */
interface PartialSeed {
  runId: string;
  fixtureEmail?: string;
  fixtureUserId?: string;
  customerCouponId?: string;
  subscriptionCouponId?: string;
  customerId?: string;
  subscriptionId?: string;
  subscriptionSnapshot?: SubscriptionSnapshot | null;
}

async function seed(
  pool: pg.Pool,
  stripe: Stripe,
  partial: PartialSeed,
): Promise<SeedResult> {
  const { runId } = partial;
  const customerCouponName = `E2E Sub Stack Cust ${runId}`;
  const subscriptionCouponName = `E2E Sub Stack Sub ${runId}`;

  const { email: fixtureEmail, userId: fixtureUserId } = await seedFixtureUser(
    pool,
    runId.toLowerCase(),
  );
  partial.fixtureEmail = fixtureEmail;
  partial.fixtureUserId = fixtureUserId;

  // 1. Two coupons — one percent_off (customer-level), one amount_off
  //    (subscription-level) so the two badges render visibly distinct
  //    copy ("25% off — …" vs "$5.00 off — …") and a regression that
  //    collapses them into a single chip is easy to spot.
  const customerCoupon = await stripe.coupons.create({
    percent_off: CUSTOMER_PERCENT_OFF,
    duration: 'forever',
    name: customerCouponName,
    metadata: { e2e: SPEC_NAME, runId, role: 'customer' },
  });
  partial.customerCouponId = customerCoupon.id;

  const subscriptionCoupon = await stripe.coupons.create({
    amount_off: SUBSCRIPTION_AMOUNT_OFF_CENTS,
    currency: 'usd',
    duration: 'once',
    name: subscriptionCouponName,
    metadata: { e2e: SPEC_NAME, runId, role: 'subscription' },
  });
  partial.subscriptionCouponId = subscriptionCoupon.id;

  // 2. Customer.
  const customer = await stripe.customers.create({
    email: `e2e-billing-sub-stack-${runId.toLowerCase()}@voiceaihub.dev`,
    description: `E2E ${SPEC_NAME} runId=${runId}`,
    metadata: { e2e: SPEC_NAME, runId, tenantId: ADMIN_TENANT_ID },
  });
  partial.customerId = customer.id;

  // 3. Apply the customer coupon at the CUSTOMER level so
  //    `/billing/subscription` surfaces the chip via
  //    `loadActiveCustomerDiscount` — the same server path production
  //    uses. Stripe removed the `coupon` parameter from /v1/customers
  //    in API version `2025-04-30.basil`; pin this one write to an
  //    older version via `Stripe-Version` so the legacy field is still
  //    honored. (Mirrors billingDiscountBadgeStripe.spec.ts.)
  const APPLY_COUPON_API_VERSION = '2025-01-27.acacia';
  const applyCouponResp = await fetch(
    `https://api.stripe.com/v1/customers/${customer.id}`,
    {
      method: 'POST',
      headers: {
        Authorization:
          'Basic ' + Buffer.from(`${STRIPE_SECRET_KEY}:`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': APPLY_COUPON_API_VERSION,
      },
      body: `coupon=${encodeURIComponent(customerCoupon.id)}`,
    },
  );
  if (!applyCouponResp.ok) {
    const errBody = await applyCouponResp.text();
    throw new Error(
      `Failed to apply coupon to customer (status ${applyCouponResp.status}): ${errBody}`,
    );
  }

  // 4. Subscription with the OTHER coupon attached via the modern
  //    `discounts: [{ coupon }]` shape so `loadActiveSubscriptionDiscounts`
  //    surfaces it. `collection_method: 'send_invoice'` lets us create
  //    a real subscription against the test-mode account WITHOUT
  //    requiring a PaymentMethod — Stripe just emails an invoice
  //    instead of trying to charge a card. The subscription becomes
  //    `active` immediately.
  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: STRIPE_PRICE_STARTER_MONTHLY! }],
    discounts: [{ coupon: subscriptionCoupon.id }],
    collection_method: 'send_invoice',
    days_until_due: 30,
    metadata: { e2e: SPEC_NAME, runId, tenantId: ADMIN_TENANT_ID },
  });
  partial.subscriptionId = subscription.id;

  // 5. Drive both lookups the /billing/subscription handler uses so a
  //    shape drift between the writes (older API for customer.coupon,
  //    pinned API for subscription.discounts) and the reads fails here,
  //    not as a slow Playwright timeout further down.
  const customerProbe = await loadActiveCustomerDiscount(stripe, customer.id, {
    tenantId: ADMIN_TENANT_ID,
    surface: 'e2e_probe',
  });
  if (!customerProbe) {
    throw new Error(
      `loadActiveCustomerDiscount returned null for customer ${customer.id}; production code path will not surface a customer-level chip`,
    );
  }
  if (customerProbe.percentOff !== CUSTOMER_PERCENT_OFF) {
    throw new Error(
      `loadActiveCustomerDiscount surfaced an unexpected percent_off (${customerProbe.percentOff}); expected ${CUSTOMER_PERCENT_OFF}`,
    );
  }

  const subscriptionProbe = await loadActiveSubscriptionDiscounts(
    stripe,
    subscription.id,
    { tenantId: ADMIN_TENANT_ID, surface: 'e2e_probe' },
  );
  if (subscriptionProbe.length < 1) {
    throw new Error(
      `loadActiveSubscriptionDiscounts returned [] for subscription ${subscription.id}; production code path will not surface a subscription-level chip`,
    );
  }
  if (subscriptionProbe[0]!.amountOffCents !== SUBSCRIPTION_AMOUNT_OFF_CENTS) {
    throw new Error(
      `loadActiveSubscriptionDiscounts surfaced an unexpected amount_off (${subscriptionProbe[0]!.amountOffCents}); expected ${SUBSCRIPTION_AMOUNT_OFF_CENTS}`,
    );
  }

  // 6. Snapshot the existing subscription row BEFORE we overwrite it so
  //    cleanup can restore whatever the admin tenant had.
  const subscriptionSnapshot = await snapshotSubscription(pool);
  partial.subscriptionSnapshot = subscriptionSnapshot;
  await upsertSubscriptionRow(
    pool,
    customer.id,
    subscription.id,
    STRIPE_PRICE_STARTER_MONTHLY!,
  );

  return {
    runId,
    fixtureEmail,
    fixtureUserId,
    customerCouponId: customerCoupon.id,
    customerCouponName,
    subscriptionCouponId: subscriptionCoupon.id,
    subscriptionCouponName,
    customerId: customer.id,
    subscriptionId: subscription.id,
    subscriptionSnapshot,
  };
}

async function cleanup(
  pool: pg.Pool,
  stripe: Stripe,
  partial: PartialSeed,
): Promise<void> {
  // Restore the local DB row only when seed() actually overwrote it
  // (`subscriptionSnapshot` is set as the very last step before that
  // write). Skipping restore on an earlier-stage failure leaves the
  // DB untouched, which is the safe default.
  if (partial.subscriptionSnapshot !== undefined) {
    await restoreSubscription(pool, partial.subscriptionSnapshot);
  }

  // Cancel the subscription before deleting the customer so we don't
  // leave a dangling row on the test account.
  if (partial.subscriptionId) {
    await stripe.subscriptions
      .cancel(partial.subscriptionId, { invoice_now: false, prorate: false })
      .catch((err) =>
        console.warn(
          `[e2e] cleanup subscription cancel failed (${partial.subscriptionId}):`,
          (err as Error).message,
        ),
      );
  }

  if (partial.customerId) {
    await stripe.customers
      .del(partial.customerId)
      .catch((err) =>
        console.warn(
          `[e2e] cleanup customer delete failed (${partial.customerId}):`,
          (err as Error).message,
        ),
      );
  }

  for (const couponId of [partial.customerCouponId, partial.subscriptionCouponId]) {
    if (!couponId) continue;
    await stripe.coupons
      .del(couponId)
      .catch((err) =>
        console.warn(
          `[e2e] cleanup coupon delete failed (${couponId}):`,
          (err as Error).message,
        ),
      );
  }

  if (partial.fixtureUserId && partial.fixtureEmail) {
    await softDeleteUser(pool, partial.fixtureUserId, partial.fixtureEmail);
  }
}

async function run(): Promise<void> {
  if (!STRIPE_SECRET_KEY) {
    console.log(`[e2e] SKIP: ${SPEC_NAME} requires STRIPE_SECRET_KEY (test-mode key).`);
    return;
  }
  if (!STRIPE_PRICE_STARTER_MONTHLY) {
    console.log(
      `[e2e] SKIP: ${SPEC_NAME} requires STRIPE_PRICE_STARTER_MONTHLY to seed a real subscription.`,
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
  let page: Page | undefined;

  // Allocated up-front so even a mid-seed failure has a place to
  // record what was created (coupons, customer, etc) — cleanup walks
  // this object and tears down whatever it finds.
  const partial: PartialSeed = {
    runId: randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase(),
  };
  let seedData: SeedResult | undefined;

  try {
    seedData = await seed(pool, stripe, partial);
    console.log(
      `[e2e] seeded fixture user=${seedData.fixtureEmail} customer=${seedData.customerId} `
      + `subscription=${seedData.subscriptionId} coupons=${seedData.customerCouponId},${seedData.subscriptionCouponId} `
      + `runId=${seedData.runId}`,
    );

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();

    // NO API mocks here — the whole point of this spec is to exercise
    // the live server discount-loading paths.
    await login(page, seedData.fixtureEmail, FIXTURE_PASSWORD);
    await page.goto(`${BASE_URL}/billing`, { waitUntil: 'networkidle' });

    // ---- Subscription card stacked-discount badges ------------------
    // Driven by `loadActiveCustomerDiscount` + `loadActiveSubscriptionDiscounts`
    // and the `pushIfFresh` merge loop in
    // `server/admin-api/routes/billing.ts`. Two distinct coupons (no
    // duplicates), so the dedup must yield exactly two final entries.
    const subBadges = page.locator('[data-testid="billing-subscription-discount-badge"]');
    await subBadges.first().waitFor({ state: 'visible', timeout: 30_000 });
    const subBadgeCount = await subBadges.count();
    assert(
      subBadgeCount === 2,
      `expected exactly two subscription discount badges (one per stacked customer/subscription coupon), got ${subBadgeCount}`,
    );

    // Each chip should carry the plural tooltip when the rendered list
    // has more than one entry. A regression that drops the merge would
    // also drop the plural tooltip, so this is a defence-in-depth
    // signal alongside the count assertion.
    for (let i = 0; i < subBadgeCount; i += 1) {
      const titleAttr = await subBadges.nth(i).getAttribute('title');
      assert(
        titleAttr === MULTI_DISCOUNT_TOOLTIP,
        `subscription discount badge #${i} should carry the multi-discount tooltip, got: ${JSON.stringify(titleAttr)}`,
      );
    }

    const allBadgeText = (
      await Promise.all(
        Array.from({ length: subBadgeCount }, (_, i) =>
          subBadges.nth(i).innerText(),
        ),
      )
    )
      .map((t) => t.trim())
      .join(' || ');

    // Don't pin which chip lands first — the route concatenates
    // customer-level then subscription-level via `pushIfFresh`, but a
    // future reorder shouldn't false-fail the spec. Match per-coupon
    // copy across the union of all rendered chip texts. The unique
    // runId in each coupon name proves the badges are being driven by
    // THIS run's seeded coupons — not stale leftovers on admin-org.
    assert(
      /Active discount:/i.test(allBadgeText),
      `subscription discount badges should include 'Active discount:' label, got: ${JSON.stringify(allBadgeText)}`,
    );
    assert(
      new RegExp(`${CUSTOMER_PERCENT_OFF}% off`, 'i').test(allBadgeText),
      `subscription discount badges should include '${CUSTOMER_PERCENT_OFF}% off' (customer-level coupon), got: ${JSON.stringify(allBadgeText)}`,
    );
    assert(
      allBadgeText.includes(seedData.customerCouponName),
      `subscription discount badges should include this run's customer-coupon name `
      + `'${seedData.customerCouponName}', got: ${JSON.stringify(allBadgeText)}`,
    );
    // formatDiscountLabel renders 500 cents USD as "$5.00 off" and
    // appends the coupon name when no promotion_code is present.
    assert(
      /\$5\.00 off/i.test(allBadgeText),
      `subscription discount badges should include '$5.00 off' (subscription-level coupon), got: ${JSON.stringify(allBadgeText)}`,
    );
    assert(
      allBadgeText.includes(seedData.subscriptionCouponName),
      `subscription discount badges should include this run's subscription-coupon name `
      + `'${seedData.subscriptionCouponName}', got: ${JSON.stringify(allBadgeText)}`,
    );

    console.log(`[e2e] ${SPEC_NAME}: PASS`);
  } catch (err) {
    console.error(`[e2e] ${SPEC_NAME}: FAIL — ${(err as Error).message}`);
    await captureFailureScreenshot(page);
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
    await cleanup(pool, stripe, partial).catch((err) =>
      console.warn(`[e2e] cleanup failed for runId=${partial.runId}:`, err),
    );
    await pool.end().catch(() => {});
  }
}

run().catch((err) => {
  console.error(`[e2e] ${SPEC_NAME}: unhandled — ${(err as Error).message}`);
  process.exitCode = 1;
});
