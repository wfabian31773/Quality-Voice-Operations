/**
 * Task #1255 — End-to-end regression for the BillingEstimator
 * recommendation banner funnel, plus a viewer-no-CTA RBAC check
 * carried over from Task #1252.
 *
 * Funnel (tenant_owner):
 *   banner renders → impression POST (+ sessionStorage dedup key) →
 *   CTA click → click POST → /api/billing/checkout (recommendation
 *   snapshot in body) → Stripe Checkout → /billing?checkout=success →
 *   Stripe webhook handleCheckoutCompleted writes switch_completed →
 *   Platform Admin "Plan switches from banner (30d)" tile reflects bumps.
 *
 * RBAC (viewer / support_reviewer): banner renders but no CTA / interval
 * toggle (sub-tree gated on hasMinRole(role, 'manager')).
 *
 * The completion event is server-authoritative: the client never POSTs
 * switch_completed. We exercise that by invoking the production
 * `handleCheckoutCompleted` webhook handler with a constructed Stripe
 * session (recommendation snapshot in metadata mirrors what
 * createCheckoutSession would have stamped). admin-org's seeded
 * Enterprise subscription row is snapshotted and restored so the
 * webhook's UPSERT doesn't permanently downgrade the fixture.
 *
 * Run:  npm run test:e2e:billing-recommendation-checkout
 */
import { chromium, type Browser, type Page, type Request, type Route } from 'playwright';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import path from 'path';
import { handleCheckoutCompleted } from '../../platform/billing/stripe/webhook';
import type Stripe from 'stripe';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@voiceaihub.dev';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'test-password-123';
// platform/db/index.ts:getPoolUrl prefers DATABASE_URL in dev; the
// spec must talk to the same DB the dev workflow does.
const DB_URL = (() => {
  const env = process.env.APP_ENV ?? 'development';
  if (env === 'development') {
    return process.env.DATABASE_URL ?? process.env.PLATFORM_DB_POOL_URL ?? '';
  }
  return process.env.PLATFORM_DB_POOL_URL ?? process.env.DATABASE_URL ?? '';
})();
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'billing-recommendation-checkout';

const ADMIN_TENANT_ID = 'admin-org';
const FIXTURE_PASSWORD = 'test-password-123';
const FIXTURE_AI_MINUTES_PER_MONTH = 100;

if (!DB_URL) {
  console.error('PLATFORM_DB_POOL_URL or DATABASE_URL must be set to seed test data');
  process.exit(1);
}

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
  viewerEmail: string;
  viewerUserId: string;
  /** UTC ISO timestamp; rows in billing_recommendation_events / billing_events
   *  with created_at >= cutoff are deletable as test rows. */
  eventsCutoffIso: string;
  preserveUsageMetrics: UsageMetricSnapshot[];
  seededPeriodStartsIso: string[];
  /** Pre-test snapshot of admin-org's subscriptions row, restored on
   *  cleanup (the webhook UPSERTs subscriptions to 'starter' and would
   *  permanently mutate the seeded enterprise plan otherwise). */
  subscriptionSnapshot: SubscriptionSnapshot | null;
  stripeEventId: string;
  stripeSessionId: string;
}

interface EventCounts {
  impression: number;
  click: number;
  switch_completed: number;
}

interface PlatformTileSnapshot {
  completedSwitches: number;
  impressions: number;
  clicks: number;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

function monthStart(now: Date, monthsAgo: number): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1, 0, 0, 0, 0));
}

async function upsertFixtureUser(
  pool: pg.Pool,
  args: {
    tenantId: string;
    email: string;
    passwordHash: string;
    role: 'tenant_owner' | 'support_reviewer';
  },
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
  // /auth/login JOINs user_roles for tenant_id + role.
  await pool.query(
    `INSERT INTO user_roles (user_id, tenant_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, tenant_id, role) DO NOTHING`,
    [id, args.tenantId, args.role],
  );
  return id;
}

