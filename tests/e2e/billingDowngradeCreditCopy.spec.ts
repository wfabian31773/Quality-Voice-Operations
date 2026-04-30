/**
 * Task #1306 — End-to-end coverage for the downgrade-credit copy on
 * the tenant Billing page.
 *
 * Background:
 *   `GET /billing/downgrade-preview` already has unit + endpoint
 *   coverage (`tests/billing/downgradePreview.test.ts`,
 *   `tests/admin-api/billingDowngradePreview.test.ts`). What was
 *   missing was a browser-level check that the React Query plumbing
 *   on Billing.tsx — the `useQueries` hook fanning out one preview per
 *   downgrade tier, the `downgradePreviews` map lookup keyed by
 *   `${tier}|${interval}`, and the `handleDowngrade` confirm dialog —
 *   actually wires the prorated-credit value through to the tenant.
 *
 * What this spec asserts:
 *   1. `useQueries` fires a `GET /billing/downgrade-preview` per
 *      candidate downgrade tier (Pro + Starter, since admin-org is on
 *      Enterprise).
 *   2. The Pro card paragraph at `[data-testid="billing-downgrade-credit-pro"]`
 *      renders the credit copy ("$X credit on …") for the value the
 *      stubbed preview returned.
 *   3. Clicking the Pro Downgrade button surfaces a `window.confirm`
 *      whose message contains the SAME credit copy (the regression we
 *      care about: a refactor that drops the `creditCopy` branch in
 *      `handleDowngrade`, or a render block that reads from a
 *      different field, would silently let the dialog and the card
 *      drift apart).
 *
 * Strategy:
 *   - Stub `/api/billing/downgrade-preview` via page.route() so the
 *     test is hermetic — it doesn't depend on Stripe or on admin-org's
 *     real subscription state (which other specs mutate).
 *   - Stub `/api/billing/schedule-downgrade` to return success in case
 *     the dialog gets accepted, so the page never lands in an error
 *     state. (We dismiss the dialog by default — the credit copy is
 *     captured before either branch is taken.)
 *   - Seed a `tenant_owner` user on admin-org because the seeded
 *     admin@… user has users.role='admin' which falls outside the
 *     hasMinRole('manager') hierarchy and would not see downgrade
 *     cards at all. Same approach `billingRecommendationCheckout.spec`
 *     uses for the same reason.
 *
 * Run:  npm run test:e2e:billing-downgrade-credit-copy
 */
import { chromium, type Browser, type Dialog, type Page, type Route } from 'playwright';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import path from 'path';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
// Same DB-URL resolution `billingRecommendationCheckout.spec` uses —
// platform/db/index.ts:getPoolUrl prefers DATABASE_URL in dev, so the
// spec must talk to the same DB the dev workflow does.
const DB_URL = (() => {
  const env = process.env.APP_ENV ?? 'development';
  if (env === 'development') {
    return process.env.DATABASE_URL ?? process.env.PLATFORM_DB_POOL_URL ?? '';
  }
  return process.env.PLATFORM_DB_POOL_URL ?? process.env.DATABASE_URL ?? '';
})();
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'billing-downgrade-credit-copy';

const ADMIN_TENANT_ID = 'admin-org';
const FIXTURE_PASSWORD = 'test-password-123';

// Stubbed downgrade-preview values for `plan=pro&interval=monthly`.
// Picked so the rendered amount string is unambiguous (12345 cents →
// "$123" with min 0 / max 2 fraction digits via Intl.NumberFormat).
const STUB_CREDIT_CENTS = 12_345;
const STUB_NEXT_INVOICE_CENTS = 9_900;
// May 15, 2026 at midnight UTC — `formatDate` uses 'en-US' locale so
// the rendered string is "May 15, 2026" regardless of the runner's
// timezone (toLocaleDateString without a TZ option respects the local
// TZ for date *boundaries*, but the ISO is anchored at noon UTC so
// any North-American + European TZ rolls to May 15).
const STUB_NEXT_INVOICE_AT = '2026-05-15T12:00:00.000Z';

if (!DB_URL) {
  console.error('PLATFORM_DB_POOL_URL or DATABASE_URL must be set to seed test data');
  process.exit(1);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

interface SeedResult {
  runId: string;
  fixtureEmail: string;
  fixtureUserId: string;
}

async function upsertFixtureUser(
  pool: pg.Pool,
  args: {
    tenantId: string;
    email: string;
    passwordHash: string;
  },
): Promise<string> {
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
    [args.tenantId, args.email, args.passwordHash],
  );
  const id = rows[0]?.id;
  assert(id, `Failed to upsert fixture user ${args.email}`);
  // /auth/login JOINs user_roles for tenant_id + role.
  await pool.query(
    `INSERT INTO user_roles (user_id, tenant_id, role)
     VALUES ($1, $2, 'tenant_owner')
     ON CONFLICT (user_id, tenant_id, role) DO NOTHING`,
    [id, args.tenantId],
  );
  return id;
}

