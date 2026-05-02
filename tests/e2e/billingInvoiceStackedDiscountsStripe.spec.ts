/**
 * Task #1473 — End-to-end regression for the Billing Invoice History
 * row when a finalised invoice carries TWO stacked discounts, driven
 * by a REAL Stripe test customer + invoice (no API route mocks).
 *
 * Companion to `tests/e2e/billingInvoiceStackedDiscounts.spec.ts`,
 * which fulfils `/api/billing/invoices` from in-test fixtures. That
 * spec catches client-side regressions but, by stubbing the API
 * response, it bypasses the server's per-invoice discount expansion:
 *
 *   - `stripe.invoices.list({ expand: ['data.discounts',
 *      'data.discounts.promotion_code'] })` and the `normalizeDiscount`
 *      mapping (server/admin-api/routes/billing.ts line ~1118) that
 *      walks every entry on the invoice's `discounts[]` and pushes one
 *      normalized chip per usable coupon.
 *
 * A regression that drops the loop, swaps the expand path, or filters
 * out one of the two discounts would slip past the mocked spec because
 * the renderer is fed the expected shape directly. This spec drives
 * the FULL server → API → UI badge path against a dedicated Stripe
 * test-mode customer + finalised invoice with two stacked coupons so
 * the regression surfaces here with a real failing badge count.
 *
 * Skips cleanly (matching `billingDiscountBadgeStripe.spec.ts`) when
 * STRIPE_SECRET_KEY is absent.
 *
 * Run:  npm run test:e2e:billing-invoice-stacked-discounts-stripe
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
import { normalizeDiscount } from '../../platform/billing/stripe/effectiveRate';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'billing-invoice-stacked-discounts-stripe';
const STRIPE_API_VERSION = '2026-02-25.clover' as const;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

const ADMIN_TENANT_ID = 'admin-org';
const FIXTURE_PASSWORD = 'test-password-123';
const COUPON_PERCENT_OFF = 25;
const COUPON_AMOUNT_OFF_CENTS = 500; // $5.00 off
// One-off line item amount on the invoice we'll attach the coupons to.
// Picked away from any plan price so a stray production invoice on the
// admin-org customer can't masquerade as the spec's invoice.
const INVOICE_LINE_AMOUNT_CENTS = 7_654;

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
  percentCouponId: string;
  percentCouponName: string;
  amountCouponId: string;
  amountCouponName: string;
  customerId: string;
  invoiceId: string;
  invoiceItemId: string;
  subscriptionSnapshot: SubscriptionSnapshot | null;
}

/**
 * Tracker for partially-created Stripe + DB resources. Populated as
 * each resource is created inside `seed()` so the surrounding
 * cleanup can tear down whatever made it across the line — even when
 * `seed()` itself throws halfway through (e.g. a Stripe-side
 * validation error on `invoices.finalize` after the customer and
 * coupons were already created).
 */
