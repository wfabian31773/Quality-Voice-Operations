/**
 * Task #1216: end-to-end regression for the FORWARD-skip guard on the
 * onboarding wizard's progress dots.
 *
 * Why this exists in addition to onboardingProgressDotsBackNav.spec.ts:
 *   The back-nav spec proves that, AFTER reaching step 3, the user can
 *   navigate backwards via Back buttons and previously-visited dots and
 *   that `maxVisitedStep` correctly clamps each dot's clickability so a
 *   user who came back to step 1 can still jump forward to step 3 (the
 *   highest visited). What it does NOT cover is the inverse guard:
 *   `goToStep` (in `client-app/src/pages/Onboarding.tsx`) explicitly
 *   refuses any target greater than `maxVisitedStep`, and the render
 *   block reflects that refusal by emitting the dot as a non-interactive
 *   `<div aria-hidden="true">` (no onClick, no role, no aria-label)
 *   instead of a `<button>`. A regression that flipped the `isClickable`
 *   ternary, removed the `target > maxVisitedStep` short-circuit inside
 *   `goToStep`, or turned the dot into a `<button>` early would let
 *   users skip past the template confirmation (or the provisioning
 *   wait) by clicking ahead — and break the funnel without any spec
 *   catching it.
 *
 * What this spec asserts (against a freshly-seeded user pinned to step 1):
 *   1. The step-2 and step-3 progress dots are NOT rendered as
 *      `<button>` elements. We assert via accessible-name lookup
 *      (`Go to step 2: Template`, `Go to step 3: Phone number`) that
 *      no such button exists on the page. The non-interactive
 *      `<div aria-hidden="true">` fallback exposes neither a role
 *      nor an accessible name, so the lookup must come back empty.
 *   2. Clicking on the unvisited-dot regions (the only entry point a
 *      user has to attempt forward navigation via the dots) does NOT
 *      fire a PATCH `/me/preferences` with an `onboarding_step` value
 *      higher than 1. The PATCH listener is installed BEFORE the
 *      click attempts so we can't miss a fast-fire request.
 *   3. The wizard remains on step 1 after the click attempts —
 *      verified by the persisted "Setting Up Your Environment"
 *      heading and by reading the source-of-truth `users.preferences`
 *      blob from Postgres (still empty / no `onboarding_step` key).
 *
 * Why we pin the tenant to `status = 'provisioning'` instead of `active`:
 *   The sibling resume + back-nav specs seed `status = 'active'` so
 *   `/tenants/me/provisioning-status` returns `ready` on the first
 *   poll and the wizard auto-advances to step 2. THAT is exactly what
 *   we need to prevent here — we want the wizard stuck on step 1 with
 *   `maxVisitedStep === 1`, so the dots-2-and-3 forward-skip guard is
 *   the only thing between the user and step 3. Setting tenant.status
 *   to `'provisioning'` makes `getProvisioningStatus` return
 *   `'provisioning'` (see `platform/tenant/provisioning/
 *   TenantProvisioningService.ts`); the dev-mode auto-provision path
 *   in `server/admin-api/routes/tenants.ts` only triggers on the
 *   `'pending'` branch, so `'provisioning'` is safe — the tenant
 *   stays non-ready for the duration of the spec and no automatic
 *   advance fires.
 *
 * Why we DON'T also dispatch a synthetic `goToStep(3)` JS call:
 *   The task scope says "via the only entry point users have (a
 *   click)". `goToStep` is an internal closure, not exposed on
 *   `window`, so the production attack surface IS the dot click. If
 *   the dot stops rendering as a non-interactive div (regression),
 *   the click will go through `onClick={() => goToStep(s)}` and the
 *   PATCH assertion below will catch it. If the dot stays a div but
 *   `goToStep` itself loses its `target > maxVisitedStep` guard, the
 *   click still won't fire because the div has no onClick — but that
 *   regression is impossible to hit through the UI (no other call
 *   site exists on step 1) and is covered structurally by the
 *   sibling back-nav spec when `maxVisitedStep === 3` and the dots
 *   are buttons.
 *
 * Standalone runner:
 *
 *   E2E_ADMIN_PASSWORD='test-password-123' \
 *     npx tsx tests/e2e/onboardingProgressDotsNoSkipAhead.spec.ts
 *
 * Pre-requisites:
 *   - Platform Dev workflow running (admin API on :3002, vite on :5000).
 *   - DATABASE_URL is set so the spec can (idempotently) seed a tenant
 *     user pinned to `provisioning` and reset its `preferences` blob.
 *   - Playwright browsers installed: `npx playwright install chromium`.
 *
 * Why we DON'T delete the seeded tenant after the test:
 *   `audit_logs` is immutable in this schema (BEFORE UPDATE / BEFORE
 *   DELETE triggers raise). Logging in writes a `user.login` audit row
 *   that references the user via FK ON DELETE SET NULL. Removing the
 *   user would trigger that SET NULL, which the immutability trigger
 *   refuses. Same pattern as the sibling onboarding specs — we use a
 *   stable email/tenant id and upsert idempotently. The seed uses
 *   identifiers distinct from the BL-013, dismiss/restart, resume,
 *   and back-nav fixtures so the specs cannot interfere if they ever
 *   run in parallel against the same DB.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { mkdir } from 'fs/promises';
import path from 'path';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'onboarding-progress-dots-no-skip-ahead';

// Stable identifiers — distinct from the BL-013, dismiss/restart, resume,
// and back-nav fixtures so the specs cannot interfere if they ever run
// against the same DB in parallel.
const TENANT_USER_EMAIL =
  process.env.E2E_NO_SKIP_USER_EMAIL ?? 't1216-no-skip@voiceaihub.test';
const TENANT_USER_PASSWORD =
  process.env.E2E_NO_SKIP_USER_PASSWORD ?? 'NoSkipOnboardingTest!2026';
const TENANT_ID = process.env.E2E_NO_SKIP_TENANT_ID ?? 't1216-no-skip-tenant';
const TENANT_SLUG =
  process.env.E2E_NO_SKIP_TENANT_SLUG ?? 't1216-no-skip-tenant';

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
 * The tenant is seeded as `status = 'provisioning'` so
 * `/tenants/me/provisioning-status` returns `provisioning` on every
 * poll — the wizard's auto-advance from step 1 only fires on `ready`.
 * That keeps `maxVisitedStep` at 1 and makes step-2 + step-3 dots the
 * unvisited (non-clickable) variant, which is exactly what this spec
 * is here to verify cannot be skipped past.
 *
 * The dev-mode auto-provision branch in `server/admin-api/routes/
 * tenants.ts` only triggers on the `'pending'` branch, so seeding the
 * tenant as `'provisioning'` skips that branch entirely and the tenant
 * stays non-ready for the duration of the spec.
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
    // We force `status = 'provisioning'` on every run so a previous test
    // pass that left the tenant `active` doesn't leak into this run.
    await client.query(
      `INSERT INTO tenants (id, name, slug, status, plan, settings, feature_flags, created_at)
       VALUES ($1, 'No-skip e2e Tenant', $2, 'provisioning', 'starter',
               '{"timezone": "America/New_York"}'::jsonb,
               '{}'::jsonb,
               NOW() - INTERVAL '7 days')
       ON CONFLICT (id) DO UPDATE SET
         status = 'provisioning',
         created_at = LEAST(tenants.created_at, EXCLUDED.created_at),
         updated_at = NOW()`,
      [TENANT_ID, TENANT_SLUG],
    );

    const passwordHash = await bcrypt.hash(TENANT_USER_PASSWORD, 12);

    const userResult = await client.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, first_name, password_hash,
                          role, is_active, is_platform_admin, email_verified,
                          preferences)
       VALUES ($1, $2, 'No-skip Tester', $3, 'admin', TRUE, FALSE, TRUE,
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

    // Record EVERY PATCH /me/preferences request body so we can prove,
    // after the click attempts, that none of them carried an
    // `onboarding_step` value greater than 1. We attach the listener
    // before navigation so we don't miss anything fired during initial
    // mount or polling. Bodies are kept verbatim for the failure
    // message — if the assertion ever trips, the diff is the evidence.
    const patchedSteps: Array<{ url: string; body: unknown }> = [];
    page.on('request', (req) => {
      try {
        if (req.method() !== 'PATCH') return;
        if (!/\/api\/me\/preferences(\?|$)/.test(req.url())) return;
        const raw = req.postData() ?? '{}';
        const body = JSON.parse(raw) as Record<string, unknown>;
        if ('onboarding_step' in body) {
          patchedSteps.push({ url: req.url(), body });
        }
      } catch {
        // Ignore unparseable bodies — the wizard always sends JSON, so
        // a parse failure here would be a different bug entirely and
        // shouldn't mask the assertion below.
      }
    });

    await tenantUiLogin(page);
    console.log(`[e2e] logged in as ${TENANT_USER_EMAIL}`);

    await page.goto(`${BASE_URL}/onboarding`, { waitUntil: 'domcontentloaded' });

    // Wait for the step-1 panel to render. Step 1's heading is
    // "Setting Up Your Environment" regardless of whether provisioning
    // status is `provisioning` (loader branch) or `ready` (continue
    // branch) — the heading is rendered once, with the body swapping
    // underneath. We additionally guard against accidental advance by
    // waiting for the in-progress copy ("Provisioning your environment...")
    // before reading the dots, which only renders on the loader branch.
    const setupHeading = page.locator('h2', { hasText: 'Setting Up Your Environment' });
    await setupHeading.waitFor({ state: 'visible', timeout: 15_000 });
    const provisioningCopy = page.locator('p', { hasText: 'Provisioning your environment' });
    await provisioningCopy.waitFor({ state: 'visible', timeout: 15_000 });
    console.log('[e2e] wizard rendered step 1 (provisioning loader branch)');

    // ─── Phase 1: dots 2 and 3 are NOT rendered as <button> ───────────
    //
    // The clickable variant of the dot is a `<button aria-label="Go to
    // step N: <label>">` whose accessible name is exactly the format
    // emitted by `t('onboarding.go_to_step_aria', { step, label })`.
    // The non-interactive fallback is a `<div aria-hidden="true">`
    // that exposes neither a role nor an accessible name. So if the
    // forward-skip guard is intact, no button matching either name
    // exists on the page.
    const stepTwoButton = page.getByRole('button', { name: 'Go to step 2: Template' });
    const stepThreeButton = page.getByRole('button', { name: 'Go to step 3: Phone number' });

    const stepTwoButtonCount = await stepTwoButton.count();
    const stepThreeButtonCount = await stepThreeButton.count();
    assert(
      stepTwoButtonCount === 0,
      `step-2 progress dot must NOT render as <button> on a fresh wizard (maxVisitedStep === 1), got ${stepTwoButtonCount} matching button(s)`,
    );
    assert(
      stepThreeButtonCount === 0,
      `step-3 progress dot must NOT render as <button> on a fresh wizard (maxVisitedStep === 1), got ${stepThreeButtonCount} matching button(s)`,
    );
    console.log('[e2e] step-2 and step-3 dots correctly render as non-interactive divs');

    // Sanity check: step 1 IS still a button (the active step renders
    // as a disabled button, not the non-interactive fallback). If this
    // ever flips, the regression has gone the opposite direction —
    // dots have stopped rendering as buttons entirely — which would
    // be its own UX regression worth catching here even though the
    // task is technically forward-skip-focused.
    const stepOneButton = page.getByRole('button', { name: 'Go to step 1: Setup' });
    await stepOneButton.waitFor({ state: 'visible', timeout: 5_000 });
    console.log('[e2e] step-1 dot still renders as <button> (active-step sanity check)');

    // ─── Phase 2: clicking the unvisited-dot regions does NOT fire ───
    //          a forward-skip PATCH                                  ───
    //
    // The unvisited dots render as `<div aria-hidden="true">` (the
    // pill itself) inside a `<div className="flex flex-col
    // items-center gap-2">` wrapper that also contains a `<span>`
    // with the step label. Locating the wrapper by its label text is
    // unambiguous because the label words ("Template", "Phone
    // number") don't appear elsewhere on step 1 — the step-2 panel
    // ("Choose Your Agent Template") and step-3 panel ("Add Your
    // First Phone Number") aren't mounted yet.
    //
    // We click both the wrapper bounding box AND the inner dot div
    // for each unvisited step. That covers both regression shapes
    // the forward-skip guard exists to prevent:
    //   (a) Wrapper acquired an onClick handler (e.g. someone hoisted
    //       the button's onClick onto the parent so the dot stayed
    //       a div but became "clickable" via event delegation).
    //   (b) The dot div itself acquired an onClick / role="button"
    //       (e.g. someone removed the `isClickable` ternary and made
    //       the dot interactive directly).
    // If either regression lands, one of the four clicks below will
    // route through `goToStep` and fire a PATCH(onboarding_step > 1),
    // which the assertion further down will catch.
    const stepTwoWrapper = page.locator(
      'div.flex.flex-col.items-center.gap-2', { hasText: 'Template' },
    );
    const stepThreeWrapper = page.locator(
      'div.flex.flex-col.items-center.gap-2', { hasText: 'Phone number' },
    );
    // The visual dot inside each wrapper is the `<div aria-hidden="true">`
    // child — `aria-hidden` distinguishes it from the wrapper itself,
    // which has no aria-hidden attribute.
    const stepTwoDot = stepTwoWrapper.locator('div[aria-hidden="true"]');
    const stepThreeDot = stepThreeWrapper.locator('div[aria-hidden="true"]');

    await stepTwoWrapper.waitFor({ state: 'visible', timeout: 5_000 });
    await stepThreeWrapper.waitFor({ state: 'visible', timeout: 5_000 });
    await stepTwoDot.waitFor({ state: 'visible', timeout: 5_000 });
    await stepThreeDot.waitFor({ state: 'visible', timeout: 5_000 });

    // `force: true` because these elements aren't focusable targets —
    // playwright's actionability checks would otherwise insist on
    // hover/scroll semantics that don't matter for this test. We're
    // not trying to simulate a real user; we're trying to deliver a
    // click event to the DOM region the dot occupies and confirm no
    // handler picks it up.
    await stepTwoWrapper.click({ force: true });
    await stepTwoDot.click({ force: true });
    await stepThreeWrapper.click({ force: true });
    await stepThreeDot.click({ force: true });
    console.log('[e2e] clicked through step-2 and step-3 dot wrappers + dot divs');

    // Give any stray fire-and-forget PATCH a generous window to
    // surface. `persistStep` is fully synchronous-to-fire (no awaits
    // ahead of the PATCH) so 1500ms is well past any reasonable
    // dispatch latency — if a forward-skip PATCH was going to fire,
    // it's already on the wire by now. The polling effect runs every
    // 3000ms but only ever fires GETs, never PATCHes, so the wait
    // can't accidentally pick up unrelated traffic.
    await page.waitForTimeout(1500);

    const skipAheadPatches = patchedSteps.filter((p) => {
      const step = (p.body as { onboarding_step?: unknown }).onboarding_step;
      return typeof step === 'number' && step > 1;
    });
    assert(
      skipAheadPatches.length === 0,
      `no PATCH /me/preferences should fire with onboarding_step > 1 from a fresh step-1 wizard, got ${JSON.stringify(skipAheadPatches)}`,
    );
    console.log('[e2e] no forward-skip PATCH fired from dot click attempts');

    // ─── Phase 3: wizard still on step 1, preferences untouched ──────
    //
    // Belt-and-suspenders: the click attempts must leave the visible
    // step unchanged AND the persisted source-of-truth blob clean.
    // The "Setting Up Your Environment" heading + provisioning loader
    // copy are still mounted (we never navigated away), and the
    // user's preferences blob should still lack an `onboarding_step`
    // key (it was reset to `{}` in seedTenantUser and no PATCH fired).
    await setupHeading.waitFor({ state: 'visible', timeout: 5_000 });
    await provisioningCopy.waitFor({ state: 'visible', timeout: 5_000 });

    const prefsAfterClicks = await readPreferences(pool, userId);
    const persistedStep = prefsAfterClicks.onboarding_step;
    assert(
      persistedStep === undefined || persistedStep === 1,
      `users.preferences.onboarding_step must remain unset (or 1) after blocked dot clicks, got ${JSON.stringify(prefsAfterClicks)}`,
    );
    assert(
      prefsAfterClicks.onboarding_completed !== true,
      `users.preferences.onboarding_completed must NOT be true on a fresh wizard, got ${JSON.stringify(prefsAfterClicks)}`,
    );
    console.log('[e2e] wizard still on step 1; preferences blob untouched');

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
