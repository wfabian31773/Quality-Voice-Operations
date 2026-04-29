# Frontend Bundle-Size Baseline

This document records the current bundle measurements for the `client-app` frontend so future work (code splitting, dependency cleanup, lazy loading) can be measured against a known starting point.

> Source backlog item: `docs/audit/09-prioritized-backlog.md` — **BL-043**.

## How to reproduce

From the repository root:

```bash
npm run analyze         # builds the in-app bundle, writes client-app/dist/stats.html
npm run analyze:json    # same in-app build, writes client-app/dist/stats.json (raw data)
npm run analyze:public  # builds the marketing bundle, writes client-app/dist/public/stats.html
```

The first two scripts run `vite-bundle-visualizer` against `client-app/vite.config.ts` (the React-based in-app build). `analyze:public` runs against `client-app/vite.public.config.ts` (the Preact-based marketing build — see "Two front-end bundles" below) and writes its stats artifact under `client-app/dist/public/`.

To produce both production bundles in one go without the visualizer, run `npm --prefix client-app run build` — it shells out to `build:app` (in-app) and `build:public` (marketing) sequentially.

Open the relevant `stats.html` in a browser to interactively explore the chunk graph (treemap, sunburst, network views available via the visualizer UI). The JSON variant is useful for diffing module sizes in CI scripts later.

## Toolchain at the time of measurement

| Tool                        | Version        |
| --------------------------- | -------------- |
| Node.js                     | v20.20.0       |
| Vite                        | 6.4.1          |
| `vite-bundle-visualizer`    | 1.2.1          |
| Build mode                  | `production`   |
| Date measured               | 2026-04-29     |

The numbers below were captured by running `npm run analyze:json` and re-computing gzip sizes from the emitted files in `client-app/dist/assets/` using `gzip -9`.

## Top-line totals

| Group                         | Files | Raw bytes  | Raw KiB  | Gzip bytes | Gzip KiB |
| ----------------------------- | ----- | ---------- | -------- | ---------- | -------- |
| JavaScript chunks             | 299   | 4,311,231  | 4,210.2  | 1,245,121  | 1,215.9  |
| CSS chunks                    | 4     | 329,527    | 321.8    | 48,979     | 47.8     |
| `index.html`                  | 1     | 1,296      | 1.27     | 597        | 0.58     |
| **Total JS + CSS + HTML**     | 304   | 4,642,054  | 4,533.3  | 1,294,697  | 1,264.4  |

> Static assets (avatars, hero imagery, OG images, etc.) are not counted above. The total `client-app/dist/` directory weighs ≈15 MB on disk including those non-code assets.

The chunk count grew from 180 → 304 because each `(language, namespace)` translation pair is now its own async chunk (see "Lazy locale loading" below) and the Tailwind sheet is split into three surface-scoped sheets. Total transferred bytes for the dist tree are roughly unchanged; the win is in **what** gets shipped on the first paint.

The 500 KiB chunk-size warning Vite previously emitted for the entry chunk no longer appears: the largest emitted JS chunk is now ≈329 KiB raw (`BarChart.js`, the `recharts` shared chunk), well under Vite's default 500 KiB warning threshold.

## Largest 25 JavaScript / CSS chunks

Sorted by raw size. Hashes change every build, so they are stripped here. `tw-app.css` / `tw-public.css` and the per-language locale chunks (`marketing.js`, `common.js`, `docs.js`, `tenant.js`, `admin.js`) all share the same canonical name across languages and only differ by content hash.

