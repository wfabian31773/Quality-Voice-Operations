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

// Live-screenshot card mode. The card lives next to the Base/Metered
// tables and pulls from `/last-live-run` (GitHub-API-backed). Each
// case fixes its mode so the same runner exercises:
//   * 'unconfigured' — current default in deterministic CI; card hides
//   * 'success'      — `configured: true` + `latestSuccess` thumbnail
//   * 'failure'      — `latestRun.conclusion === 'failure'` red dot +
//                      tracking-issue link
type LiveScreenshotMode = 'unconfigured' | 'success' | 'failure';

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

// ── Live-screenshot card fixtures ────────────────────────────────────
// The card's success branch needs both `latestRun` (drives the dot/
// "Last run" line) and `latestSuccess` (drives the thumbnail + the
// "Last live screenshot" timestamp button). The failure branch shares
// the same `latestSuccess` so the thumbnail keeps rendering, but
// swaps `latestRun.conclusion` to 'failure' and supplies an open
// tracking issue so the red dot + tracking-issue link both render.
const LIVE_RUN_SUCCESS_AT = '2026-04-30T08:00:00.000Z';
const LIVE_RUN_FAILURE_AT = '2026-04-30T11:30:00.000Z';
const LIVE_ARTIFACT_ID = 999_111;
const LIVE_TRACKING_ISSUE_NUMBER = 4242;
const LIVE_WORKFLOW_HTML_URL =
  'https://github.com/example/repo/actions/workflows/billing-health-live-stripe.yml';
const LIVE_TRACKING_ISSUE_LABEL_SEARCH_URL =
  'https://github.com/example/repo/issues?q=is%3Aissue+is%3Aopen+label%3Abilling-health-live-drift';

const LIVE_SUCCESS_RUN = {
  id: 100,
  conclusion: 'success' as const,
  status: 'completed',
  htmlUrl: 'https://github.com/example/repo/actions/runs/100',
  runStartedAt: LIVE_RUN_SUCCESS_AT,
  updatedAt: LIVE_RUN_SUCCESS_AT,
  headSha: 'abc1234',
  headBranch: 'main',
  event: 'schedule',
};

const LIVE_SUCCESS_SUMMARY = {
  ...LIVE_SUCCESS_RUN,
  artifactId: LIVE_ARTIFACT_ID,
  artifactExpired: false,
  artifactSizeInBytes: 2048,
  screenshotAvailable: true,
};

const LIVE_FAILURE_RUN = {
  id: 200,
  conclusion: 'failure' as const,
  status: 'completed',
  htmlUrl: 'https://github.com/example/repo/actions/runs/200',
  runStartedAt: LIVE_RUN_FAILURE_AT,
  updatedAt: LIVE_RUN_FAILURE_AT,
  headSha: 'def5678',
  headBranch: 'main',
  event: 'schedule',
};

function buildLiveRunResponse(mode: LiveScreenshotMode): unknown {
  if (mode === 'unconfigured') {
    return {
      configured: false,
      unavailableReason: 'mocked off in deterministic e2e',
      workflowHtmlUrl: null,
      trackingIssueLabelSearchUrl: null,
      latestRun: null,
      latestSuccess: null,
      openTrackingIssue: null,
      error: null,
      fetchedAt: NOW_ISO,
    };
  }
  if (mode === 'success') {
    return {
      configured: true,
      workflowHtmlUrl: LIVE_WORKFLOW_HTML_URL,
      trackingIssueLabelSearchUrl: LIVE_TRACKING_ISSUE_LABEL_SEARCH_URL,
      latestRun: LIVE_SUCCESS_RUN,
      latestSuccess: LIVE_SUCCESS_SUMMARY,
      openTrackingIssue: null,
      error: null,
      fetchedAt: NOW_ISO,
    };
  }
  // 'failure'
  return {
    configured: true,
    workflowHtmlUrl: LIVE_WORKFLOW_HTML_URL,
    trackingIssueLabelSearchUrl: LIVE_TRACKING_ISSUE_LABEL_SEARCH_URL,
    latestRun: LIVE_FAILURE_RUN,
    latestSuccess: LIVE_SUCCESS_SUMMARY,
    openTrackingIssue: {
      number: LIVE_TRACKING_ISSUE_NUMBER,
      htmlUrl: `https://github.com/example/repo/issues/${LIVE_TRACKING_ISSUE_NUMBER}`,
      title: 'Live billing-health drift detected',
      updatedAt: LIVE_RUN_FAILURE_AT,
    },
    error: null,
    fetchedAt: NOW_ISO,
  };
}

