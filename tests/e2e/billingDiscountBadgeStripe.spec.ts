/**
 * Task #1353 — End-to-end regression for the Billing page discount
 * badges driven by a REAL Stripe test customer + coupon + invoice
 * (no API route mocks).
 *
 * Companion to `tests/e2e/billingDiscountBadge.spec.ts`, which fulfils
 * `/api/billing/subscription` and `/api/billing/invoices` from in-test
 * fixtures. That spec catches client-side regressions but, by stubbing
 * the API responses, it bypasses the server's discount-loading code
 * paths entirely:
 *
 *   - `loadActiveCustomerDiscount` (platform/billing/stripe/effectiveRate.ts)
 *     wired into `GET /billing/subscription` for the customer-level
 *     coupon chip.
 *   - `stripe.invoices.list({ expand: ['data.discounts', ...] })` and
 *     the `normalizeDiscount` mapping wired into `GET /billing/invoices`
 *     for the per-invoice chip.
 *
 * This spec drives the FULL server → API → UI badge path against a
 * dedicated Stripe test-mode customer so a regression in either of
 * those server paths (e.g. a renamed expand key, a dropped discount
 * field, a normaliser drift) surfaces here with a real failing badge
 * — not as a passing mocked spec.
 *
 * Skips cleanly (matching the other Stripe-dependent specs) when
 * STRIPE_SECRET_KEY is absent.
 *
 * Run:  npm run test:e2e:billing-discount-badge-stripe
 *
 * Pre-requisites:
 *   - Platform Dev workflow is running (admin API on :3002, vite on :5000).
 *   - Playwright browsers installed: `npx playwright install chromium`.
 *   - STRIPE_SECRET_KEY set to a test-mode key (sk_test_…).
 *
 * Env vars:
 *   STRIPE_SECRET_KEY   required (must be a test-mode key)
 *   E2E_BASE_URL        default http://localhost:5000
 *   E2E_ARTIFACT_DIR    default .ci-logs/screenshots
 *   DATABASE_URL / PLATFORM_DB_POOL_URL — must point at the same DB
 *                       as the running Platform Dev workflow.
 */
import { chromium, type Browser, type Page } from 'playwright';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import path from 'path';
import Stripe from 'stripe';
import { loadActiveCustomerDiscount } from '../../platform/billing/stripe/effectiveRate';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'billing-discount-badge-stripe';
const STRIPE_API_VERSION = '2026-02-25.clover' as const;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

const ADMIN_TENANT_ID = 'admin-org';
const FIXTURE_PASSWORD = 'test-password-123';
const COUPON_PERCENT_OFF = 20;
// One-off line item amount on the invoice we'll attach the coupon to.
// Picked away from any plan price so a stray production invoice on the
// admin-org customer can't masquerade as the spec's invoice.
const INVOICE_LINE_AMOUNT_CENTS = 4_321;

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
  couponId: string;
  couponName: string;
  customerId: string;
  invoiceId: string;
  invoiceItemId: string;
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

