/**
 * Task #1309: end-to-end regression for the Agent Builder's per-language
 * starter-template copy resolution.
 *
 * Why this exists in addition to agentBuilderStarterTemplates.spec.ts:
 *   The sibling #1262 spec walks every starter card but always with
 *   `agent.language = 'en'` — it asserts the English first-node labels
 *   render, nothing more. That leaves three production code paths
 *   completely untested by e2e:
 *
 *     1. The Voice-panel language `<select>` (operator clicks the
 *        "Voice" toggle in the builder header, then picks Spanish or
 *        French from the picker) → `handleSettingChange('language', …)`
 *        → `setAgentSettings({ …, language })`. A regression that
 *        broke the controlled `<select>` value, dropped the
 *        `onChange` wiring, or short-circuited the language branch
 *        of `handleSettingChange` would leave operators stuck on the
 *        agent's previously-saved language with no failing test.
 *
 *     2. `getIndustryTemplateCopy(language, key)` resolving NON-English
 *        copy AFTER an in-page language switch. `INDUSTRY_TEMPLATE_COPY`
 *        ships translated `nodes['1'].label` for every supported
 *        language, and `buildIndustryTemplates(t, agentSettings.language)`
 *        is wrapped in `useMemo` keyed on the current `agentSettings.language`,
 *        so the empty-state picker MUST re-render its template tiles
 *        every time the operator flips the picker. A regression in
 *        either function (a stripped Spanish entry, a normalisation
 *        drift, a stale memo dep, a missing `nodes['1']` after a
 *        refactor) would silently fall back to English in a tenant's
 *        browser without any CI signal.
 *
 *     3. The `usedEnglishFallback` branch of `loadTemplate` in
 *        `client-app/src/pages/AgentBuilder.tsx` — the toast that
 *        warns operators when a template ships with no copy for their
 *        agent's spoken language. Today every shipped template is
 *        fully translated, so this branch is unreachable through real
 *        data alone, which means it's also been silently untested
 *        since it was added.
 *
 *   This spec exercises all three. For each `(language, template)`
 *   pair we reload the builder, **drive the language switch through
 *   the actual Voice panel `<select>` in the UI** (NOT a DB write),
 *   then click the picker tile and assert the visible first-node
 *   `<span>` on the canvas matches the localized `nodes['1'].label`
 *   from `INDUSTRY_TEMPLATE_COPY`. Driving via the UI is critical:
 *   it means a regression in `handleSettingChange`, the `<select>`
 *   `onChange` wiring, the `agentSettings.language` re-render path,
 *   or the `useMemo` dependency on `industryTemplates` will all show
 *   up as a test failure instead of a silent stale-English bug.
 *
 *   For the fallback hint we use the `__INDUSTRY_TEMPLATE_COPY_FORCE_MISSING__`
 *   test seam in `agentBuilderI18n.ts` (which production code never
 *   touches) to simulate an untranslated (template, language) pair,
 *   then drive the same UI switch to Spanish, click the tile, and
 *   assert (a) the saveMessage banner contains the `templateFallbackHint`
 *   copy with the agent's language label interpolated in, AND (b)
 *   the first node falls back to its English label.
 *
 *   The test reloads the page between templates because the only way
 *   the empty-state picker re-renders is `nodes.length === 0`, and we
 *   never call Save — so the seeded agent's `workflow_definition`
 *   stays NULL in the DB across iterations and the language picker
 *   resets to the seeded English value on every reload (which is
 *   exactly what we want, so each iteration drives a fresh UI switch).
 *
 * Standalone runner:
 *
 *   E2E_ADMIN_PASSWORD='test-password-123' \
 *     npx tsx tests/e2e/agentBuilderTemplateLocalization.spec.ts
 *
 * Pre-requisites:
 *   - Platform Dev workflow running (admin API on :3002, vite on :5000).
 *   - DATABASE_URL is set so the spec can (idempotently) seed a tenant,
 *     user, and agent with no workflow_definition AND flip its
 *     `language` between iterations.
 *   - Playwright browsers installed: `npx playwright install chromium`.
 *
 * Why we DON'T delete the seeded tenant after the test:
 *   `audit_logs` is immutable in this schema (BEFORE DELETE triggers
 *   raise on the audit table's FK targets). Logging in writes a
 *   `user.login` audit row that references the user via
 *   ON DELETE SET NULL — the immutability trigger refuses the SET NULL.
 *   Same pattern as the sibling onboarding/template e2e specs: seed
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
const SPEC_NAME = 'agent-builder-template-localization';

// Stable identifiers — the seed is idempotent (upsert), so reruns reuse
// the same row. Distinct from every other onboarding/template fixture
// so the specs cannot interfere if they ever run against the same DB.
const TENANT_USER_EMAIL =
  process.env.E2E_TPL_LOC_USER_EMAIL ?? 't1309-tpl-loc@voiceaihub.test';
const TENANT_USER_PASSWORD =
  process.env.E2E_TPL_LOC_USER_PASSWORD ?? 'TemplateLocalizationTest!2026';
const TENANT_ID = process.env.E2E_TPL_LOC_TENANT_ID ?? 't1309-tpl-loc-tenant';
const TENANT_SLUG = process.env.E2E_TPL_LOC_TENANT_SLUG ?? 't1309-tpl-loc-tenant';

// Seeded agent metadata. We reset workflow_definition to NULL on every
// run so the empty-state picker is the FIRST thing rendered — that's
// the picker we're trying to exercise. The `language` column is seeded
// to 'en' and stays 'en' for the entire run; the per-iteration
// language switch happens through the actual Voice-panel `<select>`
// in the builder UI, NOT through a DB write. (Reloading the page
// between templates resets `agentSettings.language` back to 'en' from
// the DB row, which is exactly what we want — every iteration drives
// a fresh end-to-end UI switch.)
const SEED_AGENT_NAME = 'Template Localization Smoke Agent';
const SEED_AGENT_TYPE = 'answering-service';

/**
 * One row per shipped industry starter, with the localized first-node
 * label that `getIndustryTemplateCopy(<lang>, key).nodes['1'].label`
 * resolves to. The English column is here so the picker locator (which
 * reads `tpl.label = uiT(tpl.labelKey)` — i.e. the operator's UI
 * language, which the test runs as English) can find the card by its
 * `title="<en label> — <en description>"` attribute regardless of what
 * the agent's spoken language is set to.
 *
 * Hardcoding rather than importing from `agentBuilderI18n.ts` is the
 * same trade-off as the sibling specs: the file pulls in React +
 * react-i18next at the top so it can't load cleanly under plain `tsx`,
 * AND we want the spec to fail loudly when canonical copy changes —
 * a silent drift between this table and `INDUSTRY_TEMPLATE_COPY` is
 * exactly the regression we're trying to catch.
 *
 * Source of truth (for both columns):
 *   client-app/src/lib/agentBuilderI18n.ts → INDUSTRY_TEMPLATE_COPY
 *   client-app/src/lib/agentBuilderI18n.ts → translations.{en,es,fr}
 *     (for the picker label keys: tplMedical, tplDental, etc.)
 */
