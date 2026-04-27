# Frontend Bundle-Size Baseline

This document records the current bundle measurements for the `client-app` frontend so future work (code splitting, dependency cleanup, lazy loading) can be measured against a known starting point.

> Source backlog item: `docs/audit/09-prioritized-backlog.md` — **BL-043**.

## How to reproduce

From the repository root:

```bash
npm run analyze        # builds client-app and writes client-app/dist/stats.html (treemap)
npm run analyze:json   # same build, but writes client-app/dist/stats.json (raw data)
```

Both scripts are thin wrappers around `vite-bundle-visualizer` running against `client-app/vite.config.ts`. They run a fresh production build and emit the stats artifact under `client-app/dist/`.

Open `client-app/dist/stats.html` in a browser to interactively explore the chunk graph (treemap, sunburst, network views available via the visualizer UI). The JSON variant is useful for diffing module sizes in CI scripts later.

## Toolchain at the time of measurement

| Tool                        | Version        |
| --------------------------- | -------------- |
| Node.js                     | v20.20.0       |
| Vite                        | 6.4.1          |
| `vite-bundle-visualizer`    | 1.2.1          |
| Build mode                  | `production`   |
| Date measured               | 2026-04-27     |

The numbers below were captured by running `npm run analyze` and re-computing gzip sizes from the emitted files in `client-app/dist/assets/`.

## Top-line totals

| Group                         | Files | Raw bytes  | Raw KiB  | Gzip bytes | Gzip KiB |
| ----------------------------- | ----- | ---------- | -------- | ---------- | -------- |
| JavaScript chunks             | 177   | 3,238,138  | 3,162.2  | 897,592    | 876.6    |
| CSS chunks                    | 2     | 229,216    | 223.8    | 29,971     | 29.3     |
| `index.html`                  | 1     | 1,296      | 1.27     | 612        | 0.60     |
| **Total JS + CSS + HTML**     | 180   | 3,468,650  | 3,387.4  | 928,175    | 906.4    |

> Static assets (avatars, hero imagery, OG images, etc.) are not counted above. The total `client-app/dist/` directory weighs ≈15 MB on disk including those non-code assets.

The 500 KiB chunk-size warning Vite previously emitted for the entry chunk no longer appears: the largest emitted JS chunk is now ≈329 KiB raw (`BarChart.js`, the `recharts` shared chunk), well under Vite's default 500 KiB warning threshold.

## Largest 25 JavaScript / CSS chunks

Sorted by raw size. Hashes change every build, so they are stripped here.

| # | Chunk                  | Raw KiB | Gzip KiB |
| - | ---------------------- | ------- | -------- |
| 1 | `BarChart.js`          | 328.8   | 97.3     |
| 2 | `index.js` (entry)     | 295.0   | 80.2     |
| 3 | `AgentBuilder.js`      | 215.7   | 64.2     |
| 4 | `index.css`            | 208.3   | 26.7     |
| 5 | `react-vendor.js`      | 191.8   | 59.8     |
| 6 | `PlatformAdmin.js`     | 118.5   | 22.8     |
| 7 | `KnowledgeBase.js`     | 95.1    | 28.1     |
| 8 | `Calls.js`             | 84.8    | 24.5     |
| 9 | `Dispatch.js`          | 74.1    | 13.2     |
| 10 | `Connectors.js`       | 73.0    | 17.5     |
| 11 | `Scheduling.js`       | 63.7    | 11.4     |
| 12 | `i18n-vendor.js`      | 56.1    | 18.3     |
| 13 | `Governance.js`       | 54.9    | 11.1     |
| 14 | `Landing.js`          | 51.0    | 12.9     |
| 15 | `Campaigns.js`        | 48.9    | 10.1     |
| 16 | `SmsInbox.js`         | 44.4    | 10.3     |
| 17 | `Marketplace.js`      | 43.4    | 9.3      |
| 18 | `Settings.js`         | 42.9    | 9.7      |
| 19 | `query-vendor.js`     | 39.9    | 11.8     |
| 20 | `AdminSalesInbox.js`  | 39.0    | 10.6     |
| 21 | `Analytics.js`        | 37.1    | 10.6     |
| 22 | `router-vendor.js`    | 36.8    | 13.3     |
| 23 | `CallDebug.js`        | 35.2    | 7.1      |
| 24 | `VerticalLanding.js`  | 34.9    | 10.7     |
| 25 | `TicketAdmin.js`      | 32.5    | 5.2      |

