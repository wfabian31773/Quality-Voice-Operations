/**
 * Task #1204: end-to-end regression for the non-default template branch of
 * the onboarding wizard's step 2 → step 3 transition.
 *
 * Why this exists in addition to onboardingResumeSavedStep.spec.ts:
 *   The resume spec deliberately keeps the default `answering-service`
 *   template selected so step 2 → step 3 short-circuits without an
 *   `/agents` PATCH (it's only verifying the resume contract, and any
 *   template-update side effects would muddy that signal). That leaves
 *   the non-default branch of `handleTemplateConfirm` in
 *   `client-app/src/pages/Onboarding.tsx` — the branch that actually
 *   updates the tenant's starter agent — without any e2e coverage. A
 *   regression there would silently leave new tenants on the generic
 *   answering-service prompt even after they explicitly picked
 *   "Medical after-hours" or "Dental".
 *
 * What this spec asserts:
 *   1. The wizard auto-advances from step 1 to step 2 once the seeded
 *      tenant's provisioning status reads `ready` (we seed it as
 *      `active`), so the user actually lands on the template chooser.
 *   2. Selecting the `medical-after-hours` radio and clicking Continue
 *      fires a `PATCH /api/agents/:id` 200, AND the seeded agent row in
 *      Postgres ends up with:
 *        - `type` = `medical-after-hours`
 *        - `name` = `Medical After-Hours` (the English template label)
 *        - `welcome_greeting` = the medical industry English greeting
 *          from `getIndustryTemplateCopy('en', 'medical')`
 *        - `system_prompt` = `getDefaultSystemPrompt('en')` + `\n\n` +
 *          the medical English `systemPromptSuffix`
 *      The DB read is the source of truth — we don't trust the response
 *      body alone, because what we actually care about is the persisted
 *      state that the voice gateway will read on the next call.
 *   3. The wizard advances to step 3 (the phone-number step) only after
 *      the PATCH succeeds — i.e. the `catch (err) { advanceTo(3) }`
 *      fallback didn't silently swallow a server-side failure.
 *
 * Why we seed the agent ourselves instead of relying on provisioning:
 *   `TenantProvisioningService.createDefaultAgent` runs as part of the
 *   real signup flow, but we're inserting the tenant directly into
 *   Postgres to keep the spec hermetic. We seed the starter agent
 *   explicitly with the *generic* English greeting + system prompt so
 *   the post-PATCH assertions can prove the values actually changed —
 *   if we left them empty/null, a regression that PATCHed the wrong
 *   columns (or skipped the update entirely) might still satisfy a
 *   loose `!== null` check.
 *
 * Standalone runner:
 *
 *   E2E_ADMIN_PASSWORD='test-password-123' \
 *     npx tsx tests/e2e/onboardingTemplateUpdatesAgent.spec.ts
 *
 * Pre-requisites:
 *   - Platform Dev workflow running (admin API on :3002, vite on :5000).
 *   - DATABASE_URL is set so the spec can (idempotently) seed a tenant,
 *     user, and starter agent and read the agent row back.
 *   - Playwright browsers installed: `npx playwright install chromium`.
 *
 * Why we DON'T delete the seeded tenant after the test:
 *   `audit_logs` is immutable in this schema (BEFORE UPDATE / BEFORE
 *   DELETE triggers raise). Logging in writes a `user.login` audit row,
 *   and the agent PATCH writes an `agent.updated` row, both of which
 *   reference the user via FK ON DELETE SET NULL. Removing the user
 *   would trigger that SET NULL, which the immutability trigger
 *   refuses. Same pattern as the sibling onboarding specs — we use
 *   stable identifiers and upsert idempotently. The seed uses
 *   identifiers distinct from the dismiss/restart and resume specs so
 *   the three specs cannot interfere if they ever run against the
 *   same DB.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { mkdir } from 'fs/promises';
import path from 'path';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'onboarding-template-updates-agent';

// Stable identifiers — the seed is idempotent (upsert), so reruns reuse the
// same row. Distinct from the dismiss/restart and resume fixtures so the
// specs cannot interfere if they ever run against the same DB.
const TENANT_USER_EMAIL =
  process.env.E2E_TEMPLATE_USER_EMAIL ?? 't1204-template@voiceaihub.test';
const TENANT_USER_PASSWORD =
  process.env.E2E_TEMPLATE_USER_PASSWORD ?? 'TemplateOnboardingTest!2026';
const TENANT_ID = process.env.E2E_TEMPLATE_TENANT_ID ?? 't1204-template-tenant';
const TENANT_SLUG = process.env.E2E_TEMPLATE_TENANT_SLUG ?? 't1204-template-tenant';

// ─── Expected post-PATCH agent values ──────────────────────────────────
//
// Sourced from `client-app/src/lib/agentBuilderI18n.ts`:
//   - `DEFAULT_SYSTEM_PROMPTS.en`
//   - `INDUSTRY_TEMPLATE_COPY.medical.en.welcomeGreeting`
//   - `INDUSTRY_TEMPLATE_COPY.medical.en.systemPromptSuffix`
// and the English template label from
//   `client-app/src/locales/en/common.json` →
//   `onboarding.templates.medical-after-hours.label`.
//
// We hardcode rather than `import { getIndustryTemplateCopy }` because
// `agentBuilderI18n.ts` pulls in `react` + `react-i18next` at the top of
// the file, which won't load cleanly under plain `tsx` outside the bundler.
// Hardcoding does mean if the canonical copy changes upstream this spec
// will need to be updated alongside — that's the intentional contract:
// the test should fail loudly when "what we send to the agent on
// template selection" changes, so we notice the regression on the next
// CI run instead of in production.
const EXPECTED_TEMPLATE_TYPE = 'medical-after-hours';
const EXPECTED_TEMPLATE_NAME = 'Medical After-Hours';
const EXPECTED_WELCOME_GREETING =
  'Thank you for calling. This is the after-hours service. How can I help you tonight?';
const EXPECTED_SYSTEM_PROMPT_SUFFIX =
  'You are an after-hours medical answering service.\n- Triage urgency before any other action.\n- Never give medical advice.\n- Escalate true emergencies to the on-call provider immediately.';
const DEFAULT_SYSTEM_PROMPT_EN = `You are a friendly, professional voice agent.
- Greet the caller warmly and confirm how you can help.
- Listen carefully, ask clarifying questions when needed, and confirm details before acting.
- Always respond in English.
- Keep replies concise and natural for spoken conversation.
- If the caller asks for something outside your scope, politely offer to escalate or take a message.`;
const EXPECTED_SYSTEM_PROMPT = `${DEFAULT_SYSTEM_PROMPT_EN}\n\n${EXPECTED_SYSTEM_PROMPT_SUFFIX}`;

// The seeded starter agent — what `TenantProvisioningService` would
// normally create. We seed it ourselves with the GENERIC English
// greeting + system prompt so the post-PATCH assertions prove the
// values actually flipped to the medical copy.
const SEED_AGENT_NAME = 'Default Answering Service';
const SEED_AGENT_TYPE = 'answering-service';
const SEED_AGENT_GREETING = 'Hello! Thank you for calling. How can I help you today?';
const SEED_AGENT_SYSTEM_PROMPT = DEFAULT_SYSTEM_PROMPT_EN;

interface AgentRow {
  id: string;
  type: string;
  name: string;
  welcome_greeting: string | null;
  system_prompt: string | null;
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

/**
 * Seed an isolated tenant + non-admin tenant user + starter agent. The
 * agent is seeded with the GENERIC English greeting + system prompt
 * (matching what `TenantProvisioningService.createDefaultAgent` writes)
 * so the post-PATCH assertions can prove the medical template copy
 * actually overwrote them.
 *
 * The user's preferences are reset to `{}` so neither
 * `onboarding_completed` nor `onboarding_step` carries over from a
 * previous run — otherwise the wizard might resume on step 3 and skip
 * the template-confirm click entirely.
 *
 * The tenant is seeded as `status = 'active'` so
 * `/tenants/me/provisioning-status` returns `ready` on the first poll
 * and the wizard auto-advances from step 1 to step 2.
 *
 * Returns both the seeded user id and the seeded agent id so we can
 * read the agent row back after the PATCH.
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
       VALUES ($1, 'Template e2e Tenant', $2, 'active', 'starter',
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
       VALUES ($1, $2, 'Template Tester', $3, 'admin', TRUE, FALSE, TRUE,
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

    // Seed (or reset) the starter agent. We RESET name/type/greeting/
    // system_prompt back to the generic defaults on EVERY agent that
    // exists for this tenant — not just the oldest — so a previous
    // run's medical-template state doesn't poison this run's
    // assertions, and so the agent the wizard's `GET /agents` will
    // PATCH (returned newest-first by the route) is always one of the
    // ones we just reset.
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

    // If the tenant has no starter agent yet (first ever run), insert
    // one matching what `TenantProvisioningService.createDefaultAgent`
    // would have written.
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

    // Pick the NEWEST agent for this tenant — that's the one the
    // wizard's `GET /agents` (which `ORDER BY created_at DESC`) will
    // hand to `handleTemplateConfirm` for the PATCH. Using the newest
    // here keeps the assertion target aligned with the production
    // code path even if extra agents accumulate against this stable
    // tenant id (e.g. from prior schema-evolution runs).
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

    // Clear any prompt-version history that previous runs may have
    // accumulated against the agent we'll be patching. The PATCH route
    // archives the existing system_prompt into agent_prompt_versions
    // on every update, so this isn't strictly needed for correctness —
    // but it keeps reruns tidy.
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

/**
 * Read the seeded agent row directly from Postgres. The PATCH endpoint
 * returns the updated row in its response too, but we go to the source
 * of truth so we're testing the actual persisted state — the thing the
 * voice gateway will read on the next call.
 */