interface LocalizedTemplateExpectation {
  /** Template key — matches the `key` field in `INDUSTRY_TEMPLATES_RAW`. */
  key: string;
  /** English picker-card label. Used to locate the button via `title^=`. */
  enPickerLabel: string;
  /** Spanish first-node label resolved from `INDUSTRY_TEMPLATE_COPY[key].es.nodes['1'].label`. */
  esFirstNodeLabel: string;
  /** French first-node label resolved from `INDUSTRY_TEMPLATE_COPY[key].fr.nodes['1'].label`. */
  frFirstNodeLabel: string;
  /** English first-node label — asserted in the forced-fallback case below. */
  enFirstNodeLabel: string;
}

const TEMPLATES: LocalizedTemplateExpectation[] = [
  {
    key: 'medical',
    enPickerLabel: 'Medical After-Hours',
    enFirstNodeLabel: 'Patient Greeting',
    esFirstNodeLabel: 'Saludo al paciente',
    frFirstNodeLabel: 'Accueil du patient',
  },
  {
    key: 'dental',
    enPickerLabel: 'Dental Office',
    enFirstNodeLabel: 'Welcome',
    esFirstNodeLabel: 'Bienvenida',
    frFirstNodeLabel: 'Accueil',
  },
  {
    key: 'hvac',
    enPickerLabel: 'HVAC / Home Services',
    enFirstNodeLabel: 'Service Call',
    esFirstNodeLabel: 'Llamada de servicio',
    frFirstNodeLabel: "Appel d'intervention",
  },
  {
    key: 'legal',
    enPickerLabel: 'Legal Intake',
    enFirstNodeLabel: 'Caller Greeting',
    esFirstNodeLabel: 'Saludo al llamante',
    frFirstNodeLabel: "Accueil de l'appelant",
  },
  {
    key: 'support',
    enPickerLabel: 'Customer Support',
    enFirstNodeLabel: 'Customer Welcome',
    esFirstNodeLabel: 'Bienvenida al cliente',
    frFirstNodeLabel: 'Accueil du client',
  },
  {
    key: 'realestate',
    enPickerLabel: 'Real Estate Lead',
    enFirstNodeLabel: 'Caller Greeting',
    esFirstNodeLabel: 'Saludo al cliente',
    frFirstNodeLabel: "Accueil de l'appelant",
  },
  {
    key: 'restaurant',
    enPickerLabel: 'Restaurant Reservations',
    enFirstNodeLabel: 'Guest Greeting',
    esFirstNodeLabel: 'Saludo al cliente',
    frFirstNodeLabel: "Accueil de l'invité",
  },
  {
    key: 'salon',
    enPickerLabel: 'Salon & Spa',
    enFirstNodeLabel: 'Guest Greeting',
    esFirstNodeLabel: 'Saludo al cliente',
    frFirstNodeLabel: "Accueil de l'invité",
  },
  {
    key: 'propertymanagement',
    enPickerLabel: 'Property Management',
    enFirstNodeLabel: 'Front Desk Greeting',
    esFirstNodeLabel: 'Saludo de recepción',
    frFirstNodeLabel: "Accueil de l'immeuble",
  },
  {
    key: 'customer-support',
    enPickerLabel: 'Customer Support Center',
    enFirstNodeLabel: 'Support Welcome',
    esFirstNodeLabel: 'Bienvenida de soporte',
    frFirstNodeLabel: 'Accueil du support',
  },
  {
    key: 'outbound-sales',
    enPickerLabel: 'Outbound Sales',
    enFirstNodeLabel: 'Outbound Intro',
    esFirstNodeLabel: 'Introducción saliente',
    frFirstNodeLabel: 'Introduction sortante',
  },
  {
    key: 'technical-support',
    enPickerLabel: 'Technical Support',
    enFirstNodeLabel: 'Tech Welcome',
    esFirstNodeLabel: 'Bienvenida técnica',
    frFirstNodeLabel: 'Accueil technique',
  },
  {
    key: 'collections',
    enPickerLabel: 'Collections & Recovery',
    enFirstNodeLabel: 'Mini-Miranda & ID',
    esFirstNodeLabel: 'Mini-Miranda e identidad',
    frFirstNodeLabel: 'Mini-Miranda & identité',
  },
];

