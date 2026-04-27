-- Speed up analytics dashboards by extending the (tenant_id, time DESC, kind)
-- composite-index pattern that migration 078 introduced for `usage_metrics`.
--
-- Audit reference: docs/audit/05-integration-and-performance.md (I-23 family).
-- Companion to: migrations/078_call_events_partition_and_usage_metrics_index.sql.
--
-- Why these specific (table, time, kind) triples:
--
--   * call_sessions     -> (tenant_id, created_at DESC, lifecycle_state)
--       AnalyticsService.getCallAnalytics/getCostAnalytics filter by
--       (tenant_id, created_at range) and aggregate FILTER (WHERE
--       lifecycle_state IN ('CALL_COMPLETED','CALL_FAILED','ESCALATED')).
--       The existing (tenant_id, start_time) index is on a different column
--       (and ASC), so the planner currently sequential-scans for these
--       dashboard queries on large tenants.
--
--   * tool_invocations  -> (tenant_id, invoked_at DESC, status)
--       ToolExecutionService.listToolExecutions / getToolExecutionStats
--       filter by (tenant_id, invoked_at range) and FILTER on status
--       ('success','failed','timeout'). The existing
--       (tenant_id, tool_name) and (invoked_at) singletons can't satisfy
--       both predicates.
--
--   * workflow_executions -> (tenant_id, started_at DESC, status)
--       Reliability dashboards list executions newest-first per tenant and
--       FILTER on status. The existing (tenant_id, started_at) is ASC and
--       does not include status.
--
--   * audit_logs        -> (tenant_id, occurred_at DESC, action)
--       Compliance / audit listing pages page newest-first per tenant.
--       Migration 027 added (tenant_id, action, occurred_at DESC) which is
--       great for action-filtered queries; this complements it for the
--       common "no-action-filter" listing path.
--
--   * analytics_metrics -> (tenant_id, recorded_at DESC, metric_name)
--       Custom metric rollups page through the most recent samples per
--       tenant and almost always narrow by metric_name; the existing
--       (tenant_id, recorded_at DESC) index has to fall back to a
--       per-row name check.
--
--   * call_events       -> (tenant_id, occurred_at DESC, event_type)
--       InsightsEngine.runInsightsAnalysis / AutopilotEngine / GIN
--       AggregationPipeline filter by (tenant_id, occurred_at range) and
--       event_type IN ('TOOL_START','TOOL_END',...). Migration 078 created
--       (tenant_id, occurred_at DESC) on the partitioned parent; we extend
--       it with event_type as a tail column so the planner can do an index
--       skip-scan on the type filter. Postgres propagates the index
--       definition to every existing and future monthly partition.
--
-- error_logs already has (tenant_id, severity, occurred_at DESC) from
-- migration 012 and is intentionally skipped.
--
-- All indexes use IF NOT EXISTS so re-running the migration is a no-op.
-- We do NOT use CREATE INDEX CONCURRENTLY because (a) migrations here run
-- inside transactions where CONCURRENTLY is illegal, and (b) call_events
-- is a partitioned parent which only accepts non-concurrent CREATE INDEX.

CREATE INDEX IF NOT EXISTS idx_call_sessions_tenant_created_state
  ON call_sessions(tenant_id, created_at DESC, lifecycle_state);

CREATE INDEX IF NOT EXISTS idx_tool_invocations_tenant_invoked_status
  ON tool_invocations(tenant_id, invoked_at DESC, status);

CREATE INDEX IF NOT EXISTS idx_workflow_executions_tenant_started_status
  ON workflow_executions(tenant_id, started_at DESC, status);

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_occurred_action
  ON audit_logs(tenant_id, occurred_at DESC, action);

CREATE INDEX IF NOT EXISTS idx_analytics_metrics_tenant_recorded_name
  ON analytics_metrics(tenant_id, recorded_at DESC, metric_name);

CREATE INDEX IF NOT EXISTS idx_call_events_tenant_occurred_type
  ON call_events(tenant_id, occurred_at DESC, event_type);