// Smallest legal PNG (1×1 transparent) — the card only needs a
// successful 200 + image/png response to render the <img>; we don't
// inspect pixel content. Hex is a hand-rolled IHDR + IDAT + IEND.
const STUB_PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000500010d0a2bb40000000049454e44ae426082',
  'hex',
);

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
async function installApiMock(
  page: Page,
  opts: { withMetered: boolean; liveScreenshot: LiveScreenshotMode },
): Promise<void> {
  const { withMetered, liveScreenshot } = opts;
  await page.unroute('**/api/platform/billing-config-health').catch(() => undefined);
  await page
    .unroute('**/api/platform/billing-config-health/last-live-run')
    .catch(() => undefined);
  await page
    .unroute('**/api/platform/billing-config-health/last-live-screenshot.png*')
    .catch(() => undefined);
  await page.route('**/api/platform/billing-config-health', async (route: Route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(buildResponse({ withMetered })),
    });
  });
  // The "Live screenshot" card (added with task-1392) fetches this
  // sibling endpoint via the GitHub-API-backed
  // `getLiveBillingHealthSummary` helper. The deterministic spec
  // doesn't have GitHub creds wired up, and we don't want a real
  // request landing on api.github.com from a PR job, so we always
  // intercept it. The `liveScreenshot` mode chooses between the
  // hide-the-card default (`'unconfigured'`), a healthy `latestSuccess`
  // payload (`'success'`), and a failed `latestRun` payload that drives
  // the red dot + tracking-issue link (`'failure'`).
  await page.route(
    '**/api/platform/billing-config-health/last-live-run',
    async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(buildLiveRunResponse(liveScreenshot)),
      });
    },
  );
  // Stub the proxied PNG endpoint with a tiny valid image so the
  // thumbnail / modal <img> tags resolve to a real bitmap instead of
  // tripping the `onError → setScreenshotMissing(true)` fallback that
  // would replace the thumbnail with the "Screenshot unavailable"
  // placeholder. Only relevant when the card is rendered at all.
  if (liveScreenshot !== 'unconfigured') {
    await page.route(
      '**/api/platform/billing-config-health/last-live-screenshot.png*',
      async (route: Route) => {
        await route.fulfill({
          status: 200,
          contentType: 'image/png',
          body: STUB_PNG_BYTES,
        });
      },
    );
  }
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

/**
 * Asserts the `LiveBillingHealthScreenshotCard` for a given mock mode.
 * Returns a failure reason string when an assertion fails, or `null`
 * when everything matches the expected branch.
 *
 *   * unconfigured → card hides itself (no "Live screenshot" header,
 *                    no `<img alt="Last live billing-health screenshot">`)
 *   * success      → card renders the timestamp button + thumbnail;
 *                    clicking the thumbnail opens the preview modal
 *   * failure      → card renders the red `Latest run: failure` dot
 *                    (aria-labelled), the "Latest run failed" text,
 *                    and a tracking-issue link by issue number
 */