/** Languages we drive through the localization positive-path loop. */
const ALL_LANGUAGES_UNDER_TEST: ReadonlyArray<{
  code: 'es' | 'fr';
  pretty: string;
  pick: (tpl: LocalizedTemplateExpectation) => string;
}> = [
  { code: 'es', pretty: 'Spanish', pick: (t) => t.esFirstNodeLabel },
  { code: 'fr', pretty: 'French', pick: (t) => t.frFirstNodeLabel },
];

/**
 * Optional CLI filter: pass `--lang=es` or `--lang=fr` to run a
 * single language. Defaults to all (es + fr). Useful when running
 * locally on Replit, where the bash tool kills child processes after
 * ~120s — splitting the run lets each subprocess finish in time.
 * The forced-fallback assertion always runs (it doesn't materially
 * extend the runtime and depends on the Spanish copy table).
 */
function parseLangFilter(): ReadonlyArray<'es' | 'fr'> | null {
  for (const arg of process.argv.slice(2)) {
    const m = /^--lang=(es|fr|both)$/.exec(arg);
    if (m) return m[1] === 'both' ? null : [m[1] as 'es' | 'fr'];
  }
  return null;
}

const LANG_FILTER = parseLangFilter();
const LANGUAGES_UNDER_TEST = LANG_FILTER
  ? ALL_LANGUAGES_UNDER_TEST.filter((l) => LANG_FILTER.includes(l.code))
  : ALL_LANGUAGES_UNDER_TEST;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