interface PartialSeed {
  runId: string;
  fixtureEmail?: string;
  fixtureUserId?: string;
  percentCouponId?: string;
  amountCouponId?: string;
  customerId?: string;
  invoiceId?: string;
  subscriptionSnapshot?: SubscriptionSnapshot | null;
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
  // customer-level discount path and (since the customer here has no
  // attached coupon) ends up rendering ZERO subscription badges. That
  // keeps the stacked-invoice assertion clean and avoids muddying it
  // with subscription-card chip noise — subscription-level stacking is
  // pinned by `billingSubscriptionStackedDiscountsStripe.spec.ts`.
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

async function seedFixtureUser(
  pool: pg.Pool,
  runId: string,
): Promise<{ email: string; userId: string }> {
  const fixtureEmail = `billing-inv-stack-stripe-e2e-${runId}@voiceaihub.dev`;
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

async function softDeleteUser(
  pool: pg.Pool,
  userId: string,
  originalEmail: string,
): Promise<void> {
  // Hard-DELETE blows up the SET NULL FK cascade because audit_logs is
  // append-only (prevent_audit_log_mutation trigger). Soft-delete + drop
  // user_roles instead, mirroring billingDiscountBadgeStripe.spec.ts.
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

async function seed(
  pool: pg.Pool,
  stripe: Stripe,
  partial: PartialSeed,
): Promise<SeedResult> {
  const { runId } = partial;
  const percentCouponName = `E2E Stack Pct ${runId}`;
  const amountCouponName = `E2E Stack Amt ${runId}`;

  const { email: fixtureEmail, userId: fixtureUserId } = await seedFixtureUser(
    pool,
    runId.toLowerCase(),
  );
  partial.fixtureEmail = fixtureEmail;
  partial.fixtureUserId = fixtureUserId;

  // 1. Coupons — one percent_off, one amount_off so the two badges
  //    render visibly distinct copy ("25% off — …" vs "$5.00 off — …").
  const percentCoupon = await stripe.coupons.create({
    percent_off: COUPON_PERCENT_OFF,
    duration: 'forever',
    name: percentCouponName,
    metadata: { e2e: SPEC_NAME, runId, role: 'percent' },
  });
  partial.percentCouponId = percentCoupon.id;

  const amountCoupon = await stripe.coupons.create({
    amount_off: COUPON_AMOUNT_OFF_CENTS,
    currency: 'usd',
    duration: 'once',
    name: amountCouponName,
    metadata: { e2e: SPEC_NAME, runId, role: 'amount' },
  });
  partial.amountCouponId = amountCoupon.id;

  // 2. Customer — no attached coupon. We want both invoice chips to
  //    come EXCLUSIVELY from the stacked invoice.discounts[] expansion
  //    so a regression in the per-invoice loop fails here cleanly,
  //    not via a confounding customer.discount inheritance.
  const customer = await stripe.customers.create({
    email: `e2e-billing-inv-stack-${runId.toLowerCase()}@voiceaihub.dev`,
    description: `E2E ${SPEC_NAME} runId=${runId}`,
    metadata: { e2e: SPEC_NAME, runId, tenantId: ADMIN_TENANT_ID },
  });
  partial.customerId = customer.id;

  // 3. Add a one-off invoice item and finalise an invoice with BOTH
  //    coupons stacked on it. Proves the per-invoice badge path
  //    end-to-end against the multi-discount expansion in
  //    `GET /billing/invoices`:
  //      stripe.invoices.list({ expand: ['data.discounts', ...] })
  //      → for each raw on inv.discounts: normalizeDiscount(raw)
  //      → discounts[] on the API response
  //      → one `data-testid="billing-invoice-discount-badge"` per entry.
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
    discounts: [{ coupon: percentCoupon.id }, { coupon: amountCoupon.id }],
    metadata: { e2e: SPEC_NAME, runId },
  });
  assert(invoice.id, 'expected stripe.invoices.create to return an invoice id');
  partial.invoiceId = invoice.id;
  invoice = await stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: false });
  // Mark paid out-of-band so the invoice surfaces in the same shape
  // (`status='paid'`, `amount_paid` populated) production renders for
  // historical receipts.
  if (invoice.status !== 'paid' && invoice.id) {
    invoice = await stripe.invoices.pay(invoice.id, { paid_out_of_band: true });
  }

  // 4. Drive the same expansion the /billing/invoices handler uses so
  //    a shape drift between create/finalise and the read fails here,
  //    not as a slow Playwright timeout on missing badges. We retrieve
  //    the invoice with the SAME expand path the route uses
  //    (`data.discounts.promotion_code` is the deepest path; Stripe
  //    auto-expands the parent `data.discounts` for that to hold).
  const probedInvoice = (await stripe.invoices.retrieve(invoice.id!, {
    expand: ['discounts', 'discounts.promotion_code'],
  })) as unknown as { discounts?: unknown[] | null };
  const probedRaw = Array.isArray(probedInvoice.discounts) ? probedInvoice.discounts : [];
  const normalizedProbed = probedRaw
    .filter((raw): raw is object => typeof raw === 'object' && raw !== null)
    .map((raw) => normalizeDiscount(raw as Parameters<typeof normalizeDiscount>[0]))
    .filter((d): d is NonNullable<typeof d> => d !== null);
  if (normalizedProbed.length !== 2) {
    throw new Error(
      `expected exactly two normalized discounts on seeded invoice ${invoice.id}, got ${normalizedProbed.length}; the production /billing/invoices code path will not surface two badges`,
    );
  }

  const subscriptionSnapshot = await snapshotSubscription(pool);
  partial.subscriptionSnapshot = subscriptionSnapshot;
  await upsertSubscriptionWithCustomer(pool, customer.id);

  return {
    runId,
    fixtureEmail,
    fixtureUserId,
    percentCouponId: percentCoupon.id,
    percentCouponName,
    amountCouponId: amountCoupon.id,
    amountCouponName,
    customerId: customer.id,
    invoiceId: invoice.id!,
    invoiceItemId: invoiceItem.id!,
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

  // Void the invoice so it doesn't linger in the test-mode dashboard
  // as an "uncollectible" past-due — best-effort because already-paid
  // invoices can't be voided in some Stripe states; in that case the
  // customer.del below cascades it away anyway.
  if (partial.invoiceId) {
    await stripe.invoices
      .voidInvoice(partial.invoiceId)
      .catch(() => undefined);
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

  for (const couponId of [partial.percentCouponId, partial.amountCouponId]) {
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
  // record what was created (coupons, customer, invoice, fixture
  // user) — cleanup walks this object and tears down whatever it
  // finds. Mirrors the same pattern in the subscription Stripe spec.
  const partial: PartialSeed = {
    runId: randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase(),
  };
  let seedData: SeedResult | undefined;

  try {
    seedData = await seed(pool, stripe, partial);
    console.log(
      `[e2e] seeded fixture user=${seedData.fixtureEmail} customer=${seedData.customerId} `
      + `coupons=${seedData.percentCouponId},${seedData.amountCouponId} `
      + `invoice=${seedData.invoiceId} runId=${seedData.runId}`,
    );

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await context.newPage();

    // NO API mocks here — the whole point of this spec is to exercise
    // the live server discount-loading paths.
    await login(page, seedData.fixtureEmail, FIXTURE_PASSWORD);
    await page.goto(`${BASE_URL}/billing`, { waitUntil: 'networkidle' });

    // ---- Invoice History per-invoice stacked discount badges --------
    // Driven by the `data.discounts` expansion + `normalizeDiscount`
    // mapping in `GET /billing/invoices`. The fixture invoice was
    // finalised with TWO coupons stacked, so exactly two chips should
    // mount on its row. Any regression that drops the multi-discount
    // loop would produce one (or zero) badge here.
    const invoiceBadges = page.locator('[data-testid="billing-invoice-discount-badge"]');
    await invoiceBadges.first().waitFor({ state: 'visible', timeout: 30_000 });
    const invoiceBadgeCount = await invoiceBadges.count();
    // The customer is brand-new for this run so there is exactly one
    // invoice. Two stacked discounts on it must render two chips.
    assert(
      invoiceBadgeCount === 2,
      `expected exactly two invoice discount badges (one per stacked discount on the seeded invoice), got ${invoiceBadgeCount}`,
    );

    const allBadgeText = (
      await Promise.all(
        Array.from({ length: invoiceBadgeCount }, (_, i) =>
          invoiceBadges.nth(i).innerText(),
        ),
      )
    )
      .map((t) => t.trim())
      .join(' || ');

    // Stripe's order on `discounts[]` is insertion order, but we don't
    // pin which chip comes first — any regression that flips the order
    // shouldn't break the spec. Match per-coupon copy across the union
    // of all rendered chip texts.
    assert(
      new RegExp(`${COUPON_PERCENT_OFF}% off`, 'i').test(allBadgeText),
      `invoice discount badges should include '${COUPON_PERCENT_OFF}% off' across the chip block, got: ${JSON.stringify(allBadgeText)}`,
    );
    assert(
      allBadgeText.includes(seedData.percentCouponName),
      `invoice discount badges should include this run's percent-coupon name `
      + `'${seedData.percentCouponName}', got: ${JSON.stringify(allBadgeText)}`,
    );
    // formatDiscountLabel renders 500 cents USD as "$5.00 off" and
    // appends the coupon name when no promotion_code is present.
    assert(
      /\$5\.00 off/i.test(allBadgeText),
      `invoice discount badges should include '$5.00 off' across the chip block, got: ${JSON.stringify(allBadgeText)}`,
    );
    assert(
      allBadgeText.includes(seedData.amountCouponName),
      `invoice discount badges should include this run's amount-coupon name `
      + `'${seedData.amountCouponName}', got: ${JSON.stringify(allBadgeText)}`,
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
