/**
 * Browser smoke test for the Billing config health tile on the Platform
 * Admin dashboard. Loads `/admin/dashboard`, opens the "Billing config
 * health" tab, mocks `/api/platform/billing-config-health`, and asserts
 * the `BillingConfigHealthPanel` renders the full Base + Metered
 * AI-minute column sets, row data, and status pills — including the
 * `wrong-meter` "expected <meter>" mismatch hint and the not-opted-in
 * empty state. The verifier itself is covered by the unit test in
 * `tests/billing/verifyStripePrices.test.ts`.
 *
 * Auth + runner shape mirror `tests/e2e/adminPagesSmoke.spec.ts`.
 * Run: `npx tsx tests/e2e/platformAdminBillingHealth.spec.ts`.
 * Requires the Platform Dev workflow running, the admin seeded via
 * `scripts/seed-admin.ts`, and `npx playwright install chromium`.
 *
 * Env vars (all optional):
 *   E2E_BASE_URL        default http://localhost:5000
 *   E2E_ADMIN_EMAIL     default admin@voiceaihub.dev
 *   E2E_ADMIN_PASSWORD  default test-password-123
 *   E2E_ARTIFACT_DIR    default .ci-logs/screenshots
 */
import { chromium, type Browser, type Locator, type Page, type Route } from 'playwright';
import { mkdir } from 'fs/promises';
import path from 'path';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@voiceaihub.dev';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'test-password-123';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';

const SPEC_NAME = 'platform-admin-billing-health';
const PAGE_TIMEOUT_MS = 20_000;

// Shape mirrors `VerifyStripePricesReport` + the `lastScheduledRun`
// field added by `server/admin-api/routes/platformBillingHealth.ts`.
// Kept inline so the spec runs as a single tsx script.
type PriceCheckStatus =
  | 'ok'
  | 'missing-env'
  | 'stripe-error'
  | 'wrong-interval'
  | 'no-amount'
  | 'wrong-usage-type'
  | 'wrong-meter';

interface MockPriceRow {
  envKey: string;
  plan: 'free' | 'starter' | 'pro' | 'enterprise';
  kind: 'base' | 'metered-ai-minutes';
  interval: 'monthly' | 'annual' | null;
  status: PriceCheckStatus;
  priceId: string | null;
  expectedInterval: 'month' | 'year' | null;
  actualInterval: 'month' | 'year' | null;
  expectedUsageType: 'licensed' | 'metered';
  actualUsageType: 'licensed' | 'metered' | null;
  expectedMeter: string | null;
  actualMeter: string | null;
  unitAmountCents: number | null;
  unitAmountDecimal: string | null;
  monthlyEquivalentCents: number | null;
  catalogMonthlyCents: number | null;
  catalogOverageRatePerMinute: number | null;
  message?: string;
}

interface MockBillingHealthResponse {
  summary: {
    total: number;
    ok: number;
    failed: number;
    status: 'ok' | 'failed';
    message: string;
  };
  results: MockPriceRow[];
  generatedAt: string;
  lastScheduledRun: null;
}

const NOW_ISO = '2026-04-30T12:00:00.000Z';

const BASE_ROW: MockPriceRow = {
  envKey: 'STRIPE_PRICE_PRO_MONTHLY',
  plan: 'pro',
  kind: 'base',
  interval: 'monthly',
  status: 'ok',
  priceId: 'price_test_pro_monthly',
  expectedInterval: 'month',
  actualInterval: 'month',
  expectedUsageType: 'licensed',
  actualUsageType: 'licensed',
  expectedMeter: null,
  actualMeter: null,
  unitAmountCents: 19900,
  unitAmountDecimal: '19900',
  monthlyEquivalentCents: 19900,
  catalogMonthlyCents: 19900,
  catalogOverageRatePerMinute: null,
};

/** Healthy metered row — drives the "OK" status pill assertion. */
const METERED_OK_ROW: MockPriceRow = {
  envKey: 'STRIPE_PRICE_PRO_AI_MINUTES',
  plan: 'pro',
  kind: 'metered-ai-minutes',
  interval: null,
  status: 'ok',
  priceId: 'price_test_pro_ai_minutes',
  expectedInterval: null,
  actualInterval: null,
  expectedUsageType: 'metered',
  actualUsageType: 'metered',
  expectedMeter: 'mtr_test_ai_minutes',
  actualMeter: 'mtr_test_ai_minutes',
  unitAmountCents: null,
  unitAmountDecimal: '8.5',
  monthlyEquivalentCents: null,
  catalogMonthlyCents: null,
  catalogOverageRatePerMinute: 0.085,
};