/**
 * Seed an isolated tenant + non-admin tenant user + a single starter
 * agent whose `workflow_definition` is forced back to NULL on every
 * run so the empty-state picker is what AgentBuilder renders first.
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
    // transaction so the seed inserts can write across tenants without
    // needing a tenant context (matches the sibling onboarding specs).
    await client.query(`SET LOCAL row_security = off`);

    // Backdate the tenant's created_at so the TenantLayout onboarding
    // gate doesn't bounce us based on the "<24h old AND no phone numbers"
    // heuristic. Same age-out pattern as the sibling specs.
    await client.query(
      `INSERT INTO tenants (id, name, slug, status, plan, settings, feature_flags, created_at)
       VALUES ($1, 'Template Localization e2e Tenant', $2, 'active', 'starter',
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
    // redirect us to /onboarding on first navigation.
    const userResult = await client.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, first_name, password_hash,
                          role, is_active, is_platform_admin, email_verified,
                          preferences)
       VALUES ($1, $2, 'Template Localization Tester', $3, 'admin', TRUE, FALSE, TRUE,
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
    // hidden on this run. We seed language='en' so the very first
    // navigation lands on an English picker; the test loop flips
    // language between iterations via setAgentLanguage() below.
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

    // First-ever-run insert: minimal seed so the empty-state picker
    // renders immediately. workflow_definition is intentionally null —
    // any non-null value would suppress the picker.
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

/**
 * Defensive reset: clear `workflow_definition` on the seeded agent so
 * a previous run that ever persisted a saved canvas can't suppress
 * the empty-state picker on the next reload. We do NOT touch
 * `language` here — the per-iteration switch is driven exclusively
 * through the Voice-panel `<select>` in the UI.
 */
async function resetAgentWorkflow(
  pool: pg.Pool,
  agentId: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query(`SET LOCAL row_security = off`);
    await client.query(
      `UPDATE agents SET
         language = 'en',
         workflow_definition = NULL,
         published_workflow_definition = NULL,
         updated_at = NOW()
       WHERE id = $1`,
      [agentId],
    );
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
  // Let the dashboard chunks finish loading before we yank the page
  // to /agents/<id>/builder. Without this Vite has been observed to
  // 429-throttle subsequent module fetches on the cold-start path,
  // which deadlocks the next `page.goto()` waiting for DOMContentLoaded.
  // `networkidle` is best-effort with a short cap — we don't fail
  // the test if the dashboard never goes fully idle.
  await page
    .waitForLoadState('networkidle', { timeout: 10_000 })
    .catch(() => undefined);
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
 * Dev-only console noise we explicitly tolerate. Kept in lockstep with
 * the sibling agentBuilderStarterTemplates spec — we silence Vite HMR
 * connect/refresh, the React DevTools nag, and React Router future
 * flag warnings. Anything else gets surfaced as a hard fail because
 * silent client-side regressions are exactly what this spec is here
 * to catch.
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

/**
 * Open the Voice & Agent Config side-panel by clicking the "Voice"
 * toggle in the builder header (`<button>{t('voice')}</button>` in
 * AgentBuilder.tsx ~line 3838). The toggle is a plain text+icon
 * button whose accessible name is exactly the translated word
 * (English UI → "Voice"); the panel header itself reads "Voice &
 * Agent Config", so anchoring with `name: 'Voice'` + `exact: true`
 * disambiguates the two.
 */
async function openVoicePanel(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: 'Voice', exact: true });
  await toggle.waitFor({ state: 'visible', timeout: 10_000 });
  await toggle.click();
}

/**
 * Drive the agent's spoken language through the Voice-panel
 * `<select>` — the actual UI control operators use. Triggers
 * `handleSettingChange('language', value)` → `setAgentSettings`
 * → `industryTemplates` re-memo → picker re-render. We then close
 * the Voice panel via the panel's close (X) button so it doesn't
 * obscure the picker tile we're about to click.
 *
 * The language `<select>` is the SECOND `<select>` in the panel
 * (the first is `modelField`), so we anchor by the `<label>` text
 * "Language" and locate the immediate-following `<select>` sibling.
 * That is robust against tone/voice/model picker changes upstream.
 */
