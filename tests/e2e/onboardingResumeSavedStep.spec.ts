/**
 * Task #1122: end-to-end regression for the resume-from-saved-step path of
 * the onboarding wizard.
 *
 * Why this exists in addition to onboardingDismissRestart.spec.ts:
 *   The dismiss/restart spec only covers the two endpoints of the flow
 *   (start-to-dismissed, dismissed-to-restarted). The middle of the
 *   wizard — where the user advances step-by-step and `onboarding_step`
 *   is persisted to `users.preferences` via PATCH /me/preferences — is
 *   exactly what `Onboarding.tsx`'s `clampStep` + `persistedStepRef` +
 *   the saved-progress `useEffect` rely on. A regression there would
 *   silently drop returning users back at step 1 even though they had
 *   already advanced, and the bookend spec would not catch it.
 *
 * What this spec asserts:
 *   1. Advancing the wizard from step 1 → step 2 → step 3 PATCHes the
 *      saved step into `users.preferences.onboarding_step` after each
 *      transition (verified directly against Postgres, the source of
 *      truth that controls resume on the next visit).
 *   2. Reloading `/onboarding` after the wizard has reached step 3 brings
 *      the user back to step 3 — NOT to step 1. This is the core resume
 *      contract.
 *
 * Step 1 → step 2 detail:
 *   In Onboarding.tsx, the polling effect calls `advanceTo(2)` as soon
 *   as `/tenants/me/provisioning-status` returns `ready`. Our seed sets
 *   the tenant to `active`, so `getProvisioningStatus` resolves to
 *   `ready` on the first poll and the wizard auto-advances to step 2,
 *   firing the PATCH that persists `onboarding_step: 2`. This is the
 *   real production path users hit once their tenant finishes
 *   provisioning, not a synthetic shortcut.
 *
 * Step 2 → step 3 detail:
 *   The seed leaves the default `answering-service` template selected,
 *   so clicking Continue runs the `selectedTemplate === 'answering-service'`
 *   branch of `handleTemplateConfirm` — which calls `advanceTo(3)`
 *   directly without an intermediate `/agents` PATCH. That exercises
 *   the same `persistStep` codepath without coupling the resume test
 *   to template-update internals (which already have their own coverage).
 *
 * Standalone runner:
 *
 *   E2E_ADMIN_PASSWORD='test-password-123' \
 *     npx tsx tests/e2e/onboardingResumeSavedStep.spec.ts
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
 *   refuses. Same pattern as the sibling onboardingDismissRestart spec —
 *   we use a stable email/tenant id and upsert idempotently. The seed
 *   uses identifiers that are distinct from the dismiss/restart spec's
 *   so the two specs cannot interfere if they ever run in parallel
 *   against the same DB.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { mkdir } from 'fs/promises';
import path from 'path';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'onboarding-resume-saved-step';

// Stable identifiers — the seed is idempotent (upsert), so reruns reuse the
// same row. Distinct from the BL-013 + dismiss/restart fixtures so the
// specs cannot interfere if they ever run against the same DB.
const TENANT_USER_EMAIL =
  process.env.E2E_RESUME_USER_EMAIL ?? 't1122-resume@voiceaihub.test';
const TENANT_USER_PASSWORD =
  process.env.E2E_RESUME_USER_PASSWORD ?? 'ResumeOnboardingTest!2026';
const TENANT_ID = process.env.E2E_RESUME_TENANT_ID ?? 't1122-resume-tenant';
const TENANT_SLUG = process.env.E2E_RESUME_TENANT_SLUG ?? 't1122-resume-tenant';

interface UserPreferencesRow {
  id: string;
  preferences: Record<string, unknown> | null;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

/**
 * Seed an isolated tenant + non-admin tenant user, then RESET the user's
 * preferences blob to `{}` so neither `onboarding_completed` nor
 * `onboarding_step` carries over from a previous run. Returns the seeded
 * user id so we can poll the preferences row directly afterwards.
 *
 * The tenant is seeded as `status = 'active'` so
 * `/tenants/me/provisioning-status` returns `ready` on the first poll.
 * That's what triggers the wizard's auto-advance from step 1 to step 2 —
 * the production path we want to exercise.
 */
