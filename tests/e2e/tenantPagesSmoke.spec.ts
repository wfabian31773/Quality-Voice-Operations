/**
 * Browser-level smoke test for high-traffic Tenant Portal pages.
 *
 * Sibling of `tests/e2e/adminPagesSmoke.spec.ts`. The admin spec catches
 * regressions in the Platform Admin surface; this spec does the same for
 * the tenant-side pages most likely to break silently between PRs
 * (Dispatch Center, Calls/Conversations, Reliability, Agents, Workflows,
 * Dashboard).
 *
 * For each page it asserts (hard fails):
 *
 *   1. The page navigates without redirecting back to /login (auth still
 *      works for the seeded admin-org tenant owner).
 *   2. The expected `<h1>` (or test-id sentinel) renders within the timeout
 *      — i.e. the route resolved, the lazy chunk loaded, and the top-level
 *      component rendered without throwing into the ErrorBoundary.
 *   3. A page-specific "data hydrated" sentinel testid renders within the
 *      timeout — added by task #1213 to catch the much more common
 *      regression where the shell renders fine but every card under it
 *      stays stuck on a skeleton/loader because its backing /api/* route
 *      changed shape. Each `dataSentinel` testid is wired into the source
 *      page on a node that only mounts after the primary fetch resolved
 *      (e.g. the post-load list wrapper, the post-load content container
 *      after the page-level loading guard returns, or the KPI grid that
 *      lives inside `!isLoading`).
 *   4. The ErrorBoundary fallback ("An unexpected error occurred", from
 *      `client-app/src/pages/ServerError.tsx`) is NOT visible.
 *   5. The RoleGuard's AccessDenied panel is NOT visible (would mean the
 *      seeded tenant_owner role on admin-org somehow regressed).
 *   6. No uncaught page errors fired during navigation.
 *   7. No 5xx responses from /api/* during page load (task #1213 turned
 *      the previous soft-warning into a hard fail). A backing route that
 *      starts returning 500 is exactly the regression class this spec
 *      exists to catch — and the prior "log a warning then move on"
 *      behaviour meant CI stayed green even when half the cards on a page
 *      were silently broken. 4xx is still allowed (auth/empty-row
 *      handling is each card's responsibility).
 *
 * Runs against a real Chromium browser via the `playwright` runtime API
 * (no @playwright/test dependency required). Standalone — no test runner.
 *
 *   npx tsx tests/e2e/tenantPagesSmoke.spec.ts
 *
 * Pre-requisites (same as the admin smoke spec):
 *   - Platform Dev workflow is running (admin API on :3002, vite on :5000).
 *   - `ADMIN_PASSWORD=<known-password> npx tsx scripts/seed-admin.ts` has been
 *     run, so the platform-admin login below succeeds. The seed script also
 *     gives that user a `tenant_owner` role on admin-org, which is what
 *     unlocks the tenant routes (RoleGuard manager+, Dispatch, etc).
 *   - Playwright browsers installed: `npx playwright install chromium`.
 *
 * Env vars (all optional):
 *   E2E_BASE_URL           default http://localhost:5000   (vite dev preview)
 *   E2E_ADMIN_EMAIL        default admin@voiceaihub.dev
 *   E2E_ADMIN_PASSWORD     default test-password-123
 *   E2E_ARTIFACT_DIR       default .ci-logs/screenshots    (failure shots)
 */
import { chromium, type Browser, type Page, type Response } from 'playwright';
import { mkdir } from 'fs/promises';
import path from 'path';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@voiceaihub.dev';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'test-password-123';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';

const SPEC_NAME = 'tenant-pages-smoke';

