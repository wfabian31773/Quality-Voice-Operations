/**
 * Task #1262: end-to-end regression that walks the Agent Builder's
 * empty-state template picker, clicks every industry starter workflow,
 * and asserts each template actually paints onto the React Flow canvas
 * with the expected node count + first-node label and without firing
 * any browser console errors.
 *
 * Why this exists:
 *   `client-app/src/pages/AgentBuilder.tsx` ships nine industry starter
 *   workflows (`INDUSTRY_TEMPLATES_RAW` around line 599). Translation
 *   key coverage is verified by `scripts/check-i18n-keys.mjs`, but
 *   nothing actually clicks each card and asserts the resulting nodes /
 *   edges. A regression in any one template — a malformed `nodeType`,
 *   a stale `conditionField`, an `edge.labelKey` pointing at a removed
 *   key — would only surface when a real tenant clicks the card and
 *   sees a half-rendered canvas (or worse, a thrown error in the
 *   render path that React Flow swallows into a black square).
 *
 *   This spec runs every starter template through the same code path
 *   the operator would: navigate to the builder, click the card in the
 *   empty-state picker, wait for `loadTemplate` to commit nodes/edges
 *   to React Flow, then assert:
 *     1. the rendered `.react-flow__node` count equals the template's
 *        declared node count,
 *     2. the first node's visible label matches the localized English
 *        copy from `INDUSTRY_TEMPLATE_COPY` (which is what
 *        `buildIndustryTemplates` writes into `data.label`),
 *     3. no `console.error` / `pageerror` events fired between the
 *        click and the canvas painting — caught errors during
 *        `loadTemplate` would otherwise be invisible because the
 *        function has no try/catch and React's error boundaries can
 *        eat the failure mid-commit.
 *
 *   The test reloads the page between templates because the only way
 *   the empty-state picker is shown is `nodes.length === 0`, and we
 *   never call Save — so the seeded agent's `workflow_definition`
 *   stays NULL in the DB across iterations and the picker re-renders
 *   on each reload.
 *
 * Standalone runner:
 *
 *   E2E_ADMIN_PASSWORD='test-password-123' \
 *     npx tsx tests/e2e/agentBuilderStarterTemplates.spec.ts
 *
 * Pre-requisites:
 *   - Platform Dev workflow running (admin API on :3002, vite on :5000).
 *   - DATABASE_URL is set so the spec can (idempotently) seed a tenant,
 *     user, and an agent with no workflow_definition.
 *   - Playwright browsers installed: `npx playwright install chromium`.
 *
 * Why we DON'T delete the seeded tenant after the test:
 *   `audit_logs` is immutable in this schema (BEFORE DELETE triggers
 *   raise on the audit table's FK targets). Logging in writes a
 *   `user.login` audit row that references the user via
 *   ON DELETE SET NULL — the immutability trigger refuses the SET NULL.
 *   Same pattern as the other onboarding/template e2e specs: seed
 *   idempotently against a stable tenant id, leave the row in place.
 *   We use identifiers distinct from the other onboarding/template
 *   specs so the suites can't poison each other's assertions if they
 *   ever run against the same DB.
 */
import { chromium, type Browser, type BrowserContext, type ConsoleMessage, type Page } from 'playwright';
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { mkdir } from 'fs/promises';
import path from 'path';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const SPEC_NAME = 'agent-builder-starter-templates';

// Stable identifiers — the seed is idempotent (upsert), so reruns reuse
// the same row. Distinct from the dismiss/restart, resume, and
// template-update fixtures so the specs cannot interfere if they ever
// run against the same DB.
const TENANT_USER_EMAIL =
  process.env.E2E_STARTER_TPL_USER_EMAIL ?? 't1262-starter-tpl@voiceaihub.test';
const TENANT_USER_PASSWORD =
  process.env.E2E_STARTER_TPL_USER_PASSWORD ?? 'StarterTemplatesTest!2026';
const TENANT_ID = process.env.E2E_STARTER_TPL_TENANT_ID ?? 't1262-starter-tpl-tenant';
const TENANT_SLUG = process.env.E2E_STARTER_TPL_TENANT_SLUG ?? 't1262-starter-tpl-tenant';