async function upsertSubscriptionWithCustomer(
  pool: pg.Pool,
  customerId: string,
): Promise<void> {
  // Wipe stripe_subscription_id so /billing/subscription only reads the
  // customer-level discount (no surprise hits on a stale sub-id from a
  // prior run). The test asserts the customer-chip path; subscription-
  // level discounts are pinned by `billingPortalSubscriptionDiscountHeadline.spec.ts`.
  await pool.query(
    `INSERT INTO subscriptions (tenant_id, plan, status, billing_interval,
                                stripe_customer_id, stripe_subscription_id,
                                monthly_call_limit, monthly_sms_limit, monthly_ai_minute_limit,
                                overage_enabled)
     VALUES ($1, 'pro', 'active'::subscription_status, 'monthly'::billing_interval,
             $2, NULL,
             2000, 5000, 1000, false)
     ON CONFLICT (tenant_id) DO UPDATE SET
       plan = 'pro',
       status = 'active',
       billing_interval = 'monthly',
       stripe_customer_id = EXCLUDED.stripe_customer_id,
       stripe_subscription_id = NULL,
       updated_at = NOW()`,
    [ADMIN_TENANT_ID, customerId],
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

async function seedFixtureUser(pool: pg.Pool, runId: string): Promise<{ email: string; userId: string }> {
  const fixtureEmail = `billing-discount-stripe-e2e-${runId}@voiceaihub.dev`;
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
  // this row, the role returned to the client falls back to the
  // (potentially `viewer`) default and the invoice sub-tree's
  // `hasMinRole(user?.role, 'manager')` gate fails closed.
  await pool.query(
    `INSERT INTO user_roles (user_id, tenant_id, role)
     VALUES ($1, $2, 'tenant_owner')
     ON CONFLICT (user_id, tenant_id, role) DO NOTHING`,
    [fixtureUserId, ADMIN_TENANT_ID],
  );

  return { email: fixtureEmail, userId: fixtureUserId };
}

async function softDeleteUser(pool: pg.Pool, userId: string, originalEmail: string): Promise<void> {
  // Hard-DELETE blows up the SET NULL FK cascade because audit_logs is
  // append-only (prevent_audit_log_mutation trigger). Soft-delete + drop
  // user_roles instead, mirroring billingDiscountBadge.spec.ts.
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

async function seed(pool: pg.Pool, stripe: Stripe): Promise<SeedResult> {
  const runId = randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
  const couponName = `E2E Spring Promo ${runId}`;

  const { email: fixtureEmail, userId: fixtureUserId } = await seedFixtureUser(pool, runId.toLowerCase());

  // 1. Coupon — percent_off so the badge renders "20% off — <name>".
  const coupon = await stripe.coupons.create({
    percent_off: COUPON_PERCENT_OFF,
    duration: 'forever',
    name: couponName,
    metadata: { e2e: SPEC_NAME, runId },
  });

  // 2. Customer.
  const customer = await stripe.customers.create({
    email: `e2e-billing-discount-${runId.toLowerCase()}@voiceaihub.dev`,
    description: `E2E ${SPEC_NAME} runId=${runId}`,
    metadata: { e2e: SPEC_NAME, runId, tenantId: ADMIN_TENANT_ID },
  });

  // 3. Apply the coupon at the CUSTOMER level so `/billing/subscription`
  //    surfaces the chip via `loadActiveCustomerDiscount` — the same
  //    server path production uses. Stripe removed the `coupon` parameter
  //    from /v1/customers in API version `2025-04-30.basil`; pin this one
  //    write to an older version via `Stripe-Version` so the legacy
  //    field is still honored. (Mirrors billingPortalDiscountHeadline.spec.ts.)
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
      body: `coupon=${encodeURIComponent(coupon.id)}`,
    },
  );
  if (!applyCouponResp.ok) {
    const errBody = await applyCouponResp.text();
    throw new Error(
      `Failed to apply coupon to customer (status ${applyCouponResp.status}): ${errBody}`,
    );
  }

  // 4. Drive the same lookup the /billing/subscription handler uses so
  //    a shape drift between the apply (older API) and the read (pinned
  //    API) fails here, not as a slow Playwright timeout.
  const probed = await loadActiveCustomerDiscount(stripe, customer.id, {
    tenantId: ADMIN_TENANT_ID,
    surface: 'e2e_probe',
  });
  if (!probed) {
    throw new Error(
      `loadActiveCustomerDiscount returned null for customer ${customer.id}; production code path will not surface a badge`,
    );
  }
  if (probed.percentOff !== COUPON_PERCENT_OFF) {
    throw new Error(
      `loadActiveCustomerDiscount surfaced an unexpected percent_off (${probed.percentOff}); expected ${COUPON_PERCENT_OFF}`,
    );
  }

  // 5. Add a one-off invoice item and finalise an invoice with the
  //    coupon stamped on it. This proves the per-invoice badge path
  //    end-to-end: `stripe.invoices.list({ expand: ['data.discounts',
  //    'data.discounts.promotion_code'] })` -> `normalizeDiscount` ->
  //    `discounts[]` on the API response -> the `data-testid=
  //    billing-invoice-discount-badge` chip.
  const invoiceItem = await stripe.invoiceItems.create({
    customer: customer.id,
    amount: INVOICE_LINE_AMOUNT_CENTS,
    currency: 'usd',
    description: `E2E ${SPEC_NAME} line item runId=${runId}`,
  });

  // `auto_advance: false` keeps Stripe from emailing the (fake)
  // customer or auto-finalising; we explicitly finalise below so the
  // invoice transitions out of `draft` and lands in `invoices.list`.
  let invoice = await stripe.invoices.create({
    customer: customer.id,
    auto_advance: false,
    collection_method: 'send_invoice',
    days_until_due: 30,
    description: `E2E ${SPEC_NAME} invoice runId=${runId}`,
    discounts: [{ coupon: coupon.id }],
    metadata: { e2e: SPEC_NAME, runId },
  });
  assert(invoice.id, 'expected stripe.invoices.create to return an invoice id');
  invoice = await stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: false });
  // Mark paid out-of-band so the invoice surfaces in the same shape
  // (`status='paid'`, `amount_paid` populated) production renders for
  // historical receipts.
  if (invoice.status !== 'paid' && invoice.id) {
    invoice = await stripe.invoices.pay(invoice.id, { paid_out_of_band: true });
  }

  // Defence in depth: the spec depends on the invoice being visible to
  // `stripe.invoices.list({ customer })`. If anything in finalize / pay
  // dropped the discount, fail here with a clear message rather than
  // as a Playwright timeout on a missing badge.
  assert(
    Array.isArray((invoice as unknown as { discounts?: unknown[] }).discounts)
      && ((invoice as unknown as { discounts: unknown[] }).discounts.length > 0),
    `seeded invoice ${invoice.id} has no discounts attached after finalisation`,
  );

  const subscriptionSnapshot = await snapshotSubscription(pool);
  await upsertSubscriptionWithCustomer(pool, customer.id);

  return {
    runId,
    fixtureEmail,
    fixtureUserId,
    couponId: coupon.id,
    couponName,
    customerId: customer.id,
    invoiceId: invoice.id!,
    invoiceItemId: invoiceItem.id!,
    subscriptionSnapshot,
  };
}

