/**
 * Task #1174: visual-regression coverage for marketing hero patterns.
 *
 * Background — the existing dark-mode contrast probe
 * (`tests/e2e/publicDarkModeContrast.spec.ts`) catches "white text on
 * white background" classes of regression but is, by design, a
 * CONTRAST-only check. It walks elements with direct text content and
 * asserts each one has enough text/background contrast.
 *
 * That misses a whole class of bug:
 *
 *   <section class="relative">
 *     <div class="absolute inset-0 bg-gradient-to-br from-white to-..." />
 *     <div class="relative">
 *       <!-- no direct text in the offending zone -->
 *     </div>
 *   </section>
 *
 * If somebody re-introduces `from-white` on a hero gradient that is
 * supposed to be dark, the entire top of that page reads as a white
 * slab in dark mode but the contrast probe doesn't see it because no
 * text element is directly on top of the broken layer.
 *
 * This spec catches those visual regressions by sampling the actual
 * rendered colour at a grid of points across the top "hero" rectangle
 * of every public route in both light and dark mode, computing a
 * dominant RGB triple, and comparing it against a checked-in baseline
 * file (`tests/e2e/__baselines__/publicHeroColors.json`). It also
 * applies a hard theme-invariant: in dark mode the dominant hero
 * colour MUST be dark (luminance < 0.5), so even a fresh baseline
 * cannot accidentally lock in a white-slab regression.
 *
 * Why a colour-baseline rather than a literal pixel-diff:
 *
 *   - No dependency on a binary image lib (`sharp` / `pngjs`).
 *   - Stable across font-rendering jitter, animated counters, and the
 *     other small visual differences that make literal screenshot
 *     diffs notoriously flaky in CI.
 *   - Directly catches the regression the task calls out (hero shows a
 *     white slab in dark mode) without false positives from cosmetic
 *     tweaks that don't touch the dominant colour.
 *
 * Standalone runner — no `@playwright/test` dependency. Mirrors the
 * pattern established in `publicDarkModeContrast.spec.ts`:
 *
 *   npx tsx tests/e2e/publicHeroVisualRegression.spec.ts
 *
 * Pre-requisites:
 *   - Platform Dev workflow running (vite on :5000).
 *   - Playwright browsers installed: `npx playwright install chromium`.
 *
 * Env vars (all optional):
 *   E2E_BASE_URL              default http://localhost:5000
 *   UPDATE_HERO_BASELINES     default 0   (set to 1 to (re)write baseline JSON)
 *   HERO_RGB_TOLERANCE        default 32  (max per-channel RGB delta)
 *   HERO_DARK_MAX_LUMA        default 0.5 (dark theme dominant must be ≤ this)
 *   HERO_ZONE_HEIGHT          default 600 (top-of-page zone, in CSS pixels)
 *
 * Regenerating baselines after an intentional design change:
 *
 *   1. Start the Platform Dev workflow (or any vite server on :5000).
 *   2. Run:
 *        UPDATE_HERO_BASELINES=1 npm run test:e2e:public-hero-visual
 *   3. Review the diff in
 *        tests/e2e/__baselines__/publicHeroColors.json
 *      and commit it with the design change.
 */
import * as fs from 'fs';
import * as path from 'path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5000';
const UPDATE_BASELINES = process.env.UPDATE_HERO_BASELINES === '1';
const RGB_TOLERANCE = Number(process.env.HERO_RGB_TOLERANCE ?? '32');
const DARK_MAX_LUMA = Number(process.env.HERO_DARK_MAX_LUMA ?? '0.5');
const HERO_ZONE_HEIGHT = Number(process.env.HERO_ZONE_HEIGHT ?? '600');

const VIEWPORT = { width: 1280, height: 900 };
const SAMPLE_GRID_X = 16;
const SAMPLE_GRID_Y = 10;

const BASELINE_PATH = path.join(
  __dirname,
  '__baselines__',
  'publicHeroColors.json',
);