interface PageCheck {
  /** Path under BASE_URL — e.g. `/dispatch`. */
  path: string;
  /** Human-friendly slug used for screenshot filenames. */
  slug: string;
  /**
   * Top-level shell sentinel. One of:
   *   - { kind: 'heading'; text: string }       waits for an <h1>/<h2> with
   *       the given text content.
   *   - { kind: 'testid'; testid: string }      waits for [data-testid="..."].
   *   - { kind: 'displayValue'; value: string } waits for a form control
   *       (input/textarea/select) whose displayed value equals the string.
   *       Use this when the page's heading is an editable input so the
   *       sentinel proves *both* the shell rendered AND the data fetch that
   *       populates the input actually resolved (a missing/404'd fetch
   *       would leave the input on its empty initial state, while a testid
   *       on the shell would falsely pass).
   * Proves the route resolved and the lazy chunk mounted without throwing.
   */
  expect:
    | { kind: 'heading'; text: string }
    | { kind: 'testid'; testid: string }
    | { kind: 'displayValue'; value: string };
  /**
   * Per-page "data hydrated" sentinel testid (task #1213). Must be wired
   * into the source page on a node that only mounts after the page's
   * primary data fetch resolved successfully. Without this, the spec
   * could pass even when every panel under the heading is stuck on a
   * skeleton because /api/* changed shape. Required — every page in
   * PAGES below has one.
   *
   * For pages whose `expect` already targets a post-fetch element (e.g.
   * Agent Builder's `displayValue` against the agent name input — that
   * input only populates after GET /api/agents/:id resolves), the
   * `dataSentinel` is allowed to point at the same/equivalent post-load
   * shell node; the hydration signal is already covered by `expect` and
   * adding a redundant testid would just be noise.
   */
  dataSentinel: string;
}