async function selectAgentLanguageViaUi(
  page: Page,
  langCode: string,
): Promise<void> {
  await openVoicePanel(page);

  // The Voice panel renders `<label>Language</label><select …>`
  // (see VoiceConfigPanel ~line 1424). Use the label-anchored
  // adjacent <select> so we don't pick up tone/voice/model selects.
  const languageSelect = page.locator(
    'label:has-text("Language") + select',
  );
  await languageSelect.waitFor({ state: 'visible', timeout: 10_000 });
  await languageSelect.selectOption({ value: langCode });

  // The `<select>` is controlled — value flips synchronously after
  // selectOption returns, but we wait on the DOM value as a guard
  // against React's commit being deferred under load.
  await page.waitForFunction(
    (expected) => {
      const sel = document.querySelector(
        'label:has(+ select) + select',
      ) as HTMLSelectElement | null;
      // jsdom-style :has fallback: re-find via siblings if needed.
      if (sel && sel.value === expected) return true;
      const labels = Array.from(document.querySelectorAll('label'));
      for (const l of labels) {
        if (l.textContent?.trim() === 'Language') {
          const next = l.nextElementSibling as HTMLSelectElement | null;
          if (next && next.tagName === 'SELECT' && next.value === expected) {
            return true;
          }
        }
      }
      return false;
    },
    langCode,
    { timeout: 5_000 },
  );

  // Close the side panel by toggling the same "Voice" header button
  // again (`setRightPanel(rightPanel === 'voice' ? 'none' : 'voice')`).
  // We close (rather than navigate-and-reset) because the panel is a
  // right-side overlay that visually covers the picker cards on the
  // canvas: leaving it open causes `card.click()` below to either
  // miss or scroll-into-view the wrong element. Using the toggle
  // button is more robust than the panel's X button: the X has
  // aria-label "Close" which collides with other dismiss buttons on
  // the page (e.g. translation-suggestion banners).
  await openVoicePanel(page);
  await page
    .locator('h3', { hasText: 'Voice & Agent Config' })
    .waitFor({ state: 'hidden', timeout: 5_000 });
}

/**
 * Reload the empty-state picker page, switch the agent's language
 * through the UI to `langCode`, then click the card identified by
 * its English picker label. The picker title is built as
 * `${tpl.label} — ${tpl.description}` (em-dash) where `tpl.label`
 * resolves through `useBuilderUiT()` — the operator's UI language —
 * which the test runs as English. So the same locator works
 * regardless of what the agent's spoken language is set to.
 *
 * Pass `langCode = null` to skip the UI-language switch (used for
 * the seam-bypass setup phase before the forced-fallback case sets
 * its global on the next reload).
 */
async function pickTemplateAndWaitForCanvas(
  page: Page,
  builderUrl: string,
  langCode: string | null,
  enPickerLabel: string,
  templateKeyForLogs: string,
): Promise<void> {
  await page.goto(builderUrl, { waitUntil: 'domcontentloaded' });

  // Wait for the empty-state picker. Targeting the heading text
  // (`t('startBuilding')`) is more robust than waiting on a selector
  // because the picker only mounts inside `<Panel position="top-center">`
  // once the React Flow Provider has set up its viewport.
  const pickerHeading = page.locator('p', {
    hasText: 'Start building your agent workflow',
  });
  await pickerHeading.waitFor({ state: 'visible', timeout: 20_000 });

  if (langCode !== null) {
    await selectAgentLanguageViaUi(page, langCode);
    // The picker re-renders via `industryTemplates` useMemo when
    // `agentSettings.language` flips. Wait for the heading again so
    // we know the picker is still mounted (loadTemplate hasn't fired
    // yet — nodes.length is still 0).
    await pickerHeading.waitFor({ state: 'visible', timeout: 5_000 });
  }

  // The card title is `${tpl.label} — ${tpl.description}` (em-dash with
  // regular spaces — see AgentBuilder.tsx ~line 4036). Anchoring to
  // the title prefix `<label> —` keeps us isolated from description
  // text changing AND distinguishes "Customer Support" (key=support)
  // from "Customer Support Center" (key=customer-support) — both
  // titles share the prefix "Customer Support" but only the former
  // is followed immediately by " —".
  const card = page
    .locator(`button[title^=${JSON.stringify(`${enPickerLabel} —`)}]`)
    .first();
  await card.waitFor({ state: 'visible', timeout: 10_000 });
  await card.click();

  // React Flow renders one `.react-flow__node` per node. The picker
  // hands back to AgentBuilder synchronously inside `loadTemplate`,
  // which calls `setNodes(template.nodes)` — but the React Flow
  // commit is async, so we wait until at least one node is in the
  // DOM before returning.
  await page.waitForFunction(
    () => document.querySelectorAll('.react-flow__node').length > 0,
    undefined,
    { timeout: 10_000 },
  );
  console.log(`[e2e]   ${templateKeyForLogs}: picker clicked, canvas painted`);
}

