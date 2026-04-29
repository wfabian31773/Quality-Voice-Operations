/**
 * Task #988: end-to-end regression for the two small-but-high-visibility
 * controls that bookend the onboarding wizard:
 *
 *   1. The "Don't show this again" link at the bottom of `/onboarding`.
 *      Clicking it must:
 *        - send the user to the dashboard (i.e. off `/onboarding`), AND
 *        - PATCH `/me/preferences` so `onboarding_completed` is `true`
 *          inside `users.preferences`.
 *
 *   2. The "Restart onboarding" button on `Settings → General`. Clicking it
 *      must:
 *        - send the user back to `/onboarding`, AND
 *        - PATCH `/me/preferences` so `onboarding_completed` is `false`
 *          (and `onboarding_step` is cleared) — exercising the
 *          shallow-merge contract on `/me/preferences`.
 *
 * Why this lives in `tests/e2e/` rather than as a unit test:
 *   The wiring under test is split across the React component, the
 *   `api.patch` shim, the Express route handler, and the JSONB merge SQL.
 *   A real-browser spec is the only thing that catches regressions like
 *   "someone removed the link", "someone replaced PATCH with PUT", or
 *   "someone broke the resume logic in `clampStep`". Sibling unit tests
 *   in `tests/admin-api/` cover the SQL-merge semantics in isolation;
 *   this spec covers the live round-trip.
 *
 * Standalone runner:
 *
 *   E2E_ADMIN_PASSWORD='test-password-123' \
 *     npx tsx tests/e2e/onboardingDismissRestart.spec.ts
 *
 * Pre-requisites:
 *   - Platform Dev workflow running (admin API on :3002, vite on :5000).
 *   - DATABASE_URL is set so the spec can (idempotently) seed a tenant
 *     user and reset its `preferences` blob between flow steps.
 *   - Playwright browsers installed: `npx playwright install chromium`.
 *
 * Why we DON'T delete the seeded tenant after the test:
 *   `audit_logs` is immutable in this schema (BEFORE UPDATE / BEFORE
 *   DELETE triggers raise). Logging in writes a `user.login` audit row
 *   that references the user via FK ON DELETE SET NULL. Removing the
 *   user would trigger that SET NULL, which the immutability trigger
 *   refuses. Instead we use a stable email/tenant id and upsert
 *   idempotently — the same pattern used by
 *   `maintenanceGateAuthenticatedTenant.spec.ts` and
 *   `scripts/seed-admin.ts`.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { mkdir } from 'fs/promises';
import path from 'path';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'onboarding-dismiss-restart';

// Stable identifiers — the seed is idempotent (upsert), so reruns reuse the
// same row. Distinct from the BL-013 fixtures so the two specs cannot
// interfere if they ever run against the same DB.
const TENANT_USER_EMAIL =
  process.env.E2E_ONBOARDING_USER_EMAIL ?? 't988-onboarding@voiceaihub.test';
const TENANT_USER_PASSWORD =
  process.env.E2E_ONBOARDING_USER_PASSWORD ?? 'OnboardingTest!2026';
const TENANT_ID = process.env.E2E_ONBOARDING_TENANT_ID ?? 't988-onboarding-tenant';
const TENANT_SLUG = process.env.E2E_ONBOARDING_TENANT_SLUG ?? 't988-onboarding-tenant';

interface UserPreferencesRow {
  id: string;
  preferences: Record<string, unknown> | null;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

/**
 * Seed an isolated tenant + non-admin tenant user so the spec has a known
 * credential to log in with, then RESET the user's preferences blob to
 * `{}` so neither `onboarding_completed` nor `onboarding_step` carries
 * over from a previous run. Returns the seeded user id so we can poll
 * the preferences row directly afterwards.
 */
