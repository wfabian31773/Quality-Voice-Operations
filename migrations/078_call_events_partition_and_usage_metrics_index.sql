-- BL-044 — usage_metrics composite index + call_events monthly partition w/ 90-day retention
-- See docs/audit/05-integration-and-performance.md (I-23, I-24) and
-- docs/audit/09-prioritized-backlog.md (BL-044).
--
-- Two changes:
--
--   1. Add a composite index on usage_metrics built for the
--      AnalyticsService.getCostAnalytics rollup access pattern
--      (tenant_id = X AND metric_type IN (...) AND period_start range).
--
--      The audit (I-23) recommends an index on (tenant_id, time DESC,
--      metric_type) so the rollups stop sequential-scanning. We use that
--      column order's spirit but reorder to (tenant_id, metric_type,
--      period_start DESC): with the audit's literal ordering the planner
--      would not naturally pick this index because metric_type is
--      always pinned to a single value (or a small IN list) in the
--      rollup, so an index whose middle column is `period_start` forces
--      a recheck of metric_type after the period scan. With metric_type
--      promoted to position #2, the same index serves the rollup as a
--      perfect-prefix index scan and `period_start DESC` keeps it useful
--      for tenant + recent-time scans elsewhere.
--
--      As part of this we drop the now-redundant
--      idx_usage_metrics_tenant_type_period from migration 012: that
--      index has the same leading three columns as the new index plus
--      a fourth column (period_end) that no production query filters
--      on, so the new index is a strict superset for every query path.
--      Removing it avoids carrying a duplicate index and lets the
--      planner converge on a single tenant+type+time access path.
--
--      schema notes: the audit recommends `recorded_at` but our schema
--      stores the time-of-record in `period_start` (see
--      migrations/008_billing.sql), so the index is built on
--      `period_start DESC`.
--
--   2. Convert `call_events` into a monthly RANGE-partitioned table on
--      `occurred_at`, with helper functions to create future partitions and
--      drop partitions whose entire range is older than the retention window
--      (default 90 days). A Node-side scheduler (CallEventsRetentionScheduler)
--      calls these helpers once a day. We do the table swap inside the same
--      transaction so the migration is atomic — if anything fails we roll back
--      to the original heap table with no data loss.

-- ---------------------------------------------------------------------------
-- 1. usage_metrics composite index
-- ---------------------------------------------------------------------------

-- Drop-then-create so environments that already applied an earlier draft of
-- this migration (which used the column order
-- (tenant_id, period_start DESC, metric_type)) get the corrected order
-- (tenant_id, metric_type, period_start DESC) on re-deploy. On fresh
-- deploys the DROP is a no-op. The migration only ever runs once per
-- environment (gated by schema_migrations), so this is not "always
-- rebuild on every boot".
DROP INDEX IF EXISTS idx_usage_metrics_tenant_time_type;
CREATE INDEX IF NOT EXISTS idx_usage_metrics_tenant_time_type
  ON usage_metrics(tenant_id, metric_type, period_start DESC);

-- Drop the now-redundant 4-column index from migration 012 (see header).
DROP INDEX IF EXISTS idx_usage_metrics_tenant_type_period;

-- ---------------------------------------------------------------------------
-- 2. call_events monthly partitioning
-- ---------------------------------------------------------------------------

-- Idempotency guard: only run the table-swap if call_events is not already a
-- partitioned table. `relkind = 'p'` means "partitioned table"; 'r' means
-- ordinary heap table. Re-running this migration must be a no-op for the
-- partition swap.
DO $$
DECLARE
  v_kind char;
BEGIN
  SELECT relkind INTO v_kind
    FROM pg_class
   WHERE relname = 'call_events'
     AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema());

  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'call_events table is missing — migration 005 must run first';
  END IF;

  IF v_kind = 'p' THEN
    RAISE NOTICE 'call_events is already partitioned, skipping table swap';
    RETURN;
  END IF;

  -- Rename the existing heap table out of the way so we can re-create
  -- `call_events` as a partitioned parent. We keep the data in
  -- `call_events_legacy` and copy it into the partitioned table below.
  EXECUTE 'ALTER TABLE call_events RENAME TO call_events_legacy';

  -- The legacy table's indexes/policies follow the rename, so drop the ones
  -- we re-create below to avoid name collisions with the new partitioned
  -- table's per-partition indexes.
  EXECUTE 'ALTER INDEX IF EXISTS idx_call_events_tenant         RENAME TO idx_call_events_legacy_tenant';
  EXECUTE 'ALTER INDEX IF EXISTS idx_call_events_session        RENAME TO idx_call_events_legacy_session';
  EXECUTE 'ALTER INDEX IF EXISTS idx_call_events_type           RENAME TO idx_call_events_legacy_type';

  -- The new partitioned parent. PostgreSQL requires every column of the
  -- partition key to be part of any unique constraint on the partitioned
  -- table, so the primary key becomes (id, occurred_at). `id` is still a
  -- gen_random_uuid() so global uniqueness is preserved in practice (the row
  -- only ever lands in the partition matching its occurred_at).
  EXECUTE $ddl$
    CREATE TABLE call_events (
      id               VARCHAR NOT NULL DEFAULT gen_random_uuid(),
      tenant_id        VARCHAR NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
      call_session_id  VARCHAR NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
      event_type       VARCHAR(60) NOT NULL,
      from_state       call_lifecycle_state,
      to_state         call_lifecycle_state,
      payload          JSONB DEFAULT '{}',
      occurred_at      TIMESTAMP NOT NULL DEFAULT NOW(),
      PRIMARY KEY (id, occurred_at)
    ) PARTITION BY RANGE (occurred_at)
  $ddl$;

  -- Re-create indexes on the partitioned parent — Postgres propagates these
  -- to existing and future partitions automatically.
  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_call_events_tenant            ON call_events(tenant_id)';
  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_call_events_session           ON call_events(call_session_id)';
  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_call_events_type              ON call_events(event_type)';
  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_call_events_tenant_occurred   ON call_events(tenant_id, occurred_at DESC)';

  -- Re-enable RLS + tenant isolation policy. Both 011_rls.sql and
  -- 017_rls_with_check.sql installed a `tenant_isolation_call_events` policy
  -- on the original heap; that policy was dropped along with the rename's
  -- column-resolution context, so we recreate it on the new parent.
  EXECUTE 'ALTER TABLE call_events ENABLE ROW LEVEL SECURITY';
  EXECUTE $rls$
    CREATE POLICY tenant_isolation_call_events ON call_events
      USING (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
      WITH CHECK (tenant_id = current_setting('app.tenant_id', TRUE)::varchar)
  $rls$;
END $$;

-- ---------------------------------------------------------------------------
-- Helper: ensure_call_events_partition(month_start)
-- ---------------------------------------------------------------------------
-- Creates the monthly partition that covers `month_start` (truncated to the
-- start of its month) if it does not yet exist. Idempotent — safe to call
-- repeatedly. Returns the partition name.
CREATE OR REPLACE FUNCTION ensure_call_events_partition(p_month_start TIMESTAMPTZ)
RETURNS TEXT
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_start DATE := date_trunc('month', p_month_start)::DATE;
  v_end   DATE := (date_trunc('month', p_month_start) + INTERVAL '1 month')::DATE;
  v_name  TEXT := 'call_events_' || to_char(v_start, 'YYYY_MM');
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE relname = v_name
  ) THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF call_events FOR VALUES FROM (%L) TO (%L)',
      v_name, v_start, v_end
    );
  END IF;
  RETURN v_name;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Helper: prune_call_events_older_than(retain_days)
