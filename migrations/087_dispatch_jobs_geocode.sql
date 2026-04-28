-- 087_dispatch_jobs_geocode.sql
-- Cache the geocoded latitude/longitude of each job's address on the job
-- row itself so the live-map ETA enrichment doesn't re-call the geocoding
-- provider on every dispatcher poll. We keep the source string we
-- geocoded so a downstream address edit invalidates the cached coords
-- automatically (the routing service compares `address_geocoded_for`
-- against the current `address` column).

ALTER TABLE dispatch_jobs
  ADD COLUMN IF NOT EXISTS address_lat NUMERIC(10, 7),
  ADD COLUMN IF NOT EXISTS address_lon NUMERIC(10, 7),
  ADD COLUMN IF NOT EXISTS address_geocoded_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS address_geocoded_for TEXT;

-- Helps the live-map enrichment query skip jobs that already have coords.
CREATE INDEX IF NOT EXISTS idx_dispatch_jobs_address_geocoded
  ON dispatch_jobs (tenant_id, address_geocoded_at)
  WHERE address_lat IS NOT NULL AND address_lon IS NOT NULL;