async function seedTenantUser(pool: pg.Pool): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // RLS is enabled on most tables; turn it off for this connection's
    // transaction so the seed inserts can write across tenants without
    // needing a tenant context (matches signup + sibling spec patterns).
    await client.query(`SET LOCAL row_security = off`);

    // Backdate the tenant's created_at so TenantLayout's onboarding-gate
    // doesn't bounce the user back to /onboarding when they navigate to
    // /settings/general after the dismiss step. The gate treats a tenant
    // with no phone numbers AND a created_at within the last 24h as
    // "still onboarding" and redirects accordingly. Our seed has no
    // phone number, so we age the tenant past that window.
    await client.query(
      `INSERT INTO tenants (id, name, slug, status, plan, settings, feature_flags, created_at)
       VALUES ($1, 'Onboarding e2e Tenant', $2, 'active', 'starter',
               '{"timezone": "America/New_York"}'::jsonb,
               '{}'::jsonb,
               NOW() - INTERVAL '7 days')
       ON CONFLICT (id) DO UPDATE SET
         status = 'active',
         created_at = LEAST(tenants.created_at, EXCLUDED.created_at),
         updated_at = NOW()`,
      [TENANT_ID, TENANT_SLUG],
    );

    const passwordHash = await bcrypt.hash(TENANT_USER_PASSWORD, 12);

    const userResult = await client.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, first_name, password_hash,
                          role, is_active, is_platform_admin, email_verified,
                          preferences)
       VALUES ($1, $2, 'Onboarding Tester', $3, 'admin', TRUE, FALSE, TRUE,
               '{}'::jsonb)
       ON CONFLICT (email) DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         password_hash = EXCLUDED.password_hash,
         role = EXCLUDED.role,
         is_active = TRUE,
         is_platform_admin = FALSE,
         email_verified = TRUE,
         preferences = '{}'::jsonb,
         updated_at = NOW()
       RETURNING id`,
      [TENANT_ID, TENANT_USER_EMAIL, passwordHash],
    );
    const userId = userResult.rows[0]?.id;
    if (!userId) {
      throw new Error('failed to seed tenant user (no id returned)');
    }

    await client.query(
      `INSERT INTO user_roles (user_id, tenant_id, role)
       VALUES ($1, $2, 'tenant_owner')
       ON CONFLICT (user_id, tenant_id, role) DO NOTHING`,
      [userId, TENANT_ID],
    );

    await client.query('COMMIT');
    return userId;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Read the seeded user's preferences directly from Postgres. The PATCH
 * endpoint returns the merged blob in its response too, but we go to the
 * source of truth so we're testing the actual persisted state — the
 * thing that controls whether the wizard resumes on the next login.
 */
async function readPreferences(
  pool: pg.Pool,
  userId: string,
): Promise<Record<string, unknown>> {
  const client = await pool.connect();
  try {
    await client.query(`SET LOCAL row_security = off`);
    const { rows } = await client.query<UserPreferencesRow>(
      `SELECT id, preferences FROM users WHERE id = $1 LIMIT 1`,
      [userId],
    );
    if (rows.length === 0) throw new Error(`user ${userId} disappeared mid-test`);
    return (rows[0].preferences ?? {}) as Record<string, unknown>;
  } finally {
    client.release();
  }
}

async function tenantUiLogin(page: Page) {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', TENANT_USER_EMAIL);
  await page.fill('input[type="password"]', TENANT_USER_PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15_000 }),
    page.click('button[type="submit"]'),
  ]);
}

/**
 * Wait for a successful PATCH /me/preferences response. The wizard fires
 * this fire-and-forget before it navigates, so we hook the response
 * promise BEFORE clicking and then await it after, instead of guessing a
 * sleep window. Optional `predicate` lets the caller scope the match —
 * the wizard sends multiple PATCHes during a session (e.g. a step
 * persist), and the dismiss vs restart flows write distinct payloads.
 */
function waitForPreferencesPatch(
  page: Page,
  opts: {
    predicate?: (body: Record<string, unknown>) => boolean;
    timeoutMs?: number;
  } = {},
) {
  return page.waitForResponse(
    async (res) => {
      try {
        if (res.request().method() !== 'PATCH') return false;
        if (!/\/api\/me\/preferences(\?|$)/.test(res.url())) return false;
        if (res.status() !== 200) return false;
        if (!opts.predicate) return true;
        // postData is whatever the client sent — parse it here so the
        // caller can match on the keys the dismiss/restart flows write.
        const raw = res.request().postData() ?? '{}';
        const body = JSON.parse(raw) as Record<string, unknown>;
        return opts.predicate(body);
      } catch {
        return false;
      }
    },
    { timeout: opts.timeoutMs ?? 10_000 },
  );
}

async function captureFailureScreenshot(page: Page | undefined, suffix: string): Promise<void> {
  if (!page) return;
  const shotPath = path.join(ARTIFACT_DIR, `${SPEC_NAME}-${suffix}.png`);
  try {
    await mkdir(path.dirname(shotPath), { recursive: true });
    await page.screenshot({ path: shotPath, fullPage: true });
    console.error(`[e2e]   screenshot: ${shotPath}`);
  } catch (err) {
    console.warn(`[e2e] failed to write screenshot to ${shotPath}: ${(err as Error).message}`);
  }
}

async function run(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.PLATFORM_DB_POOL_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is required to seed the tenant user and verify preferences for this spec.',
    );
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
  let browser: Browser | undefined;
  let ctx: BrowserContext | undefined;
  let page: Page | undefined;

  try {
    const userId = await seedTenantUser(pool);
    console.log(`[e2e] seeded tenant user ${TENANT_USER_EMAIL} (id=${userId})`);

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await ctx.newPage();

    await tenantUiLogin(page);
    console.log(`[e2e] logged in as ${TENANT_USER_EMAIL}`);

    // ─── Phase 1: Dismiss flow ────────────────────────────────────────
    //
    // Open /onboarding, click "Don't show this again", and assert:
    //   a) the user is sent to the dashboard (off /onboarding), AND
    //   b) `onboarding_completed` is true in users.preferences.
    await page.goto(`${BASE_URL}/onboarding`, { waitUntil: 'domcontentloaded' });
    const dismissLink = page.locator('button', { hasText: "Don't show this again" });
    await dismissLink.waitFor({ state: 'visible', timeout: 15_000 });

    // Hook the preference PATCH BEFORE clicking; the wizard fires it
    // fire-and-forget right before it navigates, so we'd race it
    // otherwise. Match on `onboarding_completed: true` so we don't
    // mistakenly resolve on an intermediate `onboarding_step` write.
    const dismissPatched = waitForPreferencesPatch(page, {
      predicate: (body) => body.onboarding_completed === true,
    });
    await dismissLink.click();
    const dismissRes = await dismissPatched;
    assert(
      dismissRes.status() === 200,
      `dismiss PATCH should be 200, got ${dismissRes.status()}`,
    );

    // The dismiss button calls `handleFinish('/')`, which navigates to
    // `/`. For an authenticated tenant the public Landing component
    // redirects to `/dashboard`. We wait for the final URL rather than
    // the intermediate `/` to avoid racing the redirect.
    await page.waitForURL((u) => u.pathname === '/dashboard', { timeout: 15_000 });
    assert(
      !page.url().includes('/onboarding'),
      `expected to leave /onboarding after dismiss, still at ${page.url()}`,
    );

    const prefsAfterDismiss = await readPreferences(pool, userId);
    assert(
      prefsAfterDismiss.onboarding_completed === true,
      `users.preferences.onboarding_completed should be true after dismiss, got ${JSON.stringify(prefsAfterDismiss)}`,
    );
    console.log('[e2e] dismiss flow: navigated to /dashboard and onboarding_completed=true');

    // ─── Phase 2: Restart flow ────────────────────────────────────────
    //
    // Open /settings/general, click "Restart onboarding", and assert:
    //   a) the user is sent back to /onboarding, AND
    //   b) `onboarding_completed` is false in users.preferences (the
    //      shallow-merge contract on /me/preferences must overwrite
    //      the previously-true value, not just merge a new key in).
    await page.goto(`${BASE_URL}/settings/general`, { waitUntil: 'domcontentloaded' });
    const restartButton = page.locator('button', { hasText: 'Restart onboarding' });
    await restartButton.waitFor({ state: 'visible', timeout: 15_000 });

    const restartPatched = waitForPreferencesPatch(page, {
      predicate: (body) => body.onboarding_completed === false,
    });
    await restartButton.click();
    const restartRes = await restartPatched;
    assert(
      restartRes.status() === 200,
      `restart PATCH should be 200, got ${restartRes.status()}`,
    );

    await page.waitForURL((u) => u.pathname === '/onboarding', { timeout: 15_000 });
    assert(
      page.url().includes('/onboarding'),
      `expected to land on /onboarding after restart, got ${page.url()}`,
    );

    const prefsAfterRestart = await readPreferences(pool, userId);
    assert(
      prefsAfterRestart.onboarding_completed === false,
      `users.preferences.onboarding_completed should be false after restart, got ${JSON.stringify(prefsAfterRestart)}`,
    );
    // The Restart button also nulls `onboarding_step`. The PATCH endpoint
    // only supports merge (not delete), so this asserts the wizard
    // explicitly overwrites the saved step rather than relying on a
    // server-side delete that doesn't exist.
    assert(
      prefsAfterRestart.onboarding_step === null,
      `users.preferences.onboarding_step should be null after restart, got ${JSON.stringify(prefsAfterRestart)}`,
    );
    console.log('[e2e] restart flow: navigated to /onboarding and onboarding_completed=false');

    console.log('[e2e] PASS');
  } catch (err) {
    await captureFailureScreenshot(page, 'failure');
    throw err;
  } finally {
    if (ctx) await ctx.close().catch(() => undefined);
    if (browser) await browser.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

run().catch((err) => {
  console.error('[e2e] FAIL', err);
  process.exitCode = 1;
});
