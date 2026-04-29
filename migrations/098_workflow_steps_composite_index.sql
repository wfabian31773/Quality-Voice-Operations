-- Speed up step-level reliability and tool-execution drilldowns by extending
-- the (tenant_id, time DESC, kind) composite-index pattern to `workflow_steps`.
--
-- Companion to: migrations/081_analytics_composite_indexes.sql, which added
-- the equivalent index to the parent `workflow_executions` table. The
-- per-step `workflow_steps` table is joined into by reliability dashboards
-- and the tool-execution drilldown to answer questions like "show me failed
-- steps in the last 24h for tenant X". With only the existing
-- (workflow_execution_id) and (tenant_id) singletons it falls into the same
-- sequential-scan trap that #580 just escaped on the parent as tenants
-- accumulate executions.
--
-- Why (tenant_id, started_at DESC, status):
--
--   * tenant_id leads so RLS / per-tenant filters use the index.
--   * started_at DESC matches the newest-first listing/window predicates
--     (`started_at >= NOW() - INTERVAL '24 hours'`, `ORDER BY started_at
--     DESC`).
--   * status as the tail column lets the planner satisfy the common
--     `status IN ('failed','timed_out')` reliability filter from the index
--     instead of re-checking each row from the heap.
--
-- The migration runner wraps each file in a transaction, so we use
-- `CREATE INDEX IF NOT EXISTS` (not CONCURRENTLY) and accept the brief
-- SHARE lock during build. Schedule production rollout in a low-traffic
-- window, same as migration 081.

CREATE INDEX IF NOT EXISTS idx_workflow_steps_tenant_started_status
  ON workflow_steps(tenant_id, started_at DESC, status);