// Mismatched metered row — drives the "Wrong meter" status pill and
// the "expected <expectedMeter>" hint that only renders on mismatch.
const METERED_MISMATCH_ROW: MockPriceRow = {
  envKey: 'STRIPE_PRICE_ENTERPRISE_AI_MINUTES',
  plan: 'enterprise',
  kind: 'metered-ai-minutes',
  interval: null,
  status: 'wrong-meter',
  priceId: 'price_test_enterprise_ai_minutes',
  expectedInterval: null,
  actualInterval: null,
  expectedUsageType: 'metered',
  actualUsageType: 'metered',
  expectedMeter: 'mtr_test_ai_minutes',
  actualMeter: 'mtr_wrong_id',
  unitAmountCents: null,
  unitAmountDecimal: '7',
  monthlyEquivalentCents: null,
  catalogMonthlyCents: null,
  catalogOverageRatePerMinute: 0.07,
  message:
    'Price price_test_enterprise_ai_minutes has recurring.meter=mtr_wrong_id, expected mtr_test_ai_minutes (STRIPE_METER_AI_MINUTES)',
};

function buildResponse(opts: { withMetered: boolean }): MockBillingHealthResponse {
  const results: MockPriceRow[] = [BASE_ROW];
  if (opts.withMetered) {
    results.push(METERED_OK_ROW, METERED_MISMATCH_ROW);
  }
  const failed = results.filter((r) => r.status !== 'ok').length;
  const ok = results.length - failed;
  return {
    summary: {
      total: results.length,
      ok,
      failed,
      status: failed === 0 ? 'ok' : 'failed',
      message:
        failed === 0
          ? opts.withMetered
            ? `All ${results.length} Stripe prices verified (1 base + 2 metered AI-minutes).`
            : `All ${results.length} STRIPE_PRICE_<TIER>_<INTERVAL> env vars verified.`
          : `${failed} of ${results.length} checks failed.`,
    },
    results,
    generatedAt: NOW_ISO,
    lastScheduledRun: null,
  };
}

/** Column-header sets the spec contracts on. Order matches the panel. */
const BASE_TABLE_HEADERS = [
  'Env var',
  'Plan',
  'Interval',
  'Stripe price id',
  'Unit amount',
  'Monthly equiv.',
  'Catalog',
  'Status',
] as const;

const METERED_TABLE_HEADERS = [
  'Env var',
  'Plan',
  'Stripe price id',
  'Per-minute rate',
  'Catalog',
  'Meter',
  'Status',
] as const;

interface CaseFailure {
  caseName: string;
  reason: string;
  consoleErrors: string[];
  pageErrors: string[];
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function login(page: Page): Promise<void> {
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', ADMIN_EMAIL);
  await page.fill('input[type="password"]', ADMIN_PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.toString().endsWith('/login'), { timeout: 15_000 }),
    page.click('button[type="submit"]'),
  ]);
}

// Reinstalled per case so the previous handler's `withMetered` closure
// doesn't leak between scenarios.
async function installApiMock(page: Page, withMetered: boolean): Promise<void> {
  await page.unroute('**/api/platform/billing-config-health').catch(() => undefined);
  await page.route('**/api/platform/billing-config-health', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildResponse({ withMetered })),
    });
  });
}

async function expectVisible(page: Page, locator: Locator, label: string): Promise<void> {
  try {
    await locator.first().waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
  } catch (err) {
    throw new Error(`expected ${label} to be visible (${(err as Error).message})`);
  }
}

// Scoped to a specific <table> because "Env var", "Plan", "Stripe
// price id", "Catalog", and "Status" appear in BOTH tables.
async function assertTableHeaders(
  table: Locator,
  headers: readonly string[],
  scopeLabel: string,
): Promise<void> {
  for (const header of headers) {
    const cell = table.locator('thead th', { hasText: header });
    try {
      await cell.first().waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    } catch (err) {
      throw new Error(
        `expected ${scopeLabel} table to have column header "${header}" (${(err as Error).message})`,
      );
    }
  }
}