async function ensureAdminOrgEnterprise(pool: pg.Pool): Promise<void> {
  // Defensive: if a previous spec (e.g. billingRecommendationCheckout)
  // failed mid-flight and left admin-org's subscription downgraded,
  // pin it back to enterprise/monthly so the downgrade cards for Pro
  // and Starter actually render.
  await pool.query(
    `INSERT INTO subscriptions (tenant_id, plan, status, billing_interval,
       monthly_call_limit, monthly_sms_limit, monthly_ai_minute_limit, overage_enabled)
     VALUES ($1, 'enterprise', 'active', 'monthly', 999999, 999999, 999999, false)
     ON CONFLICT (tenant_id) DO UPDATE SET
       plan = 'enterprise',
       status = 'active',
       billing_interval = 'monthly',
       updated_at = NOW()`,
    [ADMIN_TENANT_ID],
  );
}

async function seed(pool: pg.Pool): Promise<SeedResult> {
  const runId = randomUUID().slice(0, 8);
  const fixtureEmail = `billing-downgrade-credit-e2e-${runId}@voiceaihub.dev`;
  const passwordHash = await bcrypt.hash(FIXTURE_PASSWORD, 12);
  await ensureAdminOrgEnterprise(pool);
  const fixtureUserId = await upsertFixtureUser(pool, {
    tenantId: ADMIN_TENANT_ID,
    email: fixtureEmail,
    passwordHash,
  });
  return { runId, fixtureEmail, fixtureUserId };
}