-- ---------------------------------------------------------------------------
-- Drops every monthly partition whose ENTIRE range is older than NOW() minus
-- `retain_days`. A partition is only dropped when its upper bound (exclusive)
-- is at or before the cutoff, so we never lose rows that are still inside the
-- retention window. Returns the list of dropped partition names so the
-- scheduler can log them.
CREATE OR REPLACE FUNCTION prune_call_events_older_than(p_retain_days INT DEFAULT 90)
RETURNS TEXT[]
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_cutoff   TIMESTAMPTZ := date_trunc('day', NOW()) - make_interval(days => p_retain_days);
  v_dropped  TEXT[] := ARRAY[]::TEXT[];
  v_part     RECORD;
  v_upper_ts TIMESTAMPTZ;
BEGIN
  FOR v_part IN
    SELECT child.relname           AS part_name,
           pg_get_expr(child.relpartbound, child.oid) AS bounds
      FROM pg_inherits i
      JOIN pg_class child  ON child.oid  = i.inhrelid
      JOIN pg_class parent ON parent.oid = i.inhparent
     WHERE parent.relname = 'call_events'
  LOOP
    -- Default partition (if anyone creates one) returns 'DEFAULT' here; skip.
    IF v_part.bounds = 'DEFAULT' THEN
      CONTINUE;
    END IF;

    -- bounds looks like:  FOR VALUES FROM ('2025-07-01') TO ('2025-08-01')
    -- Extract the upper-bound literal between the last "TO ('" and the
    -- closing "')".
    v_upper_ts := substring(v_part.bounds FROM 'TO \(''([^'']+)''\)')::TIMESTAMPTZ;

    IF v_upper_ts <= v_cutoff THEN
      EXECUTE format('DROP TABLE IF EXISTS %I', v_part.part_name);
      v_dropped := array_append(v_dropped, v_part.part_name);
    END IF;
  END LOOP;

  RETURN v_dropped;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Bootstrap partitions, copy legacy data, drop the legacy table
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_min_ts TIMESTAMPTZ;
  v_max_ts TIMESTAMPTZ;
  v_cur    TIMESTAMPTZ;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_name = 'call_events_legacy'
       AND table_schema = current_schema()
  ) THEN
    -- Migration already ran (or there was nothing to copy). Just make sure
    -- the current and next months exist so writes after a fresh deploy land
    -- in a partition.
    PERFORM ensure_call_events_partition(NOW()::TIMESTAMPTZ);
    PERFORM ensure_call_events_partition((NOW() + INTERVAL '1 month')::TIMESTAMPTZ);
    RETURN;
  END IF;

  -- Make sure every month covered by legacy data has a partition. We also
  -- always create the current and next month so live INSERTs after the swap
  -- have a target.
  SELECT min(occurred_at), max(occurred_at)
    INTO v_min_ts, v_max_ts
    FROM call_events_legacy;

  IF v_min_ts IS NULL THEN
    v_min_ts := NOW();
    v_max_ts := NOW();
  END IF;

  v_cur := date_trunc('month', LEAST(v_min_ts, NOW()));
  WHILE v_cur <= GREATEST(v_max_ts, NOW() + INTERVAL '1 month') LOOP
    PERFORM ensure_call_events_partition(v_cur);
    v_cur := v_cur + INTERVAL '1 month';
  END LOOP;

  -- Copy the legacy rows into the partitioned table. INSERT ... SELECT
  -- routes each row to its month partition automatically.
  INSERT INTO call_events
       (id, tenant_id, call_session_id, event_type, from_state, to_state, payload, occurred_at)
  SELECT id, tenant_id, call_session_id, event_type, from_state, to_state, payload,
         COALESCE(occurred_at, NOW())
    FROM call_events_legacy;

  DROP TABLE call_events_legacy;
END $$;