async function runCase(
  page: Page,
  caseName: string,
  withMetered: boolean,
): Promise<CaseFailure | null> {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const onConsole = (msg: import('playwright').ConsoleMessage) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  };
  const onPageError = (err: Error) => pageErrors.push(err.message);
  page.on('console', onConsole);
  page.on('pageerror', onPageError);

  let reason: string | null = null;
  try {
    await installApiMock(page, withMetered);

    // Full reload so the panel's useQuery refetches against the new
    // mock instead of the previous case's cached response.
    await page.goto(`${BASE_URL}/admin/dashboard`, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_TIMEOUT_MS,
    });

    if (/\/login(\?|$)/.test(page.url())) {
      reason = `redirected to /login (lost session?) — landed at ${page.url()}`;
      return { caseName, reason, consoleErrors, pageErrors };
    }

    await expectVisible(
      page,
      page.getByRole('heading', { name: 'Platform Administration' }),
      'Platform Administration heading',
    );
    const tab = page.getByRole('tab', { name: 'Billing config health' });
    await expectVisible(page, tab, 'Billing config health tab');
    await tab.click();

    // Panel header — proves the tab swap rendered BillingConfigHealthPanel.
    await expectVisible(
      page,
      page.getByRole('heading', { name: 'Billing config health' }),
      'Billing config health panel heading',
    );

    // ── Base prices section (always rendered, first <table>) ──
    await expectVisible(
      page,
      page.getByRole('heading', { name: 'Base prices' }),
      '"Base prices" section heading',
    );

    const baseTable = page.locator('table').nth(0);
    await expectVisible(page, baseTable, 'Base prices table');
    await assertTableHeaders(baseTable, BASE_TABLE_HEADERS, 'Base prices');

    // Distinctive cells from the mocked base row.
    await expectVisible(
      page,
      baseTable.locator('tbody').getByText(BASE_ROW.envKey, { exact: false }),
      `Base prices row for ${BASE_ROW.envKey}`,
    );
    await expectVisible(
      page,
      baseTable.locator('tbody').getByText('OK', { exact: true }),
      'Base prices "OK" status pill',
    );

    // ── Metered AI-minute prices section ──
    // <h3> always renders; table body vs. empty-state swaps on the
    // presence of metered rows.
    await expectVisible(
      page,
      page.getByRole('heading', { name: 'Metered AI-minute prices' }),
      '"Metered AI-minute prices" section heading',
    );

    if (withMetered) {
      const meteredTable = page.locator('table').nth(1);
      await expectVisible(page, meteredTable, 'Metered AI-minute prices table');
      await assertTableHeaders(meteredTable, METERED_TABLE_HEADERS, 'Metered AI-minute prices');

      const meteredBody = meteredTable.locator('tbody');

      // Healthy row: env key, per-minute rate, actual meter, OK pill.
      await expectVisible(
        page,
        meteredBody.getByText(METERED_OK_ROW.envKey, { exact: false }),
        `Metered row for ${METERED_OK_ROW.envKey}`,
      );
      // unit_amount_decimal="8.5" → fmtPerMinuteRate renders "$0.085/min".
      await expectVisible(
        page,
        meteredBody.getByText('$0.085/min', { exact: false }),
        'per-minute rate cell ($0.085/min) for the OK metered row',
      );
      await expectVisible(
        page,
        meteredBody.getByText(METERED_OK_ROW.actualMeter ?? '', { exact: false }),
        `actual meter id cell (${METERED_OK_ROW.actualMeter}) for the OK row`,
      );
      await expectVisible(
        page,
        meteredBody.getByText('OK', { exact: true }),
        'Metered "OK" status pill',
      );

      // Mismatch row: actual meter, "expected <expectedMeter>" hint
      // (only rendered on mismatch), and "Wrong meter" pill.
      await expectVisible(
        page,
        meteredBody.getByText(METERED_MISMATCH_ROW.envKey, { exact: false }),
        `Metered row for ${METERED_MISMATCH_ROW.envKey}`,
      );
      await expectVisible(
        page,
        meteredBody.getByText(METERED_MISMATCH_ROW.actualMeter ?? '', { exact: false }),
        `actual meter id cell (${METERED_MISMATCH_ROW.actualMeter}) for the mismatch row`,
      );
      await expectVisible(
        page,
        meteredBody.getByText(`expected ${METERED_MISMATCH_ROW.expectedMeter}`, {
          exact: false,
        }),
        `"expected ${METERED_MISMATCH_ROW.expectedMeter}" mismatch hint`,
      );
      await expectVisible(
        page,
        meteredBody.getByText('Wrong meter', { exact: true }),
        'Metered "Wrong meter" status pill',
      );
    } else {
      // Not-opted-in: empty-state copy renders instead of the table.
      await expectVisible(
        page,
        page.getByText('STRIPE_METER_EVENT_AI_MINUTES is not set', { exact: false }),
        '"metered AI-minute checks skipped" empty-state copy',
      );
      await expectVisible(
        page,
        page.getByText('per-tier metered AI billing is not active on this deployment', {
          exact: false,
        }),
        '"metered AI billing not active" empty-state explainer',
      );

      // Exactly one <table> on the page (base only). Catches a
      // regression that renders an empty metered table where the
      // copy assertions above would not.
      const tableCount = await page.locator('table').count();
      if (tableCount !== 1) {
        reason = `expected exactly 1 table (Base prices only) when STRIPE_METER_EVENT_AI_MINUTES is unset, found ${tableCount}`;
      }

      // And none of the metered-only column headers may appear.
      if (!reason) {
        for (const meteredOnlyHeader of ['Per-minute rate', 'Meter']) {
          const count = await page
            .getByRole('columnheader', { name: meteredOnlyHeader, exact: true })
            .count();
          if (count > 0) {
            reason = `metered table column header "${meteredOnlyHeader}" rendered when STRIPE_METER_EVENT_AI_MINUTES is unset`;
            break;
          }
        }
      }
    }

    if (!reason && pageErrors.length > 0) {
      reason = `uncaught page error(s): ${pageErrors.slice(0, 3).join(' | ')}`;
    }
  } catch (err) {
    reason = (err as Error).message;
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
  }

  if (!reason) return null;

  const shotPath = path.join(ARTIFACT_DIR, `${SPEC_NAME}-${caseName}.png`);
  await mkdir(path.dirname(shotPath), { recursive: true }).catch(() => undefined);
  await page.screenshot({ path: shotPath, fullPage: true }).catch((err) => {
    console.warn(`[e2e] failed to write screenshot to ${shotPath}: ${(err as Error).message}`);
  });
  console.error(`[e2e] FAIL ${caseName}: ${reason}`);
  console.error(`[e2e]   screenshot: ${shotPath}`);
  if (consoleErrors.length > 0) {
    console.error(
      `[e2e]   console errors (${consoleErrors.length}): ${consoleErrors.slice(0, 5).join(' | ')}`,
    );
  }
  return { caseName, reason, consoleErrors, pageErrors };
}

