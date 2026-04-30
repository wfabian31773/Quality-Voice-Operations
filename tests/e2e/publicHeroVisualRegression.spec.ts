/**
 * Task #1174: visual-regression coverage for marketing hero patterns.
 * Task #1227: extended to also cover mid-page and bottom (final-CTA) bands.
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
 * The original v1 of this spec only sampled the top 600px of every
 * route — the hero zone. Several public pages also use the same
 * `<section class="relative"><div class="absolute inset-0 bg-gradient-..."/>`
 * backstop pattern in MID-PAGE feature bands (e.g. Landing's industry +
 * platform-capabilities sections) and in the BOTTOM final-CTA band on
 * almost every page. A regression there (e.g. someone re-introducing
 * `from-white` in a dark-mode CTA section) would not be caught by
 * either the dark-mode contrast probe or the v1 hero-only check.
 *
 * v2 (this file) therefore samples THREE zones per route and asserts
 * the same dark-mode luminance invariant on each:
 *
 *   - `hero`: top 600px of the page (scroll y = 0).
 *   - `mid`:  top 600px of the viewport after scrolling halfway down
 *             the page. Catches `from-white` regressions reintroduced
 *             into mid-page feature bands.
 *   - `cta`:  bottom 600px of the viewport after scrolling so the
 *             site `<footer>` sits at the bottom edge of the viewport
 *             (or the bottom of the document if no `<footer>` exists).
 *             This is the final-CTA band that lives just above the
 *             footer on almost every public page.
 *
 * Why a colour-baseline rather than a literal pixel-diff:
 *
 *   - No dependency on a binary image lib (`sharp` / `pngjs`).
 *   - Stable across font-rendering jitter, animated counters, and the
 *     other small visual differences that make literal screenshot
 *     diffs notoriously flaky in CI.
 *   - Directly catches the regression the task calls out (a section
 *     shows a white slab in dark mode) without false positives from
 *     cosmetic tweaks that don't touch the dominant colour.
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
 *   HERO_ZONE_HEIGHT          default 600 (sample-band height, in CSS pixels)
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

// The three vertical bands sampled on every route. Order matters —
// it determines the per-route nesting order in the baseline JSON.
const ZONES = ['hero', 'mid', 'cta'] as const;
type Zone = (typeof ZONES)[number];

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
  zone: Zone;
  passed: boolean;
  probe?: ProbeResult;
  baseline?: RGB;
  diff?: number;
  reason?: string;
}

type ZoneEntry = { light: RGB; dark: RGB };
type RouteBaseline = Partial<Record<Zone, ZoneEntry>>;
type BaselineFile = Record<string, RouteBaseline>;

function loadBaselines(): BaselineFile {
  if (!fs.existsSync(BASELINE_PATH)) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`! could not parse baseline file: ${(err as Error).message}`);
    return {};
  }
  if (!raw || typeof raw !== 'object') return {};
  const out: BaselineFile = {};
  for (const [route, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    // v1 shape: { light: [r,g,b], dark: [r,g,b] } — treat as hero only.
    if (Array.isArray(e.light) && Array.isArray(e.dark)) {
      out[route] = {
        hero: { light: e.light as RGB, dark: e.dark as RGB },
      };
      continue;
    }
    // v2 shape: { hero: {...}, mid: {...}, cta: {...} }.
    const migrated: RouteBaseline = {};
    for (const zone of ZONES) {
      const z = e[zone] as { light?: RGB; dark?: RGB } | undefined;
      if (z && Array.isArray(z.light) && Array.isArray(z.dark)) {
        migrated[zone] = { light: z.light as RGB, dark: z.dark as RGB };
      }
    }
    if (Object.keys(migrated).length > 0) out[route] = migrated;
  }
  return out;
}

function writeBaselines(b: BaselineFile): void {
  fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
  // Stable key ordering so re-running with no real change produces an
  // empty git diff: routes ordered by PUBLIC_ROUTES, zones ordered by
  // ZONES, themes always [light, dark].
  const ordered: BaselineFile = {};
  for (const route of PUBLIC_ROUTES) {
    const entry = b[route];
    if (!entry) continue;
    const zoneOrdered: RouteBaseline = {};
    for (const zone of ZONES) {
      const z = entry[zone];
      if (!z) continue;
      zoneOrdered[zone] = { light: z.light, dark: z.dark };
    }
    if (Object.keys(zoneOrdered).length > 0) ordered[route] = zoneOrdered;
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
 * Runs in the page context. Samples a grid of points across a band
 * of the current viewport defined by [sampleY0, sampleY1] using
 * `elementFromPoint`, walks each sample's ancestor chain to its
 * effective opaque background colour, then returns:
 *
 *   - `average`: per-channel mean across all samples (a fingerprint
 *     stable enough to baseline against).
 *   - `dominant`: the largest cluster's mean colour (used for the
 *     dark-mode luminance invariant; less sensitive to a single
 *     light "callout" pill in an otherwise-dark band).
 *
 * Reuses the gradient + child-fill backstop logic established in
 * publicDarkModeContrast.spec.ts so a band built from a sibling
 * `absolute inset-0 bg-gradient-...` div registers correctly.
 */