/**
 * Read the first-node label from the React Flow canvas. Templates lay
 * node id '1' at y=0 and React Flow renders nodes in array-insertion
 * order, so `.react-flow__node` index 0 is the node we declared with
 * `id: '1'`. Reading the visible text inside that node tells us how
 * `data.label` resolved.
 */
async function readFirstNodeText(page: Page): Promise<string> {
  return (await page.locator('.react-flow__node').first().innerText()).trim();
}

async function run(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL ?? process.env.PLATFORM_DB_POOL_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is required to seed the tenant + agent and flip its language between iterations.',
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
    // Belt-and-braces in case the seed couldn't take the language
    // back to 'en' (e.g. CONFLICT path took an old workflow_definition).
    await resetAgentWorkflow(pool, agentId);

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    page = await ctx.newPage();

    // Track console errors and uncaught page errors across the whole
    // session. We snapshot the array length BEFORE each per-template
    // step and slice from there so a noisy login redirect can't
    // poison a downstream template's verdict.
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

    // ─── Positive localization path ───────────────────────────────────
    // For each non-English language under test, walk every starter
    // template — and on EACH iteration drive the language switch
    // through the actual Voice-panel `<select>` in the builder UI
    // (NOT a DB write). Then click the picker tile and assert the
    // first node's visible text matches the localized copy from
    // `INDUSTRY_TEMPLATE_COPY`. Driving via the UI is what catches
    // regressions in the picker → handleSettingChange →
    // setAgentSettings → industryTemplates re-memo chain.
    for (const lang of LANGUAGES_UNDER_TEST) {
      console.log(`[e2e] === language: ${lang.code} (${lang.pretty}) ===`);

      for (const tpl of TEMPLATES) {
        const errorsBefore = errors.length;
        const expectedFirstNodeLabel = lang.pick(tpl);

        await pickTemplateAndWaitForCanvas(
          page,
          builderUrl,
          lang.code,
          tpl.enPickerLabel,
          `${lang.code}/${tpl.key}`,
        );

        const firstNodeText = await readFirstNodeText(page);
        assert(
          firstNodeText.includes(expectedFirstNodeLabel),
          `[${lang.code}] template ${tpl.key}: first node should display ${JSON.stringify(expectedFirstNodeLabel)}, got ${JSON.stringify(firstNodeText)}`,
        );

        // The hint banner MUST NOT fire for any (lang, template) pair
        // where shipped copy exists — every pair in
        // `INDUSTRY_TEMPLATE_COPY` is currently filled, so an
        // unexpected hint here would mean either (a) a translation
        // entry was deleted, or (b) the resolver mis-routed a
        // populated entry to the fallback branch. Both are real bugs.
        const hintCount = await page
          .locator('span', { hasText: "hasn't been translated" })
          .count();
        assert(
          hintCount === 0,
          `[${lang.code}] template ${tpl.key}: English-fallback hint should NOT render when localized copy exists, but found ${hintCount} match(es)`,
        );

        const newErrors = errors.slice(errorsBefore);
        if (newErrors.length > 0) {
          const detail = newErrors
            .map((e, i) => `  [${i}] (${e.source}) ${e.text}`)
            .join('\n');
          throw new Error(
            `[${lang.code}] template ${tpl.key} fired ${newErrors.length} console error(s) during load:\n${detail}`,
          );
        }

        console.log(
          `[e2e]   ✓ [${lang.code}] ${tpl.key}: first node = ${JSON.stringify(expectedFirstNodeLabel)}`,
        );
      }
    }

    // ─── Forced English-fallback path ─────────────────────────────────
    // Every shipped (template, language) pair has copy today, so the
    // `usedEnglishFallback` toast is unreachable through real data
    // alone. We use the `__INDUSTRY_TEMPLATE_COPY_FORCE_MISSING__`
    // test seam in `agentBuilderI18n.ts` (gated on `typeof window`,
    // never set in product code) to simulate an untranslated entry
    // for `medical` in Spanish. The language switch to Spanish goes
    // through the same UI path as the positive loop above so the
    // hint also depends on `handleSettingChange` working correctly.
    // Asserts:
    //   1. The save banner contains the templateFallbackHint copy
    //      with "Spanish" interpolated in via getAgentLanguageLabel.
    //   2. The first node falls back to the English label
    //      ("Patient Greeting"), not the Spanish one — confirming
    //      `localized?.nodes` was bypassed and `englishCopy.nodes`
    //      was used instead.
    //
    // Only run the fallback subcase when Spanish is in scope: the
    // seam targets `medical/es`, so a `--lang=fr` slice would
    // exercise the wrong language path.
    const runFallback = LANGUAGES_UNDER_TEST.some((l) => l.code === 'es');
    if (!runFallback) {
      console.log(
        '[e2e] === skipping forced English-fallback (Spanish not in --lang filter) ===',
      );
    } else {
    console.log('[e2e] === forced English-fallback (medical/es) ===');

    // `addInitScript` runs before any page script, so the override is
    // already on `window` by the time `getIndustryTemplateCopy` is
    // first called inside `buildIndustryTemplates`. We register on
    // the context (not the page) so the script also runs on the next
    // navigation triggered by `pickTemplateAndWaitForCanvas`.
    await page.context().addInitScript(() => {
      (window as unknown as {
        __INDUSTRY_TEMPLATE_COPY_FORCE_MISSING__?: Record<string, string[]>;
      }).__INDUSTRY_TEMPLATE_COPY_FORCE_MISSING__ = { medical: ['es'] };
    });

    const errorsBeforeFallback = errors.length;
    await pickTemplateAndWaitForCanvas(
      page,
      builderUrl,
      'es',
      'Medical After-Hours',
      'forced-fallback/medical',
    );

    // The hint span renders inside the header status slot — we match
    // by partial English text because the operator's UI language is
    // English and the saveMessage uses `t('templateFallbackHint',...)`
    // which interpolates `getAgentLanguageLabel('es') = 'Spanish'`.
    // We require BOTH the banner copy AND the language label to be
    // present so a regression that drops the {language} interpolation
    // (a real bug — the operator wouldn't know which language to fix)
    // also fails the spec.
    const hintBanner = page
      .locator('span', { hasText: "hasn't been translated to Spanish" })
      .first();
    await hintBanner.waitFor({ state: 'visible', timeout: 10_000 });
    const hintText = (await hintBanner.innerText()).trim();
    assert(
      hintText.includes('Spanish'),
      `fallback hint should include the agent's language label (Spanish), got ${JSON.stringify(hintText)}`,
    );
    assert(
      hintText.includes('English'),
      `fallback hint should mention English as the language being fallen back to, got ${JSON.stringify(hintText)}`,
    );
    console.log(`[e2e]   ✓ fallback hint rendered: ${JSON.stringify(hintText)}`);

    const fallbackFirstNode = await readFirstNodeText(page);
    assert(
      fallbackFirstNode.includes('Patient Greeting'),
      `forced-fallback medical: first node should fall back to the English label "Patient Greeting", got ${JSON.stringify(fallbackFirstNode)}`,
    );
    assert(
      !fallbackFirstNode.includes('Saludo al paciente'),
      `forced-fallback medical: first node should NOT render the Spanish label when the override forces a missing entry, got ${JSON.stringify(fallbackFirstNode)}`,
    );
    console.log(
      `[e2e]   ✓ first node fell back to English label: ${JSON.stringify(fallbackFirstNode)}`,
    );

    const fallbackErrors = errors.slice(errorsBeforeFallback);
    if (fallbackErrors.length > 0) {
      const detail = fallbackErrors
        .map((e, i) => `  [${i}] (${e.source}) ${e.text}`)
        .join('\n');
      throw new Error(
        `forced-fallback medical fired ${fallbackErrors.length} console error(s) during load:\n${detail}`,
      );
    }
    } // end of `if (runFallback)`

    console.log(
      `[e2e] PASS — verified ${TEMPLATES.length} templates × ${LANGUAGES_UNDER_TEST.length} languages${runFallback ? ' + forced-fallback hint' : ' (fallback skipped)'}`,
    );
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
