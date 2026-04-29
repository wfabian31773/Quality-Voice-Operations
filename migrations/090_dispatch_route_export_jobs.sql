-- 090_dispatch_route_export_jobs.sql
--
-- Tracks the async path of the bulk dispatch-route export feature
-- (POST /dispatch/jobs/routes/export with `async: true`). The sync path
-- still streams the ZIP straight back to the dispatcher's browser, but
-- for large insurance audits ("every job last quarter") that would
-- otherwise blow past the 500-job per-request cap, the dispatcher can
-- now request the archive in the background and pick it up via an
-- email link when it's ready.
--
-- Each row represents a single export request. The worker (in
-- `server/admin-api/routes/dispatch.ts`) writes to this table at three
-- points:
--   1. immediately after the request is accepted (status='pending'),
--   2. when the worker starts/finishes building the ZIP
--      (status='running' → 'ready' or 'failed'), and
--   3. when the email is dispatched (email_sent_at + email_message_id).
--
-- The `download_token` column backs the unauthenticated download link
-- emailed to the dispatcher. It's only set once the archive is
-- successfully uploaded to object storage; the matching expiry
-- `download_expires_at` lets us reject stale clicks without a separate
-- cleanup pass. RLS keeps the table tenant-scoped on every read.

CREATE TABLE IF NOT EXISTS dispatch_route_export_jobs (
  id                   VARCHAR(255) PRIMARY KEY DEFAULT gen_random_uuid()::text,
  tenant_id            VARCHAR(255) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_by_user_id VARCHAR(255) REFERENCES users(id) ON DELETE SET NULL,
  requested_by_email   TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'running', 'ready', 'failed')),
  format               TEXT NOT NULL DEFAULT 'gpx'
                         CHECK (format IN ('gpx', 'csv')),
  include_empty        BOOLEAN NOT NULL DEFAULT TRUE,
  selection            JSONB NOT NULL DEFAULT '{}'::jsonb,
  job_count            INTEGER,
  included_count       INTEGER,
  skipped_empty        INTEGER,
  archive_object_path  TEXT,
  archive_filename     TEXT,
  archive_bytes        BIGINT,
  download_token       TEXT,
  download_expires_at  TIMESTAMPTZ,
  error_message        TEXT,
  email_sent_at        TIMESTAMPTZ,
  email_message_id     TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at           TIMESTAMPTZ,
  completed_at         TIMESTAMPTZ
);

-- The dispatcher's "Recent exports" view (and the status poll) walks
-- this table by tenant + recency. Without the index those reads would
-- degrade as the table accumulates historic exports.
CREATE INDEX IF NOT EXISTS idx_dispatch_route_export_jobs_tenant_created
  ON dispatch_route_export_jobs (tenant_id, created_at DESC);

-- Token lookups go through the unauthenticated download endpoint, so
-- the index needs to be unique-per-token (NULL tokens during the
-- pending/running phase don't conflict thanks to the partial filter).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_dispatch_route_export_jobs_token
  ON dispatch_route_export_jobs (download_token)
  WHERE download_token IS NOT NULL;

ALTER TABLE dispatch_route_export_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation_dispatch_route_export_jobs
  ON dispatch_route_export_jobs;
CREATE POLICY tenant_isolation_dispatch_route_export_jobs
  ON dispatch_route_export_jobs
  USING (tenant_id = current_setting('app.tenant_id', true)::varchar)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::varchar);