async function captureGlobalFailureScreenshot(page: Page | undefined): Promise<void> {
  if (!page) return;
  const shotPath = path.join(ARTIFACT_DIR, `${SPEC_NAME}-global-failure.png`);
  try {
    await mkdir(path.dirname(shotPath), { recursive: true });
    await page.screenshot({ path: shotPath, fullPage: true });
    console.error(`[e2e]   screenshot: ${shotPath}`);
  } catch (err) {
    console.warn(`[e2e] failed to write global-failure screenshot to ${shotPath}: ${(err as Error).message}`);
  }
}

async function run(): Promise<void> {
  let browser: Browser | undefined;
  let page: Page | undefined;
  const failures: CaseFailure[] = [];
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await ctx.newPage();

    await login(page);
    console.log(`[e2e] logged in as ${ADMIN_EMAIL}`);

    for (const c of [
      { name: 'opted-in', withMetered: true },
      { name: 'not-opted-in', withMetered: false },
    ]) {
      console.log(`[e2e] -> case: ${c.name}`);
      const failure = await runCase(page, c.name, c.withMetered);
      if (failure) failures.push(failure);
      else console.log(`[e2e]    OK`);
    }
  } catch (err) {
    await captureGlobalFailureScreenshot(page);
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }

  if (failures.length > 0) {
    console.error(`[e2e] ${failures.length} billing-health case(s) failed:`);
    for (const f of failures) {
      console.error(`[e2e]   - ${f.caseName}: ${f.reason}`);
    }
    assert(false, `${failures.length} billing-health smoke case(s) failed`);
  }

  console.log(`[e2e] PASS — billing-health panel rendered correctly in both opted-in and not-opted-in cases`);
}

run().catch((err) => {
  console.error('[e2e] FAIL', err);
  process.exitCode = 1;
});