async function assertLiveScreenshotCard(
  page: Page,
  mode: LiveScreenshotMode,
): Promise<string | null> {
  if (mode === 'unconfigured') {
    // The card returns null when `configured: false`. The "Live
    // screenshot" header and the labelled thumbnail must both be
    // absent — checking only the header would miss a regression that
    // dropped the early return but still hid the heading.
    const headerCount = await page
      .getByText('Live screenshot', { exact: true })
      .count();
    if (headerCount > 0) {
      return `expected live-screenshot card to be hidden when configured: false, but found ${headerCount} "Live screenshot" header(s)`;
    }
    const thumbCount = await page
      .getByAltText('Last live billing-health screenshot')
      .count();
    if (thumbCount > 0) {
      return `expected live-screenshot thumbnail <img> to be absent when configured: false, but found ${thumbCount}`;
    }
    return null;
  }

  // Both 'success' and 'failure' render the card header.
  try {
    await page
      .getByText('Live screenshot', { exact: true })
      .first()
      .waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
  } catch (err) {
    return `expected "Live screenshot" card header to be visible (${(err as Error).message})`;
  }

  // The thumbnail <img> resolves against the stubbed PNG route in
  // both render branches because `latestSuccess` is populated.
  const thumbButton = page.getByRole('button', {
    name: 'Preview last live billing-health screenshot',
  });
  try {
    await thumbButton.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
  } catch (err) {
    return `expected live-screenshot thumbnail button to be visible (${(err as Error).message})`;
  }

  if (mode === 'success') {
    // Green dot is exposed to AT via aria-label; far more stable than
    // the Tailwind class. Using an attribute selector instead of
    // `getByLabel` because the dot is a `<span>` (not a form control)
    // and `getByLabel`'s span-aria-label coverage varies by version.
    try {
      await page
        .locator('[aria-label="Latest run: success"]')
        .first()
        .waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    } catch (err) {
      return `expected aria-labelled "Latest run: success" dot (${(err as Error).message})`;
    }

    // The success run's `runStartedAt` is rendered through
    // `toLocaleString()` — exact formatting depends on the headless
    // browser locale, but the year always appears, so we anchor on
    // it. We also verify that the timestamp is rendered as a button
    // (the only button text that contains the year inside the card).
    const timestampButton = thumbButton
      .locator('xpath=ancestor::div[contains(@class,"bg-surface")][1]')
      .getByRole('button', { name: /2026/ });
    try {
      await timestampButton.first().waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    } catch (err) {
      return `expected "Last live screenshot" timestamp button (containing 2026) to be visible (${(err as Error).message})`;
    }

    // Click the thumbnail and assert the preview modal opens with the
    // dialog role + aria-label set on the modal wrapper.
    await thumbButton.click();
    const dialog = page.getByRole('dialog', {
      name: 'Last live billing-health screenshot',
    });
    try {
      await dialog.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
    } catch (err) {
      return `expected preview modal to open after clicking thumbnail (${(err as Error).message})`;
    }
    // Close the modal so it doesn't bleed into the next case if the
    // page is reused. The close button is labelled "Close preview".
    await page
      .getByRole('button', { name: 'Close preview' })
      .click()
      .catch(() => undefined);
    return null;
  }

  // mode === 'failure'
  try {
    await page
      .locator('[aria-label="Latest run: failure"]')
      .first()
      .waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
  } catch (err) {
    return `expected aria-labelled "Latest run: failure" red dot (${(err as Error).message})`;
  }
  try {
    await page
      .getByText(/Latest run failed/)
      .first()
      .waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
  } catch (err) {
    return `expected "Latest run failed" failure-state copy (${(err as Error).message})`;
  }
  // Tracking-issue link — both the visible text and the href anchor
  // the assertion so an accidental swap to the
  // `trackingIssueLabelSearchUrl` fallback link is caught.
  const trackingLink = page.getByRole('link', {
    name: new RegExp(`tracking issue #${LIVE_TRACKING_ISSUE_NUMBER}`),
  });
  try {
    await trackingLink.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
  } catch (err) {
    return `expected tracking-issue link "tracking issue #${LIVE_TRACKING_ISSUE_NUMBER}" to be visible (${(err as Error).message})`;
  }
  const href = await trackingLink.getAttribute('href');
  if (
    href !==
    `https://github.com/example/repo/issues/${LIVE_TRACKING_ISSUE_NUMBER}`
  ) {
    return `expected tracking-issue link href to point at issue #${LIVE_TRACKING_ISSUE_NUMBER}, got ${href ?? '<null>'}`;
  }
  return null;
}

async function runCase(
  page: Page,
  caseName: string,
  withMetered: boolean,
  liveScreenshot: LiveScreenshotMode,
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
    await installApiMock(page, { withMetered, liveScreenshot });

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

    // ── Live billing-health screenshot card ─────────────────────────
    // The card is mounted by `BillingConfigHealthPanel` between the
    // summary header and the prices grid. It always fetches
    // `/last-live-run`; the rendered branch depends on the mocked
    // payload's `configured` / `latestRun.conclusion` fields.
    if (!reason) {
      const cardReason = await assertLiveScreenshotCard(page, liveScreenshot);
      if (cardReason) reason = cardReason;
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

    // Each case combines a metered-opt-in mode with a live-screenshot
    // card mode. The first two re-assert the table contract from
    // task-1392's deterministic spec while also asserting the card
    // hides itself (the original "configured: false" default). The
    // last two add browser-level coverage of the card's success and
    // failure render branches that previously had none.
    const cases: Array<{
      name: string;
      withMetered: boolean;
      liveScreenshot: LiveScreenshotMode;
    }> = [
      { name: 'opted-in', withMetered: true, liveScreenshot: 'unconfigured' },
      { name: 'not-opted-in', withMetered: false, liveScreenshot: 'unconfigured' },
      { name: 'live-screenshot-success', withMetered: false, liveScreenshot: 'success' },
      { name: 'live-screenshot-failure', withMetered: false, liveScreenshot: 'failure' },
    ];
    for (const c of cases) {
      console.log(`[e2e] -> case: ${c.name}`);
      const failure = await runCase(page, c.name, c.withMetered, c.liveScreenshot);
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

  console.log(
    `[e2e] PASS — billing-health panel rendered correctly across opted-in, not-opted-in, live-screenshot-success, and live-screenshot-failure cases`,
  );
}

run().catch((err) => {
  console.error('[e2e] FAIL', err);
  process.exitCode = 1;
});
