/**
 * Task #1203: end-to-end regression for the BACKWARD-navigation paths of
 * the onboarding wizard's progress dots and "Back" button.
 *
 * Why this exists in addition to onboardingResumeSavedStep.spec.ts:
 *   The resume spec only exercises the forward path
 *   (step 1 → 2 → 3 → resume). It does not touch:
 *     - `goBack` (the "Back" button on steps 2 and 3), or
 *     - `goToStep` (clicking a previously-visited progress dot).
 *   Both call `persistStep` and rely on `maxVisitedStep` to gate which
 *   dots are clickable. A regression in either could:
 *     - Persist a step lower than the one the user actually reached, OR
 *     - Mis-clamp the dot-clickability gate so the user can no longer
 *       jump back forward to where they were.
 *   Either failure mode would silently send returning users backwards
 *   on resume — exactly the bug the resume spec was written to prevent
 *   on the forward path, but on a different code path.
 *
 * What this spec asserts:
 *   1. Advancing the wizard 1 → 2 → 3 (same auto-advance + Continue
 *      pattern as the resume spec) leaves `onboarding_step = 3` in
 *      `users.preferences`.
 *   2. Clicking the step-3 "Back" button (`goBack`) navigates back to
 *      step 2 AND PATCHes `onboarding_step: 2` to the source of truth.
 *   3. Clicking the step-2 "Back" button (`goBack` again) navigates
 *      back to step 1 AND PATCHes `onboarding_step: 1`.
 *   4. After landing back on step 1, the step-3 progress dot is STILL
 *      a clickable button (i.e. `maxVisitedStep` correctly remembered
 *      that step 3 was reached). This is the regression guard for the
 *      "max visited" clamp — if it ever started tracking the *current*
 *      step instead of the high-water mark, the user would be stranded
 *      at step 1 with no way forward except re-doing the flow.
 *   5. Clicking the step-3 dot (`goToStep`) jumps the wizard back to
 *      step 3 AND PATCHes `onboarding_step: 3` — proving the dot's
 *      onClick wires through `persistStep` the same way the Back
 *      button does.
 *
 * Why we DON'T also cover step 3 → step 1 in a single dot click:
 *   The dot click handler caps at `maxVisitedStep`, so jumping
 *   backward by more than one step IS a valid path, but adding it
 *   would only re-prove what (2) and (3) already prove (persistStep
 *   fires for any backward target). Keeping the assertions focused
 *   on each unique code path keeps the spec quick to triage.
 *
 * Why polling can't yank us forward mid-test:
 *   `pollStatus` only auto-advances via `advanceTo(2)` when the
 *   provisioning status flips to `ready`. The polling `setInterval`
 *   clears itself the instant `provisioningStatus.status === 'ready'`
 *   (see the gated effect in Onboarding.tsx), and the seed lands the
 *   tenant in `active` so the first poll already sets ready. By the
 *   time we navigate backwards, no further polls fire — `goBack`'s
 *   target persists without contention.
 *
 * Standalone runner:
 *
 *   E2E_ADMIN_PASSWORD='test-password-123' \
 *     npx tsx tests/e2e/onboardingProgressDotsBackNav.spec.ts
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
 *   refuses. Same pattern as the sibling onboarding specs — we use a
 *   stable email/tenant id and upsert idempotently. The seed uses
 *   identifiers distinct from the resume + dismiss/restart fixtures
 *   so the three specs cannot interfere if they ever run in parallel
 *   against the same DB.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { mkdir } from 'fs/promises';
import path from 'path';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'onboarding-progress-dots-back-nav';

// Stable identifiers — distinct from the BL-013, dismiss/restart, and
// resume-saved-step fixtures so the specs cannot interfere if they ever
// run against the same DB in parallel.
const TENANT_USER_EMAIL =
  process.env.E2E_BACK_NAV_USER_EMAIL ?? 't1203-back-nav@voiceaihub.test';
const TENANT_USER_PASSWORD =
  process.env.E2E_BACK_NAV_USER_PASSWORD ?? 'BackNavOnboardingTest!2026';
const TENANT_ID = process.env.E2E_BACK_NAV_TENANT_ID ?? 't1203-back-nav-tenant';
const TENANT_SLUG =
  process.env.E2E_BACK_NAV_TENANT_SLUG ?? 't1203-back-nav-tenant';

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
 * That triggers the wizard's auto-advance from step 1 to step 2 — the
 * production path used to land the user on the step we then back away
 * from.
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
    // heuristic. Same age-out pattern as the sibling onboarding specs.
    await client.query(
      `INSERT INTO tenants (id, name, slug, status, plan, settings, feature_flags, created_at)
       VALUES ($1, 'Back-nav e2e Tenant', $2, 'active', 'starter',
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
       VALUES ($1, $2, 'Back-nav Tester', $3, 'admin', TRUE, FALSE, TRUE,
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
    // the polling-driven advance. Same setup as the resume spec — once
    // the first /tenants/me/provisioning-status returns `ready`, the
    // wizard advances to step 2 and persists onboarding_step=2.
    const stepTwoPatched = waitForPreferencesPatch(page, {
      predicate: (body) => body.onboarding_step === 2,
    });
    await page.goto(`${BASE_URL}/onboarding`, { waitUntil: 'domcontentloaded' });
    const stepTwoRes = await stepTwoPatched;
    assert(
      stepTwoRes.status() === 200,
      `step-2 PATCH should be 200, got ${stepTwoRes.status()}`,
    );

    const templateHeading = page.locator('h2', { hasText: 'Choose Your Agent Template' });
    await templateHeading.waitFor({ state: 'visible', timeout: 15_000 });
    console.log('[e2e] step 1 → step 2: wizard rendered template step');

    // ─── Phase 2: Step 2 → Step 3 (Continue with default template) ────
    //
    // Same default-template short-circuit as the resume spec — keeps
    // the transition free of /agents PATCH side effects.
    const stepThreePatched = waitForPreferencesPatch(page, {
      predicate: (body) => body.onboarding_step === 3,
    });
    await page.locator('button', { hasText: 'Continue' }).click();
    await stepThreePatched;

    const phoneHeading = page.locator('h2', { hasText: 'Add Your First Phone Number' });
    await phoneHeading.waitFor({ state: 'visible', timeout: 15_000 });

    const prefsAfterStepThree = await readPreferences(pool, userId);
    assert(
      prefsAfterStepThree.onboarding_step === 3,
      `users.preferences.onboarding_step should be 3 after step 2→3 advance, got ${JSON.stringify(prefsAfterStepThree)}`,
    );
    console.log('[e2e] step 2 → step 3: persisted onboarding_step=3');

    // ─── Phase 3: Step 3 → Step 2 via "Back" button (goBack) ──────────
    //
    // The step-3 "Back to template" link calls `goBack`, which
    // decrements the local step state AND fire-and-forgets a
    // PATCH(onboarding_step: 2). The step-3 panel renders multiple
    // buttons ("Add Phone Number", "Skip for Now — Go to Dashboard",
    // "Back to template"), so scope the locator to the unique
    // "Back to template" accessible name (translation key
    // onboarding.phone.back -> "Back to template" in en).
    const stepTwoFromBackPatched = waitForPreferencesPatch(page, {
      predicate: (body) => body.onboarding_step === 2,
    });
    await page.getByRole('button', { name: 'Back to template' }).click();
    await stepTwoFromBackPatched;

    // Wait for the step-2 panel to actually render before we read the
    // DB — the heading is the same one we waited on in Phase 1.
    await templateHeading.waitFor({ state: 'visible', timeout: 15_000 });

    const prefsAfterBackToTwo = await readPreferences(pool, userId);
    assert(
      prefsAfterBackToTwo.onboarding_step === 2,
      `users.preferences.onboarding_step should be 2 after step 3→2 goBack, got ${JSON.stringify(prefsAfterBackToTwo)}`,
    );
    assert(
      prefsAfterBackToTwo.onboarding_completed !== true,
      `users.preferences.onboarding_completed must NOT be true mid-flow, got ${JSON.stringify(prefsAfterBackToTwo)}`,
    );
    console.log('[e2e] step 3 → step 2: goBack persisted onboarding_step=2');

    // ─── Phase 4: Step 2 → Step 1 via "Back" button (goBack again) ────
    //
    // The step-2 panel's "Back" button reads "Back" (translation key
    // onboarding.template.back -> "Back"). Same exact-match locator
    // works since only one button on this panel matches.
    const stepOneFromBackPatched = waitForPreferencesPatch(page, {
      predicate: (body) => body.onboarding_step === 1,
    });
    await page.getByRole('button', { name: /^Back$/ }).click();
    await stepOneFromBackPatched;

    // Step 1 renders the "Setting Up Your Environment" heading
    // regardless of whether provisioning is ready (the "ready" branch
    // just swaps the body content, not the title). Waiting on it
    // confirms the wizard actually rendered step 1.
    const setupHeading = page.locator('h2', { hasText: 'Setting Up Your Environment' });
    await setupHeading.waitFor({ state: 'visible', timeout: 15_000 });

    const prefsAfterBackToOne = await readPreferences(pool, userId);
    assert(
      prefsAfterBackToOne.onboarding_step === 1,
      `users.preferences.onboarding_step should be 1 after step 2→1 goBack, got ${JSON.stringify(prefsAfterBackToOne)}`,
    );
    console.log('[e2e] step 2 → step 1: goBack persisted onboarding_step=1');

    // ─── Phase 5: maxVisitedStep gate — step-3 dot is still clickable ─
    //
    // After two backward navigations we're on step 1, but
    // `maxVisitedStep` should still be 3. That means all three dots
    // render as <button> elements (not disabled <div>s) and the
    // step-3 dot in particular is enabled. If `maxVisitedStep` ever
    // regressed to track the *current* step, the step-3 dot would
    // collapse into the non-interactive <div> branch and this
    // assertion would catch it.
    const stepThreeDot = page.getByRole('button', {
      name: 'Go to step 3: Phone number',
    });
    await stepThreeDot.waitFor({ state: 'visible', timeout: 5_000 });
    const stepThreeDotEnabled = await stepThreeDot.isEnabled();
    assert(
      stepThreeDotEnabled,
      'step-3 progress dot must remain clickable after navigating back to step 1 (maxVisitedStep regression)',
    );
    console.log('[e2e] step-3 dot is still clickable on step 1 (maxVisitedStep intact)');

    // ─── Phase 6: Step 1 → Step 3 via dot click (goToStep) ────────────
    //
    // Clicking the step-3 dot exercises `goToStep(3)`, which is a
    // separate code path from `goBack`. It must (a) move the wizard
    // to step 3 and (b) PATCH onboarding_step=3 — proving the dot's
    // onClick wires through `persistStep` the same way the Back
    // button does.
    const stepThreeFromDotPatched = waitForPreferencesPatch(page, {
      predicate: (body) => body.onboarding_step === 3,
    });
    await stepThreeDot.click();
    await stepThreeFromDotPatched;

    await phoneHeading.waitFor({ state: 'visible', timeout: 15_000 });

    const prefsAfterDotJump = await readPreferences(pool, userId);
    assert(
      prefsAfterDotJump.onboarding_step === 3,
      `users.preferences.onboarding_step should be 3 after dot-click goToStep, got ${JSON.stringify(prefsAfterDotJump)}`,
    );
    console.log('[e2e] step 1 → step 3: goToStep persisted onboarding_step=3');

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