async function softDeleteUser(
  pool: pg.Pool,
  userId: string,
  originalEmail: string,
): Promise<void> {
  // Hard-DELETE blows up the SET NULL FK cascade because audit_logs is
  // append-only (prevent_audit_log_mutation trigger). Soft-delete +
  // drop user_roles instead. RunId-scoped emails prevent collisions on
  // rerun. Same pattern as billingRecommendationCheckout.spec.
  await pool
    .query(
      `UPDATE users
          SET is_active = false,
              email = $2,
              updated_at = NOW()
        WHERE id = $1`,
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

interface PreviewQuery {
  plan: string;
  interval: string;
}

async function run(): Promise<void> {
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

    // Capture every downgrade-preview request so we can assert
    // useQueries fanned out one per candidate tier.
    const previewQueries: PreviewQuery[] = [];
    await page.route('**/api/billing/downgrade-preview**', async (route: Route) => {
      const url = new URL(route.request().url());
      const plan = url.searchParams.get('plan') ?? '';
      const interval = url.searchParams.get('interval') ?? '';
      previewQueries.push({ plan, interval });
      // Only the Pro/monthly slot drives the credit-copy assertion.
      // Other slots (Starter/monthly) get a null preview so the card
      // still renders but no credit paragraph appears for them.
      if (plan === 'pro' && interval === 'monthly') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            downgrade: {
              plan: 'pro',
              interval: 'monthly',
              prorationCreditCents: STUB_CREDIT_CENTS,
              nextInvoiceTotalCents: STUB_NEXT_INVOICE_CENTS,
              nextInvoiceAt: STUB_NEXT_INVOICE_AT,
              basePriceCents: 19_900,
              currency: 'USD',
              source: 'stripe',
              basePriceSource: 'stripe',
              basePriceId: 'price_test_pro_monthly',
              discount: null,
            },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ downgrade: null }),
      });
    });

    // If the user accidentally accepts the confirm dialog, the page
    // POSTs to /billing/schedule-downgrade. Stub it so we don't depend
    // on Stripe and the page doesn't show an error toast either way.
    await page.route('**/api/billing/schedule-downgrade', async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          scheduled: {
            scheduleId: `sched_test_${seedData!.runId}`,
            scheduledFor: STUB_NEXT_INVOICE_AT,
            targetPlan: 'pro',
            targetInterval: 'monthly',
          },
        }),
      });
    });

    // Capture-only handler for the confirm dialog. We dismiss it so
    // the spec exercises the message-construction path without
    // mutating any state. Multiple dialogs per page lifetime are
    // legal — keep all of them.
    const dialogMessages: string[] = [];
    page.on('dialog', async (dialog: Dialog) => {
      dialogMessages.push(dialog.message());
      await dialog.dismiss();
    });

    await login(page, seedData.fixtureEmail, FIXTURE_PASSWORD);
    console.log('[e2e] logged in as fixture user');

    await page.goto(`${BASE_URL}/billing`, { waitUntil: 'networkidle' });

    // Wait for the Pro downgrade card AND its credit paragraph. Card
    // first so a missing testid fails with a useful selector, then
    // the credit paragraph (which is what the task is actually about).
    await page.waitForSelector(
      '[data-testid="billing-upgrade-card-pro"][data-card-kind="downgrade"]',
      { timeout: 20_000 },
    );
    const creditLocator = page.locator('[data-testid="billing-downgrade-credit-pro"]');
    await creditLocator.waitFor({ state: 'visible', timeout: 10_000 });
    const creditText = (await creditLocator.innerText()).trim();
    console.log(`[e2e] Pro downgrade-credit paragraph text: ${JSON.stringify(creditText)}`);

    // The credit paragraph must surface BOTH the dollar amount Stripe
    // quoted AND the date the credit lands on. Hard-asserting both
    // pins the rendered shape so a future refactor that drops one or
    // the other (or accidentally swaps `nextInvoiceTotalCents` in)
    // fails loudly.
    assert(
      creditText.includes('$123'),
      `Expected credit paragraph to include "$123" (formatted from 12345¢), got ${JSON.stringify(creditText)}`,
    );
    assert(
      creditText.includes('May 15, 2026'),
      `Expected credit paragraph to include the credit date "May 15, 2026", got ${JSON.stringify(creditText)}`,
    );

    // useQueries must have fanned out one request per candidate
    // downgrade tier. admin-org is on Enterprise so the candidates
    // are pro+monthly and starter+monthly. Order isn't guaranteed
    // (React Query schedules them in parallel), so assert the set.
    const proHit = previewQueries.find((q) => q.plan === 'pro' && q.interval === 'monthly');
    const starterHit = previewQueries.find(
      (q) => q.plan === 'starter' && q.interval === 'monthly',
    );
    assert(proHit, `Missing GET /billing/downgrade-preview?plan=pro&interval=monthly. Saw: ${JSON.stringify(previewQueries)}`);
    assert(
      starterHit,
      `Missing GET /billing/downgrade-preview?plan=starter&interval=monthly. Saw: ${JSON.stringify(previewQueries)}`,
    );
    console.log(
      `[e2e] useQueries fanned out ${previewQueries.length} downgrade-preview requests (Pro + Starter)`,
    );

    // Click the Pro Downgrade button — `handleDowngrade` will fire
    // `window.confirm`, the dialog handler above captures the
    // message and dismisses it. We then assert the dialog message
    // contains the same credit copy the card showed.
    const downgradeButton = page.locator('[data-testid="billing-upgrade-button-pro"]');
    await downgradeButton.waitFor({ state: 'visible', timeout: 5_000 });
    await downgradeButton.click();

    // Dialog event fires synchronously off the click; give it a tick
    // to land in our buffer.
    await page.waitForFunction(
      () => true,
      null,
      { timeout: 1_000 },
    ).catch(() => undefined);
    // Poll in case the dialog took a beat to surface.
    const deadline = Date.now() + 5_000;
    while (dialogMessages.length === 0 && Date.now() < deadline) {
      await page.waitForTimeout(50);
    }
    assert(
      dialogMessages.length > 0,
      'Expected a window.confirm dialog after clicking Downgrade, none was raised',
    );
    const dialogMessage = dialogMessages[dialogMessages.length - 1];
    console.log(`[e2e] confirm dialog message: ${JSON.stringify(dialogMessage)}`);

    // The confirm message is the concatenation of the base downgrade
    // copy + next-invoice line + credit line. The credit line is the
    // exact i18n template the card paragraph also rendered, so a
    // substring assertion is the tightest invariant we can lock in.
    assert(
      dialogMessage.includes(creditText),
      `Confirm dialog must include the same credit copy as the card paragraph.\n  card:   ${JSON.stringify(creditText)}\n  dialog: ${JSON.stringify(dialogMessage)}`,
    );
    // Belt-and-braces: the dollar amount and date individually must
    // also appear, in case a future refactor reformats the dialog
    // string but keeps the same values.
    assert(
      dialogMessage.includes('$123'),
      `Confirm dialog missing credit amount "$123": ${JSON.stringify(dialogMessage)}`,
    );
    assert(
      dialogMessage.includes('May 15, 2026'),
      `Confirm dialog missing credit date "May 15, 2026": ${JSON.stringify(dialogMessage)}`,
    );

    console.log('[e2e] PASS');
  } catch (err) {
    await captureFailureScreenshot(page);
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (seedData) {
      await softDeleteUser(pool, seedData.fixtureUserId, seedData.fixtureEmail).catch(
        (err) => console.warn(`[e2e] cleanup failed for runId=${seedData?.runId}:`, err),
      );
    }
    await pool.end().catch(() => undefined);
  }
}

run().catch((err) => {
  console.error('[e2e] FAIL', err);
  process.exitCode = 1;
});