async function cleanup(
  pool: pg.Pool,
  stripe: Stripe,
  seedData: SeedResult | undefined,
): Promise<void> {
  if (!seedData) return;

  // Restore subscription FIRST so a downstream Stripe failure doesn't
  // leave admin-org pointing at a now-deleted test customer.
  await restoreSubscription(pool, seedData.subscriptionSnapshot);

  // Void the invoice so it doesn't linger in the test-mode dashboard
  // as an "uncollectible" past-due — this is best-effort because
  // already-paid invoices can't be voided in some Stripe states; in
  // that case the customer.del below cascades it away anyway.
  await stripe.invoices
    .voidInvoice(seedData.invoiceId)
    .catch(() => undefined);

  await stripe.customers
    .del(seedData.customerId)
    .catch((err) =>
      console.warn(
        `[e2e] cleanup customer delete failed (${seedData.customerId}):`,
        (err as Error).message,
      ),
    );

  await stripe.coupons
    .del(seedData.couponId)
    .catch((err) =>
      console.warn(
        `[e2e] cleanup coupon delete failed (${seedData.couponId}):`,
        (err as Error).message,
      ),
    );

  await softDeleteUser(pool, seedData.fixtureUserId, seedData.fixtureEmail);
}

async function run(): Promise<void> {
  if (!STRIPE_SECRET_KEY) {
    console.log(`[e2e] SKIP: ${SPEC_NAME} requires STRIPE_SECRET_KEY (test-mode key).`);
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
  let seedData: SeedResult | undefined;

  try {
    seedData = await seed(pool, stripe);
    console.log(
      `[e2e] seeded fixture user=${seedData.fixtureEmail} customer=${seedData.customerId} `
      + `coupon=${seedData.couponId} invoice=${seedData.invoiceId} runId=${seedData.runId}`,
    );

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();

    // NO API mocks here — the whole point of this spec is to exercise
    // the live server discount-loading paths.
    await login(page, seedData.fixtureEmail, FIXTURE_PASSWORD);
    await page.goto(`${BASE_URL}/billing`, { waitUntil: 'networkidle' });

    // ---- Subscription card customer-discount badge ------------------
    // The chip is driven by `loadActiveCustomerDiscount` in
    // server/admin-api/routes/billing.ts. Wait for it to mount; if the
    // server path drops the discount field we'd time out here.
    const subBadge = page.locator('[data-testid="billing-subscription-discount-badge"]');
    await subBadge.first().waitFor({ state: 'visible', timeout: 30_000 });
    const subBadgeCount = await subBadge.count();
    assert(
      subBadgeCount === 1,
      `expected exactly one subscription discount badge (one customer-level coupon attached), got ${subBadgeCount}`,
    );
    const subBadgeText = (await subBadge.first().innerText()).trim();
    assert(
      /Active discount:/i.test(subBadgeText),
      `subscription discount badge should include 'Active discount:', got: ${JSON.stringify(subBadgeText)}`,
    );
    assert(
      new RegExp(`${COUPON_PERCENT_OFF}% off`, 'i').test(subBadgeText),
      `subscription discount badge should reflect '${COUPON_PERCENT_OFF}% off', got: ${JSON.stringify(subBadgeText)}`,
    );
    // The customer was attached with a bare coupon (no promotion code),
    // so `formatDiscountLabel` falls through to the coupon name. The
    // unique runId in the name is what proves the badge is being driven
    // by THIS run's seeded coupon — not a stale coupon left over on
    // admin-org from another test or an earlier failed cleanup.
    assert(
      subBadgeText.includes(seedData.couponName),
      `subscription discount badge should include this run's coupon name `
      + `'${seedData.couponName}', got: ${JSON.stringify(subBadgeText)}`,
    );

    // ---- Invoice History per-invoice discount badge -----------------
    // Driven by the `data.discounts` expansion + `normalizeDiscount`
    // mapping in `GET /billing/invoices`. The fixture invoice was
    // finalised with the coupon attached, so exactly one chip should
    // mount on its row.
    const invoiceBadges = page.locator('[data-testid="billing-invoice-discount-badge"]');
    await invoiceBadges.first().waitFor({ state: 'visible', timeout: 30_000 });
    const invoiceBadgeCount = await invoiceBadges.count();
    // The customer is brand-new for this run, so there should be
    // exactly one invoice (and therefore exactly one chip). A regression
    // that paints a chip on every invoice row regardless of discount
    // would still pass a `>= 1` check, so we pin === 1 explicitly.
    assert(
      invoiceBadgeCount === 1,
      `expected exactly one invoice discount badge (one finalised discounted invoice on the test customer), got ${invoiceBadgeCount}`,
    );
    const invoiceBadgeText = (await invoiceBadges.first().innerText()).trim();
    assert(
      new RegExp(`${COUPON_PERCENT_OFF}% off`, 'i').test(invoiceBadgeText),
      `invoice discount badge should reflect '${COUPON_PERCENT_OFF}% off', got: ${JSON.stringify(invoiceBadgeText)}`,
    );
    assert(
      invoiceBadgeText.includes(seedData.couponName),
      `invoice discount badge should include this run's coupon name `
      + `'${seedData.couponName}', got: ${JSON.stringify(invoiceBadgeText)}`,
    );

    console.log(`[e2e] ${SPEC_NAME}: PASS`);
  } catch (err) {
    console.error(`[e2e] ${SPEC_NAME}: FAIL — ${(err as Error).message}`);
    await captureFailureScreenshot(page);
    process.exitCode = 1;
  } finally {
    await browser?.close().catch(() => {});
    await cleanup(pool, stripe, seedData).catch((err) =>
      console.warn(`[e2e] cleanup failed for runId=${seedData?.runId}:`, err),
    );
    await pool.end().catch(() => {});
  }
}

run().catch((err) => {
  console.error(`[e2e] ${SPEC_NAME}: unhandled — ${(err as Error).message}`);
  process.exitCode = 1;
});
