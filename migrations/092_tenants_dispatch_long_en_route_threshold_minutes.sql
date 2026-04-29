-- Per-tenant override for the dispatch board's "tech has been driving
-- too long" threshold (in minutes). Surfaced inline on each en_route
-- board card next to the live customer ETA so dispatchers can spot
-- stuck or stalled trucks at a glance: the duration badge stays grey
-- while the elapsed en_route time is below this value, flips amber
-- once it crosses, and turns red once it doubles.
--
-- Default 30 minutes mirrors the typical local-route field-service
-- drive: most jobs are reached in under that window, so anything
-- longer is worth a glance. Long-haul / cross-county operations can
-- raise it; high-density urban operations can tighten it.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS dispatch_long_en_route_threshold_minutes INTEGER NOT NULL DEFAULT 30;

-- Sanity guard: the column drives both an SQL `> threshold` check and
-- a JS `> threshold` comparison, so a non-positive or absurdly large
-- value would either flag every truck or never flag one. Bounds are
-- wide enough for the realistic operational range (5 min – 8 hours)
-- but reject obvious typos.
ALTER TABLE tenants
  ADD CONSTRAINT tenants_dispatch_long_en_route_threshold_minutes_range
  CHECK (dispatch_long_en_route_threshold_minutes BETWEEN 5 AND 480);