| #  | Chunk                  | Raw KiB | Gzip KiB |
| -- | ---------------------- | ------- | -------- |
| 1  | `BarChart.js`          | 328.8   | 97.2     |
| 2  | `AgentBuilder.js`      | 253.3   | 71.5     |
| 3  | `agentBuilderI18n.js`  | 228.2   | 70.8     |
| 4  | `react-vendor.js`      | 191.8   | 59.8     |
| 5  | `tw-app.css`           | 164.5   | 22.9     |
| 6  | `PlatformAdmin.js`     | 147.9   | 28.0     |
| 7  | `Dispatch.js`          | 144.3   | 33.6     |
| 8  | `tw-public.css`        | 124.4   | 17.5     |
| 9  | `KnowledgeBase.js`     | 95.1    | 28.4     |
| 10 | `Calls.js`             | 87.3    | 25.4     |
| 11 | `Connectors.js`        | 86.2    | 19.9     |
| 12 | `index.js` (entry)     | 76.0    | 25.7     |
| 13 | `BackfillCalls.js`     | 73.6    | 18.0     |
| 14 | `docs.js` (locale ns)  | 67.0    | 21.1     |
| 15 | `i18n-vendor.js`       | 65.4    | 21.8     |
| 16 | `Scheduling.js`        | 63.9    | 11.6     |
| 17 | `Campaigns.js`         | 54.4    | 11.6     |
| 18 | `Governance.js`        | 54.4    | 11.3     |
| 19 | `Landing.js`           | 51.8    | 11.5     |
| 20 | `marketing.js` (×5 langs) | 45–51 | 15–17  |
| 21 | `SmsInbox.js`          | 48.3    | 11.5     |
| 22 | `Settings.js`          | 46.1    | 10.6     |
| 23 | `Marketplace.js`       | 43.7    | 9.6      |
| 24 | `TrustedCallers.js`    | 44.1    | 9.7      |
| 25 | `query-vendor.js`      | 39.9    | 11.8     |

## CSS chunks

The single eager `index.css` was split into surface-scoped sheets so public marketing pages no longer ship the in-app Tailwind output and vice-versa:

| Chunk               | Loaded by                                                   | Raw KiB | Gzip KiB |
| ------------------- | ----------------------------------------------------------- | ------- | -------- |
| `tw-app.css`        | `TenantLayout`, `AdminLayout`, `OpsLayout`, in-app pages    | 164.5   | 22.9     |
| `tw-public.css`     | `PublicLayout`, `Login`, `AcceptInvite`, public marketing pages | 124.4 | 17.5  |
| `index.css` (shell) | `main.tsx` — App / ErrorBoundary / MaintenanceGate / state shell | 17.4 | 4.9   |
| `AgentBuilder.css`  | Agent Studio route                                          | 15.5    | 2.6      |

`index.css` (the eager shell sheet) only contains design-token CSS, html/body/focus/print styles, and Tailwind output scoped to the always-loaded shell components. The two large Tailwind sheets are loaded on demand alongside the layout that needs them.

## Two front-end bundles

The build emits two SPA entry points so marketing visitors and signed-in users can have very different eager preload graphs without affecting each other:

| Bundle                    | Entry HTML                            | Vite config              | Runtime    | Output dir              | Routes served                                                   |
| ------------------------- | ------------------------------------- | ------------------------ | ---------- | ----------------------- | --------------------------------------------------------------- |
| In-app (full React)       | `client-app/dist/index.html`          | `vite.config.ts`         | React 19   | `client-app/dist/`      | Tenant / Admin / Ops / Auth / Onboarding / Agent Studio (everything else) |
| Marketing (Preact compat) | `client-app/dist/public/index.public.html` | `vite.public.config.ts` | Preact 10  | `client-app/dist/public/` | `<PublicLayout>` pages only (`/`, `/pricing`, `/blog/*`, `/docs/*`, …) |

The marketing build aliases `react`, `react-dom`, `react-dom/client`, and the JSX runtime to `preact/compat`, so source files keep importing from `react` unchanged but the runtime weight collapses from ≈69 KiB gzip (`react-vendor`) to ≈13 KiB gzip (`preact-vendor`). Marketing pages don't use any React-19-only feature, and the in-app bundle is still full React, so signed-in surfaces are unaffected.

The production server (`server/admin-api/spaFallback.ts`) classifies HTML navigations with `shared/spa/marketingRoutes.ts#isMarketingPathname()` and serves `index.public.html` for marketing URLs and `index.html` for everything else. Marketing assets live under `/public/assets/...` (set via `base: '/public/'` in the marketing config) so their hashed URLs never collide with the in-app bundle's `/assets/...`. In dev, `npm --prefix client-app run dev` keeps using the React build because the marketing routes are also declared in `App.tsx` — the production split is purely a build-time optimization.

## Initial-load budget — in-app bundle (`index.html`)

The React-based bundle's eager preload graph is **unchanged** from the previous baseline. `client-app/index.html` references the entry chunk plus a small set of vendor chunks that are statically imported by `main.tsx` / `App.tsx` and therefore preloaded via `<link rel="modulepreload">`:

