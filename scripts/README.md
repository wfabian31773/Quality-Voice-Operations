# Doc capture scripts

Two Playwright scripts re-generate the assets used by the help articles.

## Prerequisites

- The Platform Dev workflow must be running (the scripts hit `http://localhost:5000`).
- Headless Chromium needs `libgbm` (already in `replit.nix`).
- The video script needs `ffmpeg` on `PATH` (provided by the Replit runtime).
- One-time browser install: `npx playwright install chromium`.

## Capture screenshots

```
node scripts/capture-doc-screenshots.mjs
```

Writes JPEGs to `client-app/public/docs/screenshots/`. Adjust the
`shots` array at the top of the file to add or change captures. Each
entry navigates to a public route, scrolls to the chosen offset, and
saves a 1280x720 JPEG. The cookie banner is dismissed via an init
script that pre-populates `qvo-cookie-consent-v1` in `localStorage`.

## Record the quickstart walkthrough video

```
node scripts/capture-doc-video.mjs
```

Records a Playwright session as WebM, transcodes to MP4 with ffmpeg
(libx264, yuv420p, faststart), and writes
`client-app/public/docs/videos/quickstart-walkthrough.mp4`.

## Wiring assets into the docs

Reference the new files from `client-app/src/data/docs.ts` using the
`image` or `video` block types — see `DocBlock` in that file and the
matching renderers in `client-app/src/components/DocBlocks.tsx`.

# Operational backfills

## Backfill missing dispatch job geocodes

`migrations/087_dispatch_jobs_geocode.sql` adds `address_lat` /
`address_lon` columns but leaves them NULL for pre-existing jobs. Two
product surfaces lazy-fill these on demand and pay a geocode round-trip
when they're missing:

1. The dispatcher live map (first ETA after a tech goes en_route).
2. The route-replay endpoint (`GET /admin/dispatch/jobs/:id/route`),
   which is opened on *historical* jobs — completed, cancelled,
   incomplete — so on a busy tenant hundreds of older rows may have
   never been geocoded.

Run the backfill once after deploying the migration so every job —
open and historical — already has cached coordinates:

```
# Development (uses DATABASE_URL)
APP_ENV=development npx tsx scripts/backfill-dispatch-job-geocodes.ts

# Production (uses PLATFORM_DB_POOL_URL)
APP_ENV=production npx tsx scripts/backfill-dispatch-job-geocodes.ts
```

The script:

- selects every `dispatch_jobs` row whose `address` is non-empty and
  whose `address_lat`/`address_lon` is missing or whose
  `address_geocoded_for` no longer matches `address` — so it's safe to
  re-run, and a re-run after an address edit picks up the change;
- by default covers ALL statuses (open + completed + cancelled), so
  the route-replay surface benefits even on historical jobs. Pass
  `--actionable-only` to scope to still-open statuses
  (`pending`, `assigned`, `scheduled`, `en_route`, `on_site`,
  `in_progress`) when you only want the live-map quick-win and need
  to save quota;
- respects the configured geocoder's rate limit. Defaults are 1 req/s
  for `nominatim` (per OSM policy), 5 req/s for `mapbox`, and
  10 req/s for `google`. Override with `--rps=<n>` or
  `DISPATCH_GEOCODE_BACKFILL_RPS=<n>`;
- logs a per-tenant `scanned/geocoded/not_found/failed` tally and a
  global total at the end.

Useful flags:

- `--dry-run` — report what would change without writing.
- `--actionable-only` — only backfill open/in-flight jobs (the
  pre-Task-#779 default).
- `--include-all-statuses` — deprecated no-op alias kept for backward
  compatibility with operator runbooks; ALL statuses are now included
  by default.
- `--tenant=<tenant_id>` — scope to a single tenant (useful for
  re-running after a backfill failure).
- `--limit=<n>` — stop after N rows (smoke test).

The geocoder provider is selected from `DISPATCH_GEOCODE_PROVIDER`
(`nominatim` | `mapbox` | `google` | `none`). With `none` the script
exits without touching the database.

