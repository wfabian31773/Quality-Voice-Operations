-- Per-tenant override for the dispatch board's "too far from address"
-- threshold (in meters). When a job completes, if the closest GPS
-- breadcrumb against the geocoded address is farther than this value,
-- we auto-flag the job as a `dispatch_job_exceptions` row and the
-- inline board badge renders red. The same value drives the badge
-- color so the passive UI signal and the active exception fire on
-- identical math.
--
-- Default 250 m matches the historical hard-coded constant: a rural
-- HVAC company on multi-acre lots can raise this to suppress
-- false-positives, while an urban locksmith can tighten it to 100 m
-- so a wrong-floor visit doesn't slip through.
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS dispatch_bad_arrival_threshold_m INTEGER NOT NULL DEFAULT 250;

-- Sanity guard: the column is consumed by both an SQL `> threshold`
-- comparison server-side and a JS `> threshold` client-side, so a
-- negative or absurdly large value would either flag every job or
-- never flag one. Keep the bounds wide enough for both ends of the
-- expected operational range (10 m – 5 km) but reject obvious typos.
ALTER TABLE tenants
  ADD CONSTRAINT tenants_dispatch_bad_arrival_threshold_m_range
  CHECK (dispatch_bad_arrival_threshold_m BETWEEN 10 AND 5000);