// Seeded agent metadata. We reset workflow_definition to NULL on every
// run so the empty-state picker is the FIRST thing rendered — that's
// the picker we're trying to exercise. We also pin language='en' so
// the resolved labels match the English copy we hardcode below.
const SEED_AGENT_NAME = 'Starter Templates Smoke Agent';
const SEED_AGENT_TYPE = 'answering-service';

/**
 * One row per starter template registered in
 * `INDUSTRY_TEMPLATES_RAW` (client-app/src/pages/AgentBuilder.tsx).
 *
 * - `label` is the English label from `agentBuilderI18n.ts` (the value
 *   `tplFoo` resolves to in `en`). The picker button's `title`
 *   attribute and the visible `<span class="truncate">` both contain
 *   this string, so we use it to locate the button.
 * - `expectedNodeCount` is the literal length of the template's
 *   `nodes` array.
 * - `expectedFirstNodeLabel` is the English `nodes['1'].label` from
 *   `INDUSTRY_TEMPLATE_COPY`. `ConversationNode` / `LogicNode` /
 *   `ActionNode` all render the resolved `data.label` inside a
 *   `<span>`, so this is what shows up on the canvas.
 * - `expectedEdgeCount` is the literal length of the template's
 *   `edges` array — used to sanity-check that React Flow drew an edge
 *   path for each one (one `.react-flow__edge` element per edge).
 *
 * Hardcoding rather than importing avoids pulling React + i18next into
 * a plain-tsx runner. The trade-off is intentional: if the canonical
 * copy or shape changes upstream, this spec MUST be updated alongside
 * — that's the contract we want, so a regression in template shape
 * fails CI on the next run instead of silently in production.
 */
interface StarterTemplateExpectation {
  key: string;
  label: string;
  expectedNodeCount: number;
  expectedFirstNodeLabel: string;
  expectedEdgeCount: number;
}

const STARTER_TEMPLATES: StarterTemplateExpectation[] = [
  {
    key: 'medical',
    label: 'Medical After-Hours',
    expectedNodeCount: 6,
    expectedFirstNodeLabel: 'Patient Greeting',
    expectedEdgeCount: 6,
  },
  {
    key: 'dental',
    label: 'Dental Office',
    expectedNodeCount: 5,
    expectedFirstNodeLabel: 'Welcome',
    expectedEdgeCount: 4,
  },
  {
    key: 'hvac',
    label: 'HVAC / Home Services',
    expectedNodeCount: 6,
    expectedFirstNodeLabel: 'Service Call',
    expectedEdgeCount: 6,
  },
  {
    key: 'legal',
    label: 'Legal Intake',
    expectedNodeCount: 5,
    expectedFirstNodeLabel: 'Caller Greeting',
    expectedEdgeCount: 4,
  },
  {
    key: 'support',
    label: 'Customer Support',
    expectedNodeCount: 5,
    expectedFirstNodeLabel: 'Customer Welcome',
    expectedEdgeCount: 4,
  },
  {
    key: 'realestate',
    label: 'Real Estate Lead',
    expectedNodeCount: 5,
    expectedFirstNodeLabel: 'Caller Greeting',
    expectedEdgeCount: 4,
  },
  {
    key: 'restaurant',
    label: 'Restaurant Reservations',
    expectedNodeCount: 6,
    expectedFirstNodeLabel: 'Guest Greeting',
    expectedEdgeCount: 6,
  },
  {
    key: 'salon',
    label: 'Salon & Spa',
    expectedNodeCount: 5,
    expectedFirstNodeLabel: 'Guest Greeting',
    expectedEdgeCount: 4,
  },
  {
    key: 'propertymanagement',
    label: 'Property Management',
    expectedNodeCount: 6,
    expectedFirstNodeLabel: 'Front Desk Greeting',
    expectedEdgeCount: 6,
  },
];

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