const PAGES: PageCheck[] = [
  // Dashboard — first page most tenant users see after login. Heading comes
  // from the i18n key `tenant:dashboard.page_title` ("Dashboard").
  //
  // dataSentinel: the five-up StatCard grid. The grid renders
  // unconditionally inside the post-header JSX but its values are fed by
  // /api/calls/today, /api/agents and /api/usage fetches; combined with
  // the new 5xx /api hard-fail (assertion #7), a backing 500 or shape
  // regression on any of those routes now reliably fails the spec
  // instead of leaving the cards stuck on `?? 0` placeholders.
  {
    path: '/dashboard',
    slug: 'tenant-dashboard',
    expect: { kind: 'heading', text: 'Dashboard' },
    dataSentinel: 'tenant-dashboard-stats',
  },

  // Agents — `tenant:agents.page_title` ("Agents"). Heavy lazy chunk.
  //
  // dataSentinel: the post-isLoading agent list wrapper. The testid is
  // wired onto BOTH the empty-state card and the populated grid, so
  // admin-org's empty (or seeded) agent list still resolves the
  // sentinel — but a /api/agents 5xx or schema break leaves the page on
  // its skeleton and this assertion fails closed.
  {
    path: '/agents',
    slug: 'tenant-agents',
    expect: { kind: 'heading', text: 'Agents' },
    dataSentinel: 'tenant-agents-list',
  },

  // Calls / Conversations — `tenant:calls.page_title` is "Conversations".
  // The page also kicks off a /api/calls list fetch on mount, which is the
  // most common backend regression vector.
  //
  // dataSentinel: the post-isLoading list wrapper. Same dual-branch
  // wiring as Agents — empty state + populated table both carry the
  // testid, so admin-org's empty call list still resolves while a
  // /api/calls regression keeps the skeleton mounted and fails closed.
  {
    path: '/calls',
    slug: 'tenant-calls',
    expect: { kind: 'heading', text: 'Conversations' },
    dataSentinel: 'tenant-calls-list',
  },

  // Workflows — RoleGuard minRole="manager"; the admin-org tenant_owner
  // seeded by seed-admin clears that bar. PageHeader title="Workflows".
  //
  // dataSentinel: the post-isLoading workflow list wrapper, wired onto
  // both the empty-state card and the populated grid so a missing seed
  // doesn't false-fail.
  {
    path: '/workflows',
    slug: 'tenant-workflows',
    expect: { kind: 'heading', text: 'Workflows' },
    dataSentinel: 'tenant-workflows-list',
  },

  // Dispatch Center — PageHeader title="Dispatch Center". Field-service
  // page with a wide map + table that has historically been brittle when
  // a single backend route changes shape.
  //
  // dataSentinel: the top-level post-loading container. The page bails
  // out to <PageSkeleton /> while its initial fetches are in flight, so
  // the testid only mounts after the dispatch resources/jobs hydrate.
  {
    path: '/dispatch',
    slug: 'tenant-dispatch',
    expect: { kind: 'heading', text: 'Dispatch Center' },
    dataSentinel: 'dispatch-center-loaded',
  },

  // NOTE: /ops/reliability used to live in this list because it was the
  // only Ops Console page covered anywhere in CI. As of task #1153 the
  // entire Ops surface (including Reliability) is owned by
  // `tests/e2e/opsPagesSmoke.spec.ts`, so it has been removed here to
  // avoid double-coverage and to keep this spec scoped to tenant routes.

  // SMS Inbox — PageHeader title="SMS Console". The customer-flow messaging
  // workspace fetches conversation lists on mount and has historically broken
  // silently when the /api/sms/* response shape changed.
  //
  // dataSentinel: the top-level post-loading container. The page bails
  // out to <PageSkeleton /> while the conversations fetch is in flight,
  // so the testid only mounts once /api/sms-inbox/* has resolved.
  {
    path: '/sms-inbox',
    slug: 'tenant-sms-inbox',
    expect: { kind: 'heading', text: 'SMS Console' },
    dataSentinel: 'sms-inbox-loaded',
  },

  // Tickets — PageHeader title="Tickets". High-traffic for home-services and
  // legal verticals; the list-fetch endpoint has changed shape before.
  //
  // dataSentinel: the post-loading list wrapper. The page renders
  // <PageSkeleton /> while loading, then the testid lands on either the
  // empty-state card or the populated table — admin-org's seeded fixture
  // ticket lights up the populated branch.
  {
    path: '/tickets',
    slug: 'tenant-tickets',
    expect: { kind: 'heading', text: 'Tickets' },
    dataSentinel: 'tenant-tickets-list',
  },

  // Tickets Reporting — renders an explicit `<h1>Ticket Reports</h1>` (no
  // PageHeader). Charts/aggregations are fed by their own /api/tickets/*
  // analytics endpoints.
  //
  // dataSentinel: the top-level post-loading container. The page early-
  // returns to a spinner while the analytics fetch is pending, so the
  // testid only mounts once the report payload arrives.
  {
    path: '/tickets/reporting',
    slug: 'tenant-tickets-reporting',
    expect: { kind: 'heading', text: 'Ticket Reports' },
    dataSentinel: 'ticket-reporting-loaded',
  },

  // Ticket Admin — RoleGuard minRole="manager" (admin-org tenant_owner clears
  // it). TicketAdmin.tsx renders an explicit `<h1>Ticket Administration</h1>`
  // and fans out to ~8 /api/ticket-* config endpoints in parallel on mount.
  // Historically broke silently when one of those route handlers returned
  // an unexpected shape (the page would stay on its loading spinner).
  //
  // dataSentinel: the top-level post-loading container, wired into the
  // main JSX after the early loading-return. A 5xx on any of the parallel
  // /api/ticket-* fetches either keeps `loading` true (sentinel never
  // mounts) or trips the new 5xx hard-fail (assertion #7).
  {
    path: '/tickets/admin',
    slug: 'tenant-tickets-admin',
    expect: { kind: 'heading', text: 'Ticket Administration' },
    dataSentinel: 'ticket-admin-loaded',
  },

  // Ticket Detail — TicketDetail.tsx fetches /api/tickets/:id on mount and
  // renders an `<h1>` with the ticket subject. Needs a real id, so
  // scripts/seed-admin.ts seeds a fixture row with a stable id+subject
  // ("admin-org-smoke-ticket" / "Smoke Test Ticket") on the admin-org
  // tenant — keep the values here in sync with that script.
  //
  // dataSentinel: the post-loading content container. The page only
  // mounts this wrapper after the ticket payload resolved (the
  // !ticket / loading branches return separate JSX), so the sentinel
  // doubles as proof the seeded fixture row was actually fetched.
  {
    path: '/tickets/admin-org-smoke-ticket',
    slug: 'tenant-ticket-detail',
    expect: { kind: 'heading', text: 'Smoke Test Ticket' },
    dataSentinel: 'ticket-detail-loaded',
  },

  // Scheduling — PageHeader title="Scheduling". Enterprise appointment
  // management; pulls from multiple endpoints (appointments, types,
  // reminders) on mount.
  //
  // dataSentinel: the top-level post-loading container. The calendar tab
  // (which is the default landing tab) early-returns to <PageSkeleton />
  // while loading is true, so this testid only mounts once the
  // scheduling fetches resolve.
  {
    path: '/scheduling',
    slug: 'tenant-scheduling',
    expect: { kind: 'heading', text: 'Scheduling' },
    dataSentinel: 'scheduling-loaded',
  },

  // Agent Builder — the heaviest agent surface. Loads its own lazy chunk
  // and fans out to several /api/agents/* fetches on mount, so it has
  // historically been a silent-failure hotspot (any one of those fetches
  // returning the wrong shape can leave the builder stuck on its loading
  // spinner, or render the shell with empty defaults if /api/agents/:id
  // 404s). Like Ticket Detail, the route requires a real id, so
  // scripts/seed-admin.ts seeds a fixture agent with a stable id
  // ("admin-org-smoke-agent" / name "Smoke Test Agent") on the admin-org
  // tenant — keep the values here in sync with that script.
  //
  // The page header's "title" is an editable <input> bound to
  // agentSettings.name, which is populated from the GET /api/agents/:id
  // response (see useEffect on agentData in AgentBuilder.tsx). Asserting
  // a heading by the agent name doesn't work (the input's aria-label
  // wins for the heading's accessible name), and asserting a testid on
  // the rendered shell would falsely pass even if the GET 404'd
  // (isLoading would still flip to false and the shell would mount with
  // an empty name). So we sentinel on the input's display value: that
  // assertion fails closed when the seeded fixture row is missing OR
  // when the primary agent fetch returns the wrong shape, which is the
  // exact regression class this entry exists to catch.
  //
  // dataSentinel: the post-isLoading shell wrapper. The hydration check
  // is already covered by `expect` (displayValue against the populated
  // input), so this just doubles as a stable shell-loaded marker for
  // assertion #3 — they fail/pass together by construction.
  {
    path: '/agents/admin-org-smoke-agent/builder',
    slug: 'tenant-agent-builder',
    expect: { kind: 'displayValue', value: 'Smoke Test Agent' },
    dataSentinel: 'agent-builder-loaded',
  },
];