## CSS chunks

| Chunk               | Raw KiB | Gzip KiB |
| ------------------- | ------- | -------- |
| `index.css`         | 208.3   | 26.7     |
| `AgentBuilder.css`  | 15.5    | 2.6      |

## Initial-load budget

`client-app/index.html` references the entry chunk plus a small set of vendor chunks that are statically imported by `main.tsx` / `App.tsx` and therefore preloaded via `<link rel="modulepreload">`. The eager initial payload after this round of splitting is:

| Asset                   | Gzip KiB |
| ----------------------- | -------- |
| `index.html`            | 0.6      |
| `index.js`              | 80.2     |
| `index.css`             | 26.7     |
| `react-vendor.js`       | 59.8     |
| `i18n-vendor.js`        | 18.3     |
| `router-vendor.js`      | 13.3     |
| `query-vendor.js`       | 11.8     |
| **`index.js` + `index.css` (entry payload)** | **107.5** |
| **Total eager (with vendor preloads)**       | **210.6** |

`index.js` + `index.css` — the per-deploy churn that ships on every release — is now **107.5 KiB gzip** (down from 207.0 KiB at the previous baseline, a ≈48 % reduction). The vendor chunks are content-hashed and rarely change between deploys, so they stay warm in the browser cache across releases.

`recharts` (`BarChart.js`, ≈97 KiB gzip) is **not** in the eager graph — it loads on demand the first time a chart route (Analytics, AdminAnalytics, AdminTenantAnalytics, CostOptimization, RevenueAnalytics) is visited. `@xyflow/react` ships only inside `AgentBuilder.js`, which is loaded on demand when the Agent Studio route is opened.

Route-level chunks (everything else above) load on demand via `React.lazy` / dynamic imports.

## How the splitting is configured

`client-app/vite.config.ts` uses `build.rollupOptions.output.manualChunks` to peel a handful of always-imported vendor packages out of the entry chunk:

| Manual chunk         | Packages                                                                 |
| -------------------- | ------------------------------------------------------------------------ |
| `react-vendor.js`    | `react`, `react-dom`, `react-is`, `scheduler`                            |
| `router-vendor.js`   | `react-router`, `react-router-dom`, `@remix-run/router`                  |
| `query-vendor.js`    | `@tanstack/*` (notably `@tanstack/react-query`)                          |
| `i18n-vendor.js`     | `i18next`, `react-i18next`, `i18next-browser-languagedetector`           |

Recharts, `@xyflow/react`, `@dnd-kit/*` and other heavy non-eager dependencies are intentionally **not** manually chunked; Vite's automatic chunking already places them into route-level or shared dynamic chunks (e.g. `BarChart.js`, `AgentBuilder.js`) so they are never preloaded by the entry HTML.

## Previous baseline (2026-04-27, pre-split)

Captured with the original `client-app/vite.config.ts` (no `manualChunks`) so the trend stays visible:

| Group                         | Files | Raw KiB  | Gzip KiB |
| ----------------------------- | ----- | -------- | -------- |
| JavaScript chunks             | 172   | 3,027.4  | 837.7    |
| CSS chunks                    | 2     | 223.5    | 29.9     |
| `index.html`                  | 1     | 0.94     | 0.52     |
| **Total JS + CSS + HTML**     | 175   | 3,251.9  | 868.2    |

Top three chunks at the previous baseline:

| # | Chunk                  | Raw KiB | Gzip KiB |
| - | ---------------------- | ------- | -------- |
| 1 | `index.js` (entry)     | 606.6   | 179.7    |
| 2 | `BarChart.js`          | 330.9   | 98.1     |
| 3 | `AgentBuilder.js`      | 215.6   | 64.3     |

Previous initial-load budget:

| Asset            | Gzip KiB |
| ---------------- | -------- |
| `index.html`     | 0.5      |
| `index.js`       | 179.7    |
| `index.css`      | 27.3     |
| **Total eager**  | **207.5** |

The previous build emitted Vite's "chunks larger than 500 kB after minification" warning for `index.js`; that warning is gone in the current build.

## Updating the baseline

When you intentionally land a perf win (or regression), re-run `npm run analyze` and update the totals + top-25 table above with the new numbers. Move the existing "current" measurements into a new entry under "Previous baseline" so the trend stays visible.