/**
 * Seed an isolated tenant + non-admin tenant user + a single starter
 * agent whose `workflow_definition` is forced back to NULL on every
 * run so the empty-state picker is what AgentBuilder renders first.
 *
 * We also reset language='en' / type='answering-service' so the
 * picker labels resolve to the English copy this spec asserts against
 * (a previous test that left the agent on Spanish would otherwise
 * silently mis-locate the picker buttons).
 *
 * Returns the seeded agent id so the test can navigate directly to
 * `/agents/:id/builder` without going through the agents list.
 */
async function seedTenantUserAndAgent(
  pool: pg.Pool,
): Promise<{ userId: string; agentId: string }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // RLS is enabled on most tables; turn it off for this connection's
    // transaction so the seed can write across tenants without needing
    // a tenant context (matches the sibling onboarding specs' pattern).
    await client.query(`SET LOCAL row_security = off`);

    // Backdate the tenant's created_at so the TenantLayout onboarding
    // gate doesn't bounce us based on the "<24h old AND no phone numbers"
    // heuristic. Same age-out pattern as the sibling specs.
    await client.query(
      `INSERT INTO tenants (id, name, slug, status, plan, settings, feature_flags, created_at)
       VALUES ($1, 'Starter Templates e2e Tenant', $2, 'active', 'starter',
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

    // Mark onboarding_completed so the TenantLayout gate doesn't
    // redirect us to /onboarding on first navigation. We're testing the
    // builder, not the wizard — the wizard already has its own e2e
    // coverage in the sibling specs.
    const userResult = await client.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, first_name, password_hash,
                          role, is_active, is_platform_admin, email_verified,
                          preferences)
       VALUES ($1, $2, 'Starter Templates Tester', $3, 'admin', TRUE, FALSE, TRUE,
               '{"onboarding_completed": true}'::jsonb)
       ON CONFLICT (email) DO UPDATE SET
         tenant_id = EXCLUDED.tenant_id,
         password_hash = EXCLUDED.password_hash,
         role = EXCLUDED.role,
         is_active = TRUE,
         is_platform_admin = FALSE,
         email_verified = TRUE,
         preferences = '{"onboarding_completed": true}'::jsonb,
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

    // Reset every existing agent for this tenant so a previous run's
    // committed-on-save workflow_definition doesn't keep the picker
    // hidden on this run. We pin language='en' explicitly so a
    // mutated persistent fixture (e.g. a future spec that flips this
    // tenant's agent to Spanish) cannot make the first-node label
    // assertions flaky — `buildIndustryTemplates` uses the agent's
    // language to resolve picker copy.
    await client.query(
      `UPDATE agents SET
         name = $2,
         type = $3,
         language = 'en',
         workflow_definition = NULL,
         published_workflow_definition = NULL,
         status = 'active',
         updated_at = NOW()
       WHERE tenant_id = $1`,
      [TENANT_ID, SEED_AGENT_NAME, SEED_AGENT_TYPE],
    );

    // First-ever-run insert: the seeded agent is intentionally minimal
    // — no workflow_definition, no welcome_greeting / system_prompt —
    // because what we're testing is the empty-state picker, and any
    // non-null workflow_definition would suppress it. language='en'
    // is set explicitly for the same reason as the UPDATE above.
    const { rowCount: existingCount } = await client.query(
      `SELECT 1 FROM agents WHERE tenant_id = $1 LIMIT 1`,
      [TENANT_ID],
    );
    if (existingCount === 0) {
      await client.query(
        `INSERT INTO agents (tenant_id, name, type, status, language, voice,
                             model, temperature, tools, escalation_config, metadata)
         VALUES ($1, $2, $3, 'active', 'en', 'sage',
                 'gpt-4o-realtime-preview', 0.8, '[]'::jsonb,
                 '{}'::jsonb, '{}'::jsonb)`,
        [TENANT_ID, SEED_AGENT_NAME, SEED_AGENT_TYPE],
      );
    }

    // Pick the NEWEST agent for this tenant. We only ever seed one,
    // but if a previous run accidentally inserted extras we want the
    // most recent (the same one the agents list would surface first).
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

/**
 * Dev-only console noise we explicitly tolerate. We do NOT silence
 * generic React warnings — those are the kind of regression this spec
 * exists to catch — but a handful of dev-server informational lines
 * (Vite HMR connect/refresh, React Router v7 future-flag heads-up)
 * legitimately fire on every page load and would otherwise drown the
 * signal.
 *
 * Keep this list as small as possible. If a real bug surfaces a new
 * console.error, add a fix instead of widening the allow-list.
 */
const TOLERATED_CONSOLE_PATTERNS: RegExp[] = [
  /\[vite\]/i,
  /Download the React DevTools/i,
  /React Router Future Flag Warning/i,
];

function isToleratedConsoleMessage(text: string): boolean {
  return TOLERATED_CONSOLE_PATTERNS.some((re) => re.test(text));
}

interface ConsoleErrorRecord {
  source: 'console.error' | 'pageerror';
  text: string;
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

    // Track console errors and uncaught page errors across the whole
    // session. We snapshot the array length BEFORE clicking each
    // template card and slice from there, so each per-template
    // assertion only sees errors that fired during THAT template's
    // load — a noisy login redirect can't poison a downstream
    // template's verdict.
    const errors: ConsoleErrorRecord[] = [];
    const onConsole = (msg: ConsoleMessage) => {
      if (msg.type() !== 'error') return;
      const text = msg.text();
      if (isToleratedConsoleMessage(text)) return;
      errors.push({ source: 'console.error', text });
    };
    const onPageError = (err: Error) => {
      errors.push({ source: 'pageerror', text: err.stack || err.message });
    };
    page.on('console', onConsole);
    page.on('pageerror', onPageError);

    // The builder fires `beforeunload` once `hasChanges` flips true
    // (after `loadTemplate`). Playwright's chromium auto-dismisses
    // `beforeunload` dialogs by default, but we register an explicit
    // accept handler so the behaviour is unambiguous in CI logs.
    page.on('dialog', (dialog) => {
      dialog.accept().catch(() => undefined);
    });

    await tenantUiLogin(page);
    console.log(`[e2e] logged in as ${TENANT_USER_EMAIL}`);

    const builderUrl = `${BASE_URL}/agents/${agentId}/builder`;

    // Sanity-check that the picker actually contains exactly the
    // templates this spec knows about. Without this guard, a tenth
    // starter template added to `INDUSTRY_TEMPLATES_RAW` would render
    // in production but go untested here, and CI would still pass —
    // exactly the regression the task asked us to close. We do this
    // once up front (against a fresh page load) instead of inside the
    // per-template loop because the picker disappears the moment the
    // first card is clicked.
    await page.goto(builderUrl, { waitUntil: 'domcontentloaded' });
    const initialPickerHeading = page.locator('p', {
      hasText: 'Start building your agent workflow',
    });
    await initialPickerHeading.waitFor({ state: 'visible', timeout: 20_000 });

    const renderedTemplateLabels = await Promise.all(
      STARTER_TEMPLATES.map(async (tpl) => {
        const card = page
          .locator(`button[title^=${JSON.stringify(`${tpl.label} —`)}]`)
          .first();
        // Each known starter must be present — a missing card here
        // means the i18n key was renamed or the template was removed
        // without updating this spec, both of which we want to fail
        // loudly.
        const visible = (await card.count()) > 0;
        return { label: tpl.label, visible };
      }),
    );
    const missing = renderedTemplateLabels.filter((r) => !r.visible).map((r) => r.label);
    assert(
      missing.length === 0,
      `picker is missing ${missing.length} starter template(s) this spec knows about: ${missing.join(', ')}`,
    );

    // Exact-count guard: if a tenth starter is added to
    // `INDUSTRY_TEMPLATES_RAW` without updating this spec, the
    // overall card count will exceed `STARTER_TEMPLATES.length` and
    // CI will fail with a clear error pointing at the discrepancy.
    // We scope the count to buttons whose title contains an em-dash
    // separator — that's the unique shape of the starter cards
    // (`${label} — ${description}`), distinguishing them from the
    // "your templates" / "shared with team" custom-template cards
    // below them which use only the template name as `title`.
    const starterCardCount = await page
      .locator('button[title*=" — "]')
      .count();
    assert(
      starterCardCount === STARTER_TEMPLATES.length,
      `picker should render exactly ${STARTER_TEMPLATES.length} starter template cards, got ${starterCardCount}. Update STARTER_TEMPLATES if a new starter was added to INDUSTRY_TEMPLATES_RAW.`,
    );
    console.log(
      `[e2e] picker contains expected ${STARTER_TEMPLATES.length} starter cards`,
    );

    for (const tpl of STARTER_TEMPLATES) {
      const errorsBefore = errors.length;
      console.log(`[e2e] template ${tpl.key} → ${JSON.stringify(tpl.label)}`);

      // Fresh page load → empty-state picker is what AgentBuilder
      // renders first because workflow_definition is NULL in the DB
      // and we never call Save.
      await page.goto(builderUrl, { waitUntil: 'domcontentloaded' });

      // Wait for the empty-state picker. Targeting the heading text
      // (`t('startBuilding')`) is more robust than waiting on a
      // selector because the picker only mounts inside `<Panel
      // position="top-center">` once the React Flow Provider has set
      // up its viewport.
      const pickerHeading = page.locator('p', {
        hasText: 'Start building your agent workflow',
      });
      await pickerHeading.waitFor({ state: 'visible', timeout: 20_000 });

      // The picker buttons render with `title="<label> — <description>"`
      // (em-dash with regular spaces — see AgentBuilder.tsx line 3952).
      // Anchoring to the title prefix keeps us isolated from the
      // description text changing without breaking the locator.
      const card = page.locator(`button[title^=${JSON.stringify(`${tpl.label} —`)}]`).first();
      await card.waitFor({ state: 'visible', timeout: 10_000 });
      await card.click();

      // React Flow renders one `.react-flow__node` per node and one
      // `.react-flow__edge` per edge in the viewport. We assert
      // EXACT counts — both undercount (template missing nodes
      // because of a malformed entry) and overcount (a leftover from
      // a previous render that didn't get cleared) are real bugs.
      const nodesLocator = page.locator('.react-flow__node');
      await page.waitForFunction(
        (expected) => document.querySelectorAll('.react-flow__node').length === expected,
        tpl.expectedNodeCount,
        { timeout: 10_000 },
      );
      const renderedNodeCount = await nodesLocator.count();
      assert(
        renderedNodeCount === tpl.expectedNodeCount,
        `template ${tpl.key}: expected ${tpl.expectedNodeCount} nodes on canvas, got ${renderedNodeCount}`,
      );

      const renderedEdgeCount = await page.locator('.react-flow__edge').count();
      assert(
        renderedEdgeCount === tpl.expectedEdgeCount,
        `template ${tpl.key}: expected ${tpl.expectedEdgeCount} edges on canvas, got ${renderedEdgeCount}`,
      );

      // First node label assertion. Templates lay node id '1' at the
      // top (y=0), and React Flow renders nodes in the order they
      // appear in its internal map — which mirrors the array order
      // we set them in. So `.react-flow__node` index 0 is the node
      // we declared with `id: '1'`. Reading the visible <span>
      // inside that node tells us `data.label` resolved as expected.
      const firstNodeText = (await nodesLocator.first().innerText()).trim();
      assert(
        firstNodeText.includes(tpl.expectedFirstNodeLabel),
        `template ${tpl.key}: first node should display ${JSON.stringify(tpl.expectedFirstNodeLabel)}, got ${JSON.stringify(firstNodeText)}`,
      );

      // Per-template console-error verdict. Anything captured while
      // this template was loading fails the spec — that's the whole
      // point: catch a thrown render or a missing translation key
      // that a tenant would otherwise hit before us.
      const newErrors = errors.slice(errorsBefore);
      if (newErrors.length > 0) {
        const detail = newErrors
          .map((e, i) => `  [${i}] (${e.source}) ${e.text}`)
          .join('\n');
        throw new Error(
          `template ${tpl.key} fired ${newErrors.length} console error(s) during load:\n${detail}`,
        );
      }

      console.log(
        `[e2e]   ✓ ${tpl.expectedNodeCount} nodes, ${tpl.expectedEdgeCount} edges, first node "${tpl.expectedFirstNodeLabel}"`,
      );
    }

    console.log(`[e2e] PASS — verified ${STARTER_TEMPLATES.length} starter templates`);
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
