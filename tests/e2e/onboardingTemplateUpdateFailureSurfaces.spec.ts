/**
 * Task #1218 / #1249: end-to-end regression for the FAILURE branch of
 * the onboarding wizard's step 2 → step 3 transition.
 *
 * Why this exists alongside onboardingTemplateUpdatesAgent.spec.ts:
 *   The sibling spec covers the happy path — PATCH /agents/:id 200, the
 *   wizard advances to step 3, the agent row holds the new template
 *   copy. It does NOT exercise what happens when the PATCH fails. Task
 *   #1218 fixed a bug where a failed PATCH used to silently advance the
 *   wizard to step 3 anyway, leaving the user on the generic
 *   answering-service prompt with no signal their pick didn't apply.
 *   The fix surfaces an inline alert on step 2 and relabels the
 *   Continue button to "Try again" so the user can retry. This spec
 *   pins down that contract so a future regression that re-introduces
 *   the silent-advance bug fails CI instead of shipping.
 *
 * What this spec asserts:
 *   1. With a Playwright `page.route` override forcing every
 *      `PATCH /api/agents/:id` to a 5xx, picking the
 *      `medical-after-hours` template and clicking Continue:
 *        a. The wizard STAYS on step 2 — the template heading is still
 *           visible and the step-3 phone-number heading never appears.
 *        b. A visible `role="alert"` element appears whose text
 *           mentions the failure (we match the
 *           `onboarding.template.update_failed*` strings from the
 *           English locale so a wording change is caught explicitly).
 *        c. The primary action button is relabelled "Try again".
 *   2. After removing the route override, clicking the relabelled
 *      "Try again" button fires a real `PATCH /api/agents/:id` 200 and
 *      the wizard finally advances to step 3.
 *
 * Why we DON'T also assert the persisted DB state on the retry:
 *   The sibling onboardingTemplateUpdatesAgent.spec.ts already pins
 *   down what gets written to the agent row on a successful PATCH —
 *   `type`, `name`, `welcome_greeting`, `system_prompt`. Re-asserting
 *   the same four columns here would just duplicate that contract.
 *   This spec's job is the failure→retry UX, not the column mapping.
 *
 * Standalone runner:
 *
 *   E2E_ADMIN_PASSWORD='test-password-123' \
 *     npx tsx tests/e2e/onboardingTemplateUpdateFailureSurfaces.spec.ts
 *
 * Pre-requisites:
 *   - Platform Dev workflow running (admin API on :3002, vite on :5000).
 *   - DATABASE_URL is set so the spec can (idempotently) seed a tenant,
 *     user, and starter agent.
 *   - Playwright browsers installed: `npx playwright install chromium`.
 *
 * Why we DON'T delete the seeded tenant after the test:
 *   `audit_logs` is immutable in this schema (BEFORE UPDATE / BEFORE
 *   DELETE triggers raise). Logging in writes a `user.login` audit row,
 *   and the successful retry-PATCH writes an `agent.updated` row, both
 *   of which reference the user via FK ON DELETE SET NULL. Removing
 *   the user would trigger that SET NULL, which the immutability
 *   trigger refuses. Same pattern as the sibling onboarding specs — we
 *   use stable identifiers and upsert idempotently. Identifiers here
 *   are distinct from every other onboarding spec so they cannot
 *   interfere if the suite ever runs against the same DB.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { mkdir } from 'fs/promises';
import path from 'path';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'onboarding-template-update-failure-surfaces';

// Stable identifiers — the seed is idempotent (upsert), so reruns reuse
// the same row. Distinct from every other onboarding spec's fixtures so
// the specs cannot interfere if they ever run against the same DB.
const TENANT_USER_EMAIL =
  process.env.E2E_TEMPLATE_FAIL_USER_EMAIL ?? 't1249-template-fail@voiceaihub.test';
const TENANT_USER_PASSWORD =
  process.env.E2E_TEMPLATE_FAIL_USER_PASSWORD ?? 'TemplateFailOnboardingTest!2026';
const TENANT_ID =
  process.env.E2E_TEMPLATE_FAIL_TENANT_ID ?? 't1249-template-fail-tenant';
const TENANT_SLUG =
  process.env.E2E_TEMPLATE_FAIL_TENANT_SLUG ?? 't1249-template-fail-tenant';

// The non-default template we'll pick. Has to be one whose value is in
// `AGENT_TYPE_TO_TEMPLATE` in client-app/src/pages/Onboarding.tsx so
// `handleTemplateConfirm` actually fires the PATCH (selecting
// `answering-service` short-circuits without one).
const PICKED_TEMPLATE_TYPE = 'medical-after-hours';

// English copy from `client-app/src/locales/en/common.json`. Hardcoded
// rather than imported so this spec runs cleanly under plain `tsx`
// outside the bundler — the locale JSON would import fine on its own,
// but keeping the entire spec import-free of client-app code matches
// the sibling onboarding specs' pattern. If these strings change
// upstream the spec will need to be updated alongside; that's the
// intentional contract — we want a wording regression in the
// failure-surface UI to fail loudly here.
const TEMPLATE_HEADING_TEXT = 'Choose Your Agent Template';
const PHONE_HEADING_TEXT = 'Add Your First Phone Number';
const ALERT_TITLE_TEXT = "Couldn't apply that template";
// The api client wraps a non-OK 5xx with no body as the friendly
// fallback "The server didn't respond as expected. Please try again."
// (see client-app/src/lib/api.ts — Task #1279), and
// `handleTemplateConfirm` interpolates that as the `{{detail}}` of the
// `_with_detail` variant. We assert two things:
//   - the shared lead-in (`ALERT_DETAIL_PREFIX`) so the spec doesn't
//     pin itself to the transient HTTP status code, and
//   - that the user-visible alert body NEVER again leaks the raw
//     `Request failed: <status>` developer string from the api client.
const ALERT_DETAIL_PREFIX =
  "We couldn't update your agent with the chosen template";
const ALERT_FRIENDLY_DETAIL =
  "The server didn't respond as expected. Please try again.";
const ALERT_RAW_LEAK_FRAGMENT = 'Request failed:';
const TRY_AGAIN_BUTTON_TEXT = 'Try again';

// What the seed writes to the starter agent. We RESET back to these
// generic defaults on every run (matching what
// `TenantProvisioningService.createDefaultAgent` would produce) so the
// retry PATCH has something meaningful to overwrite — same precondition
// the sibling happy-path spec relies on.
const SEED_AGENT_NAME = 'Default Answering Service';
const SEED_AGENT_TYPE = 'answering-service';
const SEED_AGENT_GREETING = 'Hello! Thank you for calling. How can I help you today?';
const SEED_AGENT_SYSTEM_PROMPT = `You are a friendly, professional voice agent.
- Greet the caller warmly and confirm how you can help.
- Listen carefully, ask clarifying questions when needed, and confirm details before acting.
- Always respond in English.
- Keep replies concise and natural for spoken conversation.
- If the caller asks for something outside your scope, politely offer to escalate or take a message.`;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

/**
 * Seed an isolated tenant + non-admin tenant user + starter agent. The
 * tenant is seeded as `status = 'active'` so
 * `/tenants/me/provisioning-status` returns `ready` on the first poll
 * and the wizard auto-advances from step 1 to step 2 — this spec is
 * about step 2's failure handling, not step 1's polling.
 *
 * The user's preferences are reset to `{}` so neither
 * `onboarding_completed` nor `onboarding_step` carries over from a
 * previous run — otherwise the wizard might resume on step 3 and we'd
 * never click Continue at all.
 */