| Asset                   | Gzip KiB |
| ----------------------- | -------- |
| `index.html`            | 0.89     |
| `index.js`              | 25.32    |
| `index.css` (shell)     | 4.92     |
| `react-vendor.js`       | 68.95    |
| `i18n-vendor.js`        | 21.20    |
| `router-vendor.js`      | 13.27    |
| `query-vendor.js`       | 11.84    |
| **`index.js` + `index.css` (entry payload)** | **30.24** |
| **Total eager (with vendor preloads)**       | **146.39** |

This 146 KiB gzip is what signed-in users (tenant / admin / ops / agent studio) download on a cold visit. It stays well under the 170 KiB perf budget for this surface. Note: `react-vendor.js` is slightly larger than the raw `react` + `react-dom` bytes would suggest because we explicitly pin Rollup-generated virtual modules (e.g. `\0commonjsHelpers.js`) into it. Without that pin, the same module would land in `i18n-vendor` and create a `react-vendor ↔ i18n-vendor` chunk cycle that Rollup warns about and that produces fragile preload ordering.

`recharts` (`BarChart.js`, ≈97 KiB gzip) is **not** in the eager graph — it loads on demand the first time a chart route (Analytics, AdminAnalytics, AdminTenantAnalytics, CostOptimization, RevenueAnalytics) is visited. `@xyflow/react` ships only inside `AgentBuilder.js`, which is loaded on demand when the Agent Studio route is opened.

Route-level chunks (everything else above) load on demand via `React.lazy` / dynamic imports.

## Initial-load budget — marketing bundle (`index.public.html`)

The Preact-based bundle is what visitors landing on `/`, `/pricing`, `/blog/*`, `/docs/*`, `/industries/*`, etc. download. `main.public.tsx` statically imports i18next, the router, and the design tokens, and `PublicApp.tsx` lazy-imports every public page (so `Landing.js`, `PublicLayout.js`, marketing locale chunks, etc. are not in the eager graph):

| Asset                       | Gzip KiB |
| --------------------------- | -------- |
| `index.public.html`         | 0.89     |
| `index.public.js` (entry)   | 18.08    |
| `index.css` (shell)         | 4.92     |
| `preact-vendor.js`          | 13.44    |
| `i18n-vendor.js`            | 17.77    |
| `router-vendor.js`          | 13.21    |
| **`index.public.js` + `index.css` (entry payload)** | **23.00** |
| **Total eager (with vendor preloads)**              | **68.32** |

The total eager preload graph for the public marketing surface is now **68.32 KiB gzip** — well under the 80 KiB target set in BL-043 and a **53% reduction** versus the previous unified-bundle baseline (145.57 KiB gzip). The win comes almost entirely from swapping the React 19 runtime (≈69 KiB gzip) for `preact/compat` (≈13 KiB gzip) plus dropping `query-vendor` (TanStack Query is in-app only).

There's still a `Landing.js` route chunk (≈12 KiB gzip) that fires immediately after the entry runs — it's loaded via `React.lazy` so it doesn't appear in the modulepreload list, but it is needed for first paint on `/`. End-to-end first-paint payload for `/` therefore lands around ≈80 KiB gzip including `Landing.js`, still a ≈45% reduction from the prior 145.57 KiB eager total.

Public route-level chunks (`Pricing.js`, `Docs.js`, `Blog.js`, `BlogArticle.js`, `Product.js`, `VerticalLanding.js`, etc.) all load on demand via `React.lazy` / dynamic imports, exactly the same shape they had in the unified bundle.

## How the splitting is configured

### Layouts are lazy

`client-app/src/App.tsx` no longer eagerly imports any of the layouts. `TenantLayout`, `AdminLayout`, `OpsLayout`, `PublicLayout`, and the `PlatformAssistant` overlay are all wrapped in `React.lazy(() => import(...))` and rendered inside route-level `<Suspense>` boundaries. As a consequence only the layout for the currently visited route ships — a visitor on `/` never downloads the tenant or admin layout JS.

### Tailwind is split per surface

`client-app/src/styles/` now contains:

| File              | Eager? | Purpose                                                                                          |
| ----------------- | ------ | ------------------------------------------------------------------------------------------------ |
| `_theme.css`      | shared | `@theme` + `.dark` token overrides; `@import`-ed by every Tailwind sheet below.                  |
| `tokens.css`      | yes    | Design tokens, body/html/focus/print rules — no Tailwind utilities.                              |
| `tw-shell.css`    | yes    | Tailwind output `@source`-scoped to App / ErrorBoundary / MaintenanceGate / state-shell pages.   |
| `tw-public.css`   | lazy   | Tailwind output scoped to `PublicLayout` and the public marketing / login / demo pages.          |
| `tw-app.css`      | lazy   | Tailwind output scoped to in-app components and `TenantLayout` / `AdminLayout` / `OpsLayout` pages. |

