/**
 * Task #1032: automated accessibility audit for the Refined Harbor
 * StatusBadge / StatusDot components on the authenticated tenant pages.
 *
 * The badges and dots picked up explicit `aria-label` / `title` / `srLabel`
 * support in an earlier task, but the regression risk is that a future
 * contributor strips one of those props (or wraps the component in a
 * `<button>` / `<a>` that loses its accessible name) without anyone
 * noticing — they sit on authenticated, role-gated routes that the
 * existing public-page contrast spec doesn't reach.
 *
 * For each of Dashboard, Operations, Quality, Billing, Dispatch, and
 * SmsInbox this spec:
 *
 *   1. Logs in as the seeded admin (which holds `tenant_owner` on
 *      admin-org via `seed-admin.ts`, the same auth path the existing
 *      `tenantPagesSmoke.spec.ts` relies on).
 *   2. Navigates to the page and waits for the expected `<h1>` so the
 *      lazy chunk has actually rendered.
 *   3. Counts the visible status badges and dots on the page using the
 *      `[data-status-badge]` / `[data-status-dot]` markers added to the
 *      shared components.
 *   4. Injects axe-core (the bundled `axe.min.js` from the npm package)
 *      and runs `axe.run(...)` SCOPED to those badge/dot selectors only.
 *      Scoping keeps the audit honest against the task's stated goal —
 *      "Verify status badge accessibility" — and keeps it from failing on
 *      pre-existing layout issues elsewhere on the page that are out of
 *      scope for this task.
 *   5. Fails the run if axe reports any violation with `impact` of
 *      `critical` or `serious` against a badge/dot node. Lower-impact
 *      `moderate` / `minor` results are surfaced as warnings only.
 *
 * Standalone runner — no `@playwright/test` dependency. Mirrors the
 * conventions in `tests/e2e/tenantPagesSmoke.spec.ts` and
 * `tests/e2e/publicDarkModeContrast.spec.ts`:
 *
 *   npx tsx tests/e2e/tenantStatusBadgeAxe.spec.ts
 *
 * Pre-requisites (same as `tenantPagesSmoke.spec.ts`):
 *   - Platform Dev workflow running (admin API on :3002, vite on :5000).
 *   - `ADMIN_PASSWORD=<known-password> npx tsx scripts/seed-admin.ts` has
 *     been run, so the platform-admin login below succeeds.
 *   - Playwright browsers installed: `npx playwright install chromium`.
 *
 * Env vars (all optional):
 *   E2E_BASE_URL          default http://localhost:5000
 *   E2E_ADMIN_EMAIL       default admin@voiceaihub.dev
 *   E2E_ADMIN_PASSWORD    default test-password-123
 *   E2E_ARTIFACT_DIR      default .ci-logs/screenshots
 *   AXE_BADGE_SETTLE_MS   default 1500   ms to wait after the heading
 *                                         appears for badge-bearing cards
 *                                         (counts pills, status dots, etc)
 *                                         to actually mount.
 */
import { chromium, type Browser, type Page } from 'playwright';
import { mkdir, readFile } from 'fs/promises';
import path from 'path';
// axe-core ships with bundled TypeScript types under `axe-core/axe.d.ts`.
// Importing them as types lets us strongly type both the result shape
// returned over `page.evaluate(...)` and the `window.axe` global the
// injected `axe.min.js` exposes — no `any` casts.
import type axe from 'axe-core';

declare global {
  interface Window {
    axe: typeof axe;
  }
}

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@voiceaihub.dev';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'test-password-123';
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '.ci-logs/screenshots';
const BADGE_SETTLE_MS = Number(process.env.AXE_BADGE_SETTLE_MS ?? '1500');

const SPEC_NAME = 'tenant-status-badge-axe';

/** Selectors the bundled `StatusBadge` / `StatusDot` components stamp on
 *  every render. Kept in sync with `client-app/src/components/ui/`. */
const BADGE_SELECTORS = ['[data-status-badge]', '[data-status-dot]'] as const;

/** Severities that fail the run. axe rule impact ladder is
 *  `minor < moderate < serious < critical`. */
const BLOCKING_IMPACTS = new Set(['critical', 'serious']);

/** Per-page navigation + render budget. Kept in line with the other
 *  authenticated tenant smoke specs. */
const PAGE_TIMEOUT_MS = 25_000;