async function seedTenantUserAndAgent(
  pool: pg.Pool,
): Promise<{ userId: string; agentId: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // RLS is enabled on most tables; turn it off for this connection's
    // transaction so the seed inserts can write across tenants without
    // needing a tenant context (matches signup + sibling spec patterns).
    await client.query(`SET LOCAL row_security = off`);

    // Backdate the tenant's created_at so the TenantLayout onboarding
    // gate doesn't bounce us based on the "<24h old AND no phone numbers"
    // heuristic. Same age-out pattern as the sibling specs.
    await client.query(
      `INSERT INTO tenants (id, name, slug, status, plan, settings, feature_flags, created_at)
       VALUES ($1, 'Template Failure e2e Tenant', $2, 'active', 'starter',
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
       VALUES ($1, $2, 'Template Fail Tester', $3, 'admin', TRUE, FALSE, TRUE,
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

    // Reset every existing agent for this tenant back to the generic
    // defaults so a previous run's medical-template state can't poison
    // this run's retry behaviour, AND so the agent the wizard's
    // `GET /agents` will hand to the PATCH (newest-first) is always
    // one we just reset.
    await client.query(
      `UPDATE agents SET
         name = $2,
         type = $3,
         welcome_greeting = $4,
         system_prompt = $5,
         status = 'active',
         updated_at = NOW()
       WHERE tenant_id = $1`,
      [
        TENANT_ID,
        SEED_AGENT_NAME,
        SEED_AGENT_TYPE,
        SEED_AGENT_GREETING,
        SEED_AGENT_SYSTEM_PROMPT,
      ],
    );

    // First-ever-run insert: if the tenant has no starter agent yet,
    // create one mirroring `TenantProvisioningService.createDefaultAgent`.
    const { rowCount: existingCount } = await client.query(
      `SELECT 1 FROM agents WHERE tenant_id = $1 LIMIT 1`,
      [TENANT_ID],
    );
    if (existingCount === 0) {
      await client.query(
        `INSERT INTO agents (tenant_id, name, type, status, system_prompt,
                             welcome_greeting, voice, model, temperature,
                             tools, escalation_config, metadata)
         VALUES ($1, $2, $3, 'active', $5, $4, 'sage',
                 'gpt-4o-realtime-preview', 0.8, '[]'::jsonb,
                 '{}'::jsonb, '{}'::jsonb)`,
        [
          TENANT_ID,
          SEED_AGENT_NAME,
          SEED_AGENT_TYPE,
          SEED_AGENT_GREETING,
          SEED_AGENT_SYSTEM_PROMPT,
        ],
      );
    }

    // Newest agent — same one the wizard's `GET /agents`
    // (`ORDER BY created_at DESC`) will pick to PATCH.
    const agentResult = await client.query<{ id: string }>(
      `SELECT id FROM agents
        WHERE tenant_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [TENANT_ID],
    );
    const agentId = agentResult.rows[0]?.id;
    if (!agentId) {
      throw new Error('failed to seed starter agent (no id returned)');
    }

    await client.query(
      `DELETE FROM agent_prompt_versions WHERE agent_id = $1`,
      [agentId],
    );

    await client.query('COMMIT');
    return { userId, agentId };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
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

async function captureFailureScreenshot(
  page: Page | undefined,
  suffix: string,
): Promise<void> {
  if (!page) return;
  const shotPath = path.join(ARTIFACT_DIR, `${SPEC_NAME}-${suffix}.png`);
  try {
    await mkdir(path.dirname(shotPath), { recursive: true });
    await page.screenshot({ path: shotPath, fullPage: true });
    console.error(`[e2e]   screenshot: ${shotPath}`);
  } catch (err) {
    console.warn(
      `[e2e] failed to write screenshot to ${shotPath}: ${(err as Error).message}`,
    );
  }
}

async function run(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.PLATFORM_DB_POOL_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is required to seed the tenant + agent for this spec.',
    );
  }

  const pool = new pg.Pool({ connectionString: databaseUrl, max: 3 });
  let browser: Browser | undefined;
  let ctx: BrowserContext | undefined;
  let page: Page | undefined;

  try {
    const { userId, agentId } = await seedTenantUserAndAgent(pool);
    console.log(
      `[e2e] seeded tenant user ${TENANT_USER_EMAIL} (id=${userId}) and starter agent (id=${agentId})`,
    );

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await ctx.newPage();

    // Force every PATCH /api/agents/:id to a 5xx so
    // `handleTemplateConfirm`'s catch branch runs on the first click.
    // The route is matched against the URL the BROWSER sees
    // (vite dev proxies /api/* through to the platform API), and we
    // only intercept PATCH so the wizard's preceding `GET /api/agents`
    // (which it uses to look up which agent id to PATCH) still hits
    // the real backend and returns the seeded row.
    //
    // Body is `{}` on purpose — the api client falls back to
    // `Request failed: <status>` when there's no `body.error` /
    // `body.message`, so the alert renders the
    // `update_failed_with_detail` variant exercising the user-visible
    // detail substitution.
    let patchAttempts = 0;
    let failPatch = true;
    await page.route('**/api/agents/*', async (route) => {
      if (route.request().method() !== 'PATCH') {
        await route.fallback();
        return;
      }
      patchAttempts += 1;
      if (failPatch) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: '{}',
        });
        return;
      }
      await route.fallback();
    });

    await tenantUiLogin(page);
    console.log(`[e2e] logged in as ${TENANT_USER_EMAIL}`);

    await page.goto(`${BASE_URL}/onboarding`, { waitUntil: 'domcontentloaded' });

    // Wait for the wizard to land on step 2. The provisioning-status
    // poll returns `ready` immediately because we seeded
    // `tenant.status = 'active'`, so step 1 auto-advances.
    const templateHeading = page.locator('h2', { hasText: TEMPLATE_HEADING_TEXT });
    await templateHeading.waitFor({ state: 'visible', timeout: 20_000 });

    // Pick the non-default template. Targeting the radio's `value`
    // attribute keeps us independent of the localised label.
    const templateRadio = page.locator(
      `input[type="radio"][value="${PICKED_TEMPLATE_TYPE}"]`,
    );
    await templateRadio.check();
    await page.waitForFunction(
      (slug) => {
        const el = document.querySelector(
          `input[type="radio"][value="${slug}"]`,
        ) as HTMLInputElement | null;
        return el !== null && el.checked;
      },
      PICKED_TEMPLATE_TYPE,
      { timeout: 5_000 },
    );

    // ─── Click 1: PATCH fails → wizard must stay on step 2 ──────────
    const continueBtn = page.locator('button', { hasText: 'Continue' });
    await continueBtn.click();

    // Alert is the canonical signal the catch branch ran. Wait on it
    // first so we don't race the React state update that flips the
    // Continue label to "Try again".
    const errorAlert = page.locator('[role="alert"]');
    await errorAlert.waitFor({ state: 'visible', timeout: 10_000 });

    const alertText = (await errorAlert.innerText()).trim();
    assert(
      alertText.includes(ALERT_TITLE_TEXT),
      `alert should show the failure title ${JSON.stringify(ALERT_TITLE_TEXT)}; got ${JSON.stringify(alertText)}`,
    );
    assert(
      alertText.includes(ALERT_DETAIL_PREFIX),
      `alert should mention the failure detail (prefix ${JSON.stringify(ALERT_DETAIL_PREFIX)}); got ${JSON.stringify(alertText)}`,
    );
    assert(
      alertText.includes(ALERT_FRIENDLY_DETAIL),
      `alert should surface the friendly server-error wording ${JSON.stringify(ALERT_FRIENDLY_DETAIL)} (Task #1279); got ${JSON.stringify(alertText)}`,
    );
    assert(
      !alertText.includes(ALERT_RAW_LEAK_FRAGMENT),
      `alert must not leak the raw "${ALERT_RAW_LEAK_FRAGMENT} <status>" developer string (Task #1279); got ${JSON.stringify(alertText)}`,
    );

    assert(
      patchAttempts === 1,
      `expected exactly one PATCH attempt before retry, observed ${patchAttempts}`,
    );

    // The wizard MUST still be on step 2 — the template heading is
    // visible and the step-3 phone heading hasn't appeared. This is
    // the actual regression guard: the pre-#1218 code would have
    // advanced to step 3 here despite the 500.
    assert(
      await templateHeading.isVisible(),
      'template heading should still be visible after the PATCH failed (wizard must not advance)',
    );
    const phoneHeading = page.locator('h2', { hasText: PHONE_HEADING_TEXT });
    assert(
      (await phoneHeading.count()) === 0,
      'phone-number heading should NOT be present while still on step 2 with an error',
    );

    // The primary action button should now read "Try again" — that's
    // the user-visible affordance for the retry path.
    const tryAgainBtn = page.locator('button', { hasText: TRY_AGAIN_BUTTON_TEXT });
    await tryAgainBtn.waitFor({ state: 'visible', timeout: 5_000 });
    assert(
      await tryAgainBtn.isEnabled(),
      'try-again button should be enabled (not stuck in the updating state)',
    );

    console.log('[e2e] failure surfaced on step 2 as expected; retrying...');

    // ─── Click 2: stop forcing the failure, retry → wizard advances ─
    failPatch = false;

    // Hook the success response BEFORE clicking so we don't race the
    // network. We require status 200 explicitly so a residual 5xx (or
    // a different agent id being chosen) would fail loud.
    const retrySuccess = page.waitForResponse(
      (res) =>
        res.request().method() === 'PATCH' &&
        res.url().endsWith(`/api/agents/${agentId}`) &&
        res.status() === 200,
      { timeout: 20_000 },
    );
    await tryAgainBtn.click();
    const retryRes = await retrySuccess;
    assert(
      retryRes.status() === 200,
      `retry PATCH should be 200, got ${retryRes.status()}`,
    );

    // And finally — the wizard advances. This is the second half of
    // the contract: failure surfaces an error AND a clean retry
    // recovers the user without requiring a refresh.
    await phoneHeading.waitFor({ state: 'visible', timeout: 15_000 });
    assert(
      patchAttempts === 2,
      `expected exactly two PATCH attempts (initial fail + retry), observed ${patchAttempts}`,
    );

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
