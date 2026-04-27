-- 083: Live technician location tracking
--
-- Powers the dispatcher live map: while a technician is actively servicing
-- a job (en_route → on_site → in_progress) the mobile app POSTs a position
-- ping every ~30 seconds. We keep the *latest* known fix per resource in a
-- denormalized current-state row so the dispatch board can render markers
-- with a single tenant-scoped query, and we keep a bounded history of pings
-- per resource so reviewers can replay a tech's recent path if a customer
-- disputes ETA, on-site time, or a no-show.
--
-- Why two tables:
--   * `dispatch_resource_locations` (one row per resource) → constant-time
--     lookups for the live map UI. The mobile client UPSERTs into this on
--     every ping so a noisy GPS feed never bloats the table.
--   * `dispatch_resource_location_history` → append-only ring used for
--     audit / breadcrumb playback. We rely on a per-resource pruning policy
--     in the application layer (last 200 pings per resource) so we don't
--     need a separate retention job.
--
-- The `active_job_id` column on the current-state row is the source of
-- truth for marker color on the dispatch map: when a job moves to
-- `completed` / `cancelled` / `done` the application clears this column
-- (and the mobile app stops sending pings), which causes the marker to
-- drop off the live view automatically.
--
-- RLS follows the same tenant_id pattern used across the dispatch tables
-- (migration 052) so cross-tenant location data is impossible to read or
-- write through the normal pool, even with a forged tenant header.

CREATE TABLE IF NOT EXISTS dispatch_resource_locations (
  resource_id     VARCHAR(255) PRIMARY KEY REFERENCES dispatch_resources(id) ON DELETE CASCADE,
  tenant_id       VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  latitude        DOUBLE PRECISION NOT NULL,
  longitude       DOUBLE PRECISION NOT NULL,
  accuracy_m      DOUBLE PRECISION,
  heading_deg     DOUBLE PRECISION,
  speed_mps       DOUBLE PRECISION,
  active_job_id   VARCHAR(255) REFERENCES dispatch_jobs(id) ON DELETE SET NULL,
  active_status   VARCHAR(30),
  recorded_at     TIMESTAMPTZ NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_resource_locations_tenant
  ON dispatch_resource_locations(tenant_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispatch_resource_locations_active_job
  ON dispatch_resource_locations(tenant_id, active_job_id)
  WHERE active_job_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS dispatch_resource_location_history (
  id              BIGSERIAL PRIMARY KEY,
  resource_id     VARCHAR(255) NOT NULL REFERENCES dispatch_resources(id) ON DELETE CASCADE,
  tenant_id       VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  latitude        DOUBLE PRECISION NOT NULL,
  longitude       DOUBLE PRECISION NOT NULL,
  accuracy_m      DOUBLE PRECISION,
  heading_deg     DOUBLE PRECISION,
  speed_mps       DOUBLE PRECISION,
  active_job_id   VARCHAR(255) REFERENCES dispatch_jobs(id) ON DELETE SET NULL,
  recorded_at     TIMESTAMPTZ NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dispatch_location_history_resource_time
  ON dispatch_resource_location_history(resource_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_dispatch_location_history_tenant_time
  ON dispatch_resource_location_history(tenant_id, recorded_at DESC);

ALTER TABLE dispatch_resource_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispatch_resource_location_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_dispatch_resource_locations ON dispatch_resource_locations;
CREATE POLICY tenant_isolation_dispatch_resource_locations ON dispatch_resource_locations
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);

DROP POLICY IF EXISTS tenant_isolation_dispatch_resource_location_history ON dispatch_resource_location_history;
CREATE POLICY tenant_isolation_dispatch_resource_location_history ON dispatch_resource_location_history
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);