interface PageCheck {
  /** Path under BASE_URL — e.g. `/dispatch`. */
  path: string;
  /** Human-friendly slug used for screenshot filenames. */
  slug: string;
  /** Heading text used to wait for the lazy chunk to mount. */
  heading: string;
  /**
   * Per-page expectation about whether the page should render at least
   * one StatusBadge / StatusDot under the test fixtures (admin-only
   * seed). This is the explicit per-page coverage marker the audit
   * uses to decide whether a zero-badge result is a hard failure or a
   * soft warning:
   *
   *   `'required'` — the page is known to render badges with zero data
   *     (chrome-level pills, integration counts, subscription state,
   *     etc.). A zero-badge result here means a regression silently
   *     stripped the badges and the audit would otherwise no-op.
   *     Treated as a failure.
   *
   *   `'data-dependent'` — the page only renders badges inside per-row
   *     data (jobs, conversations, calls). Under the admin-only seed
   *     used by `admin-e2e.yml` there are no rows yet, so a zero-badge
   *     result is expected and emitted as a warning rather than a
   *     failure. Tracked by follow-up #1159 (seed demo data) so this
   *     leniency can be tightened to `'required'` once that work
   *     lands.
   */
  expectsBadges: 'required' | 'data-dependent';
}

/** The six tenant-portal pages called out in the task. Each path is
 *  reachable by the seeded admin (`seed-admin.ts` grants the admin
 *  `tenant_owner` on admin-org, plus platform_admin / operations_manager
 *  for ops-side pages like Operations). */
const PAGES: PageCheck[] = [
  // Dashboard chrome (live-call dot, integration health pills, agent
  // status pills) renders ~18 badge nodes under the admin-only seed.
  { path: '/dashboard',   slug: 'dashboard',   heading: 'Dashboard',       expectsBadges: 'required' },
  // Operations Console — Live Call Activity section renders the live
  // status pill on first paint regardless of whether any call is in
  // flight, so we can require at least one badge here.
  { path: '/ops/monitor', slug: 'operations',  heading: 'Operations',      expectsBadges: 'required' },
  // Call Quality (task #1158) now renders a chrome-level
  // StatusBadge in the PageHeader status slot showing the rolling
  // average score band, plus per-row score StatusBadges in the
  // Lowest Scoring table when data exists. The chrome badge is
  // unconditional, so we can require it.
  { path: '/quality',     slug: 'quality',     heading: 'Call Quality',    expectsBadges: 'required' },
  // Billing chrome renders the subscription-state pill on every render,
  // so we require it.
  { path: '/billing',     slug: 'billing',     heading: 'Billing',         expectsBadges: 'required' },
  // Dispatch Center renders status pills only inside dispatch-job rows;
  // empty fixture in CI -> zero badges. Tracked by follow-up #1159.
  { path: '/dispatch',    slug: 'dispatch',    heading: 'Dispatch Center', expectsBadges: 'data-dependent' },
  // SMS Console renders inbox-status / unread / priority pills only
  // inside conversation rows; empty fixture in CI -> zero badges.
  // Tracked by follow-up #1159.
  { path: '/sms-inbox',   slug: 'sms-inbox',   heading: 'SMS Console',     expectsBadges: 'data-dependent' },
];

/** Subset of axe.AxeResults we serialise back from the browser. The full
 *  `AxeResults` object includes `Date`/`URL` instances that don't survive
 *  `page.evaluate`'s structured clone unchanged, so we narrow to just the
 *  violation list (which IS clone-safe) and re-use axe's own `Result` type
 *  for the violations themselves. */
type SerialisableAxeResult = { violations: axe.Result[] };