async function readAgent(pool: pg.Pool, agentId: string): Promise<AgentRow> {
  const client = await pool.connect();
  try {
    await client.query(`SET LOCAL row_security = off`);
    const { rows } = await client.query<AgentRow>(
      `SELECT id, type, name, welcome_greeting, system_prompt
         FROM agents
        WHERE id = $1
        LIMIT 1`,
      [agentId],
    );
    if (rows.length === 0) throw new Error(`agent ${agentId} disappeared mid-test`);
    return rows[0];
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
 * Wait for a successful PATCH against `/api/agents/:id` for the seeded
 * agent. Hooking the response promise BEFORE the click that triggers
 * the PATCH is critical — the wizard advances to step 3 in *both* the
 * success and the catch branches, so a "click then wait" sequence
 * could falsely pass even if the PATCH never reached the server.
 */
function waitForAgentPatch(page: Page, agentId: string, timeoutMs = 20_000) {
  const expected = `/api/agents/${agentId}`;
  return page.waitForResponse(
    (res) =>
      res.request().method() === 'PATCH' &&
      res.url().endsWith(expected) &&
      res.status() === 200,
    { timeout: timeoutMs },
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
      'DATABASE_URL is required to seed the tenant + agent and verify the post-PATCH state for this spec.',
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

    // Sanity-check the seed wrote the GENERIC defaults — if a previous
    // run (or a botched seed) left the medical copy in place, the
    // post-PATCH assertions below would tautologically pass.
    const seeded = await readAgent(pool, agentId);
    assert(
      seeded.type === SEED_AGENT_TYPE,
      `seed precondition: agent.type should start as ${SEED_AGENT_TYPE}, got ${seeded.type}`,
    );
    assert(
      seeded.welcome_greeting === SEED_AGENT_GREETING,
      `seed precondition: agent.welcome_greeting should start as the generic English greeting, got ${JSON.stringify(seeded.welcome_greeting)}`,
    );

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await ctx.newPage();

    await tenantUiLogin(page);
    console.log(`[e2e] logged in as ${TENANT_USER_EMAIL}`);

    await page.goto(`${BASE_URL}/onboarding`, { waitUntil: 'domcontentloaded' });

    // Wait for the wizard to land on step 2. The provisioning-status
    // poll returns `ready` on the first tick (we seeded tenant.status =
    // 'active'), so `advanceTo(2)` fires automatically; the step-2
    // template heading is the visual confirmation that we're there.
    const templateHeading = page.locator('h2', { hasText: 'Choose Your Agent Template' });
    await templateHeading.waitFor({ state: 'visible', timeout: 20_000 });

    // Pick the non-default template. The radio's `value` attribute is
    // the slug we PATCH into agent.type, so we can target it directly
    // without depending on the localised label rendering.
    const medicalRadio = page.locator(`input[type="radio"][value="${EXPECTED_TEMPLATE_TYPE}"]`);
    await medicalRadio.check();
    // Belt-and-suspenders: confirm the radio actually became selected
    // before we hand off to the Continue button. If the radio is hidden
    // by an overflow-y scroll container (the template list has
    // `max-h-72 overflow-y-auto`), `check()` would still scroll it into
    // view — but a failed click would leave it unchecked and the
    // `selectedTemplate === 'answering-service'` short-circuit would
    // run instead, hiding the regression we're trying to catch.
    await page.waitForFunction(
      (slug) => {
        const el = document.querySelector(
          `input[type="radio"][value="${slug}"]`,
        ) as HTMLInputElement | null;
        return el !== null && el.checked;
      },
      EXPECTED_TEMPLATE_TYPE,
      { timeout: 5_000 },
    );

    // Hook the PATCH response BEFORE clicking Continue so we don't race
    // the network. handleTemplateConfirm fires the PATCH and then
    // advances to step 3 in both the .then AND .catch branches, so we
    // explicitly require a 200 — a failure would silently still render
    // step 3 without ever updating the agent row.
    const agentPatched = waitForAgentPatch(page, agentId);
    await page.locator('button', { hasText: 'Continue' }).click();
    const patchRes = await agentPatched;
    assert(
      patchRes.status() === 200,
      `agents PATCH should be 200, got ${patchRes.status()}`,
    );

    // Confirm the wizard actually rendered step 3 in the UI before we
    // check the DB — guards against the case where the PATCH succeeds
    // but `advanceTo(3)` somehow doesn't run.
    const phoneHeading = page.locator('h2', { hasText: 'Add Your First Phone Number' });
    await phoneHeading.waitFor({ state: 'visible', timeout: 15_000 });

    // ─── The actual contract ─────────────────────────────────────────
    // Read back the agent row and assert all four fields the
    // non-default branch of handleTemplateConfirm sends. The DB is the
    // source of truth — what the voice gateway will read on the next
    // call.
    const updated = await readAgent(pool, agentId);
    assert(
      updated.type === EXPECTED_TEMPLATE_TYPE,
      `agent.type should be ${EXPECTED_TEMPLATE_TYPE} after template confirm, got ${updated.type}`,
    );
    assert(
      updated.name === EXPECTED_TEMPLATE_NAME,
      `agent.name should be ${JSON.stringify(EXPECTED_TEMPLATE_NAME)} after template confirm, got ${JSON.stringify(updated.name)}`,
    );
    assert(
      updated.welcome_greeting === EXPECTED_WELCOME_GREETING,
      `agent.welcome_greeting should be the medical English greeting after template confirm.\n  expected: ${JSON.stringify(EXPECTED_WELCOME_GREETING)}\n  actual:   ${JSON.stringify(updated.welcome_greeting)}`,
    );
    assert(
      updated.system_prompt === EXPECTED_SYSTEM_PROMPT,
      `agent.system_prompt should be the default English prompt + medical suffix after template confirm.\n  expected: ${JSON.stringify(EXPECTED_SYSTEM_PROMPT)}\n  actual:   ${JSON.stringify(updated.system_prompt)}`,
    );
    console.log(
      `[e2e] agent ${agentId} updated: type=${updated.type}, name=${JSON.stringify(updated.name)}, greeting + system prompt match the medical English template`,
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
