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

# Demo data

## Seed the demo barbershop (Sharp Line Barbers)

`scripts/seed-demo-barbershop.ts` turns the `demo` tenant (the number used
for live test calls) into a small bilingual barbershop, so
`scheduling.list_services` and `scheduling.check_availability` return real
services and slots. It is a seed, not a migration: nothing runs it
automatically, and the PR that adds it does not run it either.

**When and where:** after the PR is merged, and on the **test database
only** (the one behind the `demo` test-call number), never production:

1. Apply migration `125_service_aliases.sql` to the test database (the seed
   writes the `aliases` column).
2. Then run the seed against that same test database, as below.

```
# 1. See what it will write (reads the tenant, writes nothing)
npx tsx scripts/seed-demo-barbershop.ts --tenant demo --dry-run

# 2. Write it
npx tsx scripts/seed-demo-barbershop.ts --tenant demo
```

Connection: `DATABASE_URL_PRIVILEGED`, else `DATABASE_URL`
(`APP_ENV=development`) or `PLATFORM_DB_POOL_URL` (other `APP_ENV`), the
same as `scripts/seed-demo.ts`. The writes run in one transaction bound to
the tenant with `withTenantContext`.

What it seeds (QVO tables only):

- 8 services in `scheduling_appointment_types` with durations, "from" or
  fixed prices, and EN/ES spoken aliases from
  `shared/scheduling/serviceLexicon.ts` (`scheduling.list_services` with a
  `query` matches against them; everyday words such as "line up" are left
  out on purpose): Haircut 30 min, Fade 45, Taper 45,
  Lineup 15, Beard trim 15, Haircut and beard 45, Hot towel shave 30 (no
  price: the agent says the shop will confirm), Kids cut 30 (12 and under).
- 3 barbers: Marcus (all services), Luis (English/Spanish; everything but
  the hot towel shave), Dee (haircut, fade, taper, lineup, kids cut), with
  `scheduling_provider_services` links.
- Weekly schedules Tue–Sat 9:00–19:00; Dee is off Wednesday.
- Business hours Tue–Sat 9–7, closed Sunday and Monday (replaces the
  tenant's existing business-hours rows).
- One tenant-wide booking rule: 1 h lead time, up to 30 days ahead,
  same-day allowed, 24 h cancellation window. The 15-minute slot grid is
  the availability engine's default; buffers are per service (5 min after
  the 30/45-minute services).

Safe to re-run: ids are derived from (tenant, kind, key) and every write is
an upsert, so a second run changes nothing. For the three seeded barbers,
service links and weekly blocks not in the plan are removed. Nothing else in
the tenant is touched.

Flags:

- `--tenant <id>` (or `--tenant=<id>`): default `demo`. The script refuses
  to run if the tenant doesn't exist.
- `--dry-run`: print the planned upserts and roll back.
- `--allow-non-demo`: seed a tenant whose `tenants.is_demo` is not true
  (refused by default so a typo can't reshape a real shop).

Test: `scripts/seed-demo-barbershop.test.ts` runs the seed twice against a
scratch local Postgres and checks the counts, then checks that a "low fade"
resolved through the aliases gets Saturday-morning slots.

