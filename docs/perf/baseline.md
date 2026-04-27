# Frontend Bundle-Size Baseline

This document records the baseline bundle measurements for the `client-app` frontend so future work (code splitting, dependency cleanup, lazy loading) can be measured against a known starting point.

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
| JavaScript chunks             | 172   | 3,100,090  | 3,027.4  | 857,825    | 837.7    |
| CSS chunks                    | 2     | 228,892    | 223.5    | 30,633     | 29.9     |
| `index.html`                  | 1     | 964        | 0.94     | 530        | 0.52     |
| **Total JS + CSS + HTML**     | 175   | 3,329,946  | 3,251.9  | 888,988    | 868.2    |

> Static assets (avatars, hero imagery, OG images, etc.) are not counted above. The total `client-app/dist/` directory weighs ≈15 MB on disk including those non-code assets.

The Vite build currently emits a chunk-size warning because the main entry exceeds the default 500 KiB threshold:

> `(!) Some chunks are larger than 500 kB after minification.`

This is expected at the baseline and is what BL-043 will let us track over time.

## Largest 25 JavaScript chunks

Sorted by raw size. Hashes change every build, so they are stripped here.

| # | Chunk                  | Raw KiB | Gzip KiB |
| - | ---------------------- | ------- | -------- |
| 1 | `index.js` (entry)     | 606.6   | 179.7    |
| 2 | `BarChart.js`          | 330.9   | 98.1     |
| 3 | `AgentBuilder.js`      | 215.6   | 64.3     |
| 4 | `PlatformAdmin.js`     | 118.3   | 22.9     |
| 5 | `Calls.js`             | 85.0    | 24.5     |
| 6 | `Dispatch.js`          | 73.9    | 13.2     |
| 7 | `Connectors.js`        | 72.9    | 17.4     |
| 8 | `Scheduling.js`        | 63.6    | 11.4     |
| 9 | `Governance.js`        | 54.7    | 11.1     |
| 10 | `Landing.js`          | 50.9    | 12.9     |
| 11 | `SmsInbox.js`         | 44.3    | 10.3     |
| 12 | `Campaigns.js`        | 43.9    | 9.2      |
| 13 | `Marketplace.js`      | 43.2    | 9.3      |
| 14 | `Settings.js`         | 42.7    | 9.7      |
| 15 | `AdminSalesInbox.js`  | 38.9    | 10.6     |
| 16 | `Analytics.js`        | 37.0    | 10.6     |
| 17 | `CallDebug.js`        | 35.0    | 7.1      |
| 18 | `VerticalLanding.js`  | 34.7    | 10.7     |
| 19 | `TicketAdmin.js`      | 32.3    | 5.2      |
| 20 | `AreaChart.js`        | 31.9    | 9.2      |
| 21 | `Autopilot.js`        | 31.4    | 6.3      |
| 22 | `Product.js`          | 31.2    | 8.8      |
| 23 | `Demo.js`             | 29.0    | 7.8      |
| 24 | `Dashboard.js`        | 28.2    | 7.9      |
| 25 | `TicketDetail.js`     | 27.0    | 6.3      |

## CSS chunks

| Chunk               | Raw KiB | Gzip KiB |
| ------------------- | ------- | -------- |
| `index.css`         | 208.0   | 27.3     |
| `AgentBuilder.css`  | 15.5    | 2.6      |

## Initial-load budget (informational)

The Vite-emitted `index.html` references the entry chunk plus its preloaded CSS bundle. The eager initial payload at this baseline is therefore approximately:

| Asset            | Gzip KiB |
| ---------------- | -------- |
| `index.html`     | 0.5      |
| `index.js`       | 179.7    |
| `index.css`      | 27.3     |
| **Total eager**  | **207.5** |

Route-level chunks (everything else above) load on demand via `React.lazy` / dynamic imports.

## Suggested follow-up targets

These are observations from the baseline, not action items for this task:

- **`index.js` (≈607 KiB raw / 180 KiB gzip)** is the top candidate for further splitting. It bundles the router shell plus a number of always-imported utilities.
- **`BarChart.js` (≈331 KiB raw / 98 KiB gzip)** is dominated by `recharts`. Worth checking if the chart shell can be lazy-loaded only on dashboards that actually need it.
- **`AgentBuilder.js` (≈216 KiB raw / 64 KiB gzip)** ships `@xyflow/react`; only the agent builder route needs it, so we should confirm it is not pulled into the eager graph.
- **`index.css` (≈208 KiB raw / 27 KiB gzip)** is a single Tailwind-generated stylesheet. Once the design system stabilizes, enabling Tailwind's content-aware purge per-route could shrink this.

## Updating the baseline

When you intentionally land a perf win (or regression), re-run `npm run analyze` and update the totals + top-25 table above with the new numbers, keeping the previous baseline in a "Previous baselines" section so the trend is visible.