`main.tsx` imports `tokens.css` + `tw-shell.css`. Each layout / public page imports the surface sheet it actually needs. Tailwind v4's `@source` and `@source not` directives keep each sheet from emitting utilities for files outside its surface, so the public marketing pages no longer ship tenant/admin Tailwind output.

### Lazy locale loading

`client-app/src/lib/i18n.ts` now ships only `en/common` (the namespace used by the App shell, sign-in, and error pages) eagerly. Every other `(language, namespace)` pair is fetched on demand by a tiny dynamic-import backend plugged into i18next. Each `import('../locales/<lng>/<ns>.json')` becomes its own async chunk, so a visitor browsing the public marketing site in English only downloads `en/marketing.json` (alongside the marketing page chunk), and never downloads German tenant translations.

`partialBundledLanguages: true` tells i18next that the `resources` block is intentionally incomplete and to call the backend for any missing namespace. `load: 'currentOnly'` prevents it from also fetching the bare-language fallback (e.g. `pt` for `pt-BR`), which we don't ship.

### Manual vendor chunks

`client-app/vite.config.ts` uses `build.rollupOptions.output.manualChunks` to peel a handful of always-imported vendor packages out of the entry chunk:

| Manual chunk         | Packages                                                                 |
| -------------------- | ------------------------------------------------------------------------ |
| `react-vendor.js`    | `react`, `react-dom`, `react-is`, `scheduler`, plus Rollup-generated virtual modules (e.g. `\0commonjsHelpers.js`) |
| `router-vendor.js`   | `react-router`, `react-router-dom`, `@remix-run/router`                  |
| `query-vendor.js`    | `@tanstack/*` (notably `@tanstack/react-query`)                          |
| `i18n-vendor.js`     | `i18next`, `react-i18next`, `i18next-browser-languagedetector`           |

Recharts, `@xyflow/react`, `@dnd-kit/*` and other heavy non-eager dependencies are intentionally **not** manually chunked; Vite's automatic chunking already places them into route-level or shared dynamic chunks (e.g. `BarChart.js`, `AgentBuilder.js`) so they are never preloaded by the entry HTML.

## Previous baseline (2026-04-27, post-vendor-split)

This entry captures the bundle right before lazy layouts, surface-scoped Tailwind, and lazy locale loading were introduced. By the time those changes were started the eager preload graph had grown well past the 207 KiB number originally recorded under this heading — fresh measurement against the same revision of `client-app/vite.config.ts` showed **≈358 KiB gzip total eager** (driven mostly by `index.js` ballooning to ≈219 KiB gzip after multiple namespace adds, plus a single `index.css` of ≈29 KiB gzip carrying every Tailwind utility for every surface).

Top three chunks at that point:

| # | Chunk                  | Raw KiB | Gzip KiB |
| - | ---------------------- | ------- | -------- |
| 1 | `index.js` (entry)     | ~600    | ~219     |
| 2 | `BarChart.js`          | 330.9   | 98.1     |
| 3 | `AgentBuilder.js`      | 253     | ~72      |

Previous initial-load budget:

| Asset                   | Gzip KiB |
| ----------------------- | -------- |
| `index.html`            | 0.6      |
| `index.js`              | 218.6    |
| `index.css`             | 29.4     |
| `react-vendor.js`       | 61.3     |
| `i18n-vendor.js`        | 22.4     |
| `router-vendor.js`      | 13.6     |
| `query-vendor.js`       | 12.1     |
| **Total eager**         | **358.0** |

The bulk of the regression versus the original 2026-04-27 `index.js` (~80 KiB gzip) was the `marketing` namespace JSON (~16 KiB gzip per language × 5 languages = ~78 KiB gzip) being statically imported into the entry chunk along with the other four namespaces.

## Updating the baseline

When you intentionally land a perf win (or regression), re-run `npm run analyze:json` and update the totals + top-25 table above with the new numbers. Move the existing "current" measurements into a new entry under "Previous baseline" so the trend stays visible.
