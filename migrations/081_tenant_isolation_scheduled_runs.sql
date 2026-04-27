-- Allow tenant_isolation_tests rows to be tagged as scheduled vs manual runs
-- and grouped into a single run via run_id. Backfills existing rows as
-- 'manual' so the new constraint can be added safely.

ALTER TABLE tenant_isolation_tests
  ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS run_id VARCHAR;

DO $$ BEGIN
  ALTER TABLE tenant_isolation_tests
    ADD CONSTRAINT tenant_isolation_tests_source_check
    CHECK (source IN ('manual', 'scheduled'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_tenant_isolation_tests_source_runat
  ON tenant_isolation_tests(source, run_at DESC);

CREATE INDEX IF NOT EXISTS idx_tenant_isolation_tests_run_id
  ON tenant_isolation_tests(run_id);