const ERROR_BOUNDARY_TEXT = 'An unexpected error occurred';
const ACCESS_DENIED_TEXT = 'Access denied';

/** Navigation/render budget per page — must stay well below the 25-min CI cap. */
const PAGE_TIMEOUT_MS = 20_000;

interface PageFailure {
  page: PageCheck;
  reason: string;
  consoleErrors: string[];
  pageErrors: string[];
  serverErrors: { url: string; status: number }[];
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

async function checkPage(page: Page, check: PageCheck): Promise<PageFailure | null> {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const serverErrors: { url: string; status: number }[] = [];

  const onConsole = (msg: import('playwright').ConsoleMessage) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  };
  const onPageError = (err: Error) => {
    pageErrors.push(err.message);
  };
  const onResponse = (res: Response) => {
    const status = res.status();
    const url = res.url();
    if (status >= 500 && status < 600 && url.includes('/api/')) {
      serverErrors.push({ url, status });
    }
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);

  let reason: string | null = null;
  try {
    await page.goto(`${BASE_URL}${check.path}`, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_TIMEOUT_MS,
    });

    // Auth check: the global redirect bounces logged-out users to /login,
    // and OpsGuard/RoleGuard would push us off-route if the seeded role
    // ever stops including tenant_owner.
    const landed = page.url();
    if (/\/login(\?|$)/.test(landed)) {
      reason = `redirected to /login (lost session?) — landed at ${landed}`;
    } else if (!landed.includes(check.path) && !landed.includes(check.path.split('?')[0])) {
      // OpsGuard-style redirect to /dashboard would land us off-route.
      reason = `redirected away from ${check.path}, landed at ${landed}`;
    }