async function seed(pool: pg.Pool): Promise<SeedResult> {
  const runId = randomUUID().slice(0, 8);
  const fixtureEmail = `billing-rec-e2e-${runId}@voiceaihub.dev`;
  const viewerEmail = `billing-rec-e2e-viewer-${runId}@voiceaihub.dev`;
  const eventsCutoffIso = new Date().toISOString();
  const stripeEventId = `evt_e2e_${runId}`;
  const stripeSessionId = `cs_e2e_${runId}`;

  const passwordHash = await bcrypt.hash(FIXTURE_PASSWORD, 12);

  // The seeded admin user (admin@…) has users.role='admin' which is
  // not in the role hierarchy and fails hasMinRole('manager'); a
  // tenant_owner under admin-org is the cheapest way to drive the CTA.
  const fixtureUserId = await upsertFixtureUser(pool, {
    tenantId: ADMIN_TENANT_ID,
    email: fixtureEmail,
    passwordHash,
    role: 'tenant_owner',
  });
  // support_reviewer / 'viewer' tier — hasMinRole('manager') is false,
  // so the banner sub-tree must hide the CTA + interval toggle.
  const viewerUserId = await upsertFixtureUser(pool, {
    tenantId: ADMIN_TENANT_ID,
    email: viewerEmail,
    passwordHash,
    role: 'support_reviewer',
  });

  // Three trailing months of low ai_minutes — flips the estimator
  // recommendation from Enterprise → Starter (monthlySavings = 90_000c).
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

  // Snapshot subscriptions so cleanup can reverse the webhook UPSERT.
  const subResult = await pool.query<SubscriptionSnapshot & {
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
  const subRaw = subResult.rows[0];
  const subscriptionSnapshot: SubscriptionSnapshot | null = subRaw
    ? {
        ...subRaw,
        current_period_start: subRaw.current_period_start ? new Date(subRaw.current_period_start).toISOString() : null,
        current_period_end: subRaw.current_period_end ? new Date(subRaw.current_period_end).toISOString() : null,
      }
    : null;

  return {
    runId,
    fixtureEmail,
    fixtureUserId,
    viewerEmail,
    viewerUserId,
    eventsCutoffIso,
    preserveUsageMetrics,
    seededPeriodStartsIso,
    subscriptionSnapshot,
    stripeEventId,
    stripeSessionId,
  };
}

async function softDeleteUser(pool: pg.Pool, userId: string, originalEmail: string): Promise<void> {
  // Hard-DELETE blows up the SET NULL FK cascade because audit_logs is
  // append-only (prevent_audit_log_mutation trigger). Soft-delete + drop
  // user_roles instead. RunId-scoped emails prevent collisions on rerun.
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

async function restoreSubscriptionSnapshot(
  pool: pg.Pool,
  s: SubscriptionSnapshot,
): Promise<void> {
  await pool.query(
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
  );
}

async function cleanup(pool: pg.Pool, seedData: SeedResult): Promise<void> {
  // Delete the test-attributable billing_recommendation_events +
  // billing_events rows. RLS-bypass tx (privileged read).
  const cleanupClient = await pool.connect();
  try {
    await cleanupClient.query('BEGIN');
    await cleanupClient.query('SET LOCAL row_security = off');
    await cleanupClient.query(
      `DELETE FROM billing_recommendation_events
        WHERE tenant_id = $1 AND created_at >= $2`,
      [ADMIN_TENANT_ID, seedData.eventsCutoffIso],
    );
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

  // Restore admin-org's pre-test subscriptions row.
  if (seedData.subscriptionSnapshot) {
    await restoreSubscriptionSnapshot(pool, seedData.subscriptionSnapshot).catch((err) =>
      console.warn('[e2e] cleanup subscription restore failed:', err),
    );
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
  await softDeleteUser(pool, seedData.viewerUserId, seedData.viewerEmail);
}

async function readEventCountsForTenant(pool: pg.Pool, tenantId: string): Promise<EventCounts> {
  const client = await pool.connect();
  let rows: Array<{ event_type: string; count: string }>;
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL row_security = off');
    const result = await client.query<{ event_type: string; count: string }>(
      `SELECT event_type, COUNT(*)::bigint AS count
         FROM billing_recommendation_events
        WHERE tenant_id = $1
        GROUP BY event_type`,
      [tenantId],
    );
    await client.query('COMMIT');
    rows = result.rows;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  const counts: EventCounts = { impression: 0, click: 0, switch_completed: 0 };
  for (const row of rows) {
    const n = Number(row.count) || 0;
    if (row.event_type === 'impression') counts.impression = n;
    else if (row.event_type === 'click') counts.click = n;
    else if (row.event_type === 'switch_completed') counts.switch_completed = n;
  }
  return counts;
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
  pitch: string;
} | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL row_security = off');
    const { rows } = await client.query(
      `SELECT current_tier::text, recommended_tier::text,
              monthly_savings_cents, trailing_window_months, metadata, pitch
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
 * Build the Stripe Checkout Session shape that
 * `createCheckoutSession` would have returned for a banner-driven
 * checkout, then drive the production webhook handler to write the
 * `switch_completed` row. `subscription`/`customer` are left null so
 * the handler doesn't reach out to the Stripe API.
 */
async function fireCheckoutWebhook(args: {
  tenantId: string;
  stripeEventId: string;
  stripeSessionId: string;
  currentTier: 'starter' | 'pro' | 'enterprise';
  recommendedTier: 'starter' | 'pro' | 'enterprise';
  monthlySavingsCents: number;
  trailingWindowMonths: 3 | 6 | 12;
}): Promise<void> {
  const session = {
    id: args.stripeSessionId,
    object: 'checkout.session',
    customer: null,
    subscription: null,
    payment_status: 'paid',
    mode: 'subscription',
    metadata: {
      tenantId: args.tenantId,
      plan: args.recommendedTier,
      recommendationSource: 'billing_estimator_recommendation',
      recommendationCurrentTier: args.currentTier,
      recommendationRecommendedTier: args.recommendedTier,
      recommendationMonthlySavingsCents: String(args.monthlySavingsCents),
      recommendationTrailingWindowMonths: String(args.trailingWindowMonths),
      recommendationPitch: 'tier-switch',
    },
  } as unknown as Stripe.Checkout.Session;
  await handleCheckoutCompleted(session, args.stripeEventId);
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

async function readPlatformTileSnapshot(page: Page): Promise<PlatformTileSnapshot> {
  // Locate the StatCard by its label, then read the parent card's
  // text (value + sub line "{n} impressions · {n} clicks").
  const labelLocator = page.locator('text=Plan switches from banner (30d)').first();
  await labelLocator.waitFor({ state: 'visible', timeout: 10_000 });
  const tileText = await labelLocator.evaluate((el) => {
    let cur: HTMLElement | null = el as HTMLElement;
    for (let i = 0; i < 6 && cur; i += 1) {
      if (cur.querySelector('p.text-2xl')) return cur.innerText;
      cur = cur.parentElement;
    }
    return el.parentElement?.innerText ?? el.innerText;
  });
  const valueMatch = tileText.match(/(\d[\d,]*)\b/);
  const subMatch = tileText.match(/(\d[\d,]*)\s+impressions\s+·\s+(\d[\d,]*)\s+clicks/);
  assert(valueMatch, `Could not parse tile value from: ${JSON.stringify(tileText)}`);
  assert(subMatch, `Could not parse tile sub from: ${JSON.stringify(tileText)}`);
  return {
    completedSwitches: Number(valueMatch[1].replace(/,/g, '')),
    impressions: Number(subMatch[1].replace(/,/g, '')),
    clicks: Number(subMatch[2].replace(/,/g, '')),
  };
}

async function waitForPlatformTileToReflect(
  page: Page,
  expected: PlatformTileSnapshot,
  timeoutMs = 15_000,
): Promise<PlatformTileSnapshot> {
  const deadline = Date.now() + timeoutMs;
  let last: PlatformTileSnapshot | undefined;
  while (Date.now() < deadline) {
    try {
      last = await readPlatformTileSnapshot(page);
      if (
        last.completedSwitches >= expected.completedSwitches &&
        last.impressions >= expected.impressions &&
        last.clicks >= expected.clicks
      ) {
        return last;
      }
    } catch {
      // tile may not be in the DOM yet — keep polling.
    }
    await page.waitForTimeout(250);
  }
  throw new Error(
    `Platform tile never reflected expected counts. Last=${JSON.stringify(last)}, expected>=${JSON.stringify(expected)}`,
  );
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
    };
  };
}

async function runAnnualIntervalPhase(
  page: Page,
  fixtureEmail: string,
  stripeSessionId: string,
): Promise<void> {
  // Task #1298: prove that toggling the banner's interval to "Annual"
  // before clicking the CTA flips both the DOM attribute and the
  // outgoing checkout body. Without this, a regression that dropped
  // `interval` from handleUpgrade would still pass the monthly case
  // but quietly send tenants who chose Annual to a monthly sub.
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
      body: JSON.stringify({ url: successUrl, sessionId: stripeSessionId }),
    });
  });

  await login(page, fixtureEmail, FIXTURE_PASSWORD);
  await page.goto(`${BASE_URL}/billing`, { waitUntil: 'networkidle' });
  await page.waitForSelector(
    '[data-testid="billing-estimator-recommendation"][data-recommendation-state="switch"][data-recommended-tier="starter"]',
    { timeout: 20_000 },
  );

  const cta = page.locator('[data-testid="billing-estimator-recommendation-cta"]');
  await cta.waitFor({ state: 'visible', timeout: 10_000 });
  const initialIntervalAttr = await cta.getAttribute('data-recommendation-cta-interval');
  assert(
    initialIntervalAttr === 'monthly',
    `CTA must default to data-recommendation-cta-interval="monthly", got ${JSON.stringify(initialIntervalAttr)}`,
  );

  // Toggle to annual and confirm the DOM attribute flips before we
  // even hit the network — this is the wiring guard the task asks for.
  await page.click('[data-testid="billing-estimator-recommendation-interval-annual"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="billing-estimator-recommendation-cta"]')
        ?.getAttribute('data-recommendation-cta-interval') === 'annual',
    null,
    { timeout: 5_000 },
  );
  const flippedIntervalAttr = await cta.getAttribute('data-recommendation-cta-interval');
  assert(
    flippedIntervalAttr === 'annual',
    `CTA must flip to data-recommendation-cta-interval="annual" after toggle, got ${JSON.stringify(flippedIntervalAttr)}`,
  );
  // The annual toggle button should report aria-pressed="true" and the
  // monthly one "false" — keeps the toggle's a11y contract locked down
  // alongside the data attribute.
  const annualPressed = await page
    .locator('[data-testid="billing-estimator-recommendation-interval-annual"]')
    .getAttribute('aria-pressed');
  const monthlyPressed = await page
    .locator('[data-testid="billing-estimator-recommendation-interval-monthly"]')
    .getAttribute('aria-pressed');
  assert(
    annualPressed === 'true' && monthlyPressed === 'false',
    `Annual toggle aria-pressed mismatch: annual=${annualPressed} monthly=${monthlyPressed}`,
  );

  const checkoutFired = page.waitForRequest(
    (r) => r.method() === 'POST' && /\/api\/billing\/checkout(\?|$)/.test(r.url()),
    { timeout: 15_000 },
  );
  const navigated = page.waitForURL(
    (u) => u.toString().includes('/billing') && u.toString().includes('checkout=success'),
    { timeout: 20_000 },
  );
  await cta.click();
  await checkoutFired;
  await navigated;

  assert(captured.body, 'Expected to capture annual checkout request body');
  assert(
    captured.body.plan === 'starter',
    `annual checkout plan should be 'starter', got ${captured.body.plan}`,
  );
  assert(
    captured.body.interval === 'annual',
    `annual checkout body must carry interval="annual", got ${JSON.stringify(captured.body.interval)}`,
  );
  assert(
    captured.body.recommendation?.recommendedTier === 'starter',
    `annual recommendation.recommendedTier should be 'starter', got ${captured.body.recommendation?.recommendedTier}`,
  );
  console.log('[e2e] annual: CTA flipped to data-recommendation-cta-interval="annual" and forwarded interval="annual" to /billing/checkout');
}

async function runViewerNoCtaPhase(page: Page, viewerEmail: string): Promise<void> {
  // RBAC carry-over from Task #1252: the banner sub-tree that holds the
  // CTA + interval toggle is gated on `onSwitchPlan && hasMinRole(role,
  // 'manager')`. A support_reviewer (viewer) sees the banner but no CTA.
  await login(page, viewerEmail, FIXTURE_PASSWORD);
  await page.goto(`${BASE_URL}/billing`, { waitUntil: 'domcontentloaded' });

  const banner = page.locator('[data-testid="billing-estimator-recommendation"]');
  await banner.waitFor({ state: 'visible', timeout: 20_000 });
  const recommendationState = await banner.getAttribute('data-recommendation-state');
  assert(
    recommendationState === 'switch',
    `viewer banner must be in "switch" state (same usage as tenant_owner), got ${JSON.stringify(recommendationState)}`,
  );
  await banner
    .locator('[data-testid="billing-estimator-recommendation-tier"]')
    .waitFor({ state: 'visible', timeout: 5_000 });

  const ctaCount = await page
    .locator('[data-testid="billing-estimator-recommendation-cta"]')
    .count();
  assert(ctaCount === 0, `viewer must not see the CTA — found ${ctaCount}`);
  const intervalToggleCount = await page
    .locator('[data-testid="billing-estimator-recommendation-interval-toggle"]')
    .count();
  assert(
    intervalToggleCount === 0,
    `viewer must not see the interval toggle — found ${intervalToggleCount}`,
  );
  console.log('[e2e] viewer: banner rendered without a CTA');
}

async function run(): Promise<void> {
  const pool = new pg.Pool({ connectionString: DB_URL, max: 4 });
  let browser: Browser | undefined;
  let tenantPage: Page | undefined;
  let annualPage: Page | undefined;
  let viewerPage: Page | undefined;
  let adminPage: Page | undefined;
  let seedData: SeedResult | undefined;
  try {
    seedData = await seed(pool);
    console.log(
      `[e2e] seeded fixture user=${seedData.fixtureEmail} viewer=${seedData.viewerEmail} runId=${seedData.runId}`,
    );

    const beforeCounts = await readEventCountsForTenant(pool, ADMIN_TENANT_ID);
    console.log(`[e2e] pre-test event counts: ${JSON.stringify(beforeCounts)}`);

    browser = await chromium.launch({ headless: true });
    const tenantCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    tenantPage = await tenantCtx.newPage();

    const recEventBodies: Array<{
      eventType?: string;
      currentTier?: string;
      recommendedTier?: string;
      monthlySavingsCents?: number;
      trailingWindowMonths?: number;
    }> = [];
    tenantPage.on('request', (req: Request) => {
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

    // Stub the checkout endpoint so the (legitimate) downgrade guard
    // server-side never trips. We capture the body and return the same
    // success_url shape Stripe Checkout would have redirected to. The
    // `switch_completed` row is written by the actual webhook handler
    // below — not by this stub or by the client.
    const captured: CapturedCheckout = {};
    await tenantPage.route('**/api/billing/checkout', async (route: Route) => {
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
        body: JSON.stringify({
          url: successUrl,
          sessionId: seedData!.stripeSessionId,
        }),
      });
    });

    await login(tenantPage, seedData.fixtureEmail, FIXTURE_PASSWORD);
    console.log('[e2e] logged in as fixture user');

    const impressionFired = tenantPage.waitForRequest(
      (r) =>
        r.method() === 'POST' &&
        /\/api\/billing\/recommendation-event(\?|$)/.test(r.url()),
      { timeout: 20_000 },
    );
    await tenantPage.goto(`${BASE_URL}/billing`, { waitUntil: 'networkidle' });
    await tenantPage.waitForSelector(
      '[data-testid="billing-estimator-recommendation"][data-recommendation-state="switch"][data-recommended-tier="starter"]',
      { timeout: 20_000 },
    );
    await impressionFired;
    console.log('[e2e] recommendation banner rendered (enterprise → starter)');

    const impressionPayload = recEventBodies.find((b) => b.eventType === 'impression');
    assert(
      impressionPayload &&
        impressionPayload.currentTier === 'enterprise' &&
        impressionPayload.recommendedTier === 'starter' &&
        Number(impressionPayload.monthlySavingsCents) === 90_000,
      `Impression payload missing or malformed: ${JSON.stringify(impressionPayload)}`,
    );

    // Verify the BillingEstimator wrote its sessionStorage dedup key
    // (this is what suppresses repeat impressions on slider/window
    // toggles within the same tab).
    const dedupKey = `billing.rec.impression.tier-switch.enterprise.starter.90000`;
    const dedupValue = await tenantPage.evaluate(
      (k) => window.sessionStorage.getItem(k),
      dedupKey,
    );
    assert(
      dedupValue && /^\d+$/.test(dedupValue),
      `Expected sessionStorage[${dedupKey}] to hold a numeric timestamp, got ${dedupValue}`,
    );
    console.log(`[e2e] sessionStorage impression dedup key set: ${dedupKey}=${dedupValue}`);

    // Click the CTA — click event must fire BEFORE the checkout POST.
    const clickFired = tenantPage.waitForRequest(
      (r) => {
        if (r.method() !== 'POST') return false;
        if (!/\/api\/billing\/recommendation-event(\?|$)/.test(r.url())) return false;
        try {
          const body = JSON.parse(r.postData() ?? '{}');
          return body.eventType === 'click';
        } catch {
          return false;
        }
      },
      { timeout: 15_000 },
    );
    const checkoutFired = tenantPage.waitForRequest(
      (r) => r.method() === 'POST' && /\/api\/billing\/checkout(\?|$)/.test(r.url()),
      { timeout: 15_000 },
    );
    const navigated = tenantPage.waitForURL(
      (u) => u.toString().includes('/billing') && u.toString().includes('checkout=success'),
      { timeout: 20_000 },
    );

    await tenantPage.click('[data-testid="billing-estimator-recommendation-cta"]');
    await clickFired;
    await checkoutFired;
    await navigated;
    console.log(`[e2e] CTA clicked, redirected to ${tenantPage.url()}`);

    // The body the client sent to /billing/checkout is what
    // createCheckoutSession would stamp into Stripe metadata, which is
    // what the webhook reads back to write switch_completed.
    assert(captured.body, 'Expected to capture checkout request body');
    assert(
      captured.body.plan === 'starter',
      `checkout plan should be 'starter', got ${captured.body.plan}`,
    );
    assert(
      captured.body.recommendation?.currentTier === 'enterprise',
      `recommendation.currentTier should be 'enterprise', got ${captured.body.recommendation?.currentTier}`,
    );
    assert(
      captured.body.recommendation?.recommendedTier === 'starter',
      `recommendation.recommendedTier should be 'starter', got ${captured.body.recommendation?.recommendedTier}`,
    );
    assert(
      Number(captured.body.recommendation?.monthlySavingsCents) === 90_000,
      `recommendation.monthlySavingsCents should be 90000, got ${captured.body.recommendation?.monthlySavingsCents}`,
    );
    const trailingWindow = Number(captured.body.recommendation?.trailingWindowMonths);
    assert(
      trailingWindow === 3 || trailingWindow === 6 || trailingWindow === 12,
      `recommendation.trailingWindowMonths should be 3/6/12, got ${captured.body.recommendation?.trailingWindowMonths}`,
    );
    console.log('[e2e] checkout body forwarded correct attribution snapshot');

    // Drive the production webhook handler with the metadata that
    // createCheckoutSession would have stamped on the Stripe session.
    // This is what writes the `switch_completed` row in production.
    await fireCheckoutWebhook({
      tenantId: ADMIN_TENANT_ID,
      stripeEventId: seedData.stripeEventId,
      stripeSessionId: seedData.stripeSessionId,
      currentTier: 'enterprise',
      recommendedTier: 'starter',
      monthlySavingsCents: 90_000,
      trailingWindowMonths: trailingWindow as 3 | 6 | 12,
    });

    // Confirm the row the webhook wrote has the expected attribution.
    const switchRow = await readSwitchCompletedRow(
      pool,
      ADMIN_TENANT_ID,
      seedData.stripeSessionId,
    );
    assert(switchRow, 'Webhook handler did not write a switch_completed row');
    assert(
      switchRow.current_tier === 'enterprise' && switchRow.recommended_tier === 'starter',
      `switch_completed row tier mismatch: ${JSON.stringify(switchRow)}`,
    );
    assert(
      Number(switchRow.monthly_savings_cents) === 90_000,
      `switch_completed monthlySavingsCents should be 90000, got ${switchRow.monthly_savings_cents}`,
    );
    assert(
      switchRow.trailing_window_months === trailingWindow,
      `switch_completed trailingWindow should be ${trailingWindow}, got ${switchRow.trailing_window_months}`,
    );
    assert(
      (switchRow.metadata as { source?: string }).source === 'stripe_webhook',
      `switch_completed metadata.source should be 'stripe_webhook', got ${JSON.stringify(switchRow.metadata)}`,
    );
    assert(
      switchRow.pitch === 'tier-switch',
      `switch_completed pitch should be 'tier-switch', got ${JSON.stringify(switchRow.pitch)}`,
    );
    console.log('[e2e] switch_completed row written by handleCheckoutCompleted with correct attribution');

    const afterCounts = await readEventCountsForTenant(pool, ADMIN_TENANT_ID);
    console.log(`[e2e] post-test event counts: ${JSON.stringify(afterCounts)}`);
    assert(
      afterCounts.impression === beforeCounts.impression + 1,
      `Expected impression +1 (was ${beforeCounts.impression}), got ${afterCounts.impression}`,
    );
    assert(
      afterCounts.click === beforeCounts.click + 1,
      `Expected click +1 (was ${beforeCounts.click}), got ${afterCounts.click}`,
    );
    assert(
      afterCounts.switch_completed === beforeCounts.switch_completed + 1,
      `Expected switch_completed +1 (was ${beforeCounts.switch_completed}), got ${afterCounts.switch_completed}`,
    );
    console.log(
      '[e2e] billing_recommendation_events for admin-org bumped by +1 impression / +1 click / +1 switch_completed',
    );

    // Annual-interval phase: a fresh context (clean cookies +
    // sessionStorage) so the toggle's default-monthly state and the
    // impression-dedup key are exercised again before we flip to
    // annual and re-run the CTA → /billing/checkout flow. The monthly
    // phase's webhook downgraded admin-org from enterprise → starter,
    // which would suppress the recommendation banner; restore the
    // pre-test snapshot so the banner re-renders in switch state.
    await tenantCtx.close();
    if (seedData.subscriptionSnapshot) {
      await restoreSubscriptionSnapshot(pool, seedData.subscriptionSnapshot);
    }
    const annualCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    annualPage = await annualCtx.newPage();
    await runAnnualIntervalPhase(annualPage, seedData.fixtureEmail, `${seedData.stripeSessionId}-annual`);
    await annualCtx.close();

    // RBAC phase: viewer sees banner, no CTA / interval toggle. Fresh
    // context so the tenant_owner cookie doesn't bleed in.
    const viewerCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    viewerPage = await viewerCtx.newPage();
    await runViewerNoCtaPhase(viewerPage, seedData.viewerEmail);
    await viewerCtx.close();

    // Switch to platform admin and verify the dashboard tile.
    const adminCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    adminPage = await adminCtx.newPage();

    await login(adminPage, ADMIN_EMAIL, ADMIN_PASSWORD);
    const apiSnapshot = await adminPage.evaluate(async (baseUrl) => {
      const res = await fetch(`${baseUrl}/api/platform/billing-recommendations`, {
        credentials: 'include',
      });
      return (await res.json()) as {
        impressions: number;
        clicks: number;
        completedSwitches: number;
      };
    }, BASE_URL);
    // The platform tile aggregates across tenants; assert lower-bound
    // (+1 each) compared to the pre-test admin-org snapshot.
    assert(
      apiSnapshot.impressions >= beforeCounts.impression + 1,
      `Platform impressions should reflect the +1 bump (>= ${beforeCounts.impression + 1}), got ${apiSnapshot.impressions}`,
    );
    assert(
      apiSnapshot.clicks >= beforeCounts.click + 1,
      `Platform clicks should reflect the +1 bump (>= ${beforeCounts.click + 1}), got ${apiSnapshot.clicks}`,
    );
    assert(
      apiSnapshot.completedSwitches >= beforeCounts.switch_completed + 1,
      `Platform completedSwitches should reflect the +1 bump (>= ${beforeCounts.switch_completed + 1}), got ${apiSnapshot.completedSwitches}`,
    );
    console.log(
      `[e2e] /api/platform/billing-recommendations confirms aggregate counts: ${JSON.stringify(apiSnapshot)}`,
    );

    await adminPage.goto(`${BASE_URL}/admin/dashboard`, { waitUntil: 'networkidle' });
    const tile = await waitForPlatformTileToReflect(adminPage, {
      completedSwitches: apiSnapshot.completedSwitches,
      impressions: apiSnapshot.impressions,
      clicks: apiSnapshot.clicks,
    });
    console.log(`[e2e] platform admin tile renders bumped counts: ${JSON.stringify(tile)}`);

    console.log('[e2e] PASS');
  } catch (err) {
    await captureFailureScreenshot(tenantPage, 'tenant');
    await captureFailureScreenshot(annualPage, 'annual');
    await captureFailureScreenshot(viewerPage, 'viewer');
    await captureFailureScreenshot(adminPage, 'admin');
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