async function seedTenantUser(pool: pg.Pool): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // RLS is enabled on most tables; turn it off for this connection's
    // transaction so the seed inserts can write across tenants without
    // needing a tenant context (matches signup + sibling spec patterns).
    await client.query(`SET LOCAL row_security = off`);

    // Backdate the tenant's created_at so the TenantLayout onboarding
    // gate doesn't bounce us based on the "<24h old AND no phone numbers"
    // heuristic. Same age-out pattern as the dismiss/restart spec.
    await client.query(
      `INSERT INTO tenants (id, name, slug, status, plan, settings, feature_flags, created_at)
       VALUES ($1, 'Resume e2e Tenant', $2, 'active', 'starter',
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
       VALUES ($1, $2, 'Resume Tester', $3, 'admin', TRUE, FALSE, TRUE,
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
 * thing that controls whether the wizard resumes on the next mount.
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
 * Wait for a successful PATCH /me/preferences response that matches a
 * predicate on the request body. The wizard fires multiple PATCHes (one
 * per step transition), so callers always pass a predicate scoped to the
 * specific `onboarding_step` value they expect.
 *
 * Hooking the response promise BEFORE the click that triggers the PATCH
 * is critical — `persistStep` is fire-and-forget from the React side
 * (no await, no UI gate), so a "click then wait" sequence would race
 * the network and flake.
 */
function waitForPreferencesPatch(
  page: Page,
  opts: {
    predicate: (body: Record<string, unknown>) => boolean;
    timeoutMs?: number;
  },
) {
  return page.waitForResponse(
    async (res) => {
      try {
        if (res.request().method() !== 'PATCH') return false;
        if (!/\/api\/me\/preferences(\?|$)/.test(res.url())) return false;
        if (res.status() !== 200) return false;
        const raw = res.request().postData() ?? '{}';
        const body = JSON.parse(raw) as Record<string, unknown>;
        return opts.predicate(body);
      } catch {
        return false;
      }
    },
    { timeout: opts.timeoutMs ?? 15_000 },
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

    // ─── Phase 1: Step 1 → Step 2 (auto-advance from polling) ─────────
    //
    // Hook the PATCH BEFORE navigating to /onboarding so we don't race
    // the polling-driven advance. The first /tenants/me/provisioning-status
    // poll will return `ready` (we seeded tenant.status = 'active'), the
    // wizard will call advanceTo(2), and persistStep will PATCH
    // `onboarding_step: 2` fire-and-forget.
    const stepTwoPatched = waitForPreferencesPatch(page, {
      predicate: (body) => body.onboarding_step === 2,
    });
    await page.goto(`${BASE_URL}/onboarding`, { waitUntil: 'domcontentloaded' });
    const stepTwoRes = await stepTwoPatched;
    assert(
      stepTwoRes.status() === 200,
      `step-2 PATCH should be 200, got ${stepTwoRes.status()}`,
    );

    // Confirm the wizard actually rendered step 2 before we read the
    // DB or try to click Continue. The template heading only renders
    // when `step === 3 - 1`, i.e. the Phase 1 advance landed.
    const templateHeading = page.locator('h2', { hasText: 'Choose Your Agent Template' });
    await templateHeading.waitFor({ state: 'visible', timeout: 15_000 });

    const prefsAfterStepTwo = await readPreferences(pool, userId);
    assert(
      prefsAfterStepTwo.onboarding_step === 2,
      `users.preferences.onboarding_step should be 2 after step 1→2 advance, got ${JSON.stringify(prefsAfterStepTwo)}`,
    );
    assert(
      prefsAfterStepTwo.onboarding_completed !== true,
      `users.preferences.onboarding_completed must NOT be true mid-flow, got ${JSON.stringify(prefsAfterStepTwo)}`,
    );
    console.log('[e2e] step 1 → step 2: persisted onboarding_step=2');

    // ─── Phase 2: Step 2 → Step 3 (user clicks Continue) ──────────────
    //
    // The seed leaves the default `answering-service` template selected,
    // so handleTemplateConfirm short-circuits to advanceTo(3) without
    // an /agents PATCH — exactly the codepath we want for the resume
    // assertion (no template-update side effects to worry about).
    const stepThreePatched = waitForPreferencesPatch(page, {
      predicate: (body) => body.onboarding_step === 3,
    });
    // Step 1 has unmounted by now (we're on step 2), so there's only
    // one "Continue" button in the DOM — the one inside the step-2
    // card. The "Updating..." label only appears mid-PATCH for the
    // non-default templates, so it doesn't conflict with this match.
    await page.locator('button', { hasText: 'Continue' }).click();
    const stepThreeRes = await stepThreePatched;
    assert(
      stepThreeRes.status() === 200,
      `step-3 PATCH should be 200, got ${stepThreeRes.status()}`,
    );

    // Confirm we actually rendered step 3 in the UI before checking the
    // DB — guards against the case where the PATCH fires but the local
    // step state somehow desyncs.
    const phoneHeading = page.locator('h2', { hasText: 'Add Your First Phone Number' });
    await phoneHeading.waitFor({ state: 'visible', timeout: 15_000 });

    const prefsAfterStepThree = await readPreferences(pool, userId);
    assert(
      prefsAfterStepThree.onboarding_step === 3,
      `users.preferences.onboarding_step should be 3 after step 2→3 advance, got ${JSON.stringify(prefsAfterStepThree)}`,
    );
    assert(
      prefsAfterStepThree.onboarding_completed !== true,
      `users.preferences.onboarding_completed must NOT be true until the user finishes/dismisses, got ${JSON.stringify(prefsAfterStepThree)}`,
    );
    console.log('[e2e] step 2 → step 3: persisted onboarding_step=3');

    // ─── Phase 3: Resume on step 3 after a fresh mount ────────────────
    //
    // Close the browser context entirely (drops in-memory React state
    // AND the auth cookie) and reopen a fresh one. Logging in again
    // mirrors what a returning user actually does: come back the next
    // day, sign in, expect to be dropped back where they were. A simple
    // page.reload() would leave the session cookie in place and is a
    // weaker test of the resume contract.
    await ctx.close();
    ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await ctx.newPage();
    await tenantUiLogin(page);

    await page.goto(`${BASE_URL}/onboarding`, { waitUntil: 'domcontentloaded' });

    // The resume check: after the saved-progress effect runs, the wizard
    // must show step 3 (the phone-number step), NOT step 1's "Setting
    // Up Your Environment". Wait on the step-3 heading directly — it
    // only renders when `step === 3`.
    const resumedPhoneHeading = page.locator('h2', { hasText: 'Add Your First Phone Number' });
    await resumedPhoneHeading.waitFor({ state: 'visible', timeout: 15_000 });

    // Belt-and-suspenders: assert the step-1 heading is NOT showing.
    // If `clampStep` ever regressed to ignore the saved value, the
    // wizard would render step 1 and this assertion would catch it
    // even if some future refactor moved the step-3 heading text.
    const setupHeadingCount = await page
      .locator('h2', { hasText: 'Setting Up Your Environment' })
      .count();
    assert(
      setupHeadingCount === 0,
      `wizard should resume on step 3, but the step-1 "Setting Up Your Environment" heading is still rendered`,
    );

    // And the persisted step must still be 3 — i.e. the resume path
    // didn't accidentally PATCH `onboarding_step: 1` on mount.
    const prefsAfterResume = await readPreferences(pool, userId);
    assert(
      prefsAfterResume.onboarding_step === 3,
      `users.preferences.onboarding_step should still be 3 after resume, got ${JSON.stringify(prefsAfterResume)}`,
    );
    console.log('[e2e] resume: wizard re-opened on step 3 with onboarding_step=3 intact');

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
