-- 089: Index per-job breadcrumb lookups on the location history ring
--
-- The dispatch board list endpoint now computes a "closest approach"
-- distance per job (the smallest haversine between any breadcrumb ping
-- recorded against the job and the cached customer-address geocode) so
-- supervisors can spot jobs that probably never reached the right house
-- without opening the route replay tab.
--
-- That requires `WHERE tenant_id = $1 AND active_job_id = $2` lookups
-- against `dispatch_resource_location_history` for every paginated job.
-- The existing indexes are `(resource_id, recorded_at DESC)` and
-- `(tenant_id, recorded_at DESC)` (migration 083) — neither helps when
-- we know the job id but not the resource or the time, so a per-page
-- scan would degrade with history volume.
--
-- Partial on `active_job_id IS NOT NULL` keeps the index small: most
-- pings carry an active_job_id (techs only POST while on a job), but
-- any rows lingering with NULL (race when the job transitions out of
-- the active set) are uninteresting for this lookup.

CREATE INDEX IF NOT EXISTS idx_dispatch_location_history_tenant_job
  ON dispatch_resource_location_history(tenant_id, active_job_id)
  WHERE active_job_id IS NOT NULL;