// Mirror the public-route list from publicDarkModeContrast.spec.ts so
// both checks cover the same surface. Keep this in sync if the dark-
// mode probe grows new routes.
const PUBLIC_ROUTES = [
  '/',
  '/product',
  '/features',
  '/pricing',
  '/product/federated-ingest',
  '/product/global-intelligence-network',
  '/industries/vertical-agents',
  '/demo',
  '/docs',
  '/blog',
  '/case-studies',
  '/contact',
  '/signup',
] as const;

type Theme = 'light' | 'dark';
type RGB = [number, number, number];

interface ProbeResult {
  dominant: RGB;
  average: RGB;
  samples: number;
}

interface RouteResult {
  route: string;
  theme: Theme;
  passed: boolean;
  probe?: ProbeResult;
  baseline?: RGB;
  diff?: number;
  reason?: string;
}

type BaselineFile = Record<string, { light: RGB; dark: RGB }>;

function loadBaselines(): BaselineFile {
  if (!fs.existsSync(BASELINE_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as BaselineFile;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`! could not parse baseline file: ${(err as Error).message}`);
    return {};
  }
}

function writeBaselines(b: BaselineFile): void {
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  // Stable key ordering so re-running with no real change produces an
  // empty git diff.
  const ordered: BaselineFile = {};
  for (const route of PUBLIC_ROUTES) {
    if (b[route]) ordered[route] = b[route];
  }
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(ordered, null, 2) + '\n');
}