    if (!reason) {
      // Wait for the expected sentinel. We use locator.first().waitFor() so
      // duplicate matches (e.g. h1 + breadcrumb) don't fail the strict
      // "exactly one match" rule that page.waitForSelector imposes.
      let locator;
      let sentinelDescription: string;
      if (check.expect.kind === 'heading') {
        locator = page.getByRole('heading', { name: check.expect.text }).first();
        sentinelDescription = `heading "${check.expect.text}"`;
      } else if (check.expect.kind === 'testid') {
        locator = page.locator(`[data-testid="${check.expect.testid}"]`).first();
        sentinelDescription = `[data-testid="${check.expect.testid}"]`;
      } else {
        // `page.getByDisplayValue()` does NOT exist on Playwright's
        // Page or Locator class — the seven valid `getBy*` factories
        // are getByTestId, getByAltText, getByLabel, getByPlaceholder,
        // getByText, getByTitle, getByRole. Calling the non-existent
        // method threw `TypeError: page.getByDisplayValue is not a
        // function` on every CI run since this branch was added.
        //
        // The semantic equivalent in Playwright is a CSS attribute
        // selector on the `value` HTML attribute. For React inputs
        // rendered with `value={x}` or `defaultValue={x}`, the HTML
        // attribute is set on initial mount (and stays in sync on
        // re-render via React's reconciliation), so this matches the
        // same hydration-completed condition the original API would
        // have checked. Escape any embedded double-quotes in the
        // expected value to keep the selector well-formed.
        const escapedValue = check.expect.value.replace(/"/g, '\\"');
        locator = page.locator(
          `input[value="${escapedValue}"], textarea[value="${escapedValue}"]`,
        ).first();
        sentinelDescription = `form control with displayed value "${check.expect.value}"`;
      }
      try {
        await locator.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
      } catch (err) {
        reason = `expected ${sentinelDescription} never appeared (${(err as Error).message})`;
      }
    }

    // Per-page "data hydrated" sentinel (task #1213). Wait for the
    // testid that's wired into the source page on a node that only
    // mounts once the primary data fetch has resolved. Without this,
    // the spec would happily pass a page whose shell rendered fine but
    // whose every panel is silently stuck on a skeleton.
    if (!reason) {
      const sentinel = page.locator(`[data-testid="${check.dataSentinel}"]`).first();
      try {
        await sentinel.waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
      } catch (err) {
        reason = `data sentinel [data-testid="${check.dataSentinel}"] never appeared — page shell rendered but its data widget never hydrated (${(err as Error).message})`;
      }
    }

    // Even if the heading was found, the ErrorBoundary may have rendered
    // *under* it for a child component. Guard against that explicitly.
    if (!reason) {
      const errorBoundaryVisible = await page
        .getByText(ERROR_BOUNDARY_TEXT, { exact: false })
        .first()
        .isVisible()
        .catch(() => false);
      if (errorBoundaryVisible) {
        reason = `ErrorBoundary fallback rendered ("${ERROR_BOUNDARY_TEXT}")`;
      }
    }

    // RoleGuard renders an AccessDenied panel inside the layout instead of
    // redirecting, so a missing role wouldn't trip the URL check above.
    if (!reason) {
      const accessDeniedVisible = await page
        .getByText(ACCESS_DENIED_TEXT, { exact: false })
        .first()
        .isVisible()
        .catch(() => false);
      if (accessDeniedVisible) {
        reason = `RoleGuard AccessDenied rendered ("${ACCESS_DENIED_TEXT}") — seeded tenant_owner role missing?`;
      }
    }

    if (!reason && pageErrors.length > 0) {
      reason = `uncaught page error(s): ${pageErrors.slice(0, 3).join(' | ')}`;
    }

    // Hard-fail on 5xx /api responses (task #1213). Previously these
    // were logged as soft warnings and the spec moved on — which meant
    // a backing route returning 500 stayed green in CI as long as the
    // calling card swallowed the error and rendered an empty state.
    // That's exactly the regression class this spec exists to catch,
    // so a 5xx during the page load is now grounds for failure. 4xx is
    // still tolerated (auth / not-found / empty-row handling is each
    // card's responsibility, not this spec's).
    if (!reason && serverErrors.length > 0) {
      reason = `${serverErrors.length} 5xx response(s) from /api/* during page load: ${serverErrors
        .slice(0, 5)
        .map((e) => `${e.status} ${e.url}`)
        .join(' | ')}`;
    }
  } finally {
    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('response', onResponse);
  }

