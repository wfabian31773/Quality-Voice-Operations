/**
 * E2E spec: assert the Stripe-hosted billing portal renders the
 * multi-discount headline produced by `buildPortalDiscountHeadline`
 * (`Active discount: 25% off — PROMO25 + N more`) when the tenant has
 * multiple stacked subscription-level coupons. The Stripe portal only
 * allows a single headline string, so without the `+ N more` suffix a
 * tenant who attached two coupons would see only the first one and
 * wonder why the second is "missing" — the in-app subscription card
 * and the receipt PDF both render every stacked discount as its own
 * chip, so the portal should at least *acknowledge* the rest.
 *
 * Sibling of `billingPortalSubscriptionDiscountHeadline.spec.ts`,
 * which covers the single-discount path. Skips when
 * `STRIPE_SECRET_KEY`, `STRIPE_PRICE_STARTER_MONTHLY`, or
 * `DATABASE_URL` are unset and refuses to run against a non-test
 * Stripe key.
 *
 * Run: npm run test:e2e:billing-portal-stacked-discount-headline
 */
import { chromium, type Browser, type Page } from 'playwright';
import pg from 'pg';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import path from 'path';
import Stripe from 'stripe';
import {
  buildPortalDiscountHeadline,
  createPortalSession,
  __resetPortalConfigCacheForTests,
} from '../../platform/billing/stripe/checkout';
import type { TenantId } from '../../platform/core/types';
import {
  loadActiveSubscriptionDiscounts,
  type UpgradeDiscount,
} from '../../platform/billing/stripe/effectiveRate';

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRICE_STARTER_MONTHLY = process.env.STRIPE_PRICE_STARTER_MONTHLY;
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'billing-portal-stacked-discount-headline';
const STRIPE_API_VERSION = '2026-02-25.clover' as const;

// Mirrors platform/db/index.ts:getPoolUrl — the spec must seed the
// same database the in-process `createPortalSession` will read from.
const DB_URL = (() => {
  const env = process.env.APP_ENV ?? 'development';
  return env === 'development'
    ? (process.env.DATABASE_URL ?? '')
    : (process.env.PLATFORM_DB_POOL_URL ?? '');
})();

const ADMIN_TENANT_ID: TenantId = 'admin-org';
const HEADLINE_PERCENT_OFF = 25;
const SECONDARY_PERCENT_OFF = 5;
const RETURN_URL = 'https://example.test/billing';

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
  headlineCouponId: string;
  secondaryCouponId: string;
  customerId: string;
  subscriptionId: string;
  subscriptionSnapshot: SubscriptionSnapshot | null;
  expectedHeadline: string;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

/**
 * Most Stripe accounts auto-provision a default portal configuration
 * the first time the dashboard is opened, but a brand-new test-mode
 * project does not. The clone path in `resolveDiscountedPortalConfigId`
 * silently bails when no default exists, which would make the spec
 * spuriously skip the headline check. Create a minimal default here so
 * the spec is self-sufficient regardless of dashboard state.
 */
async function ensureDefaultPortalConfiguration(stripe: Stripe): Promise<void> {
  const list = await stripe.billingPortal.configurations.list({
    is_default: true,
    limit: 1,
  });
  if (list.data[0]?.id) return;
  await stripe.billingPortal.configurations.create({
    business_profile: { headline: 'Manage your subscription' },
    features: {
      customer_update: { enabled: true, allowed_updates: ['email', 'address'] },
      invoice_history: { enabled: true },
      payment_method_update: { enabled: true },
      subscription_cancel: { enabled: true, mode: 'at_period_end' },
    },
  });
}

async function snapshotSubscription(
  pool: pg.Pool,
): Promise<SubscriptionSnapshot | null> {
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
  headlineCouponId?: string;
  secondaryCouponId?: string;
  customerId?: string;
  subscriptionId?: string;
  subscriptionSnapshot?: SubscriptionSnapshot | null;
}