function relLuminance([r, g, b]: RGB): number {
  const ch = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function chebyshev(a: RGB, b: RGB): number {
  return Math.max(
    Math.abs(a[0] - b[0]),
    Math.abs(a[1] - b[1]),
    Math.abs(a[2] - b[2]),
  );
}

/**
 * Runs in the page context. Samples a grid of points across the top
 * `heroHeight` × viewport-width zone using `elementFromPoint`, walks
 * each sample's ancestor chain to its effective opaque background
 * colour, then returns:
 *
 *   - `average`: per-channel mean across all samples (a fingerprint
 *     stable enough to baseline against).
 *   - `dominant`: the largest cluster's mean colour (used for the
 *     dark-mode luminance invariant; less sensitive to a single
 *     light "callout" pill in an otherwise-dark hero).
 *
 * Reuses the gradient + child-fill backstop logic established in
 * publicDarkModeContrast.spec.ts so a hero built from a sibling
 * `absolute inset-0 bg-gradient-...` div registers correctly.
 */
function buildHeroProbe(
  heroHeight: number,
  gridX: number,
  gridY: number,
): string {
  return `(() => {
    const HERO_H = ${heroHeight};
    const GRID_X = ${gridX};
    const GRID_Y = ${gridY};

    function parseColor(str) {
      if (!str) return null;
      const m = str.match(/rgba?\\(([^)]+)\\)/i);
      if (!m) return null;
      const parts = m[1].split(',').map((p) => parseFloat(p.trim()));
      if (parts.length < 3) return null;
      const [r, g, b] = parts;
      const a = parts.length >= 4 ? parts[3] : 1;
      return [r, g, b, a];
    }

    function over(fg, bg) {
      const a = fg[3];
      return [
        Math.round(fg[0] * a + bg[0] * (1 - a)),
        Math.round(fg[1] * a + bg[1] * (1 - a)),
        Math.round(fg[2] * a + bg[2] * (1 - a)),
        1,
      ];
    }

    function parseGradientStops(bgImage) {
      if (!bgImage || bgImage === 'none') return [];
      const stops = [];
      const re = /rgba?\\([^)]+\\)/gi;
      let m;
      while ((m = re.exec(bgImage)) !== null) {
        const parsed = parseColor(m[0]);
        if (parsed) stops.push(parsed);
      }
      return stops;
    }

    // Average a list of opaque colour stops. We don't know exactly
    // where in the gradient our sample point sits without parsing
    // the gradient direction + stop offsets, so the mean is a
    // pragmatic fingerprint that still flips dark↔light correctly.
    function averageStops(stops) {
      const opaque = stops.filter((s) => s[3] >= 0.999);
      if (!opaque.length) return null;
      let r = 0, g = 0, b = 0;
      for (const s of opaque) { r += s[0]; g += s[1]; b += s[2]; }
      const n = opaque.length;
      return [Math.round(r / n), Math.round(g / n), Math.round(b / n), 1];
    }

    function findFillBackstop(parent) {
      for (const child of parent.children) {
        const ccs = getComputedStyle(child);
        if (ccs.position !== 'absolute' && ccs.position !== 'fixed') continue;
        if (ccs.top !== '0px' || ccs.left !== '0px' || ccs.right !== '0px' || ccs.bottom !== '0px') continue;
        const childBg = parseColor(ccs.backgroundColor);
        if (childBg && childBg[3] >= 0.999) return childBg;
        const stops = parseGradientStops(ccs.backgroundImage);
        const avg = averageStops(stops);
        if (avg) return avg;
      }
      return null;
    }

    function effectiveBackground(el) {
      const stack = [];
      let cur = el;
      while (cur && cur.nodeType === 1) {
        const cs = getComputedStyle(cur);
        const bg = parseColor(cs.backgroundColor);
        if (bg && bg[3] > 0) {
          stack.push(bg);
          if (bg[3] >= 0.999) break;
        }
        const stops = parseGradientStops(cs.backgroundImage);
        const avg = averageStops(stops);
        if (avg) {
          stack.push(avg);
          break;
        }
        const fillBg = findFillBackstop(cur);
        if (fillBg) {
          stack.push(fillBg);
          break;
        }
        cur = cur.parentElement;
      }
      if (!stack.length || stack[stack.length - 1][3] < 0.999) {
        const rootCs = getComputedStyle(document.documentElement);
        const rootBg = parseColor(rootCs.backgroundColor);
        if (rootBg && rootBg[3] >= 0.999) {
          stack.push(rootBg);
        } else {
          stack.push([255, 255, 255, 1]);
        }
      }
      let base = stack.pop();
      while (stack.length) {
        const layer = stack.pop();
        base = over(layer, base);
      }
      return [base[0], base[1], base[2]];
    }

    const w = Math.min(window.innerWidth, document.documentElement.clientWidth || window.innerWidth);
    const h = Math.min(HERO_H, window.innerHeight);
    const samples = [];
    // Avoid sampling literal pixel 0 — elementFromPoint(0,0) can
    // return null on some layouts. Inset by half a step.
    const stepX = w / (GRID_X + 1);
    const stepY = h / (GRID_Y + 1);
    for (let i = 1; i <= GRID_X; i++) {
      for (let j = 1; j <= GRID_Y; j++) {
        const x = Math.round(i * stepX);
        const y = Math.round(j * stepY);
        const el = document.elementFromPoint(x, y);
        if (!el) continue;
        const bg = effectiveBackground(el);
        if (bg) samples.push(bg);
      }
    }

    if (!samples.length) {
      return { dominant: [255, 255, 255], average: [255, 255, 255], samples: 0 };
    }

    // Average across all samples.
    let ar = 0, ag = 0, ab = 0;
    for (const s of samples) { ar += s[0]; ag += s[1]; ab += s[2]; }
    const average = [
      Math.round(ar / samples.length),
      Math.round(ag / samples.length),
      Math.round(ab / samples.length),
    ];

    // Dominant cluster: bucket by //32, pick most populous, return its mean.
    const buckets = new Map();
    for (const s of samples) {
      const key = (s[0] >> 5) + ',' + (s[1] >> 5) + ',' + (s[2] >> 5);
      let entry = buckets.get(key);
      if (!entry) { entry = { count: 0, r: 0, g: 0, b: 0 }; buckets.set(key, entry); }
      entry.count++;
      entry.r += s[0]; entry.g += s[1]; entry.b += s[2];
    }
    let bestKey = null;
    let bestCount = -1;
    for (const [k, v] of buckets.entries()) {
      if (v.count > bestCount) { bestCount = v.count; bestKey = k; }
    }
    const top = buckets.get(bestKey);
    const dominant = [
      Math.round(top.r / top.count),
      Math.round(top.g / top.count),
      Math.round(top.b / top.count),
    ];

    return { dominant, average, samples: samples.length };
  })()`;
}

async function applyTheme(ctx: BrowserContext, theme: Theme): Promise<void> {
  await ctx.addInitScript(
    (t: string) => {
      try {
        localStorage.setItem('theme', t);
      } catch {
        /* localStorage may be unavailable on about:blank */
      }
      if (t === 'dark') {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
    },
    theme,
  );
}

async function probeRoute(
  browser: Browser,
  route: string,
  theme: Theme,
): Promise<RouteResult> {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  await applyTheme(ctx, theme);
  const page: Page = await ctx.newPage();
  try {
    await page.goto(`${BASE_URL}${route}`, {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });
    await page.evaluate((t) => {
      try { localStorage.setItem('theme', t); } catch { /* ignore */ }
      document.documentElement.classList.toggle('dark', t === 'dark');
      // Scroll to the top so probe samples the actual hero, even on
      // routes whose initial render scrolls past it for any reason.
      window.scrollTo(0, 0);
    }, theme);
    await page.waitForTimeout(250);

    const probe = buildHeroProbe(HERO_ZONE_HEIGHT, SAMPLE_GRID_X, SAMPLE_GRID_Y);
    const result = (await page.evaluate(probe)) as ProbeResult;
    return { route, theme, passed: true, probe: result };
  } catch (err) {
    return {
      route,
      theme,
      passed: false,
      reason: `navigation/probe error: ${(err as Error).message}`,
    };
  } finally {
    await ctx.close();
  }
}

function fmtRgb([r, g, b]: RGB): string {
  return `rgb(${r}, ${g}, ${b})`;
}

async function run(): Promise<void> {
  const browser: Browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  // Always load existing baselines (even when updating) so that
  // routes which error mid-run preserve their last-known-good values
  // instead of being dropped from the file.
  const baselines = loadBaselines();
  const haveBaselines = !UPDATE_BASELINES && Object.keys(baselines).length > 0;
  if (UPDATE_BASELINES) {
    // eslint-disable-next-line no-console
    console.log('  (UPDATE_HERO_BASELINES=1 — writing baselines, not asserting)');
  } else if (!haveBaselines) {
    // Hard fail rather than silently seeding: in CI, a missing
    // baseline file almost always means a bad merge or an accidental
    // delete, not "first run ever". The baseline is checked in.
    // Re-create it explicitly via:
    //   UPDATE_HERO_BASELINES=1 npm run test:e2e:public-hero-visual
    // eslint-disable-next-line no-console
    console.error(
      `\n✗ baseline file missing: ${BASELINE_PATH}\n` +
        `  Re-create it explicitly with:\n` +
        `    UPDATE_HERO_BASELINES=1 npm run test:e2e:public-hero-visual\n` +
        `  (and review the resulting JSON diff before committing).`,
    );
    await browser.close();
    process.exit(1);
  }

  const collected: BaselineFile = {};
  const results: RouteResult[] = [];

  try {
    for (const route of PUBLIC_ROUTES) {
      collected[route] = collected[route] ?? { light: [0, 0, 0], dark: [0, 0, 0] };
      for (const theme of ['light', 'dark'] as const) {
        process.stdout.write(`  · ${theme.padEnd(5)} ${route} ... `);
        const result = await probeRoute(browser, route, theme);

        if (!result.probe) {
          results.push(result);
          // eslint-disable-next-line no-console
          console.log(`FAIL (${result.reason})`);
          continue;
        }

        // Record for baseline write.
        collected[route][theme] = result.probe.average;

        // Hard theme invariant — dark mode dominant must be DARK.
        if (theme === 'dark') {
          const luma = relLuminance(result.probe.dominant);
          if (luma > DARK_MAX_LUMA) {
            result.passed = false;
            result.reason =
              `dark-mode dominant ${fmtRgb(result.probe.dominant)} ` +
              `has luminance ${luma.toFixed(3)} > ${DARK_MAX_LUMA} ` +
              `(suggests a white/light slab leaked into a dark hero)`;
          }
        }

        // Baseline diff (skipped only when explicitly updating).
        if (!UPDATE_BASELINES && result.passed) {
          const baseline = baselines[route]?.[theme];
          if (!baseline) {
            // New route added to PUBLIC_ROUTES since the baseline was
            // last written. Fail rather than silently passing — the
            // contributor adding the route should regenerate the
            // baseline intentionally and commit the diff.
            result.passed = false;
            result.reason =
              `no baseline entry for this route+theme — re-run with ` +
              `UPDATE_HERO_BASELINES=1 to seed it and commit the result`;
          } else {
            const diff = chebyshev(result.probe.average, baseline);
            result.baseline = baseline;
            result.diff = diff;
            if (diff > RGB_TOLERANCE) {
              result.passed = false;
              result.reason =
                `dominant colour drifted from baseline ${fmtRgb(baseline)} ` +
                `to ${fmtRgb(result.probe.average)} ` +
                `(per-channel Δ=${diff} > tolerance ${RGB_TOLERANCE})`;
            }
          }
        }

        results.push(result);
        if (result.passed) {
          const tag = result.diff !== undefined
            ? ` Δ=${result.diff}`
            : '';
          // eslint-disable-next-line no-console
          console.log(`OK  avg=${fmtRgb(result.probe.average)}${tag}`);
        } else {
          // eslint-disable-next-line no-console
          console.log(`FAIL ${result.reason ?? ''}`);
        }
      }
    }
  } finally {
    await browser.close();
  }

  // Merge collected colours back into the baseline file when
  // explicitly updating. (The "missing baseline" path is now a hard
  // fail handled at the top, so this branch only runs when the user
  // has explicitly opted in to a baseline write.)
  if (UPDATE_BASELINES) {
    // Don't overwrite known routes with results that errored out
    // mid-run; preserve previous baselines for those.
    const merged: BaselineFile = { ...baselines };
    for (const route of PUBLIC_ROUTES) {
      const lightOk = results.find((r) => r.route === route && r.theme === 'light' && r.probe);
      const darkOk = results.find((r) => r.route === route && r.theme === 'dark' && r.probe);
      if (lightOk?.probe && darkOk?.probe) {
        merged[route] = {
          light: lightOk.probe.average,
          dark: darkOk.probe.average,
        };
      }
    }
    writeBaselines(merged);
    // eslint-disable-next-line no-console
    console.log(`\n→ wrote ${Object.keys(merged).length} baselines to ${BASELINE_PATH}`);
  }

  const failed = results.filter((r) => !r.passed);
  // eslint-disable-next-line no-console
  console.log(
    `\n${results.length - failed.length}/${results.length} route+theme combinations passed ` +
      `(tolerance=${RGB_TOLERANCE}, dark max luma=${DARK_MAX_LUMA}).`,
  );
  if (failed.length) {
    for (const r of failed) {
      // eslint-disable-next-line no-console
      console.error(`  [FAIL] ${r.theme} ${r.route} — ${r.reason ?? 'unknown'}`);
    }
    if (UPDATE_BASELINES) {
      // eslint-disable-next-line no-console
      console.error(
        '\n  NOTE: UPDATE_HERO_BASELINES=1 only suppresses baseline-diff failures. ' +
          'The hard dark-mode luminance invariant still applies and must be fixed.',
      );
    }
    process.exit(1);
  }
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('e2e test failed:', err);
  process.exit(1);
});