interface PageFailure {
  page: PageCheck;
  reason: string;
  blocking: axe.Result[];
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

let cachedAxeSource: string | null = null;
async function loadAxeSource(): Promise<string> {
  if (cachedAxeSource) return cachedAxeSource;
  // Prefer the minified bundle — it's ~600 KB and a non-trivial
  // `addScriptTag` payload, so we read it from disk once and cache it.
  const axePath = path.resolve(process.cwd(), 'node_modules/axe-core/axe.min.js');
  cachedAxeSource = await readFile(axePath, 'utf8');
  return cachedAxeSource;
}

async function runAxeOnBadges(
  page: Page,
): Promise<{ result: SerialisableAxeResult; badgeCount: number }> {
  const axeSource = await loadAxeSource();
  // `addScriptTag({content})` evaluates in the page context and exposes
  // `window.axe`. We then call `axe.run` with an explicit context that
  // includes only the badge/dot selectors so unrelated page-level a11y
  // issues don't fail the spec — task #1032 is specifically about badges.
  await page.addScriptTag({ content: axeSource });
  const selectors = [...BADGE_SELECTORS];
  return await page.evaluate(
    async ({ selectors }): Promise<{ result: SerialisableAxeResult; badgeCount: number }> => {
      // `window.axe` is typed via the `declare global` block at the top of
      // this file, so no `any` cast is needed here. The injected
      // `axe.min.js` from node_modules/axe-core is the same package those
      // type declarations describe.
      const axe = window.axe;
      // Count the badge/dot DOM nodes the audit will inspect. If the
      // selectors don't match anything we want a friendly "no targets"
      // outcome rather than an axe internal error.
      const badgeNodes: Element[] = [];
      for (const sel of selectors) {
        document.querySelectorAll(sel).forEach((el) => badgeNodes.push(el));
      }
      if (badgeNodes.length === 0) {
        return { result: { violations: [] }, badgeCount: 0 };
      }
      // axe Context: include is an array of selector arrays. Using
      // selector strings rather than raw nodes keeps the postMessage
      // payload small.
      const context = { include: selectors.map((s) => [s]) };
      const fullResult = await axe.run(context, {
        // Task #1032 calls out the specific regression risk: a future
        // contributor strips the new `aria-label` / `tooltip` / `srLabel`
        // props from a StatusBadge or StatusDot and a colour-only pill
        // ships to production. Restrict the rule set to the
        // accessible-name and ARIA-plumbing rules that catch exactly
        // that class of regression. We deliberately do NOT enable
        // `color-contrast` here — the badge palette comes from the
        // shared Refined Harbor design tokens and tuning those is out
        // of scope for an audit task.
        runOnly: {
          type: 'rule',
          values: [
            // StatusDot is rendered with role="img"; this rule fires if
            // the `aria-label` / accessible name is missing or empty.
            'role-img-alt',
            // StatusBadge stamps `aria-label={tooltip}`; if a regression
            // wraps it in a focusable element (button/link) without a
            // name, these rules fire.
            'button-name',
            'link-name',
            'aria-command-name',
            'aria-input-field-name',
            'aria-toggle-field-name',
            // Accessible-name plumbing — catches typos like
            // `aria-labeledby` or invalid role values.
            'aria-allowed-attr',
            'aria-required-attr',
            'aria-required-children',
            'aria-required-parent',
            'aria-roles',
            'aria-valid-attr',
            'aria-valid-attr-value',
            'aria-hidden-focus',
          ],
        },
      });
      // Project to the serialisable shape — `AxeResults` includes a
      // `Date` and `URL`, neither of which we care about and which add
      // friction to the structured-clone hop back into Node.
      return {
        result: { violations: fullResult.violations },
        badgeCount: badgeNodes.length,
      };
    },
    { selectors },
  );
}

async function checkPage(page: Page, check: PageCheck): Promise<PageFailure | null> {
  let reason: string | null = null;
  let blocking: axe.Result[] = [];
  let badgeCount = 0;

  try {
    await page.goto(`${BASE_URL}${check.path}`, {
      waitUntil: 'domcontentloaded',
      timeout: PAGE_TIMEOUT_MS,
    });

    const landed = page.url();
    if (/\/login(\?|$)/.test(landed)) {
      reason = `redirected to /login (lost session?) — landed at ${landed}`;
    } else if (!landed.includes(check.path)) {
      reason = `redirected away from ${check.path}, landed at ${landed}`;
    }

    if (!reason) {
      try {
        await page
          .getByRole('heading', { name: check.heading })
          .first()
          .waitFor({ state: 'visible', timeout: PAGE_TIMEOUT_MS });
      } catch (err) {
        reason = `expected heading "${check.heading}" never appeared (${(err as Error).message})`;
      }
    }

    // Give async cards (counts, live activity pills, dispatch tags) a
    // beat to render their badges before we audit.
    if (!reason && BADGE_SETTLE_MS > 0) {
      await page.waitForTimeout(BADGE_SETTLE_MS);
    }

    if (!reason) {
      const { result, badgeCount: count } = await runAxeOnBadges(page);
      badgeCount = count;
      if (badgeCount === 0) {
        if (check.expectsBadges === 'required') {
          // Hard failure: the page is supposed to render at least one
          // chrome-level badge regardless of fixture state. Zero badges
          // here means a regression silently stripped them and the
          // audit would otherwise no-op, defeating the point of the
          // audit.
          reason =
            'no [data-status-badge] / [data-status-dot] nodes found on a page that is expected to render badges — audit cannot run';
        } else {
          // Soft warning: data-dependent pages (Dispatch / SmsInbox)
          // only show badges inside per-row data, and the admin-only
          // seed used in CI doesn't populate those rows. Triagers
          // should know the audit no-op'd here; follow-up #1159
          // (seed demo data) will let us upgrade these to
          // `'required'`.
          console.warn(
            `[a11y] WARN ${check.path}: no [data-status-badge] / [data-status-dot] nodes found — data-dependent page, audit is a no-op until follow-up #1159 lands`,
          );
        }
      } else {
        blocking = result.violations.filter(
          (v) => v.impact != null && BLOCKING_IMPACTS.has(v.impact),
        );
        const advisory = result.violations.filter(
          (v) => v.impact == null || !BLOCKING_IMPACTS.has(v.impact),
        );
        if (advisory.length > 0) {
          console.warn(
            `[a11y] WARN ${check.path}: ${advisory.length} non-blocking violation(s): ${advisory
              .map((v) => `${v.id} (${v.impact ?? 'n/a'})`)
              .join(', ')}`,
          );
        }
        if (blocking.length > 0) {
          reason = `axe found ${blocking.length} critical/serious violation(s) on ${badgeCount} status badge/dot node(s)`;
        }
      }
    }
  } catch (err) {
    reason = `unexpected error during audit: ${(err as Error).message}`;
  }

  if (!reason) {
    console.log(`[a11y]    OK (${badgeCount} badge/dot node(s) audited)`);
    return null;
  }

  // Capture a screenshot for triage.
  const shotPath = path.join(ARTIFACT_DIR, `${SPEC_NAME}-${check.slug}.png`);
  await mkdir(path.dirname(shotPath), { recursive: true }).catch(() => undefined);
  await page.screenshot({ path: shotPath, fullPage: true }).catch((err) => {
    console.warn(`[a11y] failed to write screenshot to ${shotPath}: ${(err as Error).message}`);
  });
  console.error(`[a11y] FAIL ${check.path}: ${reason}`);
  console.error(`[a11y]   screenshot: ${shotPath}`);
  for (const v of blocking) {
    console.error(`[a11y]   - ${v.id} [${v.impact}] ${v.help}`);
    for (const n of v.nodes.slice(0, 5)) {
      console.error(`[a11y]       target: ${n.target.join(' ')}`);
      console.error(`[a11y]       html:   ${n.html.slice(0, 240)}`);
      if (n.failureSummary) {
        console.error(`[a11y]       why:    ${n.failureSummary.replace(/\s+/g, ' ').slice(0, 240)}`);
      }
    }
    console.error(`[a11y]     more: ${v.helpUrl}`);
  }

  return { page: check, reason, blocking };
}

async function captureGlobalFailureScreenshot(page: Page | undefined): Promise<void> {
  if (!page) return;
  const shotPath = path.join(ARTIFACT_DIR, `${SPEC_NAME}-global-failure.png`);
  try {
    await mkdir(path.dirname(shotPath), { recursive: true });
    await page.screenshot({ path: shotPath, fullPage: true });
    console.error(`[a11y]   screenshot: ${shotPath}`);
  } catch (err) {
    console.warn(`[a11y] failed to write global-failure screenshot to ${shotPath}: ${(err as Error).message}`);
  }
}

async function run(): Promise<void> {
  let browser: Browser | undefined;
  let page: Page | undefined;
  const failures: PageFailure[] = [];
  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    page = await ctx.newPage();

    await login(page);
    console.log(`[a11y] logged in as ${ADMIN_EMAIL}`);

    for (const check of PAGES) {
      console.log(`[a11y] -> ${check.path}`);
      const failure = await checkPage(page, check);
      if (failure) failures.push(failure);
    }
  } catch (err) {
    await captureGlobalFailureScreenshot(page);
    throw err;
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }

  if (failures.length > 0) {
    console.error(`[a11y] ${failures.length} of ${PAGES.length} tenant page(s) failed the badge audit:`);
    for (const f of failures) {
      console.error(`[a11y]   - ${f.page.path}: ${f.reason}`);
    }
    assert(false, `${failures.length} status-badge accessibility audit(s) failed`);
  }

  console.log(`[a11y] PASS — all ${PAGES.length} tenant pages cleared the status-badge axe audit`);
}

run().catch((err) => {
  console.error('[a11y] FAIL', err);
  process.exitCode = 1;
});