  if (!reason) {
    return null;
  }

  // Capture a screenshot for triage.
  const shotPath = path.join(ARTIFACT_DIR, `${SPEC_NAME}-${check.slug}.png`);
  await mkdir(path.dirname(shotPath), { recursive: true }).catch(() => undefined);
  await page.screenshot({ path: shotPath, fullPage: true }).catch((err) => {
    console.warn(`[e2e] failed to write screenshot to ${shotPath}: ${(err as Error).message}`);
  });
  console.error(`[e2e] FAIL ${check.path}: ${reason}`);
  console.error(`[e2e]   screenshot: ${shotPath}`);
  if (consoleErrors.length > 0) {
    console.error(`[e2e]   console errors (${consoleErrors.length}): ${consoleErrors.slice(0, 5).join(' | ')}`);
  }
  // Surface 5xx /api responses in the failure log even when the spec
  // failed for a different reason — e.g. a 500 caused the data sentinel
  // to never appear, and triagers want both signals in one place.
  if (serverErrors.length > 0 && !reason.includes('5xx response')) {
    console.error(
      `[e2e]   5xx /api responses (${serverErrors.length}): ${serverErrors
        .slice(0, 5)
        .map((e) => `${e.status} ${e.url}`)
        .join(' | ')}`,
    );
  }

  return { page: check, reason, consoleErrors, pageErrors, serverErrors };
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
  // Holding the page reference outside the try block lets us capture a
  // screenshot from inside the catch when login() or per-page navigation
  // throws before checkPage() has a chance to write its own.
  let page: Page | undefined;
  const failures: PageFailure[] = [];
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await ctx.newPage();

    await login(page);
    console.log(`[e2e] logged in as ${ADMIN_EMAIL}`);

    for (const check of PAGES) {
      console.log(`[e2e] -> ${check.path}`);
      const failure = await checkPage(page, check);
      if (failure) {
        failures.push(failure);
      } else {
        console.log(`[e2e]    OK`);
      }
    }
  } catch (err) {
    // Bootstrap or unexpected throw — checkPage's per-page screenshot
    // hook never ran, so capture whatever the browser is currently
    // showing as a last-ditch artifact for triage.
    await captureGlobalFailureScreenshot(page);
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }

  if (failures.length > 0) {
    console.error(`[e2e] ${failures.length} of ${PAGES.length} tenant page(s) failed:`);
    for (const f of failures) {
      console.error(`[e2e]   - ${f.page.path}: ${f.reason}`);
    }
    assert(false, `${failures.length} tenant page smoke check(s) failed`);
  }

  console.log(`[e2e] PASS — all ${PAGES.length} tenant pages rendered cleanly`);
}

run().catch((err) => {
  console.error('[e2e] FAIL', err);
  process.exitCode = 1;
});