async function seed(
  pool: pg.Pool,
  stripe: Stripe,
  partial: PartialSeed,
): Promise<SeedResult> {
  await ensureDefaultPortalConfiguration(stripe);

  // Two coupons — the headline picks the first one returned by
  // `loadActiveSubscriptionDiscounts` and the second contributes the
  // "+ 1 more" tail. Run id makes both names unique per run so a stale
  // cached portal configuration from a previous run can never satisfy
  // the assertion accidentally.
  const headlineCoupon = await stripe.coupons.create({
    percent_off: HEADLINE_PERCENT_OFF,
    duration: 'forever',
    name: `E2E Stack Head ${partial.runId}`,
    metadata: { e2e: SPEC_NAME, runId: partial.runId, role: 'headline' },
  });
  partial.headlineCouponId = headlineCoupon.id;

  const secondaryCoupon = await stripe.coupons.create({
    percent_off: SECONDARY_PERCENT_OFF,
    duration: 'forever',
    name: `E2E Stack Sec ${partial.runId}`,
    metadata: { e2e: SPEC_NAME, runId: partial.runId, role: 'secondary' },
  });
  partial.secondaryCouponId = secondaryCoupon.id;

  // Customer with NO `coupon` attached — we want the headline to come
  // exclusively from the subscription-level discount stack. Also no
  // payment method: we use `collection_method: 'send_invoice'` on the
  // subscription below so Stripe doesn't try to charge a card.
  const customer = await stripe.customers.create({
    email: `e2e-stack-portal-${partial.runId.toLowerCase()}@voiceaihub.dev`,
    description: `E2E ${SPEC_NAME} runId=${partial.runId}`,
    metadata: { e2e: SPEC_NAME, runId: partial.runId, tenantId: ADMIN_TENANT_ID },
  });
  partial.customerId = customer.id;

  // Subscription carries BOTH coupons in `discounts: [...]` — the
  // multi-stack shape that motivated this spec. Without the "+ N more"
  // tail the portal headline would surface only the first one.
  //
  // `collection_method: 'send_invoice'` lets us create a real
  // subscription against the test-mode account WITHOUT requiring an
  // account-specific PaymentMethod (which is fragile across CI
  // environments — e.g. shared `pm_card_*` tokens may not exist on
  // every project). The subscription becomes `active`; Stripe just
  // emails an invoice instead of charging a card. That's fine because
  // the spec only needs the subscription to exist long enough for
  // `createPortalSession` to read its `discounts[]`.
  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: STRIPE_PRICE_STARTER_MONTHLY! }],
    discounts: [
      { coupon: headlineCoupon.id },
      { coupon: secondaryCoupon.id },
    ],
    collection_method: 'send_invoice',
    days_until_due: 30,
    metadata: { e2e: SPEC_NAME, runId: partial.runId, tenantId: ADMIN_TENANT_ID },
  });
  partial.subscriptionId = subscription.id;

  // Drive the same lookup the portal handler uses so any shape drift
  // between subscription create and the portal-side read fails here,
  // not as a slow Playwright timeout further down.
  const probed = await loadActiveSubscriptionDiscounts(stripe, subscription.id, {
    tenantId: ADMIN_TENANT_ID,
    surface: 'e2e_probe',
  });
  if (probed.length < 2) {
    throw new Error(
      `loadActiveSubscriptionDiscounts returned ${probed.length} discount(s) for subscription ${subscription.id}; need >=2 for the stacked-headline assertion`,
    );
  }

  // Build the expected headline off the *first* probed discount so the
  // assertion tracks whichever one Stripe actually orders first (which
  // matches what `createPortalSession` will surface). Hard-coding the
  // headline coupon here would be wrong if Stripe reorders them.
  const headlineDiscount: UpgradeDiscount = probed[0]!;
  const expectedHeadline = buildPortalDiscountHeadline(headlineDiscount, {
    additionalCount: probed.length - 1,
  });
  assert(
    expectedHeadline,
    'buildPortalDiscountHeadline returned null for the seeded discount; spec cannot continue',
  );
  assert(
    expectedHeadline.includes(`+ ${probed.length - 1} more`),
    `expected headline "${expectedHeadline}" to include "+ ${probed.length - 1} more" stack indicator`,
  );

  // Snapshot the existing subscription row BEFORE we overwrite it, so
  // cleanup can restore whatever the admin tenant had. Captured into
  // the partial so cleanup can also restore on a partial-seed failure
  // path that happens after this point.
  const subscriptionSnapshot = await snapshotSubscription(pool);
  partial.subscriptionSnapshot = subscriptionSnapshot;
  await upsertSubscriptionRow(
    pool,
    customer.id,
    subscription.id,
    STRIPE_PRICE_STARTER_MONTHLY!,
  );

  return {
    runId: partial.runId,
    headlineCouponId: headlineCoupon.id,
    secondaryCouponId: secondaryCoupon.id,
    customerId: customer.id,
    subscriptionId: subscription.id,
    subscriptionSnapshot,
    expectedHeadline,
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

  // Tear down both coupons; collect ids so we can also dedupe-deactivate
  // any portal configurations that referenced either of them.
  const couponIds = [partial.headlineCouponId, partial.secondaryCouponId].filter(
    (id): id is string => Boolean(id),
  );
  for (const couponId of couponIds) {
    await stripe.coupons
      .del(couponId)
      .catch((err) =>
        console.warn(
          `[e2e] cleanup coupon delete failed (${couponId}):`,
          (err as Error).message,
        ),
      );
  }

  if (couponIds.length > 0) {
    // Deactivate any discount portal configuration this run minted so
    // repeated CI runs don't accumulate test-mode configurations on
    // the Stripe account. PortalConfigCleanupScheduler also sweeps
    // these, but doing it inline keeps the dashboard clean even if
    // the scheduler isn't running in the e2e environment.
    try {
      const cfgs = await stripe.billingPortal.configurations.list({ limit: 100 });
      for (const cfg of cfgs.data) {
        const cfgCoupon = cfg.metadata?.couponId;
        if (cfgCoupon && couponIds.includes(cfgCoupon) && cfg.active) {
          await stripe.billingPortal.configurations
            .update(cfg.id, { active: false })
            .catch((err) =>
              console.warn(
                `[e2e] cleanup portal config deactivate failed (${cfg.id}):`,
                (err as Error).message,
              ),
            );
        }
      }
    } catch (err) {
      console.warn(
        '[e2e] cleanup portal config list failed:',
        (err as Error).message,
      );
    }
  }

  // Process-local cache; reset so the next run looks up a fresh config.
  __resetPortalConfigCacheForTests();
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
  if (!STRIPE_SECRET_KEY) {
    console.log(
      `[e2e] SKIP: ${SPEC_NAME} requires STRIPE_SECRET_KEY (test-mode key).`,
    );
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
      `[e2e] seeded customer=${seedData.customerId} subscription=${seedData.subscriptionId} headlineCoupon=${seedData.headlineCouponId} secondaryCoupon=${seedData.secondaryCouponId} runId=${seedData.runId}`,
    );
    console.log(`[e2e] expected headline: ${seedData.expectedHeadline}`);

    // Reset the in-process configuration cache before the call so a
    // stale entry from another spec in the same node process can't
    // hand us back a configuration that points at the *previous* run's
    // headline.
    __resetPortalConfigCacheForTests();
    const session = await createPortalSession({
      tenantId: ADMIN_TENANT_ID,
      returnUrl: RETURN_URL,
    });
    assert(
      typeof session.url === 'string' && session.url.startsWith('https://billing.stripe.com/'),
      `createPortalSession returned an unexpected URL: ${session.url}`,
    );
    console.log(`[e2e] opened portal session url=${session.url}`);

    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await ctx.newPage();

    // Block navigations away from billing.stripe.com so the test
    // doesn't accidentally chase a logout / cancel redirect to
    // example.test mid-assertion.
    await ctx.route('**://example.test/**', (route) => route.abort());

    await page.goto(session.url, { waitUntil: 'domcontentloaded' });

    // Stripe ships the headline as plain page text inside its hosted
    // portal layout. Wait for it to appear — `waitFor()` retries until
    // it's visible or the timeout fires, which makes the assertion
    // resilient to the portal's client-side hydration.
    const headlineLocator = page.getByText(seedData.expectedHeadline, { exact: false });
    await headlineLocator.first().waitFor({ state: 'visible', timeout: 30_000 });

    const visibleCount = await headlineLocator.count();
    assert(
      visibleCount > 0,
      `expected headline "${seedData.expectedHeadline}" to render on portal page, found 0 matches`,
    );

    console.log('[e2e] PASS — stacked-discount headline with "+ N more" rendered on Stripe portal');
  } catch (err) {
    await captureFailureScreenshot(page);
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    await cleanup(pool, stripe, partial).catch((err) =>
      console.warn(`[e2e] cleanup failed for runId=${partial.runId}:`, err),
    );
    await pool.end().catch(() => undefined);
  }
}

run().catch((err) => {
  console.error('[e2e] FAIL', err);
  process.exitCode = 1;
});