function buildBandProbe(
  sampleY0: number,
  sampleY1: number,
  gridX: number,
  gridY: number,
): string {
  return `(() => {
    const Y0 = ${sampleY0};
    const Y1 = ${sampleY1};
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
    const vh = window.innerHeight;
    const y0 = Math.max(0, Math.min(vh, Y0));
    const y1 = Math.max(0, Math.min(vh, Y1));
    const bandH = Math.max(1, y1 - y0);
    const samples = [];
    // Avoid sampling literal pixel 0 — elementFromPoint(0,0) can
    // return null on some layouts. Inset by half a step.
    const stepX = w / (GRID_X + 1);
    const stepY = bandH / (GRID_Y + 1);
    for (let i = 1; i <= GRID_X; i++) {
      for (let j = 1; j <= GRID_Y; j++) {
        const x = Math.round(i * stepX);
        const y = Math.round(y0 + j * stepY);
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

/**
 * Scrolls the page so the requested zone is in the viewport, then
 * returns the [y0, y1] band (in viewport coordinates) that should be
 * sampled. Runs in the page context.
 *
 *   - hero: scroll y=0; sample top HERO_ZONE_HEIGHT of viewport.
 *   - mid:  scroll halfway down; sample top HERO_ZONE_HEIGHT of viewport.
 *   - cta:  scroll so the site `<footer>` (if present) sits at the
 *           bottom of the viewport, otherwise scroll to the bottom of
 *           the document. Sample the HERO_ZONE_HEIGHT band immediately
 *           above the footer (or at the bottom of the viewport when
 *           there is no footer).
 */
function buildZoneScroller(zone: Zone, heroH: number): string {
  return `(() => {
    const ZONE = ${JSON.stringify(zone)};
    const HERO_H = ${heroH};
    const docH = Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
    );
    const vh = window.innerHeight;
    const maxScroll = Math.max(0, docH - vh);
    let scrollY = 0;
    let y0 = 0;
    let y1 = Math.min(HERO_H, vh);
    if (ZONE === 'hero') {
      scrollY = 0;
    } else if (ZONE === 'mid') {
      scrollY = Math.round(maxScroll * 0.5);
    } else if (ZONE === 'cta') {
      // Prefer aligning the bottom of the viewport with the top of
      // the site <footer> so the band immediately above the footer
      // — the final CTA — fills the bottom of the viewport.
      const footer = document.querySelector('footer');
      const bottomEdgeDoc = footer
        ? window.scrollY + footer.getBoundingClientRect().top
        : docH;
      scrollY = Math.max(0, Math.min(maxScroll, Math.round(bottomEdgeDoc - vh)));
    }
    window.scrollTo(0, scrollY);
    // Compute the sample band in POST-SCROLL viewport coordinates
    // so getBoundingClientRect() reflects the new scroll position.
    if (ZONE === 'cta') {
      const footer = document.querySelector('footer');
      if (footer) {
        const footerTopVp = Math.max(0, Math.min(vh, Math.round(footer.getBoundingClientRect().top)));
        y1 = footerTopVp > 0 ? footerTopVp : vh;
      } else {
        y1 = vh;
      }
      y0 = Math.max(0, y1 - HERO_H);
    } else {
      y0 = 0;
      y1 = Math.min(HERO_H, vh);
    }
    return { scrollY, y0, y1, docH, vh };
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

/**
 * Open ONE page per route+theme and probe all zones in sequence,
 * scrolling between zones rather than re-navigating. This keeps the
 * full test under a couple of minutes even with 13 routes × 2 themes
 * × 3 zones (a fresh navigation per zone is multiple seconds in vite
 * dev mode).
 */
async function probeRouteThemeAllZones(
  browser: Browser,
  route: string,
  theme: Theme,
): Promise<RouteResult[]> {
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  await applyTheme(ctx, theme);
  const page: Page = await ctx.newPage();
  try {
    try {
      await page.goto(`${BASE_URL}${route}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      });
      // Best-effort: wait briefly for network to quiesce so lazy
      // public sections / icons / images are present, but don't hang
      // forever on long-poll/SSE connections.
      await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    } catch (err) {
      const reason = `navigation error: ${(err as Error).message}`;
      return ZONES.map((zone) => ({ route, theme, zone, passed: false, reason }));
    }
    await page.evaluate((t) => {
      try { localStorage.setItem('theme', t); } catch { /* ignore */ }
      document.documentElement.classList.toggle('dark', t === 'dark');
      window.scrollTo(0, 0);
    }, theme);
    // Let layout + lazy-rendered sections settle before measuring
    // doc height for mid/cta scroll positioning.
    await page.waitForTimeout(300);

    const out: RouteResult[] = [];
    for (const zone of ZONES) {
      try {
        const scroll = (await page.evaluate(
          buildZoneScroller(zone, HERO_ZONE_HEIGHT),
        )) as { scrollY: number; y0: number; y1: number; docH: number; vh: number };
        // Allow scroll-triggered reveal animations / sticky chrome
        // to settle before sampling.
        await page.waitForTimeout(250);

        const probe = buildBandProbe(
          scroll.y0,
          scroll.y1,
          SAMPLE_GRID_X,
          SAMPLE_GRID_Y,
        );
        const result = (await page.evaluate(probe)) as ProbeResult;
        out.push({ route, theme, zone, passed: true, probe: result });
      } catch (err) {
        out.push({
          route,
          theme,
          zone,
          passed: false,
          reason: `probe error: ${(err as Error).message}`,
        });
      }
    }
    return out;
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
      collected[route] = collected[route] ?? {};
      for (const theme of ['light', 'dark'] as const) {
        process.stdout.write(`  → ${theme.padEnd(5)} ${route}\n`);
        const zoneResults = await probeRouteThemeAllZones(browser, route, theme);
        for (const result of zoneResults) {
          collected[route][result.zone] = collected[route][result.zone] ?? {
            light: [0, 0, 0],
            dark: [0, 0, 0],
          };

          if (!result.probe) {
            results.push(result);
            // eslint-disable-next-line no-console
            console.log(`    · ${result.zone.padEnd(4)} FAIL (${result.reason})`);
            continue;
          }

          // Record for baseline write.
          collected[route][result.zone]![theme] = result.probe.average;

          // Hard theme invariant — dark mode dominant must be DARK.
          if (theme === 'dark') {
            const luma = relLuminance(result.probe.dominant);
            if (luma > DARK_MAX_LUMA) {
              result.passed = false;
              result.reason =
                `dark-mode dominant ${fmtRgb(result.probe.dominant)} ` +
                `has luminance ${luma.toFixed(3)} > ${DARK_MAX_LUMA} ` +
                `(suggests a white/light slab leaked into a dark ${result.zone} band)`;
            }
          }

          // Baseline diff (skipped only when explicitly updating).
          if (!UPDATE_BASELINES && result.passed) {
            const baseline = baselines[route]?.[result.zone]?.[theme];
            if (!baseline) {
              // New route or zone added since the baseline was last
              // written. Fail rather than silently passing — the
              // contributor adding it should regenerate the baseline
              // intentionally and commit the diff.
              result.passed = false;
              result.reason =
                `no baseline entry for this route+zone+theme — re-run with ` +
                `UPDATE_HERO_BASELINES=1 to seed it and commit the result`;
            } else {
              const diff = chebyshev(result.probe.average, baseline);
              result.baseline = baseline;
              result.diff = diff;
              if (diff > RGB_TOLERANCE) {
                result.passed = false;
                result.reason =
                  `${result.zone} colour drifted from baseline ${fmtRgb(baseline)} ` +
                  `to ${fmtRgb(result.probe.average)} ` +
                  `(per-channel Δ=${diff} > tolerance ${RGB_TOLERANCE})`;
              }
            }
          }

          results.push(result);
          if (result.passed) {
            const tag = result.diff !== undefined ? ` Δ=${result.diff}` : '';
            // eslint-disable-next-line no-console
            console.log(
              `    · ${result.zone.padEnd(4)} OK  avg=${fmtRgb(result.probe.average)}${tag}`,
            );
          } else {
            // eslint-disable-next-line no-console
            console.log(`    · ${result.zone.padEnd(4)} FAIL ${result.reason ?? ''}`);
          }
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
    // Don't overwrite known route/zone/theme entries with results
    // that errored out mid-run; preserve previous baselines for those.
    const merged: BaselineFile = {};
    for (const route of PUBLIC_ROUTES) {
      const existing = baselines[route] ?? {};
      const mergedRoute: RouteBaseline = { ...existing };
      for (const zone of ZONES) {
        const lightOk = results.find(
          (r) => r.route === route && r.zone === zone && r.theme === 'light' && r.probe,
        );
        const darkOk = results.find(
          (r) => r.route === route && r.zone === zone && r.theme === 'dark' && r.probe,
        );
        if (lightOk?.probe && darkOk?.probe) {
          mergedRoute[zone] = {
            light: lightOk.probe.average,
            dark: darkOk.probe.average,
          };
        }
      }
      if (Object.keys(mergedRoute).length > 0) merged[route] = mergedRoute;
    }
    writeBaselines(merged);
    // eslint-disable-next-line no-console
    console.log(
      `\n→ wrote ${Object.keys(merged).length} route baselines (×${ZONES.length} zones) to ${BASELINE_PATH}`,
    );
  }

  const failed = results.filter((r) => !r.passed);
  // eslint-disable-next-line no-console
  console.log(
    `\n${results.length - failed.length}/${results.length} route+zone+theme combinations passed ` +
      `(tolerance=${RGB_TOLERANCE}, dark max luma=${DARK_MAX_LUMA}).`,
  );
  if (failed.length) {
    for (const r of failed) {
      // eslint-disable-next-line no-console
      console.error(
        `  [FAIL] ${r.zone} ${r.theme} ${r.route} — ${r.reason ?? 'unknown'}`,
      );
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
