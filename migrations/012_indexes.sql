CREATE INDEX IF NOT EXISTS idx_call_sessions_tenant_state ON call_sessions(tenant_id, lifecycle_state);
CREATE INDEX IF NOT EXISTS idx_call_sessions_caller ON call_sessions(tenant_id, caller_number);
CREATE INDEX IF NOT EXISTS idx_call_sessions_direction ON call_sessions(tenant_id, direction);

CREATE INDEX IF NOT EXISTS idx_call_transcripts_session_seq ON call_transcripts(call_session_id, sequence_number);

CREATE INDEX IF NOT EXISTS idx_tool_invocations_tenant_tool ON tool_invocations(tenant_id, tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_invocations_invoked ON tool_invocations(invoked_at);

CREATE INDEX IF NOT EXISTS idx_workflow_executions_workflow_name ON workflow_executions(tenant_id, workflow_name);

CREATE INDEX IF NOT EXISTS idx_outbox_events_pending ON outbox_events(status, next_attempt_at)
  WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_usage_metrics_tenant_type_period ON usage_metrics(tenant_id, metric_type, period_start, period_end);

CREATE INDEX IF NOT EXISTS idx_billing_events_type ON billing_events(tenant_id, event_type);

CREATE INDEX IF NOT EXISTS idx_analytics_metrics_tenant_recorded ON analytics_metrics(tenant_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_error_logs_tenant_severity ON error_logs(tenant_id, severity, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_logs_unresolved ON error_logs(tenant_id, occurred_at)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(tenant_id, action);

CREATE INDEX IF NOT EXISTS idx_system_metrics_name_recorded ON system_metrics(metric_name, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_demo_sessions_converted ON demo_sessions(tenant_id, converted);

CREATE INDEX IF NOT EXISTS idx_user_tenant_roles_active ON user_tenant_roles(tenant_id, role)
  WHERE revoked_at IS NULL;
